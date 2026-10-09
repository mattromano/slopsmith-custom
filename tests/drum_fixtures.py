"""Synthetic YARG/Clone Hero charts and audio for the drums tests."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

TPQ = 480


def write_mid(path: Path, notes, *, tempos=((0, 120.0),), sigs=((0, 4, 4),), texts=(), sections=(),
              tpq: int = TPQ, track_name: str = "PART DRUMS"):
    """notes: (tick, midi_note, velocity, length_ticks); texts: (tick, text) in the drum track;
    sections: (tick, name) -> EVENTS "[section name]"."""
    import mido
    mid = mido.MidiFile(type=1, ticks_per_beat=tpq)

    def track(name, events):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        last = 0
        for tick, order, msg in sorted(events, key=lambda e: (e[0], e[1])):
            msg.time = tick - last
            last = tick
            tr.append(msg)
        tr.append(mido.MetaMessage("end_of_track", time=0))
        mid.tracks.append(tr)

    sync = [(t, 0, mido.MetaMessage("set_tempo", tempo=int(round(60_000_000 / bpm)))) for t, bpm in tempos]
    sync += [(t, 0, mido.MetaMessage("time_signature", numerator=n, denominator=d)) for t, n, d in sigs]
    track("sync", sync)
    track("EVENTS", [(t, 0, mido.MetaMessage("text", text=f"[section {n}]")) for t, n in sections])
    ev = [(t, 0, mido.MetaMessage("text", text=x)) for t, x in texts]
    for tick, note, vel, length in notes:
        ev.append((tick, 2, mido.Message("note_on", note=note, velocity=vel, channel=0)))
        ev.append((tick + max(1, length), 1, mido.Message("note_off", note=note, velocity=0, channel=0)))
    track(track_name, ev)
    mid.save(str(path))
    return path


def write_chart(path: Path, lines, *, resolution=192, tempos=((0, 120.0),), sigs=((0, 4),), offset=None,
                events=(), name="Song", artist="Band", phrases=()):
    """lines: (tick, 'N'|'S'|'E', a, b) entries for [ExpertDrums]."""
    song = [f'  Name = "{name}"', f'  Artist = "{artist}"', f"  Resolution = {resolution}"]
    if offset is not None:
        song.append(f"  Offset = {offset}")
    sync = [f"  {t} = TS {n}" for t, n in sigs] + [f"  {t} = B {int(round(b * 1000))}" for t, b in tempos]
    sync.sort(key=lambda s: int(s.split("=")[0]))
    ev = [f'  {t} = E "section {n}"' for t, n in events]
    drums = []
    for item in sorted(lines, key=lambda x: (x[0], x[1])):
        t, kind = item[0], item[1]
        if kind in ("N", "S"):
            drums.append(f"  {t} = {kind} {item[2]} {item[3]}")
        else:
            drums.append(f'  {t} = E {item[2]}')
    body = ["[Song]", "{", *song, "}", "[SyncTrack]", "{", *sync, "}", "[Events]", "{", *ev, "}",
            "[ExpertDrums]", "{", *drums, "}"]
    Path(path).write_text("\n".join(body) + "\n", encoding="utf-8")
    return path


def write_ini(path: Path, **kv):
    Path(path).write_text("[song]\n" + "".join(f"{k} = {v}\n" for k, v in kv.items()), encoding="utf-8")
    return path


SR = 22050


def click_track(times, dur, sr=SR, freq=None, seed=0, noise=0.0, decay=0.03):
    """Mono float32 signal with a short percussive burst at every time (seconds)."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(dur * sr), dtype=np.float32)
    n = int(decay * 6 * sr)
    env = np.exp(-np.arange(n) / (decay * sr)).astype(np.float32)
    for i, t in enumerate(times):
        a = int(round(t * sr))
        if a < 0 or a >= len(y):
            continue
        if freq is None:
            burst = rng.standard_normal(n).astype(np.float32) * env
        else:
            f = freq[i % len(freq)] if isinstance(freq, (list, tuple)) else freq
            burst = np.sin(2 * np.pi * f * np.arange(n) / sr).astype(np.float32) * env
        b = min(len(y), a + n)
        y[a:b] += 0.6 * burst[:b - a]
    if noise:
        y += noise * rng.standard_normal(len(y)).astype(np.float32)
    return y


def drum_audio(hits, dur, sr=SR, seed=0, noise=0.0):
    """Rough synthetic drum kit: hits = (time, pad, cymbal[, velocity]).  Kick = pitched
    thump, snare = noise + tone, toms = pitched, cymbals/hats = bright noise."""
    from scipy.signal import butter, lfilter
    rng = np.random.default_rng(seed)
    y = np.zeros(int(dur * sr), dtype=np.float32)
    hp = butter(2, 5000 / (sr / 2), "high")
    bp = butter(2, [300 / (sr / 2), 4000 / (sr / 2)], "band")
    tom_f = {"yellow": 200, "blue": 150, "green": 100}
    for h in hits:
        t, pad, cym = h[:3]
        vel = h[3] if len(h) > 3 else 0.7 + 0.3 * rng.random()
        a = int(round(t * sr))
        if not 0 <= a < len(y):
            continue
        if pad == "kick":
            n = int(0.25 * sr)
            x = np.arange(n) / sr
            s = np.sin(2 * np.pi * (55 * x + 60 * (1 - np.exp(-x * 40)) / 40)) * np.exp(-x * 18)
        elif pad == "red":
            n = int(0.2 * sr)
            x = np.arange(n) / sr
            s = 0.6 * lfilter(*bp, rng.standard_normal(n)) * np.exp(-x * 25) + 0.4 * np.sin(2 * np.pi * 190 * x) * np.exp(-x * 30)
        elif cym:
            n = int((0.6 if pad == "green" else 0.12) * sr)
            x = np.arange(n) / sr
            s = 0.5 * lfilter(*hp, rng.standard_normal(n)) * np.exp(-x * (6 if pad == "green" else 35))
        else:
            n = int(0.3 * sr)
            x = np.arange(n) / sr
            s = np.sin(2 * np.pi * tom_f.get(pad, 150) * x) * np.exp(-x * 12)
        b = min(len(y), a + n)
        y[a:b] += 0.5 * vel * s[:b - a].astype(np.float32)
    if noise:
        y += noise * rng.standard_normal(len(y)).astype(np.float32)
    return y


def write_audio(path: Path, y, sr=SR):
    """Write float audio as OGG (via ffmpeg) or WAV depending on suffix."""
    import soundfile as sf
    path = Path(path)
    if path.suffix.lower() == ".wav":
        sf.write(str(path), y, sr)
        return path
    tmp = path.with_suffix(".tmp.wav")
    sf.write(str(tmp), y, sr)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-c:a", "libvorbis", "-q:a", "5", str(path)],
                   check=True)
    tmp.unlink()
    return path


def drum_pattern(n_measures, seed=0, tpq=TPQ):
    """Pseudo-random but musical pro-drums groove (MIDI note, tick) - aperiodic enough for xcorr."""
    rng = np.random.default_rng(seed)
    notes = []
    e = tpq // 2
    for m in range(n_measures):
        for slot in range(8):
            t = (m * 8 + slot) * e
            if slot % 4 == 0 and rng.random() < 0.9 or rng.random() < 0.15:
                notes.append((t, 96, 100, 10))                      # kick
            if slot in (2, 6) and rng.random() < 0.95:
                notes.append((t, 97, 100, 10))                      # snare
            if rng.random() < 0.6:
                notes.append((t, 98, 100, 10))                      # hat (cymbal)
            if slot == 0 and m % 4 == 0:
                notes.append((t, 100, 100, 10))                     # crash
            if rng.random() < 0.06:
                notes.append((t, 99, 100, 10))
                notes.append((t, 111, 100, 10))                     # blue tom
    return notes


def make_gp5(path, n_measures, drum_slots):
    """Two-track GP5 (guitar + percussion) at 120 BPM, 8 eighth-note beats per bar.
    drum_slots(measure, slot) -> list of GM drum numbers."""
    import guitarpro as gp
    from guitarpro import models as M
    s = gp.Song()
    s.measureHeaders = []
    gtr = s.tracks[0]
    gtr.measures = []
    drm = M.Track(s, number=2, name="Drums", isPercussionTrack=True, measures=[])
    drm.strings = [M.GuitarString(i + 1, 0) for i in range(6)]
    s.tracks.append(drm)
    for m in range(n_measures):
        h = M.MeasureHeader(number=m + 1, start=960 + m * 3840)
        s.measureHeaders.append(h)
        for tr in (gtr, drm):
            meas = M.Measure(tr, h, voices=[])
            v = M.Voice(meas, beats=[])
            meas.voices = [v, M.Voice(meas, beats=[])]
            for slot in range(8):
                b = M.Beat(v, notes=[], duration=M.Duration(value=8), status=M.BeatStatus.normal)
                mids = ([3] if slot == 0 else []) if tr is gtr else drum_slots(m, slot)
                for i, mi in enumerate(mids):
                    b.notes.append(M.Note(b, value=mi, string=6 if tr is gtr else i + 1, type=M.NoteType.normal))
                if not mids:
                    b.status = M.BeatStatus.rest
                v.beats.append(b)
            tr.measures.append(meas)
    gp.write(s, str(path))
    return path


def make_sloppak(path, stems: dict, *, beats=None, x_build=None, x_sync=None, extra_arrangements=(),
                 title="Song", artist="Band", zip_form=True):
    """Minimal song-builder-style sloppak: a Lead arrangement (+beats), the given stems
    ({id: float audio}), optional x_build/x_sync."""
    import json
    import shutil
    import tempfile
    import zipfile
    import yaml
    work = Path(tempfile.mkdtemp(prefix="fixture_slop_"))
    (work / "arrangements").mkdir()
    (work / "stems").mkdir()
    lead = {"name": "Lead", "tuning": [0] * 6, "capo": 0,
            "notes": [{"t": 1.0, "s": 0, "f": 3, "sus": 0}], "chords": [], "anchors": [], "handshapes": [],
            "templates": [], "beats": beats or [], "sections": []}
    (work / "arrangements" / "lead.json").write_text(json.dumps(lead))
    arrs = [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json", "tuning": [0] * 6, "capo": 0}]
    for e, data in extra_arrangements:
        (work / e["file"]).write_text(json.dumps(data))
        arrs.append(e)
    st = []
    dur = 0
    for sid, y in stems.items():
        write_audio(work / "stems" / f"{sid}.ogg", y)
        st.append({"id": sid, "file": f"stems/{sid}.ogg", "default": True})
        dur = max(dur, len(y) / SR)
    man = {"title": title, "artist": artist, "album": "", "year": 0, "duration": round(dur, 3),
           "stems": st, "arrangements": arrs}
    if x_build:
        man["x_build"] = x_build
    if x_sync:
        (work / "x_sync.json").write_text(json.dumps(x_sync))
    (work / "manifest.yaml").write_text(yaml.safe_dump(man, sort_keys=False))
    path = Path(path)
    if zip_form:
        with zipfile.ZipFile(path, "w") as z:
            for f in sorted(work.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(work).as_posix())
        shutil.rmtree(work)
    else:
        shutil.move(str(work), str(path))
    return path
