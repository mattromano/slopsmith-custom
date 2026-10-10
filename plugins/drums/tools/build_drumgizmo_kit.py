"""Build a web drum kit (kit.json + Ogg Vorbis) from a multi-microphone DrumGizmo kit, with our own mix.

    python -I plugins/drums/tools/build_drumgizmo_kit.py drs <DRSKit dir> [out dir]

DRSKit 2.1 (DrumGizmo team / DRSDrums, CC BY 4.0): https://drumgizmo.org/kits/DRSKit/DRSKit2_1.zip.
Every hit is stored with all 13 microphones (close mics, two overheads, two room mics) and a "power"
value; the kit covers each drum from very soft to very hard (~30 hits per drum, ~11 per cymbal).

For every hit the microphones are mixed to stereo from the drummer's view (MIX below: gain and pan
per mic; the room mics are real room, wide). Snare bottom and kick front get their polarity checked
against snare top / kick back. Hits are sorted by power and split into LAYERS velocity layers of up
to ROUND_ROBINS hits each (velocity ~ 127 * sqrt(power / max power)); each sample is trimmed to its
onset (1 ms pre-roll), cut at the piece's max length with a fade, and the kit is scaled to a common
peak. Afterwards run tools/kit_loudness.py (layers onto the velocity law) and
tools/sync-bench/balance.mjs + tools/apply_balance.py (piece levels). Needs numpy, scipy,
soundfile and ffmpeg (libvorbis).
"""

import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

PLUGIN_DIR = Path(__file__).resolve().parent.parent
PEAK_DBFS = -3.0
VORBIS_Q = "5"

# mic: (gain dB, pan -1..1 from the drummer's view: hi-hat left, ride / floor toms right)
MIX = {
    "drs": {
        "Kdrum_back": (0, 0.0), "Kdrum_front": (-4, 0.0),
        "Snare_top": (0, -0.08), "Snare_bottom": (-9, -0.08),
        "Hihat": (-5, -0.5), "Ride": (-8, 0.55),
        "Tom1": (-1, -0.12), "Tom2": (-1, 0.3), "Tom3": (-1, 0.5),
        "OHL": (-1, -0.75), "OHR": (-1, 0.75),
        "AmbL": (-5, -1.0), "AmbR": (-5, 1.0),
    },
}
# polarity: (mic, reference mic, the instrument it is decided on). A mic's polarity is a fixed fact of
# the recording, so it is decided once (majority over that instrument's hits) and used for every piece.
POLARITY = [("Snare_bottom", "Snare_top", "Snare"), ("Kdrum_front", "Kdrum_back", "Kdrum_with_contact")]

# piece: (instrument folder, max seconds, layers, round-robins)
KITS = {
    "drs": {
        "title": "DRSKit (DrumGizmo), multi-mic mix",
        "pieces": {
            "kick":      ("Kdrum_with_contact", 0.9, 8, 3),
            "snare":     ("Snare", 1.2, 8, 3),
            "sidestick": ("Snare_rim", 0.7, 4, 3),
            "tom1":      ("Tom1", 1.8, 7, 3),
            "tom2":      ("Tom2", 2.0, 7, 3),
            "tom3":      ("Tom3", 2.2, 7, 3),
            "hhclosed":  ("Hihat_closed", 0.55, 7, 3),
            "hhpedal":   ("Hihat_foot", 0.5, 2, 3),
            "hhopen":    ("Hihat_open", 2.2, 5, 3),
            "hhhalf":    ("Hihat_semi_open", 1.2, 5, 3),
            "crash":     ("Crash_left_shank", 3.2, 4, 2),
            "crash2":    ("Crash_right_shank", 3.2, 4, 2),
            "splash":    ("Crash_left_tip", 2.4, 4, 2),
            "china":     ("Crash_right_tip", 2.6, 4, 2),
            "ride":      ("Ride_tip", 2.8, 5, 2),
            "bell":      ("Ride_shank_bell", 2.8, 4, 2),
        },
        # GM note -> piece (23 = semi-open hi-hat, for the hi-hat pedal; not a GM note)
        "notes": {35: "kick", 36: "kick", 37: "sidestick", 38: "snare", 40: "snare",
                  48: "tom1", 50: "tom1", 45: "tom2", 47: "tom2", 41: "tom3", 43: "tom3", 58: "tom3",
                  42: "hhclosed", 44: "hhpedal", 46: "hhopen", 23: "hhhalf",
                  49: "crash", 57: "crash2", 55: "splash", 52: "china",
                  51: "ride", 59: "ride", 53: "bell"},
    },
}
CHOKES = {"42": [46, 23], "44": [46, 23], "23": [46]}


def read_instrument(src: Path, folder: str):
    """[(power, {mic: path, filechannel})] for one DrumGizmo instrument (format 2.0)."""
    xml_path = src / folder / (folder + ".xml")
    root = ET.parse(xml_path).getroot()
    hits = []
    for s in root.iter("sample"):
        chans = {}
        for a in s.iter("audiofile"):
            f = (xml_path.parent / a.get("file")).resolve()
            if not f.is_relative_to(src.resolve()):
                raise SystemExit("sample outside the source folder: " + str(f))
            chans[a.get("channel")] = (f, int(a.get("filechannel", "1")) - 1)
        hits.append((float(s.get("power", "0")), chans))
    if not hits:
        raise SystemExit("no samples in " + str(xml_path))
    return sorted(hits, key=lambda h: h[0])


def load_mics(chans):
    """{mic: mono float32} for one hit (all mics share one multichannel file)."""
    cache, out, sr = {}, {}, None
    for mic, (f, ch) in chans.items():
        if f not in cache:
            cache[f], sr = sf.read(str(f), dtype="float32", always_2d=True)
        out[mic] = cache[f][:, ch]
    return out, sr


def polarity_flips(mics, sr):
    """Mics whose polarity is opposite to their reference (low band, lag within +-1.5 ms)."""
    flips = set()
    sos = butter(4, 800, "low", fs=sr, output="sos")
    for mic, ref, _ in POLARITY:
        if mic not in mics or ref not in mics:
            continue
        a, b = sosfiltfilt(sos, mics[mic][: int(0.15 * sr)]), sosfiltfilt(sos, mics[ref][: int(0.15 * sr)])
        best = 0.0
        L = int(0.0015 * sr)
        for lag in range(-L, L + 1):
            x = a[max(0, lag): len(a) + min(0, lag)]
            y = b[max(0, -lag): len(b) - max(0, lag)]
            c = float(np.dot(x, y))
            if abs(c) > abs(best):
                best = c
        if best < 0:
            flips.add(mic)
    return flips


def mix(mics, spec, flips):
    n = max(len(v) for v in mics.values())
    out = np.zeros((n, 2), dtype=np.float32)
    for mic, x in mics.items():
        if mic not in spec:
            continue
        g_db, pan = spec[mic]
        g = 10 ** (g_db / 20) * (-1 if mic in flips else 1)
        th = (pan + 1) * np.pi / 4   # equal-power pan
        out[: len(x), 0] += x * g * np.cos(th)
        out[: len(x), 1] += x * g * np.sin(th)
    return out


def shape(audio, sr, max_s):
    """Cut to the onset (1 ms pre-roll) and the decay tail; fade out the end."""
    mono = np.abs(audio).max(axis=1)
    peak = float(mono.max()) or 1.0
    on = np.flatnonzero(mono > peak * 10 ** (-30 / 20))
    start = max(0, int(on[0]) - int(0.001 * sr)) if len(on) else 0
    tail = np.flatnonzero(mono > peak * 10 ** (-60 / 20))
    end = int(tail[-1]) + 1 if len(tail) else len(mono)
    end = min(end, start + int(max_s * sr))
    out = audio[start:end].copy()
    n = len(out)
    fade = min(n // 3, int(0.3 * n) + int(0.02 * sr))
    if fade > 0:
        out[n - fade:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade)))[:, None].astype(np.float32)
    fade_in = min(n, int(0.0005 * sr))
    if fade_in > 1:
        out[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)[:, None]
    return out


def layer_groups(hits, n_layers, rr):
    """Split hits (sorted by power) into n_layers contiguous groups; up to rr hits from each group's middle."""
    n_layers = max(1, min(n_layers, len(hits)))
    edges = np.linspace(0, len(hits), n_layers + 1).round().astype(int)
    groups = []
    for i in range(n_layers):
        g = hits[edges[i]:edges[i + 1]]
        if not g:
            continue
        mid = len(g) // 2
        order = sorted(range(len(g)), key=lambda j: abs(j - mid))
        groups.append([g[j] for j in sorted(order[:rr])])
    return groups


def encode(audio, sr, path: Path):
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "x.wav"
        sf.write(str(wav), audio, sr, subtype="FLOAT")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-map_metadata", "-1",
                        "-c:a", "libvorbis", "-q:a", VORBIS_Q, str(path)], check=True)


def build(kit_id, src: Path, out: Path):
    spec = KITS[kit_id]
    mix_spec = MIX[kit_id]
    flips = set()
    for mic, _, folder in POLARITY:
        votes = [mic in polarity_flips(load_mics(chans)[0], load_mics(chans)[1]) for _, chans in read_instrument(src, folder)]
        if sum(votes) * 2 > len(votes):
            flips.add(mic)
        print("polarity: %s %s (%d of %d %s hits)" % (mic, "inverted" if mic in flips else "kept", sum(votes), len(votes), folder))
    rendered = {}
    for piece, (folder, max_s, n_layers, rr) in spec["pieces"].items():
        hits = read_instrument(src, folder)
        pmax = max(p for p, _ in hits)
        layers = []
        for li, group in enumerate(layer_groups(hits, n_layers, rr)):
            files, vels = [], []
            for ri, (p, chans) in enumerate(group):
                mics, sr = load_mics(chans)
                a = shape(mix(mics, mix_spec, flips), sr, max_s)
                files.append(("%s_v%d_%s.ogg" % (piece, li + 1, "abcd"[ri]), a, sr))
                vels.append(max(1.0, 127.0 * (p / pmax) ** 0.5))
            layers.append((float(np.median(vels)), files))
        rendered[piece] = layers
        print("%-10s %-20s %2d hits -> %d layers at vel %s" % (
            piece, folder, len(hits), len(layers), ", ".join("%.0f" % v for v, _ in layers)))

    peak = max(float(np.abs(a).max()) for ls in rendered.values() for _, fs in ls for _, a, _ in fs)
    scale = 10 ** (PEAK_DBFS / 20) / peak
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    piece_layers = {}
    for piece, layers in rendered.items():
        vels = [v for v, _ in layers]
        bounds = [int(round((vels[i] + vels[i + 1]) / 2)) for i in range(len(vels) - 1)]
        out_layers = []
        for i, (v, files) in enumerate(layers):
            lo = 1 if i == 0 else bounds[i - 1] + 1
            hi = 127 if i == len(layers) - 1 else bounds[i]
            for name, a, sr in files:
                encode(a * scale, sr, out / name)
            out_layers.append({"lo": lo, "hi": max(lo, hi), "files": [f for f, _, _ in files]})
        piece_layers[piece] = out_layers
    manifest = {
        "format": 1,
        "name": spec["title"],
        "notes": {str(n): {"piece": p, "layers": piece_layers[p]} for n, p in sorted(spec["notes"].items())},
        "chokes": CHOKES,
    }
    (out / "kit.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    files = list(out.iterdir())
    total = sum(f.stat().st_size for f in files)
    secs = sum(sf.info(str(f)).duration for f in files if f.suffix == ".ogg")
    print("%s: %d files, %.1f MB, %.0f s of audio (~%.0f MB decoded at 44.1 kHz stereo) -> %s" % (
        kit_id, len(files), total / 1e6, secs, secs * 44100 * 2 * 4 / 1e6, out))


def main(argv):
    if len(argv) < 2 or argv[0] not in KITS:
        raise SystemExit(__doc__)
    src = Path(argv[1]).resolve()
    out = Path(argv[2]).resolve() if len(argv) > 2 else PLUGIN_DIR / "sounds" / "kits" / argv[0]
    build(argv[0], src, out)


if __name__ == "__main__":
    main(sys.argv[1:])
