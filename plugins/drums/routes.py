"""Server routes for the drums plugin.

GET /api/plugins/drums/static/{name}
    Serves the plugin's extra browser modules that screen.js loads on demand for the 3D view
    (plugin.json can only name one script). Only the whitelisted files below are served.

GET /api/plugins/drums/sounds/{name}
    The drum synth's player and General MIDI drum samples (sounds/, see sounds/README.md), served
    locally so drum sounds work offline and nothing loads from third-party sites.

GET /api/plugins/drums/kit-mapping
    The e-kit's pad mapping from Clone Hero's active MIDI profile (read live, so remapping the kit
    in Clone Hero carries over). screen.js uses it as the default MIDI map when no Learn map is saved.
"""

import configparser
import os
import re
from pathlib import Path

from fastapi.responses import Response

_PLUGIN_DIR = Path(__file__).resolve().parent
_SOUND_NAME = re.compile(r"WebAudioFontPlayer\.js|128\d{2}_0_JCLive_sf2_file\.js")
_ASSETS = {
    "engine.js": "application/javascript",
    "highway3d.js": "application/javascript",
}


# Clone Hero pro-drums binding names -> this plugin's lane ids (lanes are by colour:
# ride = blue cymbal, crash = green cymbal, tom1/2/3 = yellow/blue/green tom).
_CH_LANES = {
    "Kick Pad": "kick", "Red Pad": "snare",
    "Yellow Pad": "tom1", "Blue Pad": "tom2", "Green Pad": "tom3",
    "Yellow Cymbal": "hihat", "Blue Cymbal": "ride", "Green Cymbal": "crash",
}


def clone_hero_dirs():
    """Folders Clone Hero may keep its settings in (CLONE_HERO_DIR first)."""
    home = Path.home()
    cands = []
    if os.environ.get("CLONE_HERO_DIR"):
        cands.append(Path(os.environ["CLONE_HERO_DIR"]))
    cands += [home / "Documents" / "Clone Hero", home / "OneDrive" / "Documents" / "Clone Hero",
              home / "Clone Hero", home / "Library" / "Application Support" / "Clone Hero"]
    return [d for d in cands if (d / "MIDI Profiles").is_dir()]


def _active_device_names(ch_dir: Path):
    """midi_device_name of each profile in profiles.ini, profile0 first."""
    ini = configparser.ConfigParser(interpolation=None)
    try:
        ini.read(ch_dir / "profiles.ini", encoding="utf-8")
    except (OSError, configparser.Error):
        return []
    names = []
    for sec in sorted(ini.sections()):
        n = ini.get(sec, "midi_device_name", fallback="").strip()
        if n and n not in names:
            names.append(n)
    return names


def parse_ch_midi_profile(text: str):
    """Clone Hero MIDI profile YAML -> (device, {midi: lane_id}, {midi: min_velocity})."""
    import yaml
    data = yaml.safe_load(text) or {}
    mapping, min_vel = {}, {}
    for ch_name, entries in (data.get("Mappings") or {}).items():
        lane = _CH_LANES.get(ch_name)
        if not lane or not isinstance(entries, list):
            continue
        for e in entries:
            try:
                n = int(e.get("NoteNumber"))
            except (TypeError, ValueError, AttributeError):
                continue
            if 0 <= n <= 127 and n not in mapping:
                mapping[n] = lane
                v = e.get("Velocity")
                if isinstance(v, (int, float)) and v > 0:
                    min_vel[n] = int(v)
    return data.get("DeviceName") or "", mapping, min_vel


def find_kit_mapping():
    """The active Clone Hero profile's kit mapping, or {'mapping': None, 'reason': ...}."""
    dirs = clone_hero_dirs()
    if not dirs:
        return {"mapping": None, "reason": "Clone Hero settings folder not found"}
    for d in dirs:
        prof_dir = d / "MIDI Profiles"
        files = sorted(prof_dir.glob("*.yaml"), key=lambda p: p.stat().st_mtime, reverse=True)
        by_name = {f.stem: f for f in files}
        pick = next((by_name[n] for n in _active_device_names(d) if n in by_name), None)
        pick = pick or (files[0] if files else None)
        if pick is None:
            continue
        try:
            device, mapping, min_vel = parse_ch_midi_profile(pick.read_text(encoding="utf-8"))
        except Exception as e:  # malformed YAML etc.
            return {"mapping": None, "reason": f"Could not read {pick.name}: {e}"}
        if mapping:
            return {"mapping": {str(k): v for k, v in sorted(mapping.items())},
                    "min_velocity": {str(k): v for k, v in sorted(min_vel.items())},
                    "device": device or pick.stem, "source": str(pick)}
    return {"mapping": None, "reason": "No Clone Hero MIDI profile with drum mappings"}


def setup(app, context):
    log = context.get("log") if isinstance(context, dict) else None

    @app.get("/api/plugins/drums/sounds/{name}")
    def drums_sound(name: str):
        if not _SOUND_NAME.fullmatch(name):
            return Response("", status_code=404)
        try:
            body = (_PLUGIN_DIR / "sounds" / name).read_bytes()
        except OSError:
            return Response("", status_code=404)
        # Content never changes for a given file name: let the browser keep it.
        return Response(body, media_type="application/javascript",
                        headers={"Cache-Control": "public, max-age=604800"})

    @app.get("/api/plugins/drums/kit-mapping")
    def drums_kit_mapping():
        return find_kit_mapping()

    @app.get("/api/plugins/drums/static/{name}")
    def drums_static(name: str):
        media_type = _ASSETS.get(name)
        if media_type is None:
            return Response("", status_code=404)
        path = _PLUGIN_DIR / name
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            if log:
                log.warning("drums: missing plugin asset %s", name)
            return Response("", status_code=404)
        # no-cache: the browser revalidates, so an updated plugin is picked up (screen.js also adds ?v=).
        return Response(body, media_type=media_type, headers={"Cache-Control": "no-cache"})
