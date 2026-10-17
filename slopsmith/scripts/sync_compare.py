"""Compare the song builder's sync against RockForge's beam-search refinement.

For every song-builder sloppak (one with x_sync.json), the charts are put back
in tab time through the stored beat map, re-synced several ways, and each
result is graded the way tab_check grades a build: chart onsets against
Basic Pitch notes from the matching stem (guitar / bass).

Candidates (maps tab beat -> recording time):
  base        the map the build kept (beat-DTW or constant-tempo)
  base+beam   base refined by lib/beatalign (RockForge align_beats)
  line        one constant tempo fitted to base (a deliberately rough seed)
  line+beam   that line refined by beatalign: can it recover base on its own?

Metrics per candidate (onset-weighted over the pitched arrangements):
  hit    chart onsets with a matching stem note within +/-70 ms
  lift   hit / chance (chart shifted by unrelated offsets)
  iqr    spread of stem-minus-chart offsets of hits, ms (tighter = steadier sync)
  onset  beatalign's onset evidence (what the beam maximises: biased, for reference)
  moved  median |beat - base beat|, ms
  shift  median signed beat - base beat, ms (+ = later; the beam should not move the map as a whole)
  bp_off median stem-minus-chart offset of hits, ms (Basic Pitch reads ~20-40 ms late)
  best_shift  tab_check's global shift that maximises hits, s

Needs the analysis venv (librosa, basic-pitch --no-deps, onnxruntime):
  _build/.mirvenv-mac/bin/python scripts/sync_compare.py SONG.sloppak [...] [--json out.json]
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "lib"), str(ROOT / "scripts")]

import beatalign  # noqa: E402
import tab_check  # noqa: E402

SR = 22050
CANDIDATES = ("base", "base+beam", "line", "line+beam")
SHIFTS = np.arange(-0.2, 0.201, 0.02)   # tab_check's best_shift grid


def load_mix(z, man):
    """Mono mix at SR: the full-mix stem, else the sum of the split stems."""
    import librosa
    import soundfile as sf

    stems = {s["id"]: s["file"] for s in man.get("stems", [])}
    files = [stems["full"]] if "full" in stems else list(stems.values())
    mix = None
    for f in files:
        y, sr = sf.read(io.BytesIO(z.read(f)), dtype="float32", always_2d=True)
        y = librosa.resample(y.mean(axis=1), orig_sr=sr, target_sr=SR)
        if mix is None:
            mix = y
        else:
            n = max(len(mix), len(y))
            mix = np.pad(mix, (0, n - len(mix))) + np.pad(y, (0, n - len(y)))
    return mix


def grade(ons_audio, bp):
    flags, offs = tab_check.hits(ons_audio, bp)
    chance = float(np.mean([tab_check.hits(ons_audio, bp, s)[0].mean() for s in (-0.61, -0.37, 0.29, 0.53)]))
    return flags, offs, chance


def compare(path: Path) -> dict | None:
    z = zipfile.ZipFile(path)
    if "x_sync.json" not in z.namelist():
        return None
    xs = json.loads(z.read("x_sync.json"))
    tab_b = np.asarray(xs["tab_beats"], float)
    base = np.asarray(xs["audio_beats"], float)
    man = yaml.safe_load(z.read("manifest.yaml"))
    stems = {s["id"]: s["file"] for s in man.get("stems", [])}

    arrs = []
    offset = None
    for ent in man.get("arrangements", []):
        if tab_check.DRUMS_ARR.search(f"{ent.get('name', '')} {ent.get('id', '')}"):
            continue
        arr = json.loads(z.read(ent["file"]))
        is_bass = "bass" in (ent.get("name", "") + ent["id"]).lower()
        stem = "bass" if is_bass else "guitar"
        if stem not in stems:
            continue
        cb = np.array([b["time"] for b in arr.get("beats") or []], float)
        if offset is None and len(cb) == len(base):
            offset = float(np.median(cb - base))   # the build's --offset (usually 0)
        ons = tab_check.chart_onsets(arr, is_bass)
        if not ons:
            continue
        crc = z.getinfo(stems[stem]).CRC
        bp = tab_check.stem_notes(z, stems[stem], f"{path.stem}__{stem}__{crc:08x}")
        arrs.append({"name": ent.get("name", ent["id"]), "ons": ons, "bp": bp})
    if not arrs or offset is None:
        return {"file": path.name, "skipped": "no pitched arrangement with a matching beat grid"}

    # chart onsets back to tab time through the stored map
    for a in arrs:
        t_audio = np.array([t for t, _ in a["ons"]]) - offset
        a["tab_t"] = np.interp(t_audio, base, tab_b)
    notes_tab = np.unique(np.concatenate([a["tab_t"] for a in arrs]))

    env, hop = beatalign.onset_envelope(load_mix(z, man), SR)
    t0 = time.time()
    maps = {"base": base}
    maps["base+beam"], info_b = beatalign.refine_map(env, hop, tab_b, base, notes_tab)
    k, c = np.polyfit(tab_b, base, 1)
    maps["line"] = c + k * tab_b
    maps["line+beam"], info_l = beatalign.refine_map(env, hop, tab_b, maps["line"], notes_tab)
    beam_s = time.time() - t0

    e = beatalign._normalized(env)

    def onset_evidence(times):
        idx = np.clip(np.round(times / hop).astype(int), 0, len(e) - 1)
        return float(np.mean(np.asarray(e)[idx]))

    out = {"file": path.name, "title": man.get("title"), "method": xs.get("report", {}).get("method"),
           "beats": len(base), "beam_seconds": round(beam_s, 1),
           "after_gap": {"base+beam": info_b["after_gap"], "line+beam": info_l["after_gap"]},
           "candidates": {}}
    for name in CANDIDATES:
        m = maps[name]
        n_on = hit_n = 0
        chance_w = 0.0
        offs_all = []
        shift_hits = np.zeros(len(SHIFTS))
        for a in arrs:
            t_new = np.interp(a["tab_t"], tab_b, m) + offset
            ons = [(float(t), pcs) for t, (_, pcs) in zip(t_new, a["ons"])]
            flags, offs, chance = grade(ons, a["bp"])
            n_on += len(ons)
            hit_n += int(flags.sum())
            chance_w += chance * len(ons)
            offs_all += list(offs)
            shift_hits += [tab_check.hits(ons, a["bp"], sh)[0].sum() for sh in SHIFTS]
        hit = hit_n / n_on
        chance = chance_w / n_on
        q75, q25 = (np.percentile(offs_all, [75, 25]) if offs_all else (np.nan, np.nan))
        all_t = np.interp(notes_tab, tab_b, m) + offset
        out["candidates"][name] = {
            "hit": round(hit, 3), "lift": round(hit / chance, 2) if chance else None,
            "iqr_ms": round(float(q75 - q25) * 1000, 1),
            "onset": round(onset_evidence(all_t), 3),
            "moved_ms": round(float(np.median(np.abs(m - base))) * 1000, 1),
            "shift_ms": round(float(np.median(m - base)) * 1000, 1),
            "bp_off_ms": round(float(np.median(offs_all)) * 1000, 1) if offs_all else None,
            "best_shift": round(float(SHIFTS[int(np.argmax(shift_hits))]), 2),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sloppaks", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    results = []
    for p in a.sloppaks:
        r = compare(Path(p))
        if r is None:
            continue
        results.append(r)
        if "skipped" in r:
            print(f"{r['file']}: skipped ({r['skipped']})", flush=True)
            continue
        print(f"{r['title']}  [{r['method']}, {r['beats']} beats, beam {r['beam_seconds']}s]", flush=True)
        for name, d in r["candidates"].items():
            print(f"  {name:<10} hit {d['hit']:.1%}  lift {d['lift']}  iqr {d['iqr_ms']}ms  "
                  f"onset {d['onset']}  moved {d['moved_ms']}ms  shift {d['shift_ms']:+}ms  "
                  f"bp_off {d['bp_off_ms']}ms  best_shift {d['best_shift']:+.2f}", flush=True)
    if a.json:
        Path(a.json).write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
    # Results are written; skip native-library teardown (onnxruntime's can hang at exit).
    sys.stdout.flush()
    sys.stderr.flush()
    import os
    os._exit(0)
