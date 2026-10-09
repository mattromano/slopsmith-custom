"""Grade a sloppak's charts against its own stems with Basic Pitch.

For every arrangement, the matching stem (guitar for Lead/Rhythm, bass for
Bass) is transcribed to notes with Spotify's Basic Pitch (ONNX model, no
TensorFlow).  A chart onset "hits" when the stem has a note starting within
+/-WIN seconds whose pitch class is one of the chart note's pitch classes
(octave-tolerant: distorted guitar and power chords confuse octaves).

Reported per arrangement:
  hit      - fraction of chart onsets that hit
  chance   - the same with the chart shifted by unrelated offsets (luck level)
  lift     - hit / chance  (1.0 = no better than luck; >1.5 is a decent chart)
  offset   - median stem-minus-chart onset time of hits (systematic lag)
  best_shift - global shift (s) that would maximise hits; far from 0 = offset problem
  bad_bars - runs of >= 2 bars whose hit rate is far below the song's,
             as (first_bar, last_bar, start_s, end_s): drop sync anchors here.

Needs the _build/.mirvenv interpreter (basic-pitch installed --no-deps + onnxruntime).

Usage:
  _build/.mirvenv/Scripts/python.exe scripts/tab_check.py SONG.sloppak [more...] [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import yaml

DRUMS_ARR = re.compile(r"\b(?:drums?|percussion)\b", re.I)

logging.disable(logging.WARNING)  # basic_pitch warns about missing TF/CoreML backends

GUITAR_BASE = [40, 45, 50, 55, 59, 64]  # RS string 0 = lowest
BASS_BASE = [28, 33, 38, 43, 47, 52]
WIN = 0.07
CACHE = Path(__file__).resolve().parent.parent / "_build" / "bp_cache"


def stem_notes(z: zipfile.ZipFile, stem_file: str, key: str) -> np.ndarray:
    """(start, pitch) rows for every Basic Pitch note in a stem, cached by key."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cache = CACHE / f"{key}.npy"
    if cache.exists():
        return np.load(cache)
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    model = Path(ICASSP_2022_MODEL_PATH)
    onnx = model.parent / "nmp.onnx" if model.suffix != ".onnx" else model
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / Path(stem_file).name
        p.write_bytes(z.read(stem_file))
        _, _, events = predict(str(p), str(onnx))
    arr = np.array(sorted((float(s), int(pi)) for s, e, pi, *_ in events), dtype=float).reshape(-1, 2)
    np.save(cache, arr)
    return arr


def chart_onsets(arr: dict, is_bass: bool):
    """[(time, {pitch classes})] for notes and chords, merged per onset time."""
    base = BASS_BASE if is_bass else GUITAR_BASE
    tun = list(arr.get("tuning") or [0] * 6) + [0] * 6
    capo = int(arr.get("capo") or 0)
    by_t: dict[float, set] = {}

    def add(t, s, f):
        if f is None or f < 0 or s is None or s < 0 or s > 5:
            return
        by_t.setdefault(round(float(t), 3), set()).add((base[s] + tun[s] + capo + f) % 12)

    for n in arr.get("notes", []):
        if not n.get("mt"):  # skip muted / dead notes
            add(n["t"], n["s"], n["f"])
    for c in arr.get("chords", []):
        for n in c.get("notes", []):
            if not n.get("mt"):
                add(c["t"], n["s"], n["f"])
    return sorted(by_t.items())


def hits(onsets, bp: np.ndarray, shift: float = 0.0):
    """Per-onset hit flags and stem-minus-chart offsets for hits."""
    if not len(bp):
        return np.zeros(len(onsets), bool), np.array([])
    starts, pcs = bp[:, 0], bp[:, 1].astype(int) % 12
    flags, offs = [], []
    for t, want in onsets:
        t = t + shift
        lo, hi = np.searchsorted(starts, [t - WIN, t + WIN])
        ok = [starts[i] - t for i in range(lo, hi) if pcs[i] in want]
        flags.append(bool(ok))
        if ok:
            offs.append(min(ok, key=abs))
    return np.array(flags), np.array(offs)


def bad_bar_runs(onsets, flags, bar_times, overall):
    """Runs of >= 2 consecutive bars hitting well below the song average."""
    if len(bar_times) < 3 or not len(onsets):
        return []
    times = np.array([t for t, _ in onsets])
    idx = np.searchsorted(bar_times, times, side="right") - 1
    thresh = max(0.15, overall * 0.45)
    bad = []
    for b in range(len(bar_times)):
        m = idx == b
        bad.append(m.sum() >= 3 and flags[m].mean() < thresh)
    runs, i = [], 0
    while i < len(bad):
        if bad[i]:
            j = i
            while j + 1 < len(bad) and bad[j + 1]:
                j += 1
            if j - i + 1 >= 2:
                end = bar_times[j + 1] if j + 1 < len(bar_times) else float(times.max())
                runs.append((i + 1, j + 1, round(float(bar_times[i]), 2), round(float(end), 2)))
            i = j + 1
        else:
            i += 1
    return runs


def check(path: Path) -> dict:
    z = zipfile.ZipFile(path)
    man = yaml.safe_load(z.read("manifest.yaml"))
    stems = {s["id"]: s["file"] for s in man.get("stems", [])}
    out = {"file": path.name, "title": man.get("title"), "arrangements": {}}
    bar_times = None
    for ent in man.get("arrangements", []):
        if DRUMS_ARR.search(f"{ent.get('name', '')} {ent.get('id', '')}"):
            continue  # drum charts aren't pitched; drums_join validates them against stems/drums.ogg
        arr = json.loads(z.read(ent["file"]))
        is_bass = "bass" in (ent.get("name", "") + ent["id"]).lower()
        stem = "bass" if is_bass else "guitar"
        if stem not in stems:
            stem = "full" if "full" in stems else None
        if stem is None:
            continue
        if bar_times is None and arr.get("beats"):
            bar_times = np.array([b["time"] for b in arr["beats"] if b.get("measure", -1) != -1])
        crc = z.getinfo(stems[stem]).CRC  # key on the stem's contents, not the file name
        bp = stem_notes(z, stems[stem], f"{path.stem}__{stem}__{crc:08x}")
        ons = chart_onsets(arr, is_bass)
        if not ons:
            continue
        flags, offs = hits(ons, bp)
        hit = float(flags.mean())
        chance = float(np.mean([hits(ons, bp, s)[0].mean() for s in (-0.61, -0.37, 0.29, 0.53)]))
        shifts = np.arange(-0.2, 0.201, 0.02)
        best = max(shifts, key=lambda s: hits(ons, bp, s)[0].mean())
        out["arrangements"][ent.get("name", ent["id"])] = {
            "stem": stem, "onsets": len(ons), "hit": round(hit, 3), "chance": round(chance, 3),
            "lift": round(hit / chance, 2) if chance > 0 else None,
            "offset": round(float(np.median(offs)), 3) if len(offs) else None,
            "best_shift": round(float(best), 2),
            "bad_bars": bad_bar_runs(ons, flags, bar_times if bar_times is not None else np.array([]), hit),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sloppaks", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    results = []
    for p in a.sloppaks:
        r = check(Path(p))
        results.append(r)
        print(r["title"])
        for name, d in r["arrangements"].items():
            bad = ", ".join(f"bars {b0}-{b1} ({s0:.0f}-{s1:.0f}s)" for b0, b1, s0, s1 in d["bad_bars"][:6])
            print(f"  {name:<7} hit {d['hit']:.0%} vs chance {d['chance']:.0%} -> lift {d['lift']}  "
                  f"offset {d['offset']}s  best_shift {d['best_shift']:+.2f}s"
                  + (f"\n          weak: {bad}" if bad else ""))
        sys.stdout.flush()
    if a.json:
        Path(a.json).write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
