"""Level a sampled kit's velocity layers by perceived loudness (writes kit.json in place).

    python -I plugins/drums/tools/kit_loudness.py crocell [virtuosity ...]
    python -I plugins/drums/tools/kit_loudness.py --report crocell        # measure only

Loudness = BS.1770 K-weighted momentary loudness, the loudest 400 ms window in the first 1.5 s of
the sample (so a cymbal that keeps swelling is judged by its swell, not its first peak).

Each layer gets {"gain", "ref"}: ref is the velocity the layer stands for (middle of its range) and
gain puts the layer, played at ref, exactly on the kit's velocity law (screen.js KIT_VEL_LAW: level
= 20 * LAW * log10(v / 127) dB below the piece's full-strength level). screen.js then scales each
hit by (v / ref) ** LAW inside its layer, so loudness follows one smooth curve across all layers and
only the tone changes from layer to layer. The top layer keeps gain 1, so piece levels (note "gain",
set from tools/sync-bench/balance.mjs) are unchanged by this step.
"""

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import lfilter

PLUGIN_DIR = Path(__file__).resolve().parent.parent
LAW = 1.75   # same as screen.js KIT_VEL_LAW


def k_weight(x, sr):
    """BS.1770 K-weighting (pyloudnorm's coefficient formulas, any sample rate)."""
    G, Q, fc = 3.99984385397, 0.7071752369554193, 1681.9744509555319
    A = 10 ** (G / 40)
    w0 = 2 * np.pi * fc / sr
    al = np.sin(w0) / (2 * Q)
    c = np.cos(w0)
    a0 = (A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al
    b1 = [A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al) / a0, -2 * A * ((A - 1) + (A + 1) * c) / a0,
          A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al) / a0]
    a1 = [1, 2 * ((A - 1) - (A + 1) * c) / a0, ((A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al) / a0]
    Q, fc = 0.5003270373253953, 38.13547087613982
    w0 = 2 * np.pi * fc / sr
    al = np.sin(w0) / (2 * Q)
    c = np.cos(w0)
    a0 = 1 + al
    b2 = [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0]
    a2 = [1, -2 * c / a0, (1 - al) / a0]
    return lfilter(b2, a2, lfilter(b1, a1, x, axis=0), axis=0)


def loudness(path):
    """Loudest 400 ms K-weighted momentary loudness (LUFS) in the first 1.5 s."""
    x, sr = sf.read(str(path), always_2d=True)
    x = x[: int(1.5 * sr)]
    y = k_weight(x, sr)
    e = np.concatenate([[0.0], np.cumsum((y ** 2).sum(axis=1))])
    w, step = int(0.4 * sr), int(0.01 * sr)
    if len(y) < w:   # short sample: pad with silence to the 400 ms window
        return -0.691 + 10 * np.log10(max(e[-1] / w, 1e-12))
    m = max((e[i + w] - e[i]) / w for i in range(0, len(y) - w + 1, step))
    return -0.691 + 10 * np.log10(max(m, 1e-12))


def level_kit(kit, write=True):
    d = PLUGIN_DIR / "sounds" / "kits" / kit
    path = d / "kit.json"
    m = json.loads(path.read_text(encoding="utf-8"))
    cache = {}
    print(f"{kit}:")
    for note in sorted(m["notes"], key=int):
        n = m["notes"][note]
        layers = sorted(n["layers"], key=lambda l: l["lo"])
        meas = []
        for l in layers:
            ls = [cache.setdefault(f, loudness(d / f)) for f in l["files"]]
            meas.append(10 * np.log10(np.mean([10 ** (v / 10) for v in ls])))
        refs = [(l["lo"] + l["hi"]) / 2 for l in layers]
        # full-strength level of the piece, from the top layer
        full = meas[-1] - 20 * LAW * np.log10(refs[-1] / 127)
        row = []
        for l, ref, lv in zip(layers, refs, meas):
            want = full + 20 * LAW * np.log10(ref / 127)
            g = 10 ** ((want - lv) / 20)
            l["ref"] = round(ref, 1)
            l["gain"] = round(float(min(4.0, g)), 3)
            row.append(f"{l['lo']:>3}-{l['hi']:<3} {lv:6.1f} LUFS -> {20 * np.log10(l['gain']):+5.1f} dB")
        n["layers"] = layers
        print(f"  {note:>2} {n.get('piece', ''):<10} " + " | ".join(row))
    if write:
        path.write_text(json.dumps(m, indent=1) + "\n", encoding="utf-8")
        print(f"  wrote {path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    report = "--report" in args
    for k in [a for a in args if not a.startswith("--")]:
        level_kit(k, write=not report)
