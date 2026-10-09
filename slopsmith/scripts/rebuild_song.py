"""Rebuild a sloppak from its Guitar Pro source, e.g. after marking downbeats in feedBack Studio.

The build recipe comes from the song's manifest `x_build` block (written by
gp_to_sloppak.py), or for older builds from the planner scripts by title.
If the input file contains feedBack Studio sync points (sync/syncpoints.json),
they are used as --anchors automatically.  The previous library file is backed
up to _build/backup/ before it is replaced.

Usage (run with the _build/.mirvenv interpreter so --refine-beats/tab checks work):
  python scripts/rebuild_song.py EDITED.feedpak            # anchors from the edit, replace library copy
  python scripts/rebuild_song.py SONG.sloppak --refine-beats
  python scripts/rebuild_song.py --title "Nika's Got It Wrong" --anchors EDITED.feedpak
  ... [--out other.sloppak] [--no-stems] [--check]
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "_build"))


def recipe_from_manifest(path: Path) -> dict | None:
    with zipfile.ZipFile(path) as z:
        man = yaml.safe_load(z.read("manifest.yaml"))
    return man.get("x_build")


def recipe_from_plans(title: str) -> dict | None:
    import plan_pdath
    import plan_targets
    for j in plan_pdath.build_list() + plan_targets.build_list():
        if j["title"].lower() == title.lower():
            return {"method": j.get("method"), "gp": j["tab"], "audio": j["audio"], "out": j["out"], "tracks": j["spec"],
                    "title": j["title"], "artist": j.get("artist", plan_pdath.ARTIST), "album": j["album"],
                    "year": j["year"], "cover": j.get("cover")}
    return None


def has_syncpoints(path: Path) -> bool:
    try:
        with zipfile.ZipFile(path) as z:
            return any(n.endswith("syncpoints.json") for n in z.namelist())
    except zipfile.BadZipFile:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song", nargs="?", help="edited .feedpak/.sloppak (recipe + anchors read from it)")
    ap.add_argument("--title", help="look the recipe up in the planner scripts instead")
    ap.add_argument("--anchors", help="sync points source (default: the input file, if it has them)")
    ap.add_argument("--no-anchors", action="store_true")
    ap.add_argument("--refine-beats", action="store_true")
    ap.add_argument("--out", help="write here instead of replacing the library copy")
    ap.add_argument("--no-stems", action="store_true")
    ap.add_argument("--notation-only", action="store_true",
                    help="keep the existing build's stems + sync map; rebuild charts only (anchors still apply)")
    ap.add_argument("--check", action="store_true", help="run tab_check on the result")
    a = ap.parse_args()

    src = Path(a.song) if a.song else None
    rec = recipe_from_manifest(src) if src else None
    if rec is None:
        title = a.title
        if title is None and src is not None:
            with zipfile.ZipFile(src) as z:
                title = yaml.safe_load(z.read("manifest.yaml")).get("title")
        rec = recipe_from_plans(title or "")
    if rec is None:
        raise SystemExit("no build recipe: not built by gp_to_sloppak and title not in the planner scripts")

    anchors = None
    if not a.no_anchors:
        anchors = a.anchors or (str(src) if src and has_syncpoints(src) else None)
    out = Path(a.out or rec["out"])

    cmd = [sys.executable, str(ROOT / "scripts" / "gp_to_sloppak.py"), rec["gp"], rec["audio"], str(out),
           "--tracks", rec["tracks"], "--title", rec["title"], "--artist", rec["artist"],
           "--album", str(rec.get("album", "")), "--year", str(rec.get("year", 0)),
           "--report", str(ROOT / "_build" / "logs" / f"{out.stem}_rebuild_report.json")]
    if rec.get("cover") and Path(rec["cover"]).exists():
        cmd += ["--cover", rec["cover"]]
    if rec.get("fill_min_bars"):
        cmd += ["--fill-min-bars", str(rec["fill_min_bars"])]
    if rec.get("method"):
        cmd += ["--method", rec["method"]]
    if a.refine_beats or rec.get("refine_beats"):
        cmd.append("--refine-beats")
    if anchors:
        cmd += ["--anchors", anchors]
    if a.no_stems:
        cmd.append("--no-stems")
    if a.notation_only:
        reuse_from = src if src and src.suffix == ".sloppak" else Path(rec["out"])
        cmd += ["--reuse", str(reuse_from)]
        rep = ROOT / "_build" / "logs" / f"{Path(rec['out']).stem}_rebuild_report.json"
        if rep.exists():
            cmd += ["--reuse-map", str(rep)]

    if out.exists() and not a.out:
        bak = ROOT / "_build" / "backup" / f"{out.stem}.{time.strftime('%Y%m%d-%H%M%S')}{out.suffix}"
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(out, bak)
        print(f"backed up previous build -> {bak}")
    print("anchors:", anchors or "none")
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode:
        raise SystemExit(r.returncode)
    if a.check:
        subprocess.run([sys.executable, str(ROOT / "scripts" / "tab_check.py"), str(out)], cwd=ROOT)


if __name__ == "__main__":
    main()
