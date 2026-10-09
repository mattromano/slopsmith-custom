"""Build a compact web drum kit (kit.json + Ogg Vorbis samples) from a free multi-sample library.

    python -I plugins/drums/tools/build_sample_kit.py crocell    <CrocellKit_Stereo_MIX dir>  [out dir]
    python -I plugins/drums/tools/build_sample_kit.py virtuosity <virtuosity_drums-master dir> [out dir]

The default out dir is plugins/drums/sounds/kits/<kit>/ (wiped and rebuilt). Needs numpy, scipy,
soundfile and ffmpeg (with libvorbis) on PATH.

Sources (see NOTICE.md for the licences):
  crocell     CrocellKit 1.1 by the DrumGizmo team, stereo mix: https://drumgizmo.org/kits/CrocellKit/
              CrocellKit_Stereo_MIX.rar (DrumGizmo instrument XML + stereo WAVs with a "power" per hit).
  virtuosity  Virtuosity Drums by Versilian Studios / Karoryfer: https://github.com/sfzinstruments/
              virtuosity_drums (SFZ + FLAC). Mixed like its "01-basic-kit": overheads + kick mic + snare mic.

For each General MIDI note the plugin plays (screen.js DRUM_MIDI_NOTES) a kit piece is chosen (PIECES
below; notes with no matching piece reuse a close one). Up to LAYER_TARGETS velocity layers are picked
from the source's hits (nearest to each target velocity) with up to two round-robins each. Each hit is
trimmed to its onset (1 ms pre-roll, so pads feel immediate), cut where it decays below -60 dB of its
peak or at the piece's max length, faded out; very quiet soft layers are lifted to SOFT_CURVE, pieces
get a balance trim (gain dB in KITS) and the whole kit is scaled to a common peak.
kit.json maps note -> {piece, layers [{lo, hi, files}]} plus hi-hat chokes.
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

PLUGIN_DIR = Path(__file__).resolve().parent.parent
LAYER_TARGETS = [34, 66, 96, 122]   # velocities the layers are picked around
ROUND_ROBINS = 2
PEAK_DBFS = -3.0                    # loudest sample in the kit
VORBIS_Q = "5"                      # ~160 kb/s stereo
SOFT_CURVE = 1.5                    # softest level of a layer vs the top one: (vel/127)^1.5

# GM drum notes -> piece name (screen.js DRUM_MIDI_NOTES). Chokes: closed / pedal hi-hat cut the open one.
GM_NOTES = [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 59]
CHOKES = {"42": [46], "44": [46]}

# piece: (source instrument, max seconds, gain dB, pitch semitones)
KITS = {
    "crocell": {
        "title": "CrocellKit (DrumGizmo), stereo mix",
        "pieces": {
            "kick":      ("KDrumR", 1.0, -3, 0),
            "kick2":     ("KDrumL", 1.0, -3, 0),
            "snare":     ("Snare", 1.2, 5, 0),
            "sidestick": ("SnareRim", 0.8, 12, 0),
            "rimshot":   ("SnareRimShot", 1.2, 4, 0),
            "tom1":      ("Tom1", 1.8, 3, 0),
            "tom2":      ("Tom2", 1.8, 3, 0),
            "ftom1":     ("FTom1", 2.0, 3, 0),
            "ftom2":     ("FTom2", 2.2, 3, 0),
            "hhclosed":  ("HihatClosed", 0.7, 7, 0),
            "hhpedal":   ("HihatPedal", 0.6, 10, 0),
            "hhopen":    ("HihatOpen", 2.2, 5, 0),
            "crash":     ("CrashL", 3.5, 0, 0),
            "crash2":    ("CrashR", 3.5, 3, 0),
            "ride":      ("RideR", 3.0, 10, 0),
            "bell":      ("RideRBell", 3.0, 6, 0),
            "china":     ("ChinaR", 3.0, 4, 0),
            "splash":    ("SplashL", 2.2, 7, 0),
        },
        "notes": {35: "kick2", 36: "kick", 37: "sidestick", 38: "snare", 40: "rimshot",
                  41: "ftom2", 43: "ftom1", 45: "tom2", 47: "tom2", 48: "tom1", 50: "tom1", 58: "ftom1",
                  42: "hhclosed", 44: "hhpedal", 46: "hhopen", 49: "crash", 57: "crash2",
                  51: "ride", 59: "ride", 53: "bell", 52: "china", 55: "splash"},
    },
    "virtuosity": {
        "title": "Virtuosity Drums (basic kit mix)",
        # source = SFZ map name in Programs/mappings/<mic>/<name>_map.sfz; veltrack = SFZ amp_veltrack
        # baked in (gain 0.4..1 over velocity, as the library's own programs do for these pieces).
        "pieces": {
            "kick":      ("kick_snon", 1.0, 2, 0),
            "snare":     ("snare_center", 1.3, 0, 0),
            "sidestick": ("snare_crossstick", 0.8, 0, 0),
            "rimshot":   ("snare_rimshot", 1.3, 0, 0),
            "tom1":      ("htom_center", 1.8, 0, 0),
            "tom2":      ("htom_center", 1.8, 0, -4),   # the kit has two toms: a mid tom from the high one
            "ftom1":     ("ltom_center", 2.2, 0, 0),
            "hhclosed":  ("hh_closed", 0.7, 4, 0),
            "hhpedal":   ("hh_pedal", 0.6, 8, 0),
            "hhopen":    ("hh_open", 2.2, 0, 0),
            "crash":     ("crash_crash", 3.5, 6, 0),
            "crash2":    ("flatride_crash", 3.0, 0, 0),
            "ride":      ("ride_ride", 3.0, 6, 0),
            "ride2":     ("flatride_ride", 3.0, 4, 0),
            "bell":      ("ride_bell", 3.0, 5, 0),
            "china":     ("crash_sizzle", 3.0, 4, 0),
        },
        "veltrack": {"kick", "hhclosed", "hhpedal", "hhopen", "crash", "crash2", "ride", "ride2", "bell", "china"},
        "notes": {35: "kick", 36: "kick", 37: "sidestick", 38: "snare", 40: "rimshot",
                  41: "ftom1", 43: "ftom1", 58: "ftom1", 45: "tom2", 47: "tom2", 48: "tom1", 50: "tom1",
                  42: "hhclosed", 44: "hhpedal", 46: "hhopen", 49: "crash", 57: "crash2",
                  51: "ride", 59: "ride2", 53: "bell", 52: "china", 55: "crash2"},
        "mics": {"oh": 1.0, "kickmic": 1.0, "snaremic": 1.0},
    },
}


class Hit:
    def __init__(self, audio, sr, vel, group):
        self.audio, self.sr, self.vel, self.group = audio, sr, float(vel), group


def _stereo(x):
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 1:
        return np.stack([x, x], axis=1)
    return x[:, :2] if x.shape[1] >= 2 else np.repeat(x, 2, axis=1)


# ── Sources ──────────────────────────────────────────────────────────────

def crocell_hits(src: Path, instrument: str):
    """DrumGizmo instrument XML: velocity from the hit's power (amplitude ~ sqrt(power))."""
    xml_path = src / instrument / (instrument + ".xml")
    root = ET.parse(xml_path).getroot()
    rows = []
    for s in root.iter("sample"):
        power = float(s.get("power", "0"))
        files = {a.get("channel"): a for a in s.iter("audiofile")}
        a = files["Left"] if "Left" in files else next(iter(files.values()))
        rows.append((power, (xml_path.parent / a.get("file")).resolve()))
    if not rows:
        raise SystemExit("no samples in " + str(xml_path))
    pmax = max(p for p, _ in rows)
    hits = []
    for i, (p, f) in enumerate(rows):
        if not f.is_relative_to(src.resolve()):
            raise SystemExit("sample outside the source folder: " + str(f))
        data, sr = sf.read(str(f), dtype="float32", always_2d=True)
        vel = max(1.0, 127.0 * (p / pmax) ** 0.5)
        hits.append(Hit(_stereo(data), sr, vel, i))
    return hits


_REGION_KEYS = ("sample", "lovel", "hivel", "seq_position")


def _sfz_regions(path: Path):
    regions, cur = [], None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.split("//")[0].strip()
        if not line:
            continue
        if line.startswith("<region>"):
            cur = {}
            regions.append(cur)
            line = line[len("<region>"):].strip()
        for m in re.finditer(r"(\w+)=(\S+)", line):
            if cur is not None and m.group(1) in _REGION_KEYS:
                cur[m.group(1)] = m.group(2)
    return [r for r in regions if "sample" in r]


def virtuosity_hits(src: Path, name: str, mics: dict, veltrack: bool):
    """SFZ map of the overhead mic; the other mics' files have the same name with their prefix."""
    regions = _sfz_regions(src / "Programs" / "mappings" / "oh" / (name + "_map.sfz"))
    hits = []
    for r in regions:
        lo, hi = int(r.get("lovel", 1)), int(r.get("hivel", 127))
        oh_file = (src / "Programs" / r["sample"].replace("\\", "/")).resolve()
        if not oh_file.is_relative_to(src.resolve()):
            raise SystemExit("sample outside the source folder: " + str(oh_file))
        mix, sr = None, None
        for mic, g in mics.items():
            f = Path(str(oh_file).replace("\\oh\\", "\\" + mic + "\\").replace("/oh/", "/" + mic + "/"))
            f = f.with_name(re.sub(r"^oh_", mic + "_", f.name))
            if not f.exists():
                continue
            d, sr = sf.read(str(f), dtype="float32", always_2d=True)
            d = _stereo(d) * g
            if mix is None:
                mix = d
            else:
                n = max(len(mix), len(d))
                mix = np.pad(mix, ((0, n - len(mix)), (0, 0))) + np.pad(d, ((0, n - len(d)), (0, 0)))
        vel = (lo + hi) / 2.0
        if veltrack:
            mix = mix * (0.4 + 0.6 * vel / 127.0)
        hits.append(Hit(mix, sr, vel, (lo, hi)))
    if not hits:
        raise SystemExit("no regions for " + name)
    return hits


# ── Processing ───────────────────────────────────────────────────────────

def pick_layers(hits):
    """[(vel, [hit, hit])] — groups nearest the target velocities, two round-robins each."""
    groups = {}
    for h in hits:
        groups.setdefault(h.group, []).append(h)
    gl = sorted(groups.values(), key=lambda g: np.mean([h.vel for h in g]))
    gvel = [float(np.mean([h.vel for h in g])) for g in gl]
    chosen = []
    for t in LAYER_TARGETS:
        order = sorted(range(len(gl)), key=lambda i: abs(gvel[i] - t))
        i = next((i for i in order if i not in chosen), None)
        if i is not None:
            chosen.append(i)
    chosen = sorted(set(chosen))
    used = set(chosen)
    layers = []
    for i in chosen:
        rr = list(gl[i][:ROUND_ROBINS])
        if len(rr) < ROUND_ROBINS:   # no round-robins recorded: borrow the neighbouring dynamic
            for j in sorted(range(len(gl)), key=lambda j: abs(gvel[j] - gvel[i])):
                if j not in used and len(rr) < ROUND_ROBINS:
                    rr.append(gl[j][0])
                    used.add(j)
        layers.append((gvel[i], rr))
    return layers


def shape(audio, sr, max_s):
    """Cut to the onset (1 ms pre-roll) and the decay tail; fade out the end."""
    mono = np.abs(audio).max(axis=1)
    peak = float(mono.max()) or 1.0
    on = np.flatnonzero(mono > peak * 10 ** (-24 / 20))
    start = max(0, int(on[0]) - int(0.001 * sr)) if len(on) else 0
    tail = np.flatnonzero(mono > peak * 10 ** (-60 / 20))
    end = int(tail[-1]) + 1 if len(tail) else len(mono)
    end = min(end, start + int(max_s * sr))
    out = audio[start:end].copy()
    n = len(out)
    fade = min(n // 3, int(0.25 * n) + int(0.02 * sr))
    if fade > 0:
        out[n - fade:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, fade)))[:, None].astype(np.float32)
    fade_in = min(n, int(0.0005 * sr))
    if fade_in > 1:
        out[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)[:, None]
    return out


def pitch(audio, semis):
    if not semis:
        return audio
    fr = Fraction(2 ** (semis / 12)).limit_denominator(64)
    # Resampling by 1/ratio and playing at the original rate shifts pitch (and length) like a tuned drum.
    return resample_poly(audio, fr.denominator, fr.numerator, axis=0).astype(np.float32)


def _level(files):
    """Mean RMS (dB) of the first 50 ms of a layer's samples."""
    vals = []
    for _, a, sr in files:
        head = a[: max(1, int(0.05 * sr))]
        vals.append(np.sqrt(np.mean(head ** 2)) + 1e-9)
    return 20 * np.log10(float(np.mean(vals)))


def encode(audio, sr, path: Path):
    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "x.wav"
        sf.write(str(wav), audio, sr, subtype="FLOAT")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-map_metadata", "-1",
                        "-c:a", "libvorbis", "-q:a", VORBIS_Q, str(path)], check=True)


def build(kit_id: str, src: Path, out: Path):
    spec = KITS[kit_id]
    rendered = {}   # piece -> [(vel, [(file, audio, sr)])]
    for piece, (source, max_s, gain_db, semis) in spec["pieces"].items():
        if kit_id == "crocell":
            hits = crocell_hits(src, source)
        else:
            hits = virtuosity_hits(src, source, spec["mics"], piece in spec["veltrack"])
        layers = []
        for li, (vel, rr) in enumerate(pick_layers(hits)):
            files = []
            for ri, h in enumerate(rr):
                a = shape(pitch(h.audio, semis), h.sr, max_s) * (10 ** (gain_db / 20))
                files.append(("%s_v%d_%s.ogg" % (piece, li + 1, "abcd"[ri]), a, h.sr))
            layers.append((vel, files))
        # Soft layers of some libraries are very quiet (30+ dB below the top one). Lift a layer to at
        # least SOFT_CURVE below the top layer so a medium pad hit is still clearly audible.
        top = _level(layers[-1][1])
        for i, (vel, files) in enumerate(layers[:-1]):
            floor = top + 20 * np.log10((vel / 127.0) ** SOFT_CURVE)
            lift = floor - _level(files)
            if lift > 0:
                layers[i] = (vel, [(n, a * 10 ** (lift / 20), sr) for n, a, sr in files])
        rendered[piece] = layers
        print("%-10s %-18s %d hits -> layers at vel %s" % (
            piece, source, len(hits), ", ".join("%.0f" % v for v, _ in layers)))

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
            out_layers.append({"lo": lo, "hi": hi, "files": [f for f, _, _ in files]})
        piece_layers[piece] = out_layers
    manifest = {
        "format": 1,
        "name": spec["title"],
        "notes": {str(n): {"piece": p, "layers": piece_layers[p]} for n, p in sorted(spec["notes"].items())},
        "chokes": CHOKES,
    }
    missing = [n for n in GM_NOTES if str(n) not in manifest["notes"]]
    if missing:
        raise SystemExit("unmapped GM notes: %s" % missing)
    (out / "kit.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    total = sum(f.stat().st_size for f in out.iterdir())
    print("%s: %d files, %.1f MB -> %s" % (kit_id, len(list(out.iterdir())), total / 1e6, out))


def main(argv):
    if len(argv) < 2 or argv[0] not in KITS:
        raise SystemExit(__doc__)
    src = Path(argv[1]).resolve()
    out = Path(argv[2]).resolve() if len(argv) > 2 else PLUGIN_DIR / "sounds" / "kits" / argv[0]
    build(argv[0], src, out)


if __name__ == "__main__":
    main(sys.argv[1:])
