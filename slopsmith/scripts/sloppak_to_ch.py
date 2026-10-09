"""Sloppak -> YARG / Clone Hero song folder (notes.mid + song.ini + OGG stems).

  python scripts/sloppak_to_ch.py SONG.sloppak OUT_DIR [--no-guitar] [--no-pro]

notes.mid gets:
- a tempo map + time signatures rebuilt from the sloppak's beat grid (480 ticks/beat; a
  pickup before the first beat), and EVENTS sections;
- PART DRUMS (Expert) from the "Drums" arrangement: pro-drums cymbals are the MIDI default,
  toms get tom markers (110/111/112), 2x kick on note 95, accents/ghosts as velocity
  127/1 with [ENABLE_CHART_DYNAMICS], star power (116) and drum fills (120-124) from the
  arrangement's ``drums`` block;
- PART GUITAR / PART RHYTHM / PART BASS (Expert, 5-fret) as a pitch-contour reduction of
  Lead / Rhythm / Bass: each onset's pitch is ranked against the pitches around it
  (+-4 s) and spread over the five lanes; chords become 2-3 adjacent lanes; long notes
  keep their sustain.  Necessarily lossy ("where mappable").
- PART REAL_GUITAR_22 / PART REAL_BASS_22 (Expert pro guitar/bass) - exact string+fret:
  note 96 + string (low E first), velocity 100 + fret, channel 3 for muted, 5 for
  harmonics, 0 otherwise.  Tuning goes to song.ini real_guitar_tuning / real_bass_tuning.
The MIDI layout follows YARG.Core's MidIOHelper / MidReader (LGPL-3.0, see lib/drumchart.py).

Stems: drums/bass/guitar/vocals/piano(keys)/other(song) are copied as OGG; a single
full.ogg becomes song.ogg.  Cover -> album.jpg.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "lib")]

import drumchart  # noqa: E402

TPQ = 480
GUITAR_BASE = [40, 45, 50, 55, 59, 64]
BASS_BASE = [28, 33, 38, 43, 47, 52]
STEM_TO_CH = {"drums": "drums", "bass": "bass", "guitar": "guitar", "vocals": "vocals", "piano": "keys",
              "other": "song", "full": "song"}
TOM_MARKER = {"yellow": 110, "blue": 111, "green": 112}
PAD_NOTE = {"kick": 96, "red": 97, "yellow": 98, "blue": 99, "green": 100}


# ── tempo map from beats ────────────────────────────────────────────────────

class BeatClock:
    """Seconds <-> ticks from a beat grid.  Beat k sits at tick (pickup + k) * TPQ; when the
    first beat isn't at 0 s, a pickup measure of ``pickup`` beats fills the gap."""

    def __init__(self, beats: list[dict], first_event: float | None = None):
        if len(beats) < 2:          # no grid: 120 BPM from 0
            beats = [{"time": 0.5 * i, "measure": i // 4 + 1 if i % 4 == 0 else -1} for i in range(2)]
        bt = np.array([float(b["time"]) for b in beats])
        flags = [b.get("measure", -1) not in (-1, None) for b in beats]
        self.delay = 0.0
        if 0.02 < bt[0] < 0.5 * (bt[1] - bt[0]) and (first_event is None or first_event >= bt[0] - 1e-6):
            # less than half a beat before the grid and nothing in it: song.ini delay, not a pickup
            self.delay = float(bt[0])
            bt = bt - self.delay
        if bt[0] > 0.02:
            self.pickup = max(1, int(round(bt[0] / (bt[1] - bt[0]))))
            self.times = np.r_[0.0, bt]
            self.ticks = np.r_[0, (self.pickup + np.arange(len(bt))) * TPQ]
            self.measure_flags = [True] + [False] * (self.pickup - 1) + flags
        else:
            self.pickup = 0
            self.times = np.r_[0.0, bt[1:]]
            self.ticks = np.arange(len(bt)) * TPQ
            self.measure_flags = flags

    def tick(self, t: float) -> int:
        t = float(t) - self.delay
        if t >= self.times[-1]:
            per = self.times[-1] - self.times[-2]
            return int(round(self.ticks[-1] + (t - self.times[-1]) / per * TPQ))
        return int(round(np.interp(t, self.times, self.ticks)))

    def tempo_events(self):
        """[(tick, microseconds per quarter)] - one per beat, deduplicated."""
        out, last = [], None
        for i in range(len(self.times) - 1):
            beats = (self.ticks[i + 1] - self.ticks[i]) / TPQ
            us = int(round((self.times[i + 1] - self.times[i]) / beats * 1_000_000))
            if us != last:
                out.append((int(self.ticks[i]), us))
                last = us
        return out

    def time_sigs(self):
        """[(tick, numerator)] from measure starts (x/4)."""
        starts = [i for i, f in enumerate(self.measure_flags) if f] or [0]
        if starts[0] != 0:
            starts = [0] + starts
        out, last = [], None
        for a, b in zip(starts, starts[1:] + [len(self.measure_flags)]):
            num = max(1, min(b - a, 16))
            if num != last:
                out.append((a * TPQ, num))
                last = num
        return out


# ── tracks ──────────────────────────────────────────────────────────────────

def _msgs_track(name, events):
    """events: (tick, order, mido message) -> MidiTrack with delta times."""
    import mido
    tr = mido.MidiTrack()
    tr.append(mido.MetaMessage("track_name", name=name, time=0))
    last = 0
    for tick, _, msg in sorted(events, key=lambda e: (e[0], e[1])):
        msg.time = max(0, tick - last)
        last = max(last, tick)
        tr.append(msg)
    tr.append(mido.MetaMessage("end_of_track", time=0))
    return tr


def _note(events, tick, note, vel=100, length=TPQ // 8, channel=0):
    import mido
    events.append((tick, 2, mido.Message("note_on", note=note, velocity=vel, channel=channel)))
    events.append((tick + max(1, length), 1, mido.Message("note_off", note=note, velocity=0, channel=channel)))


def drums_track(arr: dict, clock: BeatClock):
    import mido
    hits = drumchart.wire_to_hits(arr.get("notes", []) + [
        dict(cn, t=c["t"]) for c in arr.get("chords", []) for cn in c.get("notes", [])])
    meta = arr.get("drums") or {}
    ev = []
    dyn = any(h.dyn for h in hits)
    if dyn:
        ev.append((0, 0, mido.MetaMessage("text", text="[ENABLE_CHART_DYNAMICS]")))
    seen = set()
    for h in hits:
        tk = clock.tick(h.time)
        if h.pad == "kick":
            note = 95 if h.kick2x else 96
            vel = 100
        else:
            note = PAD_NOTE[h.pad]
            vel = 127 if h.dyn == "accent" else 1 if h.dyn == "ghost" else 100
        if (tk, note) in seen:
            continue
        seen.add((tk, note))
        _note(ev, tk, note, vel)
        if h.pad in TOM_MARKER and not h.cymbal:
            _note(ev, tk, TOM_MARKER[h.pad], 100, length=1 + 1)   # covers [tk, tk+1]
    for a, b in meta.get("star_power", []):
        ta, tb = clock.tick(a), clock.tick(b)
        _note(ev, ta, 116, 100, length=max(1, tb - ta))
    for a, b in meta.get("fills", []):
        ta, tb = clock.tick(a), clock.tick(b)
        for n in (120, 121, 122, 123, 124):
            _note(ev, ta, n, 100, length=max(1, tb - ta))
    for a, b in meta.get("solos", []):
        ta, tb = clock.tick(a), clock.tick(b)
        _note(ev, ta, 103, 100, length=max(1, tb - ta))
    return _msgs_track("PART DRUMS", ev), len(hits)


def _onsets(arr: dict, base, tuning, capo):
    """[(time, [pitches], [(string, fret, flags)], sustain)] per onset."""
    out = {}

    def pitch(s, f):
        return base[s] + (tuning[s] if s < len(tuning) else 0) + capo + f

    for n in arr.get("notes", []):
        if n.get("f", 0) < 0 or n.get("s", 0) > 5:
            continue
        e = out.setdefault(round(n["t"], 3), [[], [], 0.0])
        e[0].append(pitch(n["s"], n["f"]))
        e[1].append((n["s"], n["f"], n))
        e[2] = max(e[2], float(n.get("sus", 0) or 0))
    for c in arr.get("chords", []):
        for n in c.get("notes", []):
            if n.get("f", 0) < 0 or n.get("s", 0) > 5:
                continue
            e = out.setdefault(round(c["t"], 3), [[], [], 0.0])
            e[0].append(pitch(n["s"], n["f"]))
            e[1].append((n["s"], n["f"], n))
            e[2] = max(e[2], float(n.get("sus", 0) or 0))
    return sorted((t, p, sf, sus) for t, (p, sf, sus) in out.items())


def five_lane_track(name: str, arr: dict, clock: BeatClock, bass: bool):
    """5-fret reduction: rank each onset's pitch against its +-4 s neighbourhood."""
    tuning = list(arr.get("tuning") or [0] * 6)
    ons = _onsets(arr, BASS_BASE if bass else GUITAR_BASE, tuning, int(arr.get("capo", 0) or 0))
    if not ons:
        return None, 0
    times = np.array([o[0] for o in ons])
    reps = np.array([min(o[1]) if len(o[1]) > 1 else o[1][0] for o in ons], float)
    ev = []
    for i, (t, ps, _, sus) in enumerate(ons):
        lo, hi = np.searchsorted(times, t - 4.0), np.searchsorted(times, t + 4.0)
        win = np.unique(reps[lo:hi])
        if len(win) <= 1:
            lane = 2
        else:
            rank = np.searchsorted(win, reps[i]) / (len(win) - 1)
            lane = int(round(rank * 4))
        width = 1 if len(ps) == 1 else (2 if len(set(ps)) == 2 or len(ps) == 2 else 3)
        lane = min(lane, 5 - width)
        tk = clock.tick(t)
        length = clock.tick(t + sus) - tk if sus >= 0.3 else TPQ // 8
        for k in range(width):
            _note(ev, tk, 96 + lane + k, 100, length=max(1, length))
    return _msgs_track(name, ev), len(ons)


def pro_track(name: str, arr: dict, clock: BeatClock, strings: int):
    ev, n = [], 0
    for t, _, sf, sus in _onsets(arr, GUITAR_BASE, [0] * 6, 0):
        tk = clock.tick(t)
        length = clock.tick(t + sus) - tk if sus >= 0.3 else TPQ // 8
        for s, f, note in sf:
            if s >= strings or not 0 <= f <= 22:
                continue
            ch = 3 if note.get("mt") else 5 if note.get("hm") else 0
            _note(ev, tk, 96 + s, 100 + f, length=max(1, length), channel=ch)
            n += 1
    return (_msgs_track(name, ev), n) if n else (None, 0)


# ── driver ──────────────────────────────────────────────────────────────────

def _open(sloppak: Path) -> tuple[Path, Path | None]:
    if sloppak.is_dir():
        return sloppak, None
    tmp = Path(tempfile.mkdtemp(prefix="slop2ch_"))
    with zipfile.ZipFile(sloppak) as z:
        z.extractall(tmp)
    return tmp, tmp


def export(sloppak: Path, out_dir: Path, guitars=True, pro=True) -> dict:
    import mido
    import yaml
    src, tmp = _open(Path(sloppak))
    try:
        man = yaml.safe_load((src / "manifest.yaml").read_text(encoding="utf-8"))
        arrs = {}
        beats, sections = [], []
        for e in man.get("arrangements", []):
            d = json.loads((src / e["file"]).read_text(encoding="utf-8"))
            d["tuning"] = e.get("tuning", d.get("tuning"))
            d["capo"] = e.get("capo", d.get("capo", 0))
            arrs.setdefault(e["name"], d)
            if d.get("beats") and not beats:
                beats, sections = d["beats"], d.get("sections", [])
        first = min([float(n["t"]) for d in arrs.values() for n in d.get("notes", [])]
                    + [float(c["t"]) for d in arrs.values() for c in d.get("chords", [])], default=None)
        clock = BeatClock(beats, first)
        mid = mido.MidiFile(type=1, ticks_per_beat=TPQ)
        sync = [(t, 0, mido.MetaMessage("set_tempo", tempo=us)) for t, us in clock.tempo_events()]
        sync += [(t, 0, mido.MetaMessage("time_signature", numerator=n, denominator=4))
                 for t, n in clock.time_sigs()]
        mid.tracks.append(_msgs_track(man.get("title", "song"), sync))
        mid.tracks.append(_msgs_track("EVENTS", [
            (clock.tick(s["time"]), 0, mido.MetaMessage("text", text=f"[section {s['name']}]")) for s in sections]))
        summary = {"parts": {}}
        drums = next((d for n, d in arrs.items() if drumchart_is_drums(n)), None)
        if drums is not None:
            tr, n = drums_track(drums, clock)
            mid.tracks.append(tr)
            summary["parts"]["PART DRUMS"] = n
        if guitars:
            for arr_name, part, bass in (("Lead", "PART GUITAR", False), ("Rhythm", "PART RHYTHM", False),
                                         ("Bass", "PART BASS", True)):
                if arr_name in arrs:
                    tr, n = five_lane_track(part, arrs[arr_name], clock, bass)
                    if tr is not None:
                        mid.tracks.append(tr)
                        summary["parts"][part] = n
            if pro:
                for arr_name, part, strings in (("Lead", "PART REAL_GUITAR_22", 6), ("Bass", "PART REAL_BASS_22", 4)):
                    if arr_name in arrs:
                        tr, n = pro_track(part, arrs[arr_name], clock, strings)
                        if tr is not None:
                            mid.tracks.append(tr)
                            summary["parts"][part] = n
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        mid.save(str(out_dir / "notes.mid"))
        # audio
        stems = []
        groups: dict[str, list[Path]] = {}
        for s in man.get("stems", []):
            ch = STEM_TO_CH.get(s["id"])
            if ch and (src / s["file"]).exists():
                groups.setdefault(ch, []).append(src / s["file"])
        for ch, files in groups.items():
            dst = out_dir / f"{ch}.ogg"
            if len(files) == 1 and files[0].suffix.lower() == ".ogg":
                shutil.copy2(files[0], dst)
            else:
                import subprocess
                cmd = ["ffmpeg", "-v", "error", "-y"]
                for f in files:
                    cmd += ["-i", str(f)]
                if len(files) > 1:
                    cmd += ["-filter_complex", f"amix=inputs={len(files)}:duration=longest:normalize=0"]
                subprocess.run(cmd + ["-c:a", "libvorbis", "-q:a", "6", str(dst)], check=True)
            stems.append(ch)
        if man.get("cover") and (src / man["cover"]).exists():
            shutil.copy2(src / man["cover"], out_dir / "album.jpg")
        ini = {"name": man.get("title", ""), "artist": man.get("artist", ""), "album": man.get("album", ""),
               "year": man.get("year", "") or "", "charter": "Slopsmith export", "delay": int(round(clock.delay * 1000)),
               "song_length": int(round(float(man.get("duration", 0) or 0) * 1000)),
               "pro_drums": "True" if drums is not None else "False", "five_lane_drums": "False",
               "diff_drums": -1 if drums is not None else "", "diff_guitar": -1 if "PART GUITAR" in summary["parts"] else "",
               "diff_bass": -1 if "PART BASS" in summary["parts"] else ""}
        for arr_name, key, n in (("Lead", "real_guitar_tuning", 6), ("Bass", "real_bass_tuning", 4)):
            if arr_name in arrs and pro:
                ini[key] = " ".join(str(int(x)) for x in list(arrs[arr_name].get("tuning") or [0] * 6)[:n])
        (out_dir / "song.ini").write_text("[song]\n" + "".join(f"{k} = {v}\n" for k, v in ini.items() if v != ""),
                                          encoding="utf-8")
        summary.update(out=str(out_dir), stems=sorted(stems), tempo_events=len(clock.tempo_events()))
        return summary
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def drumchart_is_drums(name: str) -> bool:
    import re
    return bool(re.search(r"\b(?:drums?|percussion|drum\s*kit)\b", name or "", re.I))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sloppak")
    ap.add_argument("out_dir")
    ap.add_argument("--no-guitar", action="store_true", help="drums only (skip the guitar/bass parts)")
    ap.add_argument("--no-pro", action="store_true", help="skip PART REAL_GUITAR_22 / PART REAL_BASS_22")
    a = ap.parse_args()
    s = export(Path(a.sloppak), Path(a.out_dir), guitars=not a.no_guitar, pro=not a.no_pro)
    print(f"wrote {s['out']}: " + ", ".join(f"{k} {v}" for k, v in s["parts"].items())
          + f"; stems {', '.join(s['stems'])}")


if __name__ == "__main__":
    main()
