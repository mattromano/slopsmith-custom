"""Build an isolated Slopsmith test instance for branch work (e.g. feat/open-source-pedals).

The test instance runs the desktop app from the engine worktree (its own slopsmith_audio.node),
with its own Electron user-data folder, plugins folder and config, so the installed app and its
files are never touched. It shares only the song library (read-only use).

    python -I setup_test_instance.py            # create / refresh C:\\Users\\<you>\\SlopsmithTest
    python -I setup_test_instance.py --plugins  # refresh only the plugin copy

Then start it with launch_test_instance.cmd. Never run it while the installed Slopsmith is open:
on startup the desktop app reclaims port 18000 by stopping any Slopsmith backend listening there.
"""
import argparse
import os
import shutil
import sys
from pathlib import Path

# Makes the calls do nothing where claude-progress is not installed.
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # no __pycache__ in the plugin
try:
    sys.path.insert(0, os.environ["CLAUDE_PROGRESS_DIR"]); from claude_progress import claude_progress
except Exception:
    def claude_progress(*args): pass
finally:
    sys.dont_write_bytecode = _bytecode

HOME = Path.home()
REAL_USERDATA = Path(os.environ.get("APPDATA", HOME / "AppData" / "Roaming")) / "slopsmith-desktop"
REAL_CORE = Path(r"C:\Program Files\Slopsmith\current\resources\slopsmith")
TEST = HOME / "SlopsmithTest"
TEST_USERDATA = TEST / "userdata"
TEST_CORE = TEST / "core"

# Small settings worth carrying over so the test app starts configured (library DB avoids a
# full rescan). Caches (sloppak/art/audio/torch, pip packages) are left behind.
CONFIG_FILES = [
    "config.json", "web_library.db", "nam_tone.db", "rig_builder_cache.db", "midi_mappings.db",
    "rig_builder_settings.json", "rig_builder_known_vsts.json", "tuner.json", "song_cents.json",
]
CONFIG_DIRS = ["nam_models", "nam_irs", "nam_rig_builder"]
USERDATA_FILES = ["slopsmith-audio-settings.json", "slopsmith-desktop.json"]
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", "*.bak", "*.bak-*")


def files_under(paths):
    out = []
    for p in paths:
        if p.is_file():
            out.append(p)
        elif p.is_dir():
            out.extend(f for f in p.rglob("*") if f.is_file() and "__pycache__" not in f.parts)
    return out


def copy_tree(src, dst, label, done_bytes, total_bytes):
    """Copy a directory tree, reporting progress by bytes."""
    state = {"done": done_bytes, "n": 0}

    def copy_fn(s, d):
        shutil.copy2(s, d)
        state["done"] += os.path.getsize(d)
        state["n"] += 1
        if state["n"] % 200 == 0:
            claude_progress("-n", "test-instance", f"{state['done'] / 1e6:.0f}M/{total_bytes / 1e6:.0f}M", label)

    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=SKIP, copy_function=copy_fn)
    return state["done"]


def copy_db(src, dst):
    """SQLite files: copy with their WAL/SHM side files so a checkpoint isn't lost."""
    for suffix in ("", "-wal", "-shm"):
        s = Path(str(src) + suffix)
        if s.exists():
            shutil.copy2(s, Path(str(dst) + suffix))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plugins", action="store_true", help="refresh only the plugin copy")
    args = ap.parse_args()

    TEST_USERDATA.mkdir(parents=True, exist_ok=True)
    cfg = TEST_USERDATA / "slopsmith-config"
    cfg.mkdir(exist_ok=True)

    trees = [(REAL_USERDATA / "plugins", TEST_USERDATA / "plugins", "plugins")]
    if not args.plugins:
        trees.insert(0, (REAL_CORE, TEST_CORE, "core"))
        trees += [(REAL_USERDATA / "slopsmith-config" / d, cfg / d, d) for d in CONFIG_DIRS
                  if (REAL_USERDATA / "slopsmith-config" / d).is_dir()]
    total = sum(f.stat().st_size for f in files_under([t[0] for t in trees]))
    done = 0
    try:
        for src, dst, label in trees:
            claude_progress("-n", "test-instance", f"{done / 1e6:.0f}M/{total / 1e6:.0f}M", label)
            done = copy_tree(src, dst, label, done, total)
            print(f"copied {label}: {src} -> {dst}")
        if not args.plugins:
            for name in CONFIG_FILES:
                src = REAL_USERDATA / "slopsmith-config" / name
                if src.exists():
                    (copy_db if name.endswith(".db") else shutil.copy2)(src, cfg / name)
            for name in USERDATA_FILES:
                src = REAL_USERDATA / name
                if src.exists():
                    shutil.copy2(src, TEST_USERDATA / name)
            print(f"copied settings into {cfg}")
    except Exception as e:
        claude_progress("-n", "test-instance", "fail", str(e))
        raise
    claude_progress("-n", "test-instance", "done", str(TEST))
    print(f"test instance ready in {TEST}")


if __name__ == "__main__":
    main()
