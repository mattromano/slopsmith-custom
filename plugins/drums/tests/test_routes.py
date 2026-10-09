"""routes.py serves only the whitelisted browser modules for the 3D view."""

import importlib.util
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _client():
    spec = importlib.util.spec_from_file_location("drums_routes_under_test", PLUGIN_DIR / "routes.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = FastAPI()
    mod.setup(app, {})
    return TestClient(app)


def test_serves_whitelisted_modules():
    c = _client()
    for name in ("engine.js", "highway3d.js"):
        r = c.get(f"/api/plugins/drums/static/{name}")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/javascript")
        assert r.text == (PLUGIN_DIR / name).read_text(encoding="utf-8")


def test_rejects_everything_else():
    c = _client()
    for name in ("screen.js", "routes.py", "plugin.json", "..%2Froutes.py", "NOTICE.md", "missing.js"):
        assert c.get(f"/api/plugins/drums/static/{name}").status_code == 404
    assert c.get("/api/plugins/drums/static/../routes.py").status_code == 404



def _load_routes():
    spec = importlib.util.spec_from_file_location("drums_routes_kitmap", PLUGIN_DIR / "routes.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


routes = _load_routes()

CH_PROFILE = """DeviceName: CH 2
Mappings:
  Red Pad:
  - NoteNumber: 38
    Velocity: 10
    OverHitThreshold: 0
  Yellow Pad:
  - NoteNumber: 48
    Velocity: 10
  Blue Pad:
  - NoteNumber: 45
  Green Pad:
  - NoteNumber: 43
  Kick Pad:
  - NoteNumber: 36
  Yellow Cymbal:
  - NoteNumber: 42
  - NoteNumber: 46
  - NoteNumber: 24
  Blue Cymbal:
  - NoteNumber: 49
  Green Cymbal:
  - NoteNumber: 51
  Start: []
  Select: []
"""


def test_parse_clone_hero_profile_maps_by_colour():
    device, mapping, min_vel = routes.parse_ch_midi_profile(CH_PROFILE)
    assert device == "CH 2"
    assert mapping == {38: "snare", 48: "tom1", 45: "tom2", 43: "tom3", 36: "kick",
                       42: "hihat", 46: "hihat", 24: "hihat", 49: "ride", 51: "crash"}
    assert min_vel == {38: 10, 48: 10}


def test_find_kit_mapping_uses_the_active_profile(tmp_path, monkeypatch):
    ch = tmp_path / "Clone Hero"
    (ch / "MIDI Profiles").mkdir(parents=True)
    (ch / "MIDI Profiles" / "CH 2.yaml").write_text(CH_PROFILE, encoding="utf-8")
    (ch / "MIDI Profiles" / "Other Kit.yaml").write_text(
        "DeviceName: Other Kit\nMappings:\n  Red Pad:\n  - NoteNumber: 40\n", encoding="utf-8")
    (ch / "profiles.ini").write_text("[profile0]\nmidi_device_name = CH 2\n", encoding="utf-8")
    monkeypatch.setenv("CLONE_HERO_DIR", str(ch))
    monkeypatch.setattr(routes.Path, "home", staticmethod(lambda: tmp_path / "nohome"))
    r = routes.find_kit_mapping()
    assert r["device"] == "CH 2"
    assert r["mapping"]["49"] == "ride" and r["mapping"]["51"] == "crash"
    assert r["source"].endswith("CH 2.yaml")


def test_find_kit_mapping_without_clone_hero(tmp_path, monkeypatch):
    monkeypatch.delenv("CLONE_HERO_DIR", raising=False)
    monkeypatch.setattr(routes.Path, "home", staticmethod(lambda: tmp_path))
    assert routes.find_kit_mapping()["mapping"] is None


def test_bundled_drum_sounds_are_served_locally():
    c = _client()
    r = c.get("/api/plugins/drums/sounds/WebAudioFontPlayer.js")
    assert r.status_code == 200 and "WebAudioFontPlayer" in r.text
    r = c.get("/api/plugins/drums/sounds/12838_0_JCLive_sf2_file.js")
    assert r.status_code == 200 and "_drum_38_0_JCLive_sf2_file" in r.text
    # every note the synth preloads is bundled
    notes = [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 59]
    for n in notes:
        assert (PLUGIN_DIR / "sounds" / f"128{n}_0_JCLive_sf2_file.js").is_file(), n
    # the other kits (screen.js DRUM_KITS) are bundled and served too
    for sf in ("FluidR3_GM_sf2_file", "SBLive_sf2", "Chaos_sf2_file"):
        for n in notes:
            assert (PLUGIN_DIR / "sounds" / f"128{n}_0_{sf}.js").is_file(), (sf, n)
        r = c.get(f"/api/plugins/drums/sounds/12838_0_{sf}.js")
        assert r.status_code == 200 and f"_drum_38_0_{sf}" in r.text, sf
    # nothing else from the plugin folder
    for bad in ("README.md", "..%2Froutes.py", "routes.py", "12838_0_JCLive_sf2_file.js.bak",
                "12838_5_FluidR3_GM_sf2_file.js", "12838_0_Other_sf2.js"):
        assert c.get(f"/api/plugins/drums/sounds/{bad}").status_code == 404, bad


SAMPLED_KITS = ("crocell", "virtuosity")   # screen.js DRUM_KITS type 'samples'
GM_NOTES = [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 59]


def test_sampled_kits_are_served_with_every_file():
    import json
    c = _client()
    for kit in SAMPLED_KITS:
        r = c.get(f"/api/plugins/drums/sounds/kits/{kit}/kit.json?v=1")
        assert r.status_code == 200, kit
        assert r.headers["content-type"].startswith("application/json")
        assert "max-age" in r.headers["cache-control"]
        manifest = r.json()
        assert manifest == json.loads((PLUGIN_DIR / "sounds" / "kits" / kit / "kit.json").read_text(encoding="utf-8"))
        for n in GM_NOTES:
            layers = manifest["notes"][str(n)]["layers"]
            assert layers and layers[0]["lo"] == 1 and layers[-1]["hi"] == 127, (kit, n)
            for lo_layer, hi_layer in zip(layers, layers[1:]):
                assert hi_layer["lo"] == lo_layer["hi"] + 1, (kit, n)
            for layer in layers:
                for f in layer["files"]:
                    assert routes._KIT_FILE.fullmatch(f), f
                    assert (PLUGIN_DIR / "sounds" / "kits" / kit / f).is_file(), (kit, f)
        first = manifest["notes"]["38"]["layers"][0]["files"][0]
        r = c.get(f"/api/plugins/drums/sounds/kits/{kit}/{first}")
        assert r.status_code == 200 and r.headers["content-type"] == "audio/ogg"
        assert r.content[:4] == b"OggS"
        # every file in the folder is used by the manifest (no stray data shipped)
        used = {f for e in manifest["notes"].values() for l in e["layers"] for f in l["files"]}
        on_disk = {p.name for p in (PLUGIN_DIR / "sounds" / "kits" / kit).iterdir()} - {"kit.json"}
        assert on_disk == used, kit


def test_sampled_kit_route_rejects_traversal_and_other_files():
    c = _client()
    bad = [
        "crocell/..%2F..%2F..%2Froutes.py", "crocell/..%2Fvirtuosity%2Fkit.json", "..%2F..%2Froutes.py/x.ogg",
        "crocell/kit.json.bak", "crocell/README.md", "crocell/x.wav", "crocell/missing.ogg",
        "Crocell/kit.json", "crocell/Snare.ogg", "nope/kit.json", "crocell/.ogg", "..%5C..%5Croutes.py/kit.json",
        "crocell/..%5C..%5C..%5Croutes.py",
    ]
    for path in bad:
        assert c.get(f"/api/plugins/drums/sounds/kits/{path}").status_code == 404, path
    assert c.get("/api/plugins/drums/sounds/kits/../../routes.py").status_code == 404
    assert routes.kit_file_path("..", "kit.json") is None
    assert routes.kit_file_path("crocell", "../routes.py") is None
    assert routes.kit_file_path("crocell", "kit.json") is not None


def test_screen_js_loads_no_third_party_sound_urls():
    src = (PLUGIN_DIR / "screen.js").read_text(encoding="utf-8")
    assert "surikov.github.io" not in src.replace("Same files as surikov.github.io", "")


def test_drums_library_filter_patch(monkeypatch):
    import sys
    import types

    class MetadataDB:
        _ALLOWED_ARRANGEMENT_NAMES = {"Lead", "Rhythm", "Bass", "Combo"}

        def _build_where(self, q="", favorites_only=False, arrangements_has=None,
                         arrangements_lacks=None, naming_mode="legacy"):
            arr = [a for a in (arrangements_has or []) if a in self._ALLOWED_ARRANGEMENT_NAMES]
            where, params = "WHERE title != ''", []
            if arr:
                where += " AND HAS(" + ",".join("?" * len(arr)) + ")"
                params += arr
            return where, params

    fake = types.ModuleType("server")
    fake.MetadataDB = MetadataDB
    monkeypatch.setitem(sys.modules, "server", fake)
    assert routes.allow_drums_library_filter() is True
    assert "Drums" in MetadataDB._ALLOWED_ARRANGEMENT_NAMES
    db = MetadataDB()
    # legacy: core handles Drums itself once whitelisted
    assert db._build_where(arrangements_has=["Drums"]) == ("WHERE title != '' AND HAS(?)", ["Drums"])
    # smart: Drums leaves the smart list and is matched by plain name
    w, p = db._build_where(arrangements_has=["Bass", "Drums"], naming_mode="smart")
    assert w.startswith("WHERE title != '' AND HAS(?)") and w.endswith("AND " + routes._DRUMS_CLAUSE)
    assert p == ["Bass", "Drums"]
    w, p = db._build_where(arrangements_lacks=["Drums"], naming_mode="smart")
    assert w.endswith("AND NOT " + routes._DRUMS_CLAUSE) and p == ["Drums"]
    # no Drums: untouched; patching twice is a no-op
    assert db._build_where(arrangements_has=["Lead"], naming_mode="smart") == ("WHERE title != '' AND HAS(?)", ["Lead"])
    assert routes.allow_drums_library_filter() is True
    assert db._build_where(arrangements_has=["Drums"], naming_mode="smart")[1] == ["Drums"]
