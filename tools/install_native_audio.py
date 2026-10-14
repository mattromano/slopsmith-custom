"""Install (or roll back) our patched slopsmith_audio.node in the installed Slopsmith app.

The patched engine adds the live guitar retune (LivePitchShifter, controlled by the
live_retune plugin). Built from the feedBack-desktop worktree `wt-live-pitch`
(branch feat/live-pitch-shift, based on bd60318 = the 0.2.9 snapshot); the C++ change
is also saved as slopsmith-custom/slopsmith-desktop/patches/0003-live-pitch-shift.patch.

    python -I install_native_audio.py            # install the patched build
    python -I install_native_audio.py --restore  # put the original back
    python -I install_native_audio.py --status   # show what's installed

An app update replaces the .node, so re-run this after updating Slopsmith. Writing to
Program Files needs an elevated (Administrator) shell, and Slopsmith must be closed.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys

APP_NODE = r"C:\Program Files\Slopsmith\current\resources\app.asar.unpacked\build\Release\slopsmith_audio.node"
BUILD_NODE = os.path.join(os.path.expanduser("~"), "Desktop", "repos", "feedback-upstream",
                          "wt-live-pitch", "build", "Release", "slopsmith_audio.node")
BACKUP = APP_NODE + ".orig"
APP_VERSION_FILE = r"C:\Program Files\Slopsmith\current\sq.version"
BUILT_FOR = "0.2.9"  # the patched engine is built from this release's snapshot


def app_version():
    import re
    try:
        with open(APP_VERSION_FILE, encoding="utf-8") as f:
            m = re.search(r"<version>([^<]+)</version>", f.read())
        return m.group(1).strip() if m else None
    except OSError:
        return None


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def app_running():
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Slopsmith.exe"],
                             capture_output=True, text=True).stdout
    except OSError:
        return False
    return "slopsmith.exe" in out.lower()


def copy(src, dst):
    try:
        shutil.copy2(src, dst)
    except PermissionError:
        sys.exit("Permission denied writing to Program Files. Re-run from an Administrator shell.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--restore", action="store_true", help="put the original .node back")
    ap.add_argument("--status", action="store_true", help="show hashes only")
    ap.add_argument("--node", default=BUILD_NODE, help="patched .node to install")
    ap.add_argument("--force", action="store_true", help="install even if the app version differs")
    args = ap.parse_args()

    if not os.path.exists(APP_NODE):
        sys.exit(f"Installed engine not found: {APP_NODE}")

    version = app_version()
    print(f"app       : Slopsmith {version or '?'} (patched engine built for {BUILT_FOR})")
    print(f"installed : {sha(APP_NODE)}  {APP_NODE}")
    if os.path.exists(BACKUP):
        print(f"original  : {sha(BACKUP)}  {BACKUP}")
    if os.path.exists(args.node):
        print(f"patched   : {sha(args.node)}  {args.node}")
    if args.status:
        return

    if app_running():
        sys.exit("Slopsmith is running. Close it first (the .node is locked while it runs).")

    if args.restore:
        if not os.path.exists(BACKUP):
            sys.exit("No backup to restore from.")
        copy(BACKUP, APP_NODE)
        print(f"restored original -> {sha(APP_NODE)}")
        return

    if version != BUILT_FOR and not args.force:
        sys.exit(f"Slopsmith is {version}, but the patched engine was built for {BUILT_FOR}. Rebuild "
                 "wt-live-pitch on the new release's snapshot first (or pass --force).")
    if not os.path.exists(args.node):
        sys.exit(f"Patched build not found: {args.node} (run `npm run build:audio` in wt-live-pitch)")
    if not os.path.exists(BACKUP):
        copy(APP_NODE, BACKUP)
        print(f"backed up original -> {BACKUP}")
    elif (sha(APP_NODE) not in (sha(BACKUP), sha(args.node))
          and os.path.getmtime(APP_NODE) < os.path.getmtime(APP_VERSION_FILE) + 3600):
        # The app was updated since the backup (its .node is as old as the install, not one we
        # copied in later): keep the new original instead. A different patched build installed
        # by this script is newer than the app install and must not replace the stock backup.
        copy(APP_NODE, BACKUP)
        print(f"app engine changed since last backup; refreshed {BACKUP}")
    copy(args.node, APP_NODE)
    print(f"installed patched engine -> {sha(APP_NODE)}")


if __name__ == "__main__":
    main()
