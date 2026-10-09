"""Song builder: Guitar Pro tabs + album MP3s -> graded, stem-split sloppaks.

One YAML file describes an album (or any batch of songs); this script plans the
tracks, builds every song with gp_to_sloppak.py, grades the result with
tab_check.py and writes a quality report.

  python scripts/song_builder.py plan  ALBUM.yaml            # show track picks, no building
  python scripts/song_builder.py build ALBUM.yaml [--only "Doom Boy,Possession"] [--refine-beats]
  python scripts/song_builder.py build ALBUM.yaml --notation-only   # charts only, keep stems + sync
  python scripts/song_builder.py check ALBUM.yaml            # (re)grade existing builds
  python scripts/song_builder.py tune  ALBUM.yaml            # settle close DTW-vs-constant-tempo calls by lift
  python scripts/song_builder.py survey TAB.gp|.gp5          # list a tab's tracks
  python scripts/song_builder.py drums ALBUM.yaml [--chart-dir PATH] # add Drums: a Clone Hero chart (local, then
                                                                    #   Chorus Encore online), else the GP drums

build and tune end with the drums step for the songs they built (--no-drums skips it).

Run with _build/.mirvenv/Scripts/python.exe (has basic-pitch + refiner + the host packages).

ALBUM.yaml:
  artist: The Dirty Nil
  album: Fuck Art
  year: 2021
  audio_dir: .                  # relative to the yaml file
  tab_dir: tabs                 # .gp (GP7/8) or .gp3/4/5; .gp files are converted to .gp5 here
  cover: cover.jpg              # optional; falls back to art embedded in each MP3
  short: Dirty_Nil              # output name suffix: <Title>_-_<short>.sloppak
  out_dir: C:/Program Files (x86)/Steam/steamapps/common/Rocksmith2014/dlc/sloppak   # optional
  songs:
    - title: Doom Boy
      tab: Doom Boy             # substring of the tab filename; a list = candidates, the one
                                #   whose length best matches the recording wins
      audio: "01 "              # substring of the MP3 filename
      tracks: auto              # or an explicit spec "0+1:Lead,1+0:Rhythm,2:Bass"
      variant: Songsterr        # optional: appended to the title "(Songsterr)" and the file name
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "lib"), str(ROOT / "scripts")]
DEFAULT_OUT = Path(r"C:\Program Files (x86)\Steam\steamapps\common\Rocksmith2014\dlc\sloppak")
LOGS = ROOT / "_build" / "logs"

NON_GUITAR = re.compile(r"vocal|voice|choir|synth|kalimba|glock|trombone|flute|piano|brass|sawtooth|"
                        r"square|oohs|aahs|lead \d|strings|organ|keys", re.I)


# ── tabs ────────────────────────────────────────────────────────────────────

def ensure_gp5(tab: Path) -> Path:
    """GP7/8 .gp files -> .gp5 next to them in a gp5/ folder (pyguitarpro can't read .gp)."""
    if tab.suffix.lower() != ".gp":
        return tab
    out = tab.parent / "gp5" / (tab.stem + ".gp5")
    if not out.exists():
        out.parent.mkdir(exist_ok=True)
        subprocess.run([sys.executable, str(ROOT / "scripts" / "gp7_to_gp5.py"), str(tab), str(out)], check=True)
    return out


def survey(gp5: Path) -> list[dict]:
    import guitarpro
    import gp2rs
    song = guitarpro.parse(str(gp5))
    info = []
    for i, t in enumerate(song.tracks):
        notes = chords = beats = bars = 0
        for m in t.measures:
            has = False
            for v in m.voices:
                for b in v.beats:
                    if b.notes:
                        has = True
                        beats += 1
                        notes += len(b.notes)
                        chords += len(b.notes) >= 2
            bars += has
        info.append(dict(i=i, name=t.name, strings=len(t.strings), tuning=[s.value for s in t.strings],
                         drums=gp2rs.is_drum_track(t), bass=gp2rs._is_bass_track(t) and not gp2rs.is_drum_track(t),
                         notes=notes, chord_ratio=round(chords / beats, 2) if beats else 0,
                         bars=bars, total_bars=len(t.measures)))
    return info


def tab_seconds(gp5: Path) -> float:
    import guitarpro
    import gp2rs
    song = guitarpro.parse(str(gp5))
    idx = next((i for i, t in enumerate(song.tracks) if not gp2rs.is_drum_track(t)), 0)
    x = gp2rs.convert_track(song, idx, 0.0, "Lead")
    return float(re.search(r"<songLength>([^<]*)", x).group(1))


def plan_tracks(info: list[dict]) -> list[tuple[str, int, list[int]]]:
    """[(arrangement name, primary track, filler tracks)].

    Lead = track named "lead" or the least chordy part; Rhythm = named "rhythm" or the
    chordiest/longest part.  Parts covering < 25% of the bars never get their own
    arrangement; every other guitar part fills empty runs of bars in Lead and Rhythm.
    Vocal/synth/etc. tracks and drums are ignored; Bass = the busiest real bass track."""
    gtr = [t for t in info if not t["drums"] and not t["bass"] and not NON_GUITAR.search(t["name"])
           and t["bars"] >= 3 and t["notes"] >= 30]
    bass = sorted([t for t in info if t["bass"] and not t["drums"] and t["bars"] >= 3], key=lambda t: -t["notes"])
    picks = []
    if gtr:
        most = max(t["bars"] for t in gtr)
        big = [t for t in gtr if t["bars"] >= 0.25 * most]
        named_lead = [t for t in big if re.search(r"\blead\b", t["name"], re.I)]
        named_rhy = [t for t in big if re.search(r"rhythm", t["name"], re.I)]
        lead = max(named_lead, key=lambda t: t["bars"]) if named_lead else None
        rhy = max([t for t in named_rhy if t is not lead], key=lambda t: t["bars"], default=None)
        cand = [t for t in big if t is not lead and t is not rhy]
        if lead is None and cand:
            c = min(cand, key=lambda t: t["chord_ratio"] + 0.5 * (1 - t["bars"] / most))
            if c["chord_ratio"] < 0.8:
                lead = c
                cand.remove(c)
        if rhy is None and cand:
            rhy = max(cand, key=lambda t: t["bars"] * (0.5 + t["chord_ratio"]))
        rest = [t for t in gtr if t is not lead and t is not rhy]
        if lead:
            picks.append(("Lead", lead["i"], [t["i"] for t in sorted(rest, key=lambda t: t["chord_ratio"])]
                          + ([rhy["i"]] if rhy else [])))
        if rhy:
            picks.append(("Rhythm", rhy["i"], [t["i"] for t in sorted(rest, key=lambda t: -t["chord_ratio"])]
                          + ([lead["i"]] if lead else [])))
    if bass:
        picks.append(("Bass", bass[0]["i"], []))
    return picks


def spec_string(picks) -> str:
    return ",".join("+".join(str(x) for x in [i] + fl) + ":" + n for n, i, fl in picks)


# ── jobs ────────────────────────────────────────────────────────────────────

def audio_seconds(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    return float(r.stdout.strip() or 0)


def find_one(folder: Path, key: str, exts) -> Path:
    hits = sorted(p for p in folder.iterdir() if p.suffix.lower() in exts and key.lower() in p.name.lower())
    if not hits:
        raise SystemExit(f"no file matching {key!r} in {folder}")
    return hits[0]


def embedded_cover(audio: Path, cache: Path) -> Path | None:
    out = cache / (audio.stem + ".jpg")
    if not out.exists():
        cache.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(audio), "-an", "-frames:v", "1", str(out)])
    return out if out.exists() else None


def load_jobs(cfg_path: Path) -> list[dict]:
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    base = cfg_path.parent
    audio_dir = (base / cfg.get("audio_dir", ".")).resolve()
    tab_dir = (base / cfg.get("tab_dir", "tabs")).resolve()
    out_dir = Path(cfg.get("out_dir") or DEFAULT_OUT)
    short = cfg.get("short") or re.sub(r"[^A-Za-z0-9]+", "_", cfg["artist"]).strip("_")
    tuning_file = cfg_path.with_name(cfg_path.stem + "_tuning.json")
    tuning = json.loads(tuning_file.read_text()) if tuning_file.exists() else {}
    jobs = []
    for s in cfg["songs"]:
        audio = find_one(audio_dir, s["audio"], {".mp3", ".flac", ".wav", ".ogg", ".m4a"})
        keys = s["tab"] if isinstance(s["tab"], list) else [s["tab"]]
        cands = [ensure_gp5(find_one(tab_dir, k, {".gp", ".gp3", ".gp4", ".gp5", ".gpx"})) for k in keys]
        tab = cands[0]
        if len(cands) > 1:  # pick the version whose length matches the recording
            dur = audio_seconds(audio)
            tab = min(cands, key=lambda c: abs(tab_seconds(c) - dur))
        title = s["title"] + (f" ({s['variant']})" if s.get("variant") else "")
        slug = re.sub(r"[^A-Za-z0-9]+", "_", title.replace("&", "and")).strip("_")
        cover = s.get("cover") or cfg.get("cover")
        cover = (base / cover) if cover else None
        if cover is None or not cover.exists():
            cover = embedded_cover(audio, tab_dir / "covers")
        tracks = s.get("tracks", "auto")
        info = survey(tab)
        if tracks == "auto":
            tracks = spec_string(plan_tracks(info))
        method = s.get("method") or tuning.get(title)
        jobs.append(dict(method=method, title=title, artist=s.get("artist", cfg["artist"]), album=s.get("album", cfg.get("album", "")),
                         year=s.get("year", cfg.get("year", 0)), tab=tab, audio=audio, cover=cover, tracks=tracks,
                         slug=f"{short}_{slug}", out=out_dir / f"{slug}_-_{short}.sloppak",
                         names={int(x.split(':')[0].split('+')[0]): info[int(x.split(':')[0].split('+')[0])]["name"]
                                for x in tracks.split(",")}))
    return jobs


def build(job: dict, extra=(), out=None, tag="") -> dict:
    LOGS.mkdir(parents=True, exist_ok=True)
    rep = LOGS / f"{job['slug']}{tag}_report.json"
    cmd = [sys.executable, str(ROOT / "scripts" / "gp_to_sloppak.py"), str(job["tab"]), str(job["audio"]),
           str(out or job["out"]), "--tracks", job["tracks"], "--title", job["title"], "--artist", job["artist"],
           "--album", str(job["album"]), "--year", str(job["year"]), "--report", str(rep), *extra]
    if job.get("method") and "--method" not in extra:
        cmd += ["--method", job["method"]]
    if job["cover"]:
        cmd += ["--cover", str(job["cover"])]
    t0 = time.time()
    with open(LOGS / f"{job['slug']}{tag}.log", "w", encoding="utf-8") as lf:
        r = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, cwd=ROOT)
    res = {"title": job["title"], "rc": r.returncode, "secs": round(time.time() - t0)}
    if r.returncode == 0 and rep.exists():
        d = json.loads(rep.read_text())
        res.update(onset=round(d.get("onset_score", 0), 2), bars=round(d.get("bar_hit", 0), 2), method=d.get("method"))
    return res


def grade(sync: dict, check: dict) -> tuple[str, list[str]]:
    """A/B/C, driven by tab_check lift (chart notes vs the stem, relative to luck).

    Calibrated on 44 builds (Oct 2026): good single-note/bass parts lift 1.6-4,
    chord-heavy distorted Rhythm parts run lower because Basic Pitch smears thick
    chords, so Rhythm gets lower thresholds.  Bars-on-downbeats is only a hint:
    songs at 50% were fine (half-time downbeat miscounts).  Basic Pitch onsets
    lag ~0.02-0.04 s, so small positive best_shift values are normal."""
    notes = []
    arrs = {n: d for n, d in check.get("arrangements", {}).items() if d.get("lift")}
    onset, bars = sync.get("onset") or 0, sync.get("bars") or 0
    if not arrs:
        return "?", ["no tab_check result"]
    if bars and bars < 0.7:
        notes.append(f"{bars:.0%} of bars on downbeats (usually a half-time miscount if lift is fine)")
    level = "A"
    for n, d in arrs.items():
        rhythm = "rhythm" in n.lower()
        a_thr, c_thr = (1.4, 1.2) if rhythm else (1.5, 1.3)
        if d["lift"] < c_thr:
            level = "C"
            notes.append(f"{n}: lift {d['lift']} - notes rarely match the recording (wrong/AI tab or bad sync)")
        elif d["lift"] < a_thr and level == "A":
            level = "B"
        if d.get("bad_bars"):
            notes.append(f"{n}: weak bars " + ", ".join(f"{b0}-{b1} ({s0:.0f}s)" for b0, b1, s0, _ in d["bad_bars"][:4]))
        if d.get("best_shift") is not None and abs(d["best_shift"] - 0.03) >= 0.08:
            notes.append(f"{n}: about {d['best_shift'] - 0.03:+.2f}s off overall (rebuild with --offset)")
    if level == "A" and onset and onset < 1.4:
        level = "B"
    return level, notes


def run_check(paths: list[Path]) -> dict:
    out = LOGS / "_tabcheck_tmp.json"
    subprocess.run([sys.executable, str(ROOT / "scripts" / "tab_check.py"), *map(str, paths), "--json", str(out)],
                   cwd=ROOT, stdout=subprocess.DEVNULL)
    return {Path(r["file"]).name: r for r in json.loads(out.read_text())} if out.exists() else {}


def report(cfg_path: Path, jobs, results):
    checks = run_check([j["out"] for j in jobs if j["out"].exists()])
    rows = []
    for j in jobs:
        sync = results.get(j["title"]) or {}
        if not sync:
            rep = LOGS / f"{j['slug']}_report.json"
            if rep.exists():
                d = json.loads(rep.read_text())
                sync = {"onset": round(d.get("onset_score", 0), 2), "bars": round(d.get("bar_hit", 0), 2)}
        chk = checks.get(j["out"].name, {})
        g, notes = grade(sync, chk)
        lifts = {n: d.get("lift") for n, d in chk.get("arrangements", {}).items()}
        rows.append(dict(title=j["title"], grade=g, onset=sync.get("onset"), bars=sync.get("bars"), lift=lifts, notes=notes))
    rpt = cfg_path.with_name(cfg_path.stem + "_report.json")
    rpt.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"\n{'grade':<6}{'title':<42}{'onset':>6}{'bars':>6}  lift (chart vs luck)")
    for r in sorted(rows, key=lambda r: (r["grade"], r["title"])):
        lift = " ".join(f"{n[:4]} {v}" for n, v in r["lift"].items())
        print(f"{r['grade']:<6}{r['title'][:41]:<42}{r['onset'] or 0:>6.2f}{r['bars'] or 0:>6.0%}  {lift}")
        for n in r["notes"]:
            print(f"{'':<8}- {n}")
    print(f"\nreport: {rpt}")


def sync_scores(log: Path):
    """(dtw onset, dtw bars, linear onset, linear bars, chosen) from a gp_to_sloppak log."""
    t = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
    d = re.search(r"beat-DTW:\s+onset score ([\d.]+), bars on downbeats (\d+)%", t)
    l = re.search(r"constant-tempo: onset score ([\d.]+), bars on downbeats (\d+)%", t)
    m = re.search(r"-> using (\S+)", t)
    if not (d and l and m):
        return None
    return float(d[1]), int(d[2]) / 100, float(l[1]), int(l[2]) / 100, m[1]


def mean_lift(check: dict) -> float:
    lifts = [d["lift"] for d in check.get("arrangements", {}).values() if d.get("lift")]
    return sum(lifts) / len(lifts) if lifts else 0.0


def tune(cfg_path: Path, jobs):
    """For songs where DTW vs constant-tempo was a close call, build the other one and keep
    whichever matches the stems better (tab_check mean lift).  Choices persist in
    ALBUM_tuning.json so later builds reuse them."""
    import shutil
    tuning_file = cfg_path.with_name(cfg_path.stem + "_tuning.json")
    tuning = json.loads(tuning_file.read_text()) if tuning_file.exists() else {}
    tmp = ROOT / "_build" / "tune"
    tmp.mkdir(parents=True, exist_ok=True)
    for j in jobs:
        sc = sync_scores(LOGS / f"{j['slug']}.log")
        if sc is None or not j["out"].exists():
            continue
        ds, db, ls, lb, chosen = sc
        ratio = ls / ds if ds else 0
        if not (0.95 <= ratio <= 1.25 and abs(lb - db) <= 0.06):
            continue
        alt = "dtw" if chosen.startswith("constant") else "linear"
        alt_out = tmp / j["out"].name
        print(f"{j['title'][:40]:<41} close call (linear/dtw {ratio:.2f}); trying {alt}…", flush=True)
        r = build(j, ["--method", alt], out=alt_out, tag="_tune")
        if r["rc"]:
            print("   alt build failed"); continue
        # both files share a name and run_check keys by name, so grade them separately
        new = mean_lift(run_check([alt_out]).get(alt_out.name, {}))
        cur = mean_lift(run_check([j["out"]]).get(j["out"].name, {}))
        keep = new > cur * 1.02
        print(f"   lift {chosen} {cur:.2f} vs {alt} {new:.2f} -> {'switch' if keep else 'keep'}", flush=True)
        if keep:
            bak = ROOT / "_build" / "backup" / f"{j['out'].stem}.{time.strftime('%Y%m%d-%H%M%S')}{j['out'].suffix}"
            shutil.copy2(j["out"], bak)
            shutil.move(str(alt_out), j["out"])
            shutil.copy2(LOGS / f"{j['slug']}_tune_report.json", LOGS / f"{j['slug']}_report.json")
            shutil.copy2(LOGS / f"{j['slug']}_tune.log", LOGS / f"{j['slug']}.log")
            tuning[j["title"]] = alt
        else:
            alt_out.unlink(missing_ok=True)
            tuning[j["title"]] = "linear" if chosen.startswith("constant") else "dtw"
        tuning_file.write_text(json.dumps(tuning, indent=1), encoding="utf-8")


def online_chart(artist: str, title: str, sloppak: Path, min_match: float):
    """Best Chorus Encore drum chart for the song (name, then length, then most hand-charted
    difficulties), downloaded to the drums cache; None when nothing matches or the search fails."""
    import drums_library
    try:
        dur = float(drums_library.manifest_of(sloppak).get("duration") or 0)
        cands = drums_library.online_candidates(artist, title, dur, min_match, n=1)
        if not cands:
            print(f"  no Chorus chart for {artist} - {title}", flush=True)
            return None
        c = cands[0]
        import chorus
        folder = chorus.fetch(c["md5"], drums_library.CACHE / "chorus" / c["md5"])
        print(f"  Chorus chart {c['artist']} - {c['name']} ({c.get('charter')}), "
              f"{c['levels']} hand-charted lower levels", flush=True)
        return folder
    except Exception as e:
        print(f"  Chorus search failed: {e}", flush=True)
        return None


def drums(cfg_path: Path, jobs, a):
    """Attach a Drums arrangement to every built song: a matching YARG/Clone Hero chart
    from --chart-dir (aligned to our audio), else the tab's drum track via the stored sync
    map.  Joins that fail validation are flagged, not written (--force overrides)."""
    import drums_join
    import drumjoin
    index = drumjoin.index_chart_dir(Path(a.chart_dir)) if a.chart_dir else []
    if a.chart_dir:
        print(f"{len(index)} chart folders under {a.chart_dir}")
    rows = []
    for j in jobs:
        if not j["out"].exists():
            print(f"{j['title'][:40]:<41} not built yet; skipping")
            continue
        print(f"\n{j['title']}", flush=True)
        title = re.sub(r"\s*\([^)]*\)\s*$", "", j["title"])  # drop "(Songsterr)"-style variants
        chart = drums_join.find_chart(index, j["artist"], title, a.min_match) if index else None
        if chart is None and getattr(a, "drums_online", True) and "chart" in a.source:
            chart = online_chart(j["artist"], title, j["out"], a.min_match)
        rep = drumjoin.join(j["out"], chart_folder=chart, gp_path=j["tab"],
                            sources=[s.strip() for s in a.source.split(",") if s.strip()],
                            transcriber=a.transcriber, force=a.force, dry_run=a.dry_run,
                            force_method=None if a.method == "auto" else a.method,
                            thresholds=drums_join.thresholds(a), backup_dir=ROOT / "_build" / "backup",
                            report_path=LOGS / f"{j['slug']}_drums.json", log=lambda *x: print(*x, flush=True))
        best = next((c for c in rep["candidates"] if c.get("source") == rep["written"]), None) or \
            next((c for c in rep["candidates"] if "validation" in c), {})
        v = best.get("validation", {})
        rows.append((j["title"], rep["written"] or ("dry-run" if a.dry_run else "FLAGGED"), best.get("source", "-"),
                     v.get("median_offset_ms"), v.get("within_30ms"), v.get("drift_span_ms")))
    print(f"\n{'title':<42}{'result':<10}{'source':<8}{'median':>8}{'<30ms':>7}{'drift':>7}")
    for t, r, s, m, w, d in rows:
        print(f"{t[:41]:<42}{r:<10}{s:<8}{(m if m is not None else 0):>7.0f}ms{(w or 0):>6.0%}{(d or 0):>5.0f}ms")
    LOGS.mkdir(parents=True, exist_ok=True)
    out = cfg_path.with_name(cfg_path.stem + "_drums.json")
    out.write_text(json.dumps([dict(zip(("title", "result", "source", "median_ms", "within_30ms", "drift_ms"), r))
                               for r in rows], indent=1), encoding="utf-8")
    print(f"\nreport: {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["plan", "build", "check", "tune", "survey", "drums"])
    ap.add_argument("target", help="album YAML (or a tab file for survey)")
    ap.add_argument("--only", help='comma-separated titles ("Hollow, As You Figured" works)')
    ap.add_argument("--refine-beats", action="store_true")
    ap.add_argument("--no-stems", action="store_true")
    ap.add_argument("--notation-only", action="store_true",
                    help="rebuild charts only: reuse each existing build's stems + sync map (seconds per song)")
    ap.add_argument("--chart-dir", help="drums: folder of YARG/Clone Hero song folders to match against")
    ap.add_argument("--no-online-charts", dest="drums_online", action="store_false",
                    help="drums: don't search Chorus Encore for a chart (use --chart-dir / the GP drums only)")
    ap.add_argument("--no-drums", action="store_true", help="build/tune: skip the drums step at the end")
    import drums_join
    drums_join.add_common_args(ap)
    a = ap.parse_args()

    if a.cmd == "survey":
        for t in survey(ensure_gp5(Path(a.target))):
            kind = "drums" if t["drums"] else "bass" if t["bass"] else f"{t['strings']}str"
            print(f"{t['i']:>2} {t['name'][:30]:<30} {kind:<6} {t['tuning']} notes {t['notes']:>5} "
                  f"chord {t['chord_ratio']:.2f} bars {t['bars']}/{t['total_bars']}")
        print("plan:", spec_string(plan_tracks(survey(ensure_gp5(Path(a.target))))))
        return

    cfg = Path(a.target).resolve()
    jobs = load_jobs(cfg)
    if a.only:
        want = {s.strip().lower() for s in a.only.split(",")}
        jobs = [j for j in jobs if all(p.strip().lower() in want for p in j["title"].split(","))]
    for j in jobs:
        print(f"{j['title'][:40]:<41}{j['tracks']:<30}{j['tab'].name[:40]}")
        print(f"{'':<41}" + ", ".join(f"{i}={n}" for i, n in j["names"].items()))
    if a.cmd == "plan":
        return
    if a.cmd == "drums":
        drums(cfg, jobs, a)
        return
    results = {}
    if a.cmd == "tune":
        tune(cfg, jobs)
    if a.cmd == "build":
        extra = (["--refine-beats"] if a.refine_beats else []) + (["--no-stems"] if a.no_stems else [])
        for j in jobs:
            ex = list(extra)
            if a.notation_only and j["out"].exists():
                ex += ["--reuse", str(j["out"])]
                reps = [p for p in (LOGS / f"{j['slug']}_report.json",
                                    LOGS / f"{j['out'].stem}_rebuild_report.json") if p.exists()]
                if reps:  # older builds keep their beat map only in the newest build report
                    ex += ["--reuse-map", str(max(reps, key=lambda p: p.stat().st_mtime))]
            r = build(j, ex)
            results[j["title"]] = r
            print(json.dumps(r), flush=True)
    report(cfg, jobs, results)
    if a.cmd in ("build", "tune") and not a.no_drums:
        # Full builds and tune's rebuilds replace the sloppak, so drums are (re)attached here.
        # --notation-only keeps the existing Drums arrangement, but re-running is harmless.
        print("\n== drums", flush=True)
        drums(cfg, jobs, a)


if __name__ == "__main__":
    main()
