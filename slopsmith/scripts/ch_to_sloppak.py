"""YARG / Clone Hero song folder -> new sloppak with a "Drums" arrangement.

  python scripts/ch_to_sloppak.py SONG_FOLDER OUT.sloppak [--difficulty expert]
         [--title T --artist A --album X --year N] [--dir]

SONG_FOLDER holds notes.mid (PART DRUMS) or notes.chart ([ExpertDrums]), song.ini
and the audio (song.ogg and/or guitar/rhythm/bass/drums[_1-4]/vocals/keys .ogg/.opus/
.mp3).  The Expert drums part becomes a 4-lane pro "Drums" arrangement encoded for the
drums plugin (General MIDI drum numbers, midi = string*24 + fret; accents -> ``ac``,
ghosts -> ``mt``, 2x kick = GM 35).  Star power, drum fills and solos ride along in
the arrangement JSON's ``drums`` block.  Beats and sections come from the chart's tempo
map, and song.ini ``delay`` is applied so chart times line up with the audio as YARG
plays it.  Parsing rules are ported from YARG.Core (see lib/drumchart.py).

Audio: a lone song.ogg becomes stems/full.ogg; separate CH stems become sloppak stems
(guitar+rhythm -> guitar, keys -> piano, song -> other, drums_1..4 mixed into drums;
crowd is dropped).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "lib")]

import drumchart  # noqa: E402

STEM_ORDER = ["full", "guitar", "bass", "drums", "vocals", "piano", "other"]
ROLE_TO_STEM = {"guitar": "guitar", "rhythm": "guitar", "bass": "bass", "drums": "drums",
                "vocals": "vocals", "keys": "piano", "song": "other"}


def log(*a):
    print(*a, flush=True)


def ffprobe_seconds(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def encode_mix(inputs: list[Path], out: Path):
    """One or more audio files -> a single OGG (summed, not normalised, like the CH mixer)."""
    cmd = ["ffmpeg", "-v", "error", "-y"]
    for p in inputs:
        cmd += ["-i", str(p)]
    if len(inputs) > 1:
        cmd += ["-filter_complex", f"amix=inputs={len(inputs)}:duration=longest:normalize=0"]
    cmd += ["-vn", "-c:a", "libvorbis", "-q:a", "6", str(out)]
    subprocess.run(cmd, check=True)


def build_stems(folder: Path, stems_dir: Path) -> list[dict]:
    files = drumchart.song_audio_files(folder)
    files.pop("crowd", None)
    if not files:
        raise SystemExit(f"{folder}: no audio (song.ogg / stems) found")
    stems_dir.mkdir(parents=True, exist_ok=True)
    if set(files) == {"song"}:
        encode_mix(files["song"], stems_dir / "full.ogg")
        return [{"id": "full", "file": "stems/full.ogg", "default": True}]
    groups: dict[str, list[Path]] = {}
    for role, paths in files.items():
        groups.setdefault(ROLE_TO_STEM[role], []).extend(paths)
    out = []
    for sid in sorted(groups, key=STEM_ORDER.index):
        encode_mix(groups[sid], stems_dir / f"{sid}.ogg")
        out.append({"id": sid, "file": f"stems/{sid}.ogg", "default": True})
    return out


def parse_year(v) -> int:
    m = re.search(r"\d{4}", str(v or ""))
    return int(m.group(0)) if m else 0


def find_cover(folder: Path) -> Path | None:
    for name in ("album.jpg", "album.png", "album.jpeg", "cover.jpg", "cover.png"):
        p = folder / name
        if p.exists():
            return p
    return None


def zip_dir(work: Path, out: Path):
    tmp = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(work.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(work).as_posix())
    if out.exists():
        out.unlink() if out.is_file() else shutil.rmtree(out)
    tmp.rename(out)


def convert(folder: Path, out: Path, difficulty="expert", title=None, artist=None, album=None, year=None,
            as_dir=False) -> dict:
    folder = Path(folder)
    chart, ini = drumchart.load_song_folder(folder, difficulty)
    if not chart.hits:
        raise SystemExit(f"{folder}: the {difficulty} drums part has no notes")
    if chart.star_power and not chart.fills:   # YARG generates activation fills when a chart has none
        chart.fills = drumchart.auto_fills([h.time for h in chart.hits],
                                           [(b["time"], b["measure"]) for b in chart.beat_list()],
                                           chart.star_power, chart.solos, [t for t, _ in chart.sections])
    work = Path(tempfile.mkdtemp(prefix="ch2slop_"))
    try:
        (work / "arrangements").mkdir()
        stems = build_stems(folder, work / "stems")
        dur = max(ffprobe_seconds(work / s["file"]) for s in stems)
        dur = max(dur, chart.hits[-1].time + 1.0)
        src = {"tool": "ch_to_sloppak", "folder": str(folder.resolve()), "format": chart.source_format,
               "difficulty": difficulty, "delay": round(chart.offset, 4),
               "five_lane": chart.five_lane, "charter": ini.get("charter") or ini.get("frets") or None}
        src = {k: v for k, v in src.items() if v not in (None, "")}
        arr = drumchart.drums_arrangement(chart, with_beats=True, source=src)
        (work / "arrangements" / "drums.json").write_text(json.dumps(arr, separators=(",", ":")), encoding="utf-8")
        manifest = {
            "title": title or ini.get("name") or folder.name,
            "artist": artist or ini.get("artist") or "Unknown",
            "album": album if album is not None else ini.get("album", ""),
            "year": year if year is not None else parse_year(ini.get("year")),
            "duration": round(dur, 3),
        }
        cover = find_cover(folder)
        if cover:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(cover), "-vf",
                            "scale=512:512:force_original_aspect_ratio=decrease", "-q:v", "3",
                            str(work / "cover.jpg")], check=True)
            manifest["cover"] = "cover.jpg"
        manifest["stems"] = stems
        manifest["arrangements"] = [{"id": "drums", "name": "Drums", "file": "arrangements/drums.json",
                                     "tuning": [0] * 6, "capo": 0}]
        manifest["x_build"] = src
        import yaml
        (work / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
                                            encoding="utf-8")
        out = Path(out)
        if as_dir:
            if out.exists():
                shutil.rmtree(out) if out.is_dir() else out.unlink()
            shutil.copytree(work, out)
        else:
            zip_dir(work, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    summary = {"out": str(out), "notes": len(chart.hits), "format": chart.source_format,
               "star_power": len(chart.star_power), "fills": len(chart.fills),
               "sections": len(chart.sections), "delay": chart.offset, "five_lane": chart.five_lane,
               "stems": [s["id"] for s in stems], "duration": manifest["duration"]}
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("out")
    ap.add_argument("--difficulty", default="expert", choices=["easy", "medium", "hard", "expert"])
    ap.add_argument("--title")
    ap.add_argument("--artist")
    ap.add_argument("--album")
    ap.add_argument("--year", type=int)
    ap.add_argument("--dir", action="store_true", help="write the directory form instead of a zip")
    a = ap.parse_args()
    s = convert(Path(a.folder), Path(a.out), a.difficulty, a.title, a.artist, a.album, a.year, a.dir)
    log(f"wrote {s['out']}: {s['notes']} drum notes ({s['format']}), {s['star_power']} star power phrases, "
        f"{s['fills']} fills, {s['sections']} sections, delay {s['delay']:+.3f}s, stems {', '.join(s['stems'])}")


if __name__ == "__main__":
    main()
