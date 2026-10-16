"""Beam-search beat alignment against a recording's onset envelope.

Ported from RockForge (src/rockforge/infrastructure/_librosa_runner.py,
``align_beats`` / ``_normalized``), https://github.com/F100Pilot/RockForge.
The algorithm and constants are unchanged; ``refine_map`` / ``onset_envelope``
adapt it to the song builder's tab-beat -> audio-beat maps.

    MIT License
    Copyright (c) 2026 F100Pilot and the RockForge contributors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

What it does: the chart already knows how many beats there are and where each
note falls inside its beat; it only lacks WHEN each beat lands once the band's
tempo wanders. Keeping the chart's beats in order, a beam search moves each
beat so the notes land on attacks in the recording, with a tempo that changes
slowly. It REFINES a map that is already roughly right (first beat within
+/-0.25 s, each beat 0.8-1.25x its current length); it does not find one from
scratch.
"""
from __future__ import annotations

import bisect
import math

ALIGN_HOP_S = 0.01           # the onset envelope's frame, in seconds
ALIGN_RATIO = (0.80, 1.25)   # a beat may last this much less/more than shown now
ALIGN_SMOOTH = 0.03          # a 3 % tempo change from one beat to the next costs
                             # as much as one note landing on a full attack
ALIGN_BEAM = 48              # states kept per beat
ALIGN_START_S = 0.25         # the first beat is searched this far around where it shows
ALIGN_GAP_BEATS = 4          # beats without a note before one that is flagged to check
ALIGN_BEAT_WEIGHT = 0.35     # an attack on a beat with no note of the chart still counts a little


def _normalized(env: list[float]) -> list[float]:
    """The envelope scaled by its 95th percentile (one loud hit cannot flatten
    the rest), capped, then widened by one frame each side so an attack a frame
    off still counts."""
    if not env:
        return []
    ranked = sorted(env)
    ref = ranked[int(0.95 * (len(ranked) - 1))] or max(ranked) or 1.0
    e = [min(v / ref, 1.5) for v in env]
    return [max(e[max(0, i - 1):i + 2]) for i in range(len(e))]


def align_beats(env, hop, beats, notes, *, beam=ALIGN_BEAM, start_window=ALIGN_START_S):
    """Move each chart beat (``beats``, seconds of the recording as the chart
    shows them now, ascending) to where the recording plays it, given the
    recording's onset envelope ``env`` (one value per ``hop`` seconds) and the
    chart's note onsets ``notes`` (same clock). Returns the new beat times,
    each beat's ``support`` (how strongly the notes after it land on attacks,
    0..1.5, None for a beat with no note) and the mean note evidence before
    and after, so the caller can say when nothing improved."""
    beats = [float(b) for b in beats]
    notes = [float(t) for t in notes]
    n = len(beats)
    if n < 2:
        raise ValueError("need at least two beats to align")
    e = _normalized([float(v) for v in env])

    def ev(t):
        i = int(round(t / hop))
        return e[i] if 0 <= i < len(e) else 0.0

    # Each note as (beat, fraction of the way to the next beat); one on a beat
    # counts for that beat.
    seg = [[] for _ in range(n - 1)]
    on_beat = [0] * n
    for t in notes:
        k = bisect.bisect_right(beats, t) - 1
        if k < 0 or k >= n - 1:
            if k == n - 1 and abs(t - beats[-1]) < 0.02:
                on_beat[-1] += 1
            continue
        frac = (t - beats[k]) / (beats[k + 1] - beats[k])
        if frac < 0.02:
            on_beat[k] += 1
        elif frac > 0.98:
            on_beat[k + 1] += 1
        else:
            seg[k].append(frac)

    def beat_gain(i, t):
        return ev(t) * (on_beat[i] + ALIGN_BEAT_WEIGHT)

    # A state: (score, time of this beat, stretch of the segment that led here,
    # index of the parent state in the previous beat's list).
    frames0 = range(
        max(0, math.ceil((beats[0] - start_window) / hop)),
        math.floor((beats[0] + start_window) / hop) + 1,
    )
    states = [
        (beat_gain(0, f * hop) - ((f * hop - beats[0]) / start_window) ** 2, f * hop, 1.0, -1)
        for f in frames0
    ] or [(0.0, beats[0], 1.0, -1)]
    states.sort(key=lambda s: -s[0])
    states = states[:beam]
    history = [states]
    lo_r, hi_r = ALIGN_RATIO
    for i in range(n - 1):
        # song builder change: a zero / negative step (stacked beats) would divide by zero
        d = max(beats[i + 1] - beats[i], hop)
        fracs = seg[i]
        best = {}
        for p, (score, t, s, _) in enumerate(states):
            f_lo = math.ceil((t + d * lo_r) / hop)
            f_hi = math.floor((t + d * hi_r) / hop)
            if f_hi < f_lo:
                # song builder change: a beat too short for the ratio window to hold a
                # frame keeps its length (one frame on at least) instead of emptying the beam
                f_lo = f_hi = max(round((t + d) / hop), round(t / hop) + 1)
            for f in range(f_lo, f_hi + 1):
                t2 = f * hop
                r = (t2 - t) / d
                sc = score + beat_gain(i + 1, t2) - (math.log(r / s) / ALIGN_SMOOTH) ** 2
                for frac in fracs:
                    sc += ev(t + frac * (t2 - t))
                key = (f, round(math.log(r) / 0.01))
                old = best.get(key)
                if old is None or sc > old[0]:
                    best[key] = (sc, t2, r, p)
        states = sorted(best.values(), key=lambda s: -s[0])[:beam]
        history.append(states)

    times = [0.0] * n
    k = 0
    for i in range(n - 1, -1, -1):
        st = history[i][k]
        times[i] = st[1]
        k = st[3]

    def note_times(bt):
        out = [(i, bt[i]) for i in range(n) for _ in range(on_beat[i])]
        for i, fr in enumerate(seg):
            out += [(i, bt[i] + x * (bt[i + 1] - bt[i])) for x in fr]
        return out

    after = note_times(times)
    support = [None] * n
    per = [[] for _ in range(n)]
    for i, t in after:
        per[i].append(ev(t))
    for i, vals in enumerate(per):
        if vals:
            support[i] = round(sum(vals) / len(vals), 3)
    # Where the recording was silent for the chart (a bar of rests or more),
    # nothing held the tempo, and the first beat with notes again can lock a
    # whole subdivision off while looking perfectly supported. Those beats are
    # named for the user to check by ear.
    after_gap = []
    last = -1
    for i in range(n):
        if per[i]:
            if last >= 0 and i - last >= ALIGN_GAP_BEATS:
                after_gap.append(i)
            last = i
    before = note_times(list(beats))
    ratios = [(times[i + 1] - times[i]) / (beats[i + 1] - beats[i]) for i in range(n - 1)]
    return {
        "times": [round(t, 4) for t in times],
        "support": support,
        "after_gap": after_gap,
        "evidence_before": round(sum(ev(t) for _, t in before) / max(1, len(before)), 3),
        "evidence_after": round(sum(ev(t) for _, t in after) / max(1, len(after)), 3),
        "ratio_min": round(min(ratios), 3),
        "ratio_max": round(max(ratios), 3),
    }


# ── song builder adapters (not from RockForge) ──────────────────────────────

MIN_GAP_S = 0.03   # smallest seed beat length refine_map passes on (0.8-1.25x window >= 1 frame)
MAX_MOVE_MS = 100  # median beat move above which a refinement is rejected


def keep_refinement(score, new_score, bars, new_bars, moved_ms):
    """Whether gp_to_sloppak --beam keeps a refined map.

    Measured on 60 song-builder sloppaks (scripts/sync_compare.py, 2026-10-16): every
    refinement that moved beats a median 300+ ms had locked onto the wrong beat (Basic
    Pitch hit rate -5 to -14 pt); below 100 ms, 33 songs gained and 6 lost (mean +0.7 pt).
    So: a small move, a better onset score, and bars on downbeats down 5 pt at most."""
    return moved_ms < MAX_MOVE_MS and new_score > score and new_bars >= bars - 0.05

def onset_envelope(y, sr, hop=ALIGN_HOP_S):
    """The recording's onset strength (librosa), one value per ``hop`` seconds."""
    import librosa
    import numpy as np

    hop_len = max(1, int(round(hop * sr)))
    env = librosa.onset.onset_strength(y=np.asarray(y, dtype=float), sr=sr, hop_length=hop_len)
    return [float(v) for v in env], hop_len / sr


def refine_map(env, hop, tab_beats, audio_beats, notes_tab, **kw):
    """Refine a tab-beat -> audio-beat map with ``align_beats``.

    ``notes_tab`` are note onsets in tab time; they are placed in recording
    time through the current map (piecewise linear between beats) so each
    note keeps its position inside its beat. Returns (new audio beats as a
    numpy array, align_beats' report without the per-beat lists)."""
    import numpy as np

    tab_beats = np.asarray(tab_beats, dtype=float)
    audio_beats = np.asarray(audio_beats, dtype=float).copy()
    # beat-DTW can stack two tab beats on one audio time (a skip) or put them a few
    # ms apart; spread those to MIN_GAP_S so every beat has a ratio window to search
    for i in range(1, len(audio_beats)):
        audio_beats[i] = max(audio_beats[i], audio_beats[i - 1] + MIN_GAP_S)
    notes = np.interp(np.asarray(notes_tab, dtype=float), tab_beats, audio_beats)
    inside = (notes >= audio_beats[0]) & (notes <= audio_beats[-1] + 0.02)
    r = align_beats(env, hop, audio_beats.tolist(), sorted(notes[inside].tolist()), **kw)
    info = {k: v for k, v in r.items() if k not in ("times", "support")}
    info["after_gap"] = len(r["after_gap"])
    return np.array(r["times"], dtype=float), info
