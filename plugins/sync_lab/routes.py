"""Sync Lab: builds the calibration song and keeps a log of calibration results.

The calibration song is an ordinary sloppak (written into the library as
sloppak/_Sync_Calibration_v<N>.sloppak), so it goes through exactly the same
clock, highway, Note Detection and drum engine as any song, in single player,
split view or multiplayer. 100 BPM, one note per beat (open A string on Lead
and Bass, snare on Drums), three sections:

  listen  clicks + notes, screen blanked by screen.js: play by ear
  watch   notes, no clicks: play by eye
  play    clicks + notes: normal play, as a check

Ear vs eye timing gives the A/V offset; the eye timing gives each player's
input offset (see screen.js).
"""

import io
import json
import math
import struct
import time
import wave
import zipfile
from pathlib import Path

from fastapi import Request

VERSION = 2
NAME = f"_Sync_Calibration_v{VERSION}.sloppak"
SR = 44100
BPM = 100
BEAT = 60.0 / BPM
T0 = 2.0
# Beat index ranges (inclusive start, exclusive end). Count-ins are clicks
# only (accented), the three test sections carry the notes.
PLAN = [
    ("count", 0, 4, True),
    ("listen", 4, 36, True),
    ("count", 36, 40, True),
    ("watch", 40, 72, False),
    ("count", 72, 76, True),
    ("play", 76, 100, True),
]
END_BEAT = 103
DURATION = round(T0 + END_BEAT * BEAT, 3)

LOG = Path(__file__).parent / "sync_log.jsonl"
MAX_LOG_BYTES = 2 * 1024 * 1024


def _bt(k):
    return round(T0 + k * BEAT, 4)


def plan():
    secs = {}
    for name, a, b, _clicks in PLAN:
        if name != "count":
            secs[name] = [_bt(a), _bt(b)]
    return {
        "version": VERSION,
        "bpm": BPM,
        "beat": BEAT,
        "t0": T0,
        "duration": DURATION,
        "sections": secs,
        # Screen blanked from the first count-in click to the end of listen.
        "blank": [_bt(0) - 0.3, _bt(36) - 0.15],
        "file": "sloppak/" + NAME,
    }


def _click_track():
    n = int(DURATION * SR)
    buf = [0.0] * n
    for name, a, b, clicks in PLAN:
        if not clicks:
            continue
        accent = name == "count"
        freq = 1568.0 if accent else 1046.5
        amp = 0.75 if accent else 0.6
        for k in range(a, b):
            start = int(round(_bt(k) * SR))
            length = int(0.035 * SR)
            for i in range(length):
                j = start + i
                if j >= n:
                    break
                t = i / SR
                env = math.exp(-t / 0.010)
                # Woodblock-ish: fundamental + an inharmonic partial, sharp onset at the beat.
                s = math.sin(2 * math.pi * freq * t) + 0.45 * math.sin(2 * math.pi * freq * 2.76 * t)
                buf[j] += amp * env * s / 1.45
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767)))) for v in buf))
    return out.getvalue()


def _note(t, s, f):
    return {"t": t, "s": s, "f": f, "sus": 0.0, "sl": -1, "slu": -1, "bn": 0, "ho": False, "po": False,
            "hm": False, "hp": False, "pm": False, "mt": False, "vb": False, "tr": False, "ac": False, "tp": False}


def _note_times():
    out = []
    for name, a, b, _clicks in PLAN:
        if name != "count":
            out += [_bt(k) for k in range(a, b)]
    return out


def _beats():
    return [{"time": _bt(k), "measure": (k // 4) if k % 4 == 0 else -1} for k in range(END_BEAT)]


def _sections():
    out, num = [], {}
    for name, a, _b, _clicks in PLAN:
        num[name] = num.get(name, 0) + 1
        out.append({"name": name, "number": num[name], "time": _bt(a)})
    return out


def _guitar_arr(name):
    return {
        "name": name, "tuning": [0] * 6, "capo": 0,
        "notes": [_note(t, 1, 0) for t in _note_times()],   # open A string
        "chords": [], "anchors": [{"time": T0, "fret": 1, "width": 4}], "handshapes": [], "templates": [],
        "phrases": [], "beats": _beats(), "sections": _sections(),
    }


def _drums_arr():
    times = _note_times()
    snare = 38   # GM acoustic snare; wire format midi = s * 24 + f
    level = [[t, snare, 0] for t in times]
    return {
        "name": "Drums", "tuning": [0] * 6, "capo": 0,
        "notes": [_note(t, snare // 24, snare % 24) for t in times],
        "chords": [], "anchors": [], "handshapes": [], "templates": [],
        "beats": _beats(), "sections": _sections(),
        "drums": {"version": 1, "pro": True, "kick2x": False, "star_power": [], "fills": [],
                  "levels": {"easy": level, "medium": level, "hard": level}, "levels_generated": []},
    }


def _manifest():
    arr = lambda i, n: {"id": i, "name": n, "file": f"arrangements/{i}.json", "tuning": [0] * 6, "capo": 0}
    lines = [
        "title: Sync Calibration",
        "artist: Slopsmith Sync Lab",
        "album: Calibration",
        "year: 2026",
        f"duration: {DURATION}",
        "stems:",
        "- id: other",
        "  file: stems/click.wav",
        "  default: 'on'",
        "arrangements:",
    ]
    for a in (arr("lead", "Lead"), arr("bass", "Bass"), arr("drums", "Drums")):
        lines += [f"- id: {a['id']}", f"  name: {a['name']}", f"  file: {a['file']}",
                  "  tuning: [0, 0, 0, 0, 0, 0]", "  capo: 0"]
    lines.append("x_sync: " + json.dumps(plan()))
    return "\n".join(lines) + "\n"


def build(dest: Path):
    tmp = dest.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        z.writestr("manifest.yaml", _manifest())
        z.writestr("arrangements/lead.json", json.dumps(_guitar_arr("Lead")))
        z.writestr("arrangements/bass.json", json.dumps(_guitar_arr("Bass")))
        z.writestr("arrangements/drums.json", json.dumps(_drums_arr()))
        z.writestr("stems/click.wav", _click_track())
    tmp.replace(dest)


def ensure_song(dlc_dir, log=None):
    """Write the calibration sloppak into <dlc>/sloppak if this version is missing."""
    if not dlc_dir:
        return None
    folder = Path(dlc_dir) / "sloppak"
    if not folder.is_dir():
        return None
    dest = folder / NAME
    for old in folder.glob("_Sync_Calibration_v*.sloppak"):
        if old.name != NAME:
            try:
                old.unlink()
            except OSError:
                pass
    if not dest.exists():
        build(dest)
        if log:
            log.info("sync_lab: wrote %s", dest)
    return dest


def setup(app, context):
    ctx = context if isinstance(context, dict) else {}
    log = ctx.get("log")
    get_dlc = ctx.get("get_dlc_dir")

    def dlc():
        try:
            return get_dlc() if callable(get_dlc) else None
        except Exception:
            return None

    try:
        ensure_song(dlc(), log)
    except Exception as e:   # never block startup
        if log:
            log.warning("sync_lab: could not write the calibration song: %s", e)

    @app.get("/api/plugins/sync_lab/info")
    def info():
        path = None
        try:
            path = ensure_song(dlc(), log)
        except Exception as e:
            return {"ok": False, "error": str(e), "plan": plan()}
        return {"ok": bool(path), "plan": plan()}

    @app.post("/api/plugins/sync_lab/log")
    async def log_result(request: Request):
        try:
            entry = await request.json()
        except Exception:
            return {"ok": False}
        entry["server_ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if LOG.exists() and LOG.stat().st_size > MAX_LOG_BYTES:
            LOG.replace(LOG.with_suffix(".old.jsonl"))
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        return {"ok": True}

    @app.get("/api/plugins/sync_lab/log")
    def read_log(n: int = 20):
        if not LOG.exists():
            return {"entries": []}
        lines = LOG.read_text(encoding="utf-8").splitlines()[-max(1, min(200, n)):]
        out = []
        for ln in lines:
            try:
                out.append(json.loads(ln))
            except ValueError:
                pass
        return {"entries": out}
