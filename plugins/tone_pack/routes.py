"""Tone pack: ready-made Audio-plugin presets for every Tone Automation category.

GET /api/plugins/tone_pack/presets
    {version, presets: {name: preset}, targets: {category: name}, missing: [...], kilohearts: bool}
    Each preset is in the Audio plugin's `slopsmith-chain-presets` shape: `nativePreset` (the desktop
    engine's chain JSON: NAM / IR / VST stages by file path, no saved knob state), `items`,
    `inputGain` / `outputGain` (linear), `noiseGate`, `tonePolish`, plus `generatedBy: "tone_pack"`.
    Chains are built only from captures / IRs that exist on this computer (Rig Builder's
    nam_models / nam_irs folders), so a missing file drops that stage or that preset.

screen.js merges them into localStorage (never touching presets the user made) and fills empty
Tone Automation targets.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

VERSION = 1
TARGET_LOUDNESS_DB = -19.0      # Main Lead's capture sits here; level-match the rest to it
VST3_DIRS = [Path(os.environ.get("COMMONPROGRAMFILES", r"C:\Program Files\Common Files")) / "VST3"]

# Stage kinds -> engine slot type (ProcessorSlot::Type: VST 0, NAM 1, IR 2)
_TYPES = {"VST": 0, "NAM": 1, "IR": 2}

# Category -> preset recipe. Stages are tried in order; `alt` lists fallbacks for a stage.
# The amp capture's loudness (NAM metadata) sets the output gain.
RECIPES = [
    {"category": "clean", "name": "Auto · Clean (Twin Reverb)", "stages": [
        ("NAM", "amps/Tim R Fender Twin Reverb Ch1 BR G06.nam", ["amps/Tim R JC 120 CH 2 Hi.nam",
                                                                 "amps/1 Orange AD30 Ch2 Cleanest.nam"]),
        ("IR", "rocksmith/cab_tw112c_03.wav", ["rocksmith/cab_ca112c_03.wav"]),
    ]},
    {"category": "od", "name": "Auto · Crunch (Marshall DSL40)", "gate": -62, "stages": [
        ("NAM", "amps/Marshall DSL 40 C Crunch.nam", ["amps/Fender_57CustomDeluxe_crunch_in2_1000epochs.nam",
                                                      "other/RC JCM900 ChA.nam"]),
        ("IR", "rocksmith/cab_marshall1960a_03.wav", ["rocksmith/cab_marshall1960ax_03.wav"]),
    ]},
    {"category": "dist", "name": "Auto · Distortion (5153)", "gate": -55, "stages": [
        ("NAM", "other/5153.nam", ["other/RC JCM900 ChB.nam", "amps/OB1 JCM 900 Ch. A - 272 higher gain.nam"]),
        ("IR", "rocksmith/cab_marshall1960ax_04.wav", ["rocksmith/cab_marshall1960a_04.wav"]),
    ]},
    {"category": "solo", "name": "Auto · Lead (Mesa Mark V)", "gate": -58, "stages": [
        ("NAM", "amps/Mesa Boogie Mark V Lead V2.2 Amp Only.nam", ["amps/Hiwatt DR 103 Crancked.nam"]),
        ("IR", "rocksmith/cab_marshall1960a_03.wav", ["rocksmith/cab_orangeppc412_03.wav"]),
    ]},
    {"category": "bass", "name": "Auto · Bass (Ampeg SVT)", "stages": [
        ("NAM", "amps/SVT CLEAN.nam", ["amps/Standard SWR WorkingPro 700 G05.nam",
                                       "amps/Fender Bassman 100T Vintage Channel Vol 5 Flat EQ Master Vol 10.nam"]),
        ("IR", "rocksmith/bass_cab_at810bc_03.wav", ["rocksmith/bass_cab_bt410bc_03.wav"]),
    ]},
    {"category": "acoustic", "name": "Auto · Acoustic (emulator)", "stages": [
        ("NAM", "pedals/tone3000_29201_m125801_Pedal_AcousticEmulator.nam", []),
    ]},
    {"category": "mod", "name": "Auto · Clean Chorus (Twin)", "stages": [
        ("NAM", "pedals/tone3000_26327_m99790_Pedal_Chorus.nam", []),
        ("NAM", "amps/Tim R Fender Twin Reverb Ch1 BR G06.nam", ["amps/Tim R JC 120 CH 2 Hi.nam"]),
        ("IR", "rocksmith/cab_tw112c_03.wav", ["rocksmith/cab_ca112c_03.wav"]),
    ]},
]

# Kilohearts Essentials (free) stand in for the static chorus capture when installed.
KILOHEARTS_MOD = ["kHs Chorus", "kHs Delay", "kHs Reverb"]


def _find_vst3(name: str) -> Path | None:
    for root in VST3_DIRS:
        if not root.is_dir():
            continue
        for p in root.rglob(f"{name}.vst3"):
            return p
    return None


def _loudness(path: Path) -> float | None:
    try:
        with open(path, encoding="utf-8") as f:
            md = (json.load(f).get("metadata") or {})
        v = md.get("loudness")
        return float(v) if v is not None else None
    except (OSError, ValueError, TypeError):
        return None


def _resolve(models: Path, irs: Path, kind: str, rel: str, alts) -> Path | None:
    base = models if kind == "NAM" else irs
    for r in [rel, *alts]:
        p = base / r
        if p.is_file():
            return p
    return None


def _stage(kind: str, path: Path, sid: int) -> dict:
    label = {"NAM": "NAM", "IR": "IR", "VST": "VST"}[kind]
    return {"id": sid, "type": _TYPES[kind], "name": f"{label}: {path.stem}", "path": str(path), "bypassed": False}


def build_presets(config_dir: Path) -> dict:
    models, irs = config_dir / "nam_models", config_dir / "nam_irs"
    presets, targets, missing = {}, {}, []
    kh = [_find_vst3(n) for n in KILOHEARTS_MOD]
    have_kh = all(kh)
    for rec in RECIPES:
        chain, level_db = [], None
        stages = rec["stages"]
        if rec["category"] == "mod" and have_kh:
            # real modulation: clean amp + cab, then chorus / delay / reverb VSTs
            stages = [s for s in stages if "Chorus" not in s[1]]
        for kind, rel, alts in stages:
            p = _resolve(models, irs, kind, rel, alts)
            if p is None:
                missing.append(f"{rec['name']}: {rel}")
                continue
            chain.append(_stage(kind, p, len(chain) + 1))
            # output level follows the amp capture (else the first capture in the chain)
            if kind == "NAM" and (level_db is None or p.parent.name in ("amps", "other")):
                lv = _loudness(p)
                if lv is not None and (level_db is None or p.parent.name in ("amps", "other")):
                    level_db = lv
        if not any(s["type"] == _TYPES["NAM"] for s in chain):
            chain = None
        if not chain:
            continue
        name = rec["name"]
        if rec["category"] == "mod" and have_kh:
            name = "Auto · Clean Chorus + Delay (Kilohearts)"
            for p in kh:
                chain.append(_stage("VST", p, len(chain) + 1))
        native = {"version": 1, "chain": chain}
        out_db = 0.0 if level_db is None else max(-12.0, min(12.0, TARGET_LOUDNESS_DB - level_db))
        presets[name] = {
            "nativePreset": json.dumps(native, indent=2),
            "items": [{"type": k, "path": s["path"], "name": s["name"]}
                      for s in chain for k in [next(t for t, v in _TYPES.items() if v == s["type"])]],
            "inputGain": 1.0,
            "outputGain": round(10 ** (out_db / 20.0), 4),
            "noiseGate": {"enabled": "gate" in rec, "thresholdDb": rec.get("gate", -60),
                          "releaseMs": 120, "depthDb": -60},
            "generatedBy": "tone_pack",
            "toneFormVersion": VERSION,
            "created": 0,
        }
        targets[rec["category"]] = name
    return {"version": VERSION, "presets": presets, "targets": targets, "missing": missing, "kilohearts": have_kh}


def setup(app, context):
    config_dir = Path(context["config_dir"])

    @app.get("/api/plugins/tone_pack/presets")
    def tone_pack_presets():
        return build_presets(config_dir)
