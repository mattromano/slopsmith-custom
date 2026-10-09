"""Build a sloppak from a Guitar Pro file + a real recording, time-warped to fit.

The GP file's own tempo map rarely matches a real band's performance, so a
fixed offset drifts.  This script:

1. Converts each chosen GP track with lib/gp2rs (audio_offset=0, "tab time")
   and polishes it (RS-style sustains, hand shapes, repeat-chord flags).
2. Coarse DTW of the tab's chroma piano-roll against the recording's chroma,
   used only to estimate the local tempo ratio.
3. Detects beats + downbeats with beat_this (or reuses an existing chart's
   authored beat grid with --merge-into), builds a grid at tab-beat density,
   and aligns tab beats to it with beat-level DTW (chroma, energy, bar starts).
4. Also fits a constant-tempo map (bands playing to a click) and keeps
   whichever scores better on onset agreement + measure starts on downbeats.
5. Warps every time/startTime/endTime (and sustain as a duration) in the
   arrangement XML, serializes to sloppak wire JSON, then splits stems.

Usage:
  python scripts/gp_to_sloppak.py TAB.gp5 SONG.mp3 OUT.sloppak \
      --tracks "1:Lead,2:Rhythm,3:Bass" --title T --artist A [--album X --year N]
      [--cover cover.jpg] [--fill-min-bars 2] [--report diag.json] [--no-stems]
      [--merge-into EXISTING.sloppak]   (audio "-" = use its full-mix stem)

Track specs like "1+4+2:Lead" fill runs of empty bars in track 1 from track 4,
then 2 (for tabs with extra guitar parts beyond one lead and one rhythm).

New sloppaks are split into guitar/bass/drums/vocals/piano/other stems with
Demucs (GPU if available) so the Stems mixer can mute instruments.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "lib"), str(ROOT)]

import guitarpro  # noqa: E402
import gp2rs  # noqa: E402
from song import parse_arrangement, arrangement_to_wire  # noqa: E402

SR = 22050
HOP = 2048  # ~93 ms frames for the DTW pass
GUITAR_BASE = [40, 45, 50, 55, 59, 64]
BASS_BASE = [28, 33, 38, 43, 47, 52]


def log(*a):
    print(*a, flush=True)


# ── tab side ────────────────────────────────────────────────────────────────

def _track_xml(song, idx, name):
    return gp2rs.convert_track(song, idx, 0.0, name)


def _measure_has_notes(measure):
    return any(b.notes for v in measure.voices for b in v.beats)


def fill_gaps(song, primary, fillers, min_bars=2):
    """Return a copy of `song` whose track `primary` has every run of >= min_bars
    empty measures filled from the first filler track with notes in that bar.
    Filler notes are re-fretted on the same string for the primary's tuning
    (dropped if out of range).  Returns (song_copy, filled_bar_count)."""
    import copy
    if not fillers:
        return song, 0
    s = copy.deepcopy(song)
    tgt = s.tracks[primary]
    tgt_tun = [st.value for st in tgt.strings]
    n = len(tgt.measures)
    empty = [not _measure_has_notes(m) for m in tgt.measures]
    filled = 0
    i = 0
    while i < n:
        if not empty[i]:
            i += 1
            continue
        j = i
        while j < n and empty[j]:
            j += 1
        if j - i >= min_bars:
            prev_src = None
            for k in range(i, j):
                src = next((f for f in fillers if k < len(s.tracks[f].measures)
                            and _measure_has_notes(s.tracks[f].measures[k])), None)
                if src is None:
                    prev_src = None
                    continue
                src_tun = [st.value for st in s.tracks[src].strings]
                dst_m = tgt.measures[k]
                src_m = song.tracks[src].measures[k]
                # memo the back-reference so deepcopy doesn't clone the whole song
                voices = copy.deepcopy(src_m.voices, {id(src_m): dst_m})
                for v in voices:
                    v.measure = dst_m
                    for b in v.beats:
                        b.voice = v
                        keep = []
                        for nt in b.notes:
                            nt.beat = b
                            si = nt.string - 1
                            if si >= len(tgt_tun) or si >= len(src_tun):
                                continue
                            fret = nt.value + src_tun[si] - tgt_tun[si]
                            if not 0 <= fret <= 24:
                                continue
                            nt.value = fret
                            # a tie can't continue a note from a different source
                            if src != prev_src and nt.type == guitarpro.NoteType.tie:
                                nt.type = guitarpro.NoteType.normal
                            keep.append(nt)
                        b.notes = keep
                    prev_src = src
                dst_m.voices = voices
                filled += 1
        i = j
    return s, filled


def _xml_notes(xml_str):
    """(time, sustain, midi) for every note incl. chord notes."""
    root = ET.fromstring(xml_str)
    tun = root.find("tuning")
    offs = [int(tun.get(f"string{i}", 0)) for i in range(6)]
    capo = int(root.findtext("capo") or 0)
    is_bass = (root.findtext("arrangement") or "").lower() == "bass"
    base = BASS_BASE if is_bass else GUITAR_BASE
    out = []
    for n in root.iter("note"):
        s, f = int(n.get("string")), int(n.get("fret"))
        if f < 0 or s > 5:
            continue
        out.append((float(n.get("time")), float(n.get("sustain", 0)),
                    base[s] + offs[s] + capo + f))
    for c in root.iter("chord"):
        t = float(c.get("time"))
        for cn in c.iter("chordNote"):
            s, f = int(cn.get("string")), int(cn.get("fret"))
            if f < 0 or s > 5:
                continue
            out.append((t, float(cn.get("sustain", 0)), base[s] + offs[s] + capo + f))
    return out


def tab_features(notes, n_frames):
    chroma = np.zeros((12, n_frames))
    onset = np.zeros(n_frames)
    fr = SR / HOP
    for t, sus, midi in notes:
        a = int(t * fr)
        if a >= n_frames:
            continue
        b = min(n_frames, a + max(1, int(max(sus, 0.25) * fr)))
        decay = np.linspace(1.0, 0.4, b - a)
        chroma[midi % 12, a:b] += decay
        onset[a] += 1
    return chroma, onset


# ── audio side ──────────────────────────────────────────────────────────────

def audio_features(y):
    import librosa
    yh = librosa.effects.harmonic(y, margin=3.0)
    chroma = librosa.feature.chroma_cqt(y=yh, sr=SR, hop_length=HOP)
    onset = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    return chroma, onset


def _norm_cols(m):
    m = m - m.mean(axis=1, keepdims=True) * 0  # keep absolute energy pattern
    n = np.linalg.norm(m, axis=0, keepdims=True)
    return m / np.maximum(n, 1e-6)


def _zs(v):
    return (v - v.mean()) / (v.std() + 1e-6)


def dtw_map(tab_chroma, tab_onset, aud_chroma, aud_onset):
    """Return (tab_times, audio_times) along the DTW path."""
    import librosa
    from scipy.ndimage import gaussian_filter1d
    tc = _norm_cols(gaussian_filter1d(tab_chroma, 1, axis=1))
    ac = _norm_cols(aud_chroma)
    to = _zs(gaussian_filter1d(tab_onset, 1))
    ao = _zs(gaussian_filter1d(aud_onset, 1))
    # chroma cosine distance + small onset term
    C = 1.0 - tc.T @ ac
    C += 0.08 * np.abs(to[:, None] - ao[None, :]) / 3.0
    D, wp = librosa.sequence.dtw(C=C, backtrack=True)
    wp = wp[::-1]
    fr = SR / HOP
    return wp[:, 0] / fr, wp[:, 1] / fr, C, wp


# ── warp construction ───────────────────────────────────────────────────────

def smooth_coarse(tab_beats, path_tab, path_aud, smooth=4):
    """DTW path -> per-beat audio times, smoothed with a sliding linear fit."""
    coarse = np.interp(tab_beats, path_tab, path_aud)
    if len(tab_beats) <= 2 * smooth + 2:
        return coarse
    k = 2 * smooth + 1
    pad_t = np.pad(tab_beats, smooth, mode="reflect", reflect_type="odd")
    pad_a = np.pad(coarse, smooth, mode="reflect", reflect_type="odd")
    out = np.empty_like(coarse)
    for i in range(len(coarse)):
        p = np.polyfit(pad_t[i:i + k], pad_a[i:i + k], 1)
        out[i] = np.polyval(p, tab_beats[i])
    return out


FINE_HOP = 256


def onset_env_fine(y):
    import librosa
    yp = librosa.effects.percussive(y, margin=2.0)
    env = librosa.onset.onset_strength(y=yp, sr=SR, hop_length=FINE_HOP)
    env = env / (np.percentile(env, 99) + 1e-9)
    return np.clip(env, 0, 1.5)


def _env_at(env, times):
    idx = np.round(np.asarray(times) * SR / FINE_HOP).astype(int)
    idx = idx[(idx >= 0) & (idx < len(env))]
    return env[idx]


def refine_with_onsets(tab_beats, coarse, tab_onsets, env, win=4, max_shift=0.15):
    """Per-beat time shift that best lines tab onsets up with audio onset peaks."""
    from scipy.ndimage import maximum_filter1d, median_filter
    # tolerate ~±12 ms of jitter when scoring
    envm = maximum_filter1d(env, size=3)
    warp0 = make_warp_fn(tab_beats, coarse)
    w_on = np.array([warp0(t) for t in tab_onsets])
    shifts = np.arange(-max_shift, max_shift + 1e-9, FINE_HOP / SR)
    best = np.zeros(len(tab_beats))
    conf = np.zeros(len(tab_beats))
    for i in range(len(tab_beats)):
        lo = tab_beats[max(0, i - win)]
        hi = tab_beats[min(len(tab_beats) - 1, i + win)]
        sel = w_on[(tab_onsets >= lo) & (tab_onsets <= hi)]
        if len(sel) < 3:
            continue
        sc = np.array([_env_at(envm, sel + s).mean() for s in shifts])
        # mild prior toward zero shift so flat regions don't wander
        sc = sc - 0.15 * np.abs(shifts) / max_shift * sc.std()
        j = int(sc.argmax())
        best[i] = shifts[j]
        conf[i] = (sc[j] - np.median(sc)) / (sc.std() + 1e-9)
    # low-confidence beats inherit neighbours; then median-smooth the shift curve
    good = conf > 1.0
    if good.sum() >= 2:
        idx = np.arange(len(best))
        best = np.interp(idx, idx[good], best[good])
    best = median_filter(best, size=5, mode="nearest")
    refined = coarse + best
    for i in range(1, len(refined)):
        if refined[i] <= refined[i - 1] + 0.05:
            refined[i] = refined[i - 1] + 0.05
    return refined, float(good.mean())


def alignment_score(env, times):
    """Mean onset strength at the given times vs. a random-time baseline."""
    from scipy.ndimage import maximum_filter1d
    envm = maximum_filter1d(env, size=3)
    hit = _env_at(envm, times).mean()
    rng = np.random.default_rng(0)
    base = _env_at(envm, rng.uniform(0, len(env) * FINE_HOP / SR, 5000)).mean()
    return float(hit / (base + 1e-9))


def make_warp_fn(tab_beats, aud_beats):
    tb, ab = np.asarray(tab_beats), np.asarray(aud_beats)

    def warp(t):
        t = float(t)
        if t <= tb[0]:
            r = (ab[1] - ab[0]) / (tb[1] - tb[0]) if len(tb) > 1 else 1.0
            return ab[0] + (t - tb[0]) * r
        if t >= tb[-1]:
            r = (ab[-1] - ab[-2]) / (tb[-1] - tb[-2]) if len(tb) > 1 else 1.0
            return ab[-1] + (t - tb[-1]) * r
        return float(np.interp(t, tb, ab))
    return warp


def warp_xml(xml_str, warp, song_len):
    root = ET.fromstring(xml_str)
    for el in root.iter():
        start = None
        for attr in ("time", "startTime"):
            v = el.get(attr)
            if v is not None:
                start = float(v)
                el.set(attr, f"{warp(start):.3f}")
        if el.get("endTime") is not None:
            el.set("endTime", f"{warp(float(el.get('endTime'))):.3f}")
        if start is not None and el.get("sustain") not in (None, "0", "0.000"):
            s = float(el.get("sustain"))
            el.set("sustain", f"{max(0.0, warp(start + s) - warp(start)):.3f}")
    off = root.find("offset")
    if off is not None:
        off.text = "0.000"
    sl = root.find("songLength")
    if sl is not None:
        sl.text = f"{song_len:.3f}"
    return ET.tostring(root, encoding="unicode")


# ── chart polish: sustains, hand shapes, repeat chords ──────────────────────

def polish_xml(xml_str, note_min_beats=0.9, chord_min_beats=1.5, gap_beats=0.15):
    """GP gives every note a duration; RS charts only sustain held notes.

    - single notes keep a sustain only when >= note_min_beats long (or they
      slide/bend, which needs a tail to render); chord notes only when
      >= chord_min_beats.  Palm-muted / muted notes never sustain.
    - kept sustains stop gap_beats short of the next onset.
    - runs of the same chord shape get one <handShape>, and repeats inside
      a run are flagged highDensity (RS "repeat" chord).
    Works in tab time, before warping.
    """
    root = ET.fromstring(xml_str)
    bt = np.array([float(e.get("time")) for e in root.find("ebeats")])
    bl_arr = np.diff(bt, append=bt[-1] + (bt[-1] - bt[-2]))

    def bl(t):
        i = max(0, min(len(bt) - 1, np.searchsorted(bt, t, side="right") - 1))
        return float(bl_arr[i])

    level = root.find("levels/level")
    notes = list(level.find("notes"))
    chords = list(level.find("chords"))
    onsets = np.array(sorted({float(n.get("time")) for n in notes}
                             | {float(c.get("time")) for c in chords}))

    def next_onset(t):
        i = np.searchsorted(onsets, t + 1e-4)
        return float(onsets[i]) if i < len(onsets) else float("inf")

    def fix(el, t, min_beats):
        sus = float(el.get("sustain", 0))
        if sus <= 0:
            return
        b = bl(t)
        moving = el.get("slideTo", "-1") != "-1" or el.get("slideUnpitchTo", "-1") != "-1"             or float(el.get("bend", 0) or 0) > 0
        muted = el.get("palmMute") == "1" or el.get("mute") == "1"
        if moving:
            keep = True
        else:
            keep = not muted and sus >= min_beats * b - 1e-3
        if not keep:
            el.set("sustain", "0.000")
            return
        new = min(sus, next_onset(t) - t) - gap_beats * b
        if moving:
            new = max(new, 0.25 * b)
        el.set("sustain", f"{max(0.0, new):.3f}")

    for n in notes:
        fix(n, float(n.get("time")), note_min_beats)
    for c in chords:
        t = float(c.get("time"))
        for cn in c.iter("chordNote"):
            fix(cn, t, chord_min_beats)

    # hand shapes over runs of the same chord; single notes break a run
    note_times = np.array(sorted(float(n.get("time")) for n in notes))
    runs = []
    for c in sorted(chords, key=lambda c: float(c.get("time"))):
        t, cid = float(c.get("time")), c.get("chordId")
        if runs:
            r = runs[-1]
            last_t = float(r[-1].get("time"))
            between = np.any((note_times > last_t + 1e-4) & (note_times < t - 1e-4))
            if r[0].get("chordId") == cid and t - last_t <= 1.1 * bl(last_t) + 1e-3 and not between:
                r.append(c)
                continue
        runs.append([c])
    hs_el = level.find("handShapes")
    for k in list(hs_el):
        hs_el.remove(k)
    for r in runs:
        for c in r[1:]:
            c.set("highDensity", "1")
        st = float(r[0].get("time"))
        lt = float(r[-1].get("time"))
        b = bl(lt)
        sus = max([float(cn.get("sustain", 0)) for cn in r[-1].iter("chordNote")] + [0.0])
        end = lt + max(sus, 0.5 * b)
        end = min(end, next_onset(lt) - 0.1 * b)
        end = max(end, lt + 0.1)
        ET.SubElement(hs_el, "handShape", chordId=r[0].get("chordId"),
                      startTime=f"{st:.3f}", endTime=f"{end:.3f}")
    hs_el.set("count", str(len(runs)))
    return ET.tostring(root, encoding="unicode")


# ── beat-level alignment (beat_this grid + DTW) ─────────────────────────────

def detect_beats(audio_path, refine=False):
    from beat_this.inference import File2Beats
    import torch
    f2b = File2Beats(checkpoint_path="final0", device="cuda" if torch.cuda.is_available() else "cpu",
                     dbn=False)
    beats, downs = f2b(str(audio_path))
    beats, downs = np.asarray(beats), np.asarray(downs)
    if refine:
        downs = refine_downbeats(audio_path, beats, downs)
    return beats, downs


def refine_downbeats(audio_path, beats, downs, tol=0.12):
    """Re-pick which beat_this beats are downbeats with livechord-beat-refiner.

    The refiner's own beat times are quantised to ~93 ms frames, so only its
    downbeat *choice* is used: each refined downbeat snaps to the nearest
    beat_this beat.  Falls back to beat_this downbeats if the refiner is
    missing or disagrees wildly (fewer than half of its downbeats land on a beat)."""
    try:
        from livechord_beat_refiner import refine
    except ImportError:
        log("  refiner not installed (run with _build/.mirvenv python); keeping beat_this downbeats")
        return downs
    r = refine(str(audio_path), beats.tolist(), downs.tolist())
    if not r.get("applied"):
        log(f"  refiner skipped: {r.get('reason')}")
        return downs
    rd = np.asarray(r["refined_downbeats"])
    if not len(rd) or not len(beats):
        return downs
    idx = np.clip(np.searchsorted(beats, rd), 1, len(beats) - 1)
    near = np.where(np.abs(beats[idx - 1] - rd) < np.abs(beats[idx] - rd), idx - 1, idx)
    ok = np.abs(beats[near] - rd) < tol
    if ok.mean() < 0.5:
        log(f"  refiner downbeats mostly off-beat ({ok.mean():.0%} snap); keeping beat_this")
        return downs
    new = np.unique(beats[near[ok]])
    same = np.isin(np.round(new, 3), np.round(downs, 3)).mean() if len(new) else 0
    log(f"  refiner: {len(new)} downbeats ({same:.0%} same as beat_this, was {len(downs)})")
    return new


def load_reuse(path, map_path=None):
    """Unpack an earlier build for --reuse: its stems/cover stay, its arrangements go, and
    its tab->audio beat map comes from x_sync.json inside it (or a build report)."""
    import yaml
    d = Path(tempfile.mkdtemp(prefix="gp2slop_reuse_"))
    with zipfile.ZipFile(path) as z:
        z.extractall(d)
    man = yaml.safe_load((d / "manifest.yaml").read_text(encoding="utf-8"))
    if (d / "x_sync.json").exists():
        sync = json.loads((d / "x_sync.json").read_text(encoding="utf-8"))
    elif map_path and Path(map_path).exists():
        rep = json.loads(Path(map_path).read_text(encoding="utf-8"))
        bm = np.array(rep["beat_map"], dtype=float)
        sync = {"tab_beats": bm[:, 0].tolist(), "audio_beats": bm[:, 1].tolist(),
                "report": {k: rep.get(k) for k in ("onset_score", "bar_hit", "method", "dtw", "linear_score")}}
    else:
        raise SystemExit(f"--reuse: {path} has no x_sync.json and no --reuse-map report was given")
    # Drums (scripts/drums_join.py) aren't rebuilt from the tab here: keep them as they are
    keep = [e for e in man.get("arrangements", []) if _is_drums_entry(e)]
    keep_files = {(d / e["file"]).resolve() for e in keep}
    for f in (d / "arrangements").glob("*"):
        if f.resolve() not in keep_files:
            f.unlink()
    return {"dir": d, "manifest": man, "tab_beats": np.array(sync["tab_beats"], dtype=float),
            "audio_beats": np.array(sync["audio_beats"], dtype=float), "report": sync.get("report") or {},
            "duration": float(man.get("duration") or 0), "keep_arrangements": keep}


def _is_drums_entry(e):
    import re
    return bool(re.search(r"\b(?:drums?|percussion)\b", f"{e.get('name', '')} {e.get('id', '')}", re.I))


def load_anchors(path):
    """Bar->time anchors from a feedBack Studio sync/syncpoints.json, or from a
    .feedpak/.sloppak that contains one.  Returns [(bar, time)] sorted by bar."""
    path = Path(path)
    if path.suffix.lower() in (".feedpak", ".sloppak", ".zip"):
        with zipfile.ZipFile(path) as z:
            name = next((n for n in z.namelist() if n.endswith("syncpoints.json")), None)
            if name is None:
                raise SystemExit(f"{path} has no sync/syncpoints.json (save it from feedBack Studio first)")
            pts = json.loads(z.read(name))
    else:
        pts = json.loads(path.read_text(encoding="utf-8"))
    return sorted((int(p["bar"]), float(p["time"])) for p in pts if int(p.get("beat", 1)) == 1)


def apply_anchors(amap, tab_is_bar, anchors):
    """Pin bar k of the tab (k-th measure start, 1-based - the same numbering
    feedBack Studio gives its sync points) to the anchor time, interpolating the
    correction across the beats in between.  Outside the anchored range the
    correction fades out over 4 bars."""
    bar_idx = np.where(tab_is_bar)[0]
    xs, ds = [], []
    for bar, t in anchors:
        if 1 <= bar <= len(bar_idx):
            i = bar_idx[bar - 1]
            xs.append(i)
            ds.append(t - amap[i])
    if not xs:
        return amap, 0, 0.0
    xs, ds = np.array(xs, float), np.array(ds)
    order = np.argsort(xs)
    xs, ds = xs[order], ds[order]
    fade = 4 * max(1, int(np.median(np.diff(bar_idx))) if len(bar_idx) > 1 else 4)
    if xs[0] > 0:
        xs, ds = np.r_[max(0, xs[0] - fade), xs], np.r_[0.0, ds]
    if xs[-1] < len(amap) - 1:
        xs, ds = np.r_[xs, min(len(amap) - 1, xs[-1] + fade)], np.r_[ds, 0.0]
    out = amap + np.interp(np.arange(len(amap)), xs, ds)
    out = np.maximum.accumulate(out + np.arange(len(out)) * 1e-6)  # keep the map increasing
    return out, len(order), float(np.max(np.abs(ds)))


def beat_grid(beats, downs, tab_beats, coarse):
    """Audio beat grid at tab-beat density.  Subdivides detected beats where the
    tracker counted in half time (period ≈ 2× the tab's local beat period) and
    thins them where it counted in double time.
    Returns (grid_times, is_bar_start)."""
    from scipy.ndimage import gaussian_filter1d
    # local audio-sec per tab-sec; heavily smoothed (the coarse DTW stalls and
    # jumps locally) and clamped — a band rarely strays >40% from the tab tempo
    slope = gaussian_filter1d(np.gradient(coarse) / np.gradient(tab_beats), 12, mode="nearest")
    slope = np.clip(slope, 0.7, 1.4)
    tab_per = np.diff(tab_beats, append=tab_beats[-1] + (tab_beats[-1] - tab_beats[-2])) * slope
    down_set = set(np.round(downs, 3))
    # Tracker in double (or quadruple) time vs. the tab: keep every k-th beat,
    # counted from the most recent downbeat.
    keep = []
    since = 0
    for i, b in enumerate(beats):
        if round(float(b), 3) in down_set:
            since = 0
        per = (beats[i + 1] - b) if i + 1 < len(beats) else (b - beats[i - 1])
        k = int(round(np.interp(b, coarse, tab_per) / max(per, 1e-3)))
        if k < 2 or since % k == 0:
            keep.append(i)
        since += 1
    beats = beats[keep]
    G, src = [beats[0]], [0]
    for i, (a, b) in enumerate(zip(beats[:-1], beats[1:])):
        k = max(1, int(round((b - a) / max(np.interp(a, coarse, tab_per), 1e-3))))
        for s in range(1, k):
            G.append(a + (b - a) * s / k)
            src.append(-1)
        G.append(b)
        src.append(i + 1)
    G = np.array(G)
    # bar phase: count grid steps since the last detected downbeat, mod 4
    is_bar = np.zeros(len(G), bool)
    since = None
    for j, s in enumerate(src):
        if s >= 0 and round(float(beats[s]), 3) in down_set:
            since = 0
        elif since is not None:
            since += 1
        is_bar[j] = since is not None and since % 4 == 0
    return G, is_bar


def _edges(t):
    return np.append(t, t[-1] + (t[-1] - t[-2]))


def beat_dtw(tab_beats, tab_is_bar, notes, drum_times, G, g_is_bar, y,
             w_energy=0.25, w_bar=0.35, w_skip=0.6):
    import librosa
    H = 512
    ach = librosa.feature.chroma_cqt(y=librosa.effects.harmonic(y, margin=3.0), sr=SR, hop_length=H)
    rms = librosa.feature.rms(y=y, hop_length=H)[0]
    ge = (_edges(G) * SR / H).astype(int)
    AC = np.zeros((12, len(G)))
    AE = np.zeros(len(G))
    for j in range(len(G)):
        a, b = ge[j], max(ge[j + 1], ge[j] + 1)
        AC[:, j] = ach[:, a:b].mean(1) if a < ach.shape[1] else 0
        AE[j] = rms[a:b].mean() if a < len(rms) else 0
    AE = np.log(AE + 1e-4)
    te = _edges(tab_beats)
    TC = np.zeros((12, len(tab_beats)))
    TD = np.zeros(len(tab_beats))
    for t, sus, m in notes:
        i = np.searchsorted(te, t, side="right") - 1
        j = np.searchsorted(te, t + max(sus, 0.1), side="left")
        TC[m % 12, max(i, 0):min(j, len(tab_beats))] += 1
        if 0 <= i < len(tab_beats):
            TD[i] += 0.5
    for t in drum_times:
        i = np.searchsorted(te, t, side="right") - 1
        if 0 <= i < len(tab_beats):
            TD[i] += 1

    def nc(M):
        return M / np.maximum(np.linalg.norm(M, axis=0, keepdims=True), 1e-6)
    C = 1.0 - nc(TC).T @ nc(AC)
    C += w_energy * np.abs(_zs(np.log1p(TD))[:, None] - _zs(AE)[None, :])
    C += w_bar * (tab_is_bar[:, None] != g_is_bar[None, :])
    _, wp = librosa.sequence.dtw(
        C=C, step_sizes_sigma=np.array([[1, 1], [1, 0], [0, 1]]),
        weights_add=np.array([0, w_skip, w_skip]), weights_mul=np.array([1, 1, 1]))
    wp = wp[::-1]
    amap = np.full(len(tab_beats), np.nan)
    for i, j in wp:
        if np.isnan(amap[i]):
            amap[i] = G[j]
    for i in range(1, len(amap)):
        if not np.isnan(amap[i]) and amap[i] <= np.nanmax(amap[:i]):
            amap[i] = np.nan
    ok = ~np.isnan(amap)
    amap = np.interp(np.arange(len(tab_beats)), np.where(ok)[0], amap[ok])
    skips = [(float(tab_beats[a[0]]), float(G[a[1]]), (b - a).tolist())
             for a, b in zip(wp[:-1], wp[1:]) if (b - a).tolist() != [1, 1]]
    return amap, skips


def linear_fit(env, onsets, tab_beats, tab_is_bar, downs, coarse, rate_span=0.03):
    """Best constant-tempo map audio = a + rate*tab (bands playing to a click).
    Onset-strength grid search, then pick the beat phase that puts measure
    starts on detected downbeats."""
    from scipy.ndimage import maximum_filter1d
    envm = maximum_filter1d(env, size=3)
    base = envm.mean()
    fr = SR / FINE_HOP

    def sc(a, rate):
        i = np.round((a + rate * onsets) * fr).astype(int)
        i = i[(i >= 0) & (i < len(envm))]
        return envm[i].mean() / base if len(i) else 0.0
    a0 = float(np.median(coarse - tab_beats))
    best = []
    for rate in np.arange(1 - rate_span, 1 + rate_span + 1e-9, 0.0005):
        for a in np.arange(a0 - 2.0, a0 + 2.0, 0.006):
            best.append((sc(a, rate), rate, a))
    best.sort(reverse=True)
    top = best[0][0]
    # distinct candidates within 5% of the best score; choose by downbeat hits
    cands = []
    for s, rate, a in best[:400]:
        if s < 0.95 * top:
            break
        if all(abs(a - c[2]) > 0.05 or abs(rate - c[1]) > 0.002 for c in cands):
            cands.append((s, rate, a))
    scored = []
    for s, rate, a in cands[:12]:
        amap = a + rate * tab_beats
        scored.append((bar_hit_rate(amap, tab_is_bar, downs), s, rate, a))
    scored.sort(reverse=True)
    bh, s, rate, a = scored[0]
    return a + rate * tab_beats, {"rate": float(rate), "offset": float(a), "score": float(s), "bar_hit": float(bh)}


def bar_hit_rate(amap, tab_is_bar, downs, tol=0.06):
    m = amap[tab_is_bar]
    d = np.abs(m[:, None] - downs[None, :]).min(1)
    return float(np.mean(d < tol))


# ── main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gp")
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--tracks", required=True,
                    help='"idx:Name,idx:Name"; "3+2+5:Lead" fills empty bars of 3 from 2, then 5')
    ap.add_argument("--fill-min-bars", type=int, default=2,
                    help="only fill runs of at least this many empty bars (default 2)")
    ap.add_argument("--title")
    ap.add_argument("--artist")
    ap.add_argument("--album", default="")
    ap.add_argument("--year", type=int, default=0)
    ap.add_argument("--cover")
    ap.add_argument("--align-tracks", help="track idxs used for alignment (default: all pitched)")
    ap.add_argument("--no-align", action="store_true")
    ap.add_argument("--offset", type=float, default=0.0, help="extra seconds added after warp")
    ap.add_argument("--report", help="write alignment diagnostics JSON here")
    ap.add_argument("--no-stems", action="store_true",
                    help="skip Demucs stem splitting (default: split full mix into "
                         "guitar/bass/drums/vocals/piano/other so the Stems mixer can mute parts)")
    ap.add_argument("--method", choices=["auto", "dtw", "linear"], default="auto",
                    help="sync method: beat-level DTW, constant tempo, or auto (pick by onset score)")
    ap.add_argument("--refine-beats", action="store_true",
                    help="re-pick downbeats with livechord-beat-refiner (needs _build/.mirvenv python)")
    ap.add_argument("--anchors", help="feedBack Studio syncpoints.json, or an edited .feedpak/.sloppak "
                    "containing sync/syncpoints.json: pins those bars to the marked times")
    ap.add_argument("--reuse", help="existing build of this song: keep its stems, cover and sync map and "
                    "only rebuild the charts (seconds instead of a minute; tab timing must be unchanged)")
    ap.add_argument("--reuse-map", help="report JSON with beat_map, for older builds without x_sync.json")
    ap.add_argument("--export-rs", help="also write each synced arrangement as Rocksmith XML into this folder")
    ap.add_argument("--merge-into", help="existing sloppak: add the new arrangements to it "
                    "(keeps its audio/stems/charts; uses its authored beat grid for sync). "
                    "Pass '-' as the audio argument to use its full-mix stem.")
    a = ap.parse_args()
    if not a.merge_into and not (a.title and a.artist):
        ap.error("--title and --artist are required unless --merge-into is used")

    existing = None
    if a.merge_into:
        import yaml
        existing = {"dir": Path(tempfile.mkdtemp(prefix="gp2slop_merge_"))}
        with zipfile.ZipFile(a.merge_into) as z:
            z.extractall(existing["dir"])
        existing["manifest"] = yaml.safe_load((existing["dir"] / "manifest.yaml").read_text(encoding="utf-8"))
        man = existing["manifest"]
        if a.audio == "-":
            full = man.get("original_audio") or next(
                (s["file"] for s in man.get("stems", []) if s.get("id") == "full"), man["stems"][0]["file"])
            a.audio = str(existing["dir"] / full)
        for ent in man.get("arrangements", []):
            data = json.loads((existing["dir"] / ent["file"]).read_text(encoding="utf-8"))
            if data.get("beats"):
                bt = np.array([b["time"] for b in data["beats"]])
                existing["beats"] = bt
                existing["downs"] = np.array([b["time"] for b in data["beats"] if b.get("measure", -1) != -1])
                log(f"using authored beat grid from {ent['file']}: {len(bt)} beats")
                break

    import librosa
    song = guitarpro.parse(a.gp)
    # "3+2+5:Lead" = track 3, with empty stretches filled from 2, then 5
    picks, fills = [], {}
    for p in a.tracks.split(","):
        ids, name = p.split(":", 1)
        ids = [int(x) for x in ids.split("+")]
        picks.append((ids[0], name))
        fills[ids[0]] = ids[1:]

    reuse = load_reuse(a.reuse, a.reuse_map) if a.reuse else None
    if reuse is not None:
        dur = reuse["duration"]  # notation-only: no audio decode, no beat tracking, no Demucs
        log(f"reusing stems + sync map from {Path(a.reuse).name}")
    else:
        log("loading audio…")
        y, _ = librosa.load(a.audio, sr=SR, mono=True)
        dur = len(y) / SR

    xmls = {}
    for idx, name in picks:
        src, nfill = fill_gaps(song, idx, fills[idx], a.fill_min_bars)
        if fills[idx]:
            log(f"  {name}: filled {nfill} empty bars from tracks {fills[idx]}")
        xmls[idx] = polish_xml(_track_xml(src, idx, name))
    ref_root = ET.fromstring(xmls[picks[0][0]])
    tab_beats = np.array([float(e.get("time")) for e in ref_root.find("ebeats")])
    tab_len = float(ref_root.findtext("songLength"))
    log(f"tab length {tab_len:.1f}s, audio {dur:.1f}s, {len(tab_beats)} beats")

    report = {}
    if reuse is not None:
        old_t, amap = reuse["tab_beats"], reuse["audio_beats"].copy()
        if len(old_t) != len(tab_beats) or np.max(np.abs(old_t - tab_beats)) > 0.01:
            raise SystemExit("--reuse: the tab's beat timing changed since that build; do a full rebuild")
        if a.anchors:
            tab_is_bar = np.array([int(e.get("measure")) != -1 for e in ref_root.find("ebeats")])
            amap, n_anch, max_d = apply_anchors(amap, tab_is_bar, load_anchors(a.anchors))
            log(f"  anchors: {n_anch} bars pinned (largest correction {max_d:.2f}s)")
        base_warp = make_warp_fn(tab_beats, amap)
        warp = lambda t: base_warp(t) + a.offset  # noqa: E731
        report = {**reuse["report"], "reused": True, "tab_len": tab_len, "audio_len": dur,
                  "beat_map": [[round(float(t), 3), round(float(b), 3)] for t, b in zip(tab_beats, amap)]}
        log(f"  sync reused ({report.get('method')}, onset {report.get('onset_score') or 0:.2f})")
    elif a.no_align:
        warp = lambda t: t + a.offset  # noqa: E731
    else:
        if a.align_tracks:
            align_idx = [int(x) for x in a.align_tracks.split(",")]
        else:
            align_idx = [t["index"] for t in gp2rs.list_tracks(a.gp)
                         if not t["is_drums"] and not t["is_percussion"] and t["notes"] > 0]
        notes = []
        for idx in align_idx:
            # raw (unpolished) durations: the piano-roll wants how long notes ring
            x = _track_xml(song, idx, "Bass" if gp2rs._is_bass_track(song.tracks[idx]) else "Lead")
            notes += _xml_notes(x)
        log(f"alignment notes: {len(notes)} from tracks {align_idx}")
        timing_idx = [t["index"] for t in gp2rs.list_tracks(a.gp) if t["is_drums"]] or align_idx
        ac, ao = audio_features(y)
        n_tab = int((tab_len + 2) * SR / HOP) + 1
        tc, to = tab_features(notes, n_tab)
        log("coarse DTW…")
        pt, pa, _, _ = dtw_map(tc, to, ac, ao)
        coarse = smooth_coarse(tab_beats, pt, pa)
        log("beat tracking (beat_this)…")
        if existing is not None and "beats" in existing:
            beats, downs = existing["beats"], existing["downs"]
        else:
            beats, downs = detect_beats(a.audio, refine=a.refine_beats)
        G, g_is_bar = beat_grid(beats, downs, tab_beats, coarse)
        tab_is_bar = np.array([int(e.get("measure")) != -1 for e in ref_root.find("ebeats")])
        drum_times = []
        for idx in timing_idx:
            r = ET.fromstring(_track_xml(song, idx, "Lead"))
            drum_times += [float(n.get("time")) for n in r.iter("note")]
        log(f"beat-level DTW: {len(tab_beats)} tab beats vs {len(G)} grid beats "
            f"({len(beats)} detected)…")
        amap, skips = beat_dtw(tab_beats, tab_is_bar, notes, drum_times, G, g_is_bar, y)
        env = onset_env_fine(y)
        # score onsets from drums + every converted part
        on = set(drum_times)
        for x in xmls.values():
            r = ET.fromstring(x)
            on |= {float(n.get("time")) for n in r.iter("note")}
            on |= {float(c.get("time")) for c in r.iter("chord")}
        on = np.array(sorted(on))
        dtw_score = alignment_score(env, [make_warp_fn(tab_beats, amap)(t) for t in on])
        dtw_bars = bar_hit_rate(amap, tab_is_bar, downs)
        log(f"  beat-DTW:   onset score {dtw_score:.2f}, bars on downbeats {dtw_bars:.0%}, "
            f"{len(skips)} skips")
        lin_map, lin = linear_fit(env, on, tab_beats, tab_is_bar, downs, coarse)
        lin_score = alignment_score(env, lin["offset"] + lin["rate"] * on)
        log(f"  constant-tempo: onset score {lin_score:.2f}, bars on downbeats {lin['bar_hit']:.0%} "
            f"(rate {lin['rate']:.4f}, offset {lin['offset']:+.3f}s)")
        method = "beat-dtw"
        if a.method == "linear" or (a.method == "auto" and lin_score > dtw_score * 1.1
                                    and lin["bar_hit"] >= dtw_bars - 0.1):
            amap, method = lin_map, "constant-tempo"
        log(f"  -> using {method}")
        if a.anchors:
            amap, n_anch, max_d = apply_anchors(amap, tab_is_bar, load_anchors(a.anchors))
            method += "+anchors"
            log(f"  anchors: {n_anch} bars pinned (largest correction {max_d:.2f}s)")
        base_warp = make_warp_fn(tab_beats, amap)
        score = alignment_score(env, [base_warp(t) for t in on])
        bars = bar_hit_rate(amap, tab_is_bar, downs)
        warp = lambda t: base_warp(t) + a.offset  # noqa: E731
        report = {
            "tab_len": tab_len, "audio_len": dur, "onset_score": score, "bar_hit": bars,
            "method": method, "dtw": [float(dtw_score), float(dtw_bars)], "linear": lin,
            "linear_score": float(lin_score),
            "skips": skips,
            "beat_map": [[round(float(t), 3), round(float(b), 3)] for t, b in zip(tab_beats, amap)],
        }

    # ── write sloppak ──
    out = Path(a.out)
    if existing is not None:
        work = existing["dir"]
        used = {e["id"] for e in existing["manifest"].get("arrangements", [])}
    elif reuse is not None:
        work = reuse["dir"]  # old stems/cover kept, old arrangements already removed (drums kept)
        used = {e["id"] for e in reuse["keep_arrangements"]}
    else:
        work = Path(tempfile.mkdtemp(prefix="gp2slop_"))
        (work / "arrangements").mkdir()
        (work / "stems").mkdir()
        used = set()
    arr_manifest = []
    first = existing is None  # merged arrangements reuse the existing beats/sections
    for idx, name in picks:
        wx = warp_xml(xmls[idx], warp, dur)
        tmp = work / f"_{idx}.xml"
        tmp.write_text(wx, encoding="utf-8")
        arr = parse_arrangement(str(tmp))
        arr.name = name
        wire = arrangement_to_wire(arr)
        wire["name"] = name
        if first:
            r = ET.fromstring(wx)
            wire["beats"] = [{"time": float(e.get("time")), "measure": int(e.get("measure"))}
                             for e in r.find("ebeats")]
            # gp2rs squashes marker titles RS-style ("my best friend" ->
            # "mybestfriend"); restore the readable GP marker text.
            pretty = {}
            for mh in song.measureHeaders:
                if mh.marker and mh.marker.title:
                    title = mh.marker.title.strip()
                    pretty.setdefault(title.lower().replace(" ", ""), title.rstrip(". ").strip())
            wire["sections"] = [{"name": pretty.get(s.get("name"), s.get("name")),
                                 "number": int(s.get("number")),
                                 "time": float(s.get("startTime"))} for s in r.find("sections")]
            first = False
        aid = base_id = name.lower().replace(" ", "_")
        k = 2
        while aid in used:
            aid = f"{base_id}{k}"
            k += 1
        used.add(aid)
        (work / "arrangements" / f"{aid}.json").write_text(
            json.dumps(wire, separators=(",", ":")), encoding="utf-8")
        if a.export_rs:  # synced Rocksmith XML for DLC Builder (scripts/export_dlcbuilder.py)
            Path(a.export_rs).mkdir(parents=True, exist_ok=True)
            (Path(a.export_rs) / f"{aid}_RS2.xml").write_text(wx, encoding="utf-8")
        tmp.unlink()
        arr_manifest.append({"id": aid, "name": name, "file": f"arrangements/{aid}.json",
                             "tuning": list(arr.tuning), "capo": arr.capo})
        log(f"  {name}: {len(arr.notes)} notes, {len(arr.chords)} chords, tuning {arr.tuning}")

    import yaml
    if existing is not None:
        manifest = existing["manifest"]
        manifest["arrangements"] = list(manifest.get("arrangements", [])) + arr_manifest
    elif reuse is not None:
        manifest = reuse["manifest"]
        manifest.update({"title": a.title, "artist": a.artist, "album": a.album, "year": a.year})
        manifest["arrangements"] = arr_manifest + reuse["keep_arrangements"]
        manifest["x_build"] = _x_build(a)
        if reuse["keep_arrangements"]:
            src = (manifest.get("x_drums") or {}).get("source")
            log(f"  kept the Drums arrangement ({src or 'unknown source'})")
            if src == "gp" and a.anchors:
                log("  NOTE: these drums were placed with the old sync map; re-run song_builder.py drums")
    else:
        manifest = _new_manifest(a, work, dur, arr_manifest)
    if report.get("beat_map"):
        # the tab->audio beat map, so a later --reuse can rebuild the chart without re-syncing
        bm = report["beat_map"]
        (work / "x_sync.json").write_text(json.dumps({
            "tab_beats": [b[0] for b in bm], "audio_beats": [b[1] for b in bm],
            "report": {k: report.get(k) for k in ("onset_score", "bar_hit", "method", "dtw", "linear_score")},
        }, default=float), encoding="utf-8")
    (work / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
                                        encoding="utf-8")

    tmp_out = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp_out, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(work.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(work).as_posix())
    shutil.rmtree(work)
    if out.exists():
        out.unlink() if out.is_file() else shutil.rmtree(out)
    tmp_out.rename(out)
    if not a.no_stems:
        split_stems_if_needed(out)
    if a.report:
        Path(a.report).write_text(json.dumps(report, indent=1, default=float), encoding="utf-8")
    log(f"wrote {out}")


def split_stems_if_needed(sloppak):
    """Run Slopsmith's Demucs splitter (GPU when available) unless the sloppak
    already has per-instrument stems."""
    import yaml
    with zipfile.ZipFile(sloppak) as z:
        stems = [s["id"] for s in yaml.safe_load(z.read("manifest.yaml")).get("stems", [])]
        has_full = "stems/full.ogg" in z.namelist()
    if set(stems) - {"full"} or not has_full:
        log(f"stems already split ({', '.join(stems)}); skipping Demucs")
        return
    import time
    import torch
    from sloppak_convert import split_sloppak_stems
    log(f"splitting stems with Demucs htdemucs_6s on {'GPU' if torch.cuda.is_available() else 'CPU'}…")
    t0 = time.time()
    split_sloppak_stems(Path(sloppak))
    log(f"  stems done in {time.time() - t0:.0f}s")


def _new_manifest(a, work, dur, arr_manifest):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.audio, "-vn", "-c:a", "libvorbis",
                    "-q:a", "6", str(work / "stems" / "full.ogg")], check=True)
    manifest = {"title": a.title, "artist": a.artist, "album": a.album, "year": a.year,
                "duration": round(dur, 3)}
    if a.cover:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.cover, "-vf",
                        "scale=512:512:force_original_aspect_ratio=decrease", "-q:v", "3",
                        str(work / "cover.jpg")], check=True)
        manifest["cover"] = "cover.jpg"
    manifest["stems"] = [{"id": "full", "file": "stems/full.ogg", "default": True}]
    manifest["arrangements"] = arr_manifest
    manifest["x_build"] = _x_build(a)
    return manifest


def _x_build(a):
    """How this chart was built, so scripts/rebuild_song.py can redo it (e.g. with anchors)."""
    return {k: v for k, v in {
        "tool": "gp_to_sloppak", "gp": str(Path(a.gp).resolve()), "audio": str(Path(a.audio).resolve()),
        "out": str(Path(a.out).resolve()),
        "tracks": a.tracks, "fill_min_bars": a.fill_min_bars, "title": a.title, "artist": a.artist,
        "album": a.album, "year": a.year, "cover": str(Path(a.cover).resolve()) if a.cover else None,
        "refine_beats": bool(a.refine_beats), "offset": a.offset or None,
        "method": a.method if a.method != "auto" else None,
    }.items() if v not in (None, "")}


if __name__ == "__main__":
    main()
