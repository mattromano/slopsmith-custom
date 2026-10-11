"""Route every native setGain('chain', ...) in Audio Engine, NAM Tone and Rig Builder through the
Guitar Volume master (window.__gvChain). Re-run after any of those plugins updates; already-patched
calls are skipped.

    python patch_callers.py [BACKUP_DIR]
"""
import os
import shutil
import sys
from pathlib import Path

P = Path(os.environ["APPDATA"]) / "slopsmith-desktop" / "plugins"
BACKUP = Path(sys.argv[1]) if len(sys.argv) > 1 else None


def gv(api, v):
    return f"(window.__gvChain ? window.__gvChain({api}, {v}) : {api}.setGain('chain', {v}))"


EDITS = {
    "audio_engine/screen.js": [
        ("api.setGain('chain', dbToLinearGain(outDbR));", gv("api", "dbToLinearGain(outDbR)") + ";"),
        ("api.setGain('chain', dbToLinearGain(db));", gv("api", "dbToLinearGain(db)") + ";"),
        ("_api.setGain('chain', outputLin);", gv("_api", "outputLin") + ";"),
    ],
    "nam_tone/screen.js": [
        ("api.setGain(kind, value).catch(",
         "(kind === 'chain' && window.__gvChain ? window.__gvChain(api, value) : api.setGain(kind, value)).catch("),
        ("await api.setGain('chain', 1.0);", "await " + gv("api", "1.0") + ";"),
    ],
    "nam_rig_builder/screen.js": [
        ("return audio.setGain('chain', target).catch(", "return " + gv("audio", "target") + ".catch("),
        ("audio.setGain('chain', base * val).catch(", gv("audio", "base * val") + ".catch("),
        ("await audio.setGain('chain', 0);", "await " + gv("audio", "0") + ";"),
        ("await audio.setGain('chain', v);", "await " + gv("audio", "v") + ";"),
        ("await api.setGain('chain', 1.0).catch(", "await " + gv("api", "1.0") + ".catch("),
    ],
}

for rel, edits in EDITS.items():
    f = P / rel
    if not f.exists():
        print(f"{rel}: not installed, skipped")
        continue
    text = f.read_bytes().decode("utf-8")
    done = 0
    for old, new in edits:
        # count the bare call only where it isn't already inside the patched expression
        bare = text.replace(new, "").count(old)
        if bare == 0:
            if new not in text:
                print(f"{rel}: WARNING, call not found (plugin changed?): {old}")
            continue
        text = text.replace(new, "\0GV\0").replace(old, new).replace("\0GV\0", new)
        done += 1
    if done:
        if BACKUP:
            (BACKUP / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, BACKUP / rel)
        f.write_bytes(text.encode("utf-8"))
    print(f"{rel}: {done} patched, {len(edits) - done} already done")
