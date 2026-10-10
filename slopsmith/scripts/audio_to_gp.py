"""Transcribe a recording into a Guitar Pro tab (guitar + bass) when no tab exists.

    python scripts/audio_to_gp.py SONG.mp3 OUT.gp5 [--tuning -1] [--work DIR] [--title T --artist A]

The result is a starting point, not a hand-made tab: feed it to song_builder like any
other tab (it syncs, grades, adds drums and solos) and fix notes in feedBack Studio.

Steps
  1. Demucs htdemucs_6s on the recording (cached in --work): guitar and bass stems.
  2. beat_this beats + downbeats on the mix: one tab measure per recorded bar
     (beats per bar from the downbeats), so the later beat-DTW sync maps it back exactly.
  3. Basic Pitch on each stem. Guitar: notes struck together (within 45 ms) form a chord;
     harmonics more than two octaves above the chord's lowest note and notes quieter
     than a third of the chord's loudest are dropped; at most 4 notes per chord (power
     chords + octaves are what a distorted rhythm part mostly plays). Bass: monophonic,
     the lowest note wins.
  4. Onsets snap to a 16th-note grid of their own bar; a note lasts until the next
     onset or its detected end, whichever is first.
  5. Fingering: each event picks the string/fret positions (distinct strings, span <= 4
     frets, frets 0-17) that minimise fret height + span + the hand move from the last
     event.
Tuning: --tuning semitones from E standard for all strings (default: auto, E or Eb
from the lowest guitar and bass notes).
"""

import argparse
import itertools
import logging
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "lib"))
logging.disable(logging.WARNING)

GTR_OPEN = [64, 59, 55, 50, 45, 40]   # pyguitarpro string order: 1 = high e
BASS_OPEN = [43, 38, 33, 28]
SUB = 4                                # grid ticks per beat (16ths)
CHORD_WIN = 0.045
MAX_FRET = 17


def log(*a):
    print(*a, flush=True)


def stems(audio: Path, work: Path) -> dict:
    out = work / "htdemucs_6s" / audio.stem
    if not (out / "guitar.wav").exists():
        log("Demucs htdemucs_6s ...")
        subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs_6s", "-o", str(work), str(audio)], check=True)
    return {k: out / f"{k}.wav" for k in ("guitar", "bass")}


def notes(path: Path, lo_hz: float, hi_hz: float, min_len_ms: float):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    model = Path(ICASSP_2022_MODEL_PATH)
    onnx = model.parent / "nmp.onnx" if model.suffix != ".onnx" else model
    _, _, ev = predict(str(path), str(onnx), onset_threshold=0.5, frame_threshold=0.3,
                       minimum_note_length=min_len_ms, minimum_frequency=lo_hz, maximum_frequency=hi_hz)
    return sorted((float(s), float(e), int(p), float(a)) for s, e, p, a, *_ in ev)


def group(ev, poly: bool):
    """[(t, end, [pitches])] from (start, end, pitch, amp) notes."""
    out, i = [], 0
    while i < len(ev):
        j = i
        while j + 1 < len(ev) and ev[j + 1][0] - ev[i][0] <= CHORD_WIN:
            j += 1
        g = ev[i:j + 1]
        i = j + 1
        if not poly:
            n = min(g, key=lambda x: x[2])
            out.append((n[0], n[1], [n[2]]))
            continue
        amax = max(x[3] for x in g)
        g = [x for x in g if x[3] >= amax / 3]
        low = min(x[2] for x in g)
        ps = sorted({x[2] for x in g if x[2] - low <= 24})
        if len(ps) > 4:   # keep the lowest note and the loudest of the rest
            amp = {x[2]: x[3] for x in g}
            ps = sorted([ps[0]] + sorted(ps[1:], key=lambda p: -amp.get(p, 0))[:3])
        out.append((g[0][0], max(x[1] for x in g), ps))
    return out


def bars_from_beats(beats, downs):
    """[(beat times of the bar)], with a pickup bar before the first downbeat."""
    beats = list(beats)
    idx = [int(np.argmin(np.abs(np.asarray(beats) - d))) for d in downs]
    idx = sorted(set(idx))
    bars = [beats[a:b] for a, b in zip(idx, idx[1:])]
    if idx and len(beats) - idx[-1] >= 2:
        bars.append(beats[idx[-1]:])
    if idx and idx[0] > 0:
        n = len(bars[0]) if bars else 4
        step = float(np.median(np.diff(beats[:idx[0] + 2]))) if idx[0] >= 1 else 0.5
        first = beats[idx[0]]
        bars.insert(0, [first - step * (n - k) for k in range(n)])
    return [b for b in bars if 2 <= len(b) <= 7]


def place(events, bars):
    """{bar index: [(tick, ticks, pitches)]} on a 16th grid of each bar."""
    out = {}
    starts = [b[0] for b in bars]
    for k, (t, e, ps) in enumerate(events):
        bi = int(np.searchsorted(starts, t + 1e-6)) - 1
        if bi < 0 or bi >= len(bars):
            continue
        b = bars[bi]
        nb = len(b)
        step = (b[1] - b[0]) if nb > 1 else 0.5
        grid = []
        for i in range(nb):
            a = b[i]
            z = b[i + 1] if i + 1 < nb else a + step
            grid += [a + (z - a) * q / SUB for q in range(SUB)]
        grid.append(b[-1] + step)
        tick = int(np.argmin(np.abs(np.asarray(grid) - t)))
        if tick >= nb * SUB:
            continue
        end_t = min(e, events[k + 1][0]) if k + 1 < len(events) else e
        end_tick = int(np.argmin(np.abs(np.asarray(grid) - end_t)))
        out.setdefault(bi, {})[tick] = (max(1, end_tick - tick), ps)
    res = {}
    for bi, d in out.items():
        ticks = sorted(d)
        lst = []
        for i, tk in enumerate(ticks):
            n, ps = d[tk]
            nxt = ticks[i + 1] if i + 1 < len(ticks) else len(bars[bi]) * SUB
            lst.append((tk, max(1, min(n, nxt - tk)), ps))
        res[bi] = lst
    return res


def fingering(pitches, opens, prev_pos):
    cands = []
    for p in pitches:
        c = [(s, p - o) for s, o in enumerate(opens) if 0 <= p - o <= MAX_FRET]
        if not c:
            return None, prev_pos
        cands.append(c)
    best, best_cost = None, 1e9
    for combo in itertools.product(*cands):
        strings = [s for s, _ in combo]
        if len(set(strings)) != len(strings):
            continue
        fretted = [f for _, f in combo if f > 0]
        span = (max(fretted) - min(fretted)) if fretted else 0
        if span > 4:
            continue
        pos = min(fretted) if fretted else prev_pos
        cost = span + 0.15 * (sum(fretted) / max(1, len(fretted))) + 0.5 * abs(pos - prev_pos)
        if cost < best_cost:
            best, best_cost = combo, cost
    if best is None:   # drop notes until it fits
        return fingering(pitches[:-1], opens, prev_pos) if len(pitches) > 1 else (None, prev_pos)
    fretted = [f for _, f in best if f > 0]
    return best, (min(fretted) if fretted else prev_pos)


def durations(ticks):
    """Split a tick count (16ths) into GP durations: [(value, dotted)]."""
    table = [(16, 1, False), (12, 2, True), (8, 2, False), (6, 4, True), (4, 4, False), (3, 8, True), (2, 8, False), (1, 16, False)]
    out = []
    while ticks > 0:
        for n, v, dot in table:
            if n <= ticks:
                out.append((v, dot))
                ticks -= n
                break
    return out


def write_gp(path, bars, tracks, tempo, title, artist, tuning):
    import guitarpro as gp
    song = gp.Song()
    song.title, song.artist, song.tempo = title, artist, int(round(tempo))
    song.tracks = []
    song.measureHeaders = []
    for i, b in enumerate(bars):
        mh = gp.MeasureHeader()
        mh.number = i + 1
        mh.start = gp.Duration.quarterTime * (1 + sum(len(x) for x in bars[:i]))
        mh.timeSignature.numerator = len(b)
        mh.timeSignature.denominator = gp.Duration(4)
        song.measureHeaders.append(mh)
    for ti, (name, opens, placed, is_bass) in enumerate(tracks):
        tr = gp.Track(song)
        tr.number, tr.name = ti + 1, name
        tr.strings = [gp.GuitarString(k + 1, o + tuning) for k, o in enumerate(opens)]
        tr.channel.instrument = 33 if is_bass else 30
        tr.channel.channel, tr.channel.effectChannel = ti * 2, ti * 2 + 1
        tr.measures = []
        prev = 3
        for bi, mh in enumerate(song.measureHeaders):
            m = gp.Measure(tr, mh)
            voice = m.voices[0]
            voice.beats = []
            nb = len(bars[bi]) * SUB
            ev = placed.get(bi, [])
            cur = 0

            def rest(n):
                for v, dot in durations(n):
                    bt = gp.Beat(voice)
                    bt.duration = gp.Duration(v, dot)
                    bt.status = gp.BeatStatus.rest
                    voice.beats.append(bt)

            for tk, n, ps in ev:
                if tk > cur:
                    rest(tk - cur)
                combo, prev = fingering([p - tuning for p in ps], opens, prev)
                parts = durations(n)
                for pi, (v, dot) in enumerate(parts):
                    bt = gp.Beat(voice)
                    bt.duration = gp.Duration(v, dot)
                    if combo:
                        bt.status = gp.BeatStatus.normal
                        for s, f in combo:
                            nt = gp.Note(bt)
                            nt.string, nt.value = s + 1, f
                            nt.type = gp.NoteType.tie if pi > 0 else gp.NoteType.normal
                            bt.notes.append(nt)
                    else:
                        bt.status = gp.BeatStatus.rest
                    voice.beats.append(bt)
                cur = tk + n
            if cur < nb:
                rest(nb - cur)
            tr.measures.append(m)
        song.tracks.append(tr)
    gp.write(song, str(path), version=(5, 1, 0))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--tuning", type=int, default=None, help="semitones from E standard (default: auto E / Eb)")
    ap.add_argument("--work", type=Path, default=None)
    ap.add_argument("--title", default=None)
    ap.add_argument("--artist", default="")
    a = ap.parse_args()
    work = a.work or (HERE.parent / "_build" / "transcribe" / a.audio.stem)
    work.mkdir(parents=True, exist_ok=True)
    st = stems(a.audio, work)
    from gp_to_sloppak import detect_beats
    log("beats (beat_this) ...")
    beats, downs = detect_beats(a.audio)
    bars = bars_from_beats(beats, downs)
    tempo = 60 / float(np.median(np.diff(beats)))
    log(f"  {len(beats)} beats, {len(bars)} bars, ~{tempo:.0f} bpm")
    log("notes (Basic Pitch) ...")
    gtr = notes(st["guitar"], 75, 1400, 80)
    bass = notes(st["bass"], 35, 400, 90)
    log(f"  guitar {len(gtr)} notes, bass {len(bass)} notes")
    tuning = a.tuning
    if tuning is None:
        low = [p for _, _, p, _ in gtr if p < 45] + [p - 0 for _, _, p, _ in bass if p < 32]
        eb = sum(1 for p in low if p in (39, 27, 26)) if low else 0
        e = sum(1 for p in low if p in (40, 28))
        tuning = -1 if eb >= e else 0
        log(f"  tuning: {'Eb' if tuning == -1 else 'E'} standard (lowest notes: Eb {eb}, E {e})")
    g_ev = group(gtr, poly=True)
    b_ev = group(bass, poly=False)
    tracks = [("Guitar (transcribed)", GTR_OPEN, place(g_ev, bars), False),
              ("Bass (transcribed)", BASS_OPEN, place(b_ev, bars), True)]
    write_gp(a.out, bars, tracks, tempo, a.title or a.audio.stem, a.artist, tuning)
    log(f"wrote {a.out}: {len(bars)} measures, {sum(len(v) for v in tracks[0][2].values())} guitar events, "
        f"{sum(len(v) for v in tracks[1][2].values())} bass events")


if __name__ == "__main__":
    main()
