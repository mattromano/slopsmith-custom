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
