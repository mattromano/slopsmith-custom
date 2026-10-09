"""Find guitar solos in sloppak charts and mark them as "Solo" sections.

Slopsmith's solo meter / solo bonus (highway_tweaks) needs a chart section named
"solo". Charts built from Guitar Pro tabs get sections from the tab's markers;
many tabs have no markers (one "default" section) or don't mark the solo.

Detection works per bar of the lead part (the Lead arrangement, else the only
guitar arrangement):
  - soloish bar: mostly single notes (>= 70 % of events), dense
    (>= MIN_NPS single notes per second);
  - unique bar: its note pattern (onset in the bar, string, fret) occurs at
    most twice in the whole part (solos rarely repeat, riffs do);
  - region: consecutive soloish bars (one-bar gaps allowed), >= MIN_BARS
    long, at least half of them unique, and, when there is a Rhythm part,
    Rhythm mostly plays chords there while Lead plays single notes.
Songs whose sections already include a solo are left alone unless --force.

Writing: a "Solo" section is inserted at the region start, and the section that
was running resumes at the region end, in every guitar arrangement (Lead,
Rhythm, Combo) so the solo shows whichever part is played. The original
sloppak is copied to --backup-dir first (never overwriting an existing backup).

    python scripts/solo_sections.py                    # report every built song
    python scripts/solo_sections.py --songs Klonopin   # filter by file name
    python scripts/solo_sections.py --write --backup-dir C:/Users/mattr/Desktop/sloppak_backup_pre-solos
"""

import argparse
import json
import re
import shutil
import statistics
import sys
import zipfile
from collections import Counter
from pathlib import Path

import yaml

DLC = Path("C:/Program Files (x86)/Steam/steamapps/common/Rocksmith2014/dlc/sloppak")
GUITAR = ("Lead", "Rhythm", "Combo")
SINGLE_FRAC = 0.4      # share of a bar's events that are single notes
HIGH_FRET = 9          # median fret of the bar's single notes (solos sit up the neck) ...
FAST_NPS = 3.5         # ... or this many single notes per second
MIN_BARS = 4
MIN_SINGLES = 12
SOLO_FRET = 10         # a solo (vs a lead line): median fret >= 10 ...
SOLO_NPS = 5.0         # ... or >= 5 single notes per second
POS_MIN, POS_MAX = 0.25, 0.92   # where in the song it starts
MAX_BARS = 24


def load(path):
    z = zipfile.ZipFile(path)
    manifest = yaml.safe_load(z.read("manifest.yaml"))
    arrs = {}
    for a in manifest.get("arrangements") or []:
        name = a.get("name")
        if name in GUITAR:
            arrs[name] = (a["file"], json.loads(z.read(a["file"])))
    return manifest, arrs


def bars_of(chart):
    beats = [b for b in chart.get("beats") or [] if b.get("measure", -1) >= 0]
    starts = [b["time"] for b in beats]
    if len(starts) < 2:
        return []
    last = starts[-1] + (starts[-1] - starts[-2])
    return list(zip(starts, starts[1:] + [last]))


def events(chart):
    ev = [(n["t"], "n", ((n["s"], n["f"]),)) for n in chart.get("notes") or [] if not n.get("mt")]
    ev += [(c["t"], "c", tuple(sorted((x["s"], x["f"]) for x in c.get("notes") or []))) for c in chart.get("chords") or []]
    return sorted(ev)


def bar_stats(chart, bars):
    ev = events(chart)
    out, i = [], 0
    for a, b in bars:
        while i < len(ev) and ev[i][0] < a:
            i += 1
        j = i
        while j < len(ev) and ev[j][0] < b:
            j += 1
        seg = ev[i:j]
        dur = max(b - a, 1e-3)
        singles = [e for e in seg if e[1] == "n"]
        frets = [f for e in singles for _, f in e[2]]
        out.append({"a": a, "b": b, "n": len(seg), "singles": len(singles), "chords": len(seg) - len(singles),
                    "nps": len(singles) / dur, "fret": statistics.median(frets) if frets else 0,
                    # pitch content without timing: riffs repeat it (with small rhythm variations), solos don't
                    "sig": tuple(sorted({p for e in seg for p in e[2]}))})
        i = j
    counts = Counter(s["sig"] for s in out if s["n"])
    for s in out:
        s["unique"] = s["n"] > 0 and counts[s["sig"]] <= 2
        s["soloish"] = (s["singles"] >= 1 and s["singles"] / max(1, s["n"]) >= SINGLE_FRAC
                        and (s["fret"] >= HIGH_FRET or s["nps"] >= FAST_NPS))
    return out


def find_solos(arrs):
    lead_name = "Lead" if "Lead" in arrs else ("Combo" if "Combo" in arrs else next(iter(arrs), None))
    if not lead_name:
        return [], None
    lead = arrs[lead_name][1]
    bars = bars_of(lead)
    if not bars:
        return [], lead_name
    ls = bar_stats(lead, bars)
    good = [x["soloish"] and x["unique"] for x in ls]
    regions, k = [], 0
    while k < len(ls):
        if not good[k]:
            k += 1
            continue
        e = k
        while e + 1 < len(ls) and (good[e + 1] or (e + 2 < len(ls) and good[e + 2])):
            e += 1
        while not good[e]:
            e -= 1
        regions.append((k, e))
        k = e + 1
    rs = bar_stats(arrs["Rhythm"][1], bars) if lead_name != "Rhythm" and "Rhythm" in arrs else None
    song_end = bars[-1][1]
    out = []
    for k, e in regions:
        seg = ls[k:e + 1]
        nb = len(seg)
        singles = sum(x["singles"] for x in seg)
        fret = statistics.median(x["fret"] for x in seg)
        nps = statistics.mean(x["nps"] for x in seg)
        pos = seg[0]["a"] / song_end if song_end > 0 else 0
        r_chords = None
        if rs:
            rseg = rs[k:e + 1]
            rn = sum(x["n"] for x in rseg)
            r_chords = sum(x["chords"] for x in rseg) / rn if rn else 0.0
        cand = nb >= MIN_BARS and singles >= MIN_SINGLES
        # A solo, not a lead line: up the neck or very fast, mid/late in the song, a sane length,
        # and the rhythm part (when there is one) not doubling it note for note.
        strong = (cand and (fret >= SOLO_FRET or nps >= SOLO_NPS) and POS_MIN <= pos <= POS_MAX
                  and nb <= MAX_BARS and (r_chords is None or r_chords >= 0.3 or fret >= SOLO_FRET + 2))
        out.append({"start": seg[0]["a"], "end": seg[-1]["b"], "bars": nb, "singles": singles,
                    "nps": round(nps, 1), "fret": fret, "pos": round(pos, 2),
                    "rhythm_chords": None if r_chords is None else round(r_chords, 2),
                    "strong": strong, "solo": False})
    # At most one solo per song: the strongest candidate (highest on the neck, then most notes).
    best = max((r for r in out if r["strong"]), key=lambda r: (r["fret"], r["singles"]), default=None)
    if best:
        best["solo"] = True
    return out, lead_name


def has_solo(arrs):
    return any(re.search("solo", str(s.get("name", "")), re.I)
               for _, c in arrs.values() for s in c.get("sections") or [])


def insert_solo(sections, start, end):
    """Sections with "Solo" from start to end; the section running at `end` resumes there."""
    secs = sorted((dict(s) for s in sections or []), key=lambda s: s["time"])
    if not secs:
        secs = [{"name": "default", "number": 1, "time": 0.0}]
    resume = None
    for s in secs:
        if s["time"] <= end:
            resume = s
    inside = [s for s in secs if start <= s["time"] < end]
    keep = [s for s in secs if not (start <= s["time"] < end)]
    keep.append({"name": "Solo", "number": 1, "time": round(start, 3)})
    if resume is not None and not any(abs(s["time"] - end) < 1e-3 for s in keep):
        keep.append({"name": resume["name"], "number": resume.get("number", 1), "time": round(end, 3)})
    keep.sort(key=lambda s: s["time"])
    n = Counter()
    for s in keep:   # renumber repeated names
        n[s["name"]] += 1
        s["number"] = n[s["name"]]
    return keep, len(inside)


def write(path, arrs, solos, backup_dir):
    backup_dir.mkdir(parents=True, exist_ok=True)
    bak = backup_dir / path.name
    if not bak.exists():
        shutil.copy2(path, bak)
    new = {}
    for name, (fname, chart) in arrs.items():
        secs = chart.get("sections")
        for s in solos:
            secs, _ = insert_solo(secs, s["start"], s["end"])
        chart = dict(chart, sections=secs)
        new[fname] = json.dumps(chart, separators=(",", ":"))
    tmp = path.with_suffix(".sloppak.tmp")
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = new[item.filename].encode("utf-8") if item.filename in new else zin.read(item.filename)
            zout.writestr(item, data)
    tmp.replace(path)


def fmt(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dlc", type=Path, default=DLC)
    ap.add_argument("--songs", default="", help="only sloppaks whose file name contains this (case-insensitive)")
    ap.add_argument("--all", action="store_true", help="every sloppak, not only song_builder builds (x_build)")
    ap.add_argument("--force", action="store_true", help="also songs that already have a solo section")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--backup-dir", type=Path)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.write and not args.backup_dir:
        ap.error("--write needs --backup-dir")
    report = []
    for path in sorted(args.dlc.glob("*.sloppak")):
        if args.songs and args.songs.lower() not in path.name.lower():
            continue
        try:
            manifest, arrs = load(path)
        except Exception as e:  # noqa: BLE001
            print(f"skip {path.name}: {e}", file=sys.stderr)
            continue
        if not args.all and not isinstance(manifest.get("x_build"), dict):
            continue
        if not arrs:
            continue
        marked = has_solo(arrs)
        regions, lead = find_solos(arrs)
        solos = [r for r in regions if r["solo"]]
        report.append({"file": path.name, "lead": lead, "marked": marked, "regions": regions})
        if not args.json:
            tag = "MARKED" if marked else ("FOUND" if solos else "-")
            print(f"{tag:6} {path.name}  (part: {lead})")
            for r in regions:
                print(f"   {'SOLO' if r['solo'] else '    '} {fmt(r['start'])}-{fmt(r['end'])} {r['bars']:2d} bars "
                      f"{r['nps']} n/s {r['singles']} notes fret {r['fret']} at {int(r['pos'] * 100)}% rhythm-chords {r['rhythm_chords']}"
                      f"{'  (candidate)' if r['strong'] and not r['solo'] else ''}")
            if marked:
                for _, c in list(arrs.values())[:1]:
                    print("   marked:", [(s["name"], fmt(s["time"])) for s in c.get("sections") or [] if re.search("solo", s["name"], re.I)])
        if args.write and solos and (not marked or args.force):
            write(path, arrs, solos, args.backup_dir)
            print(f"   wrote {len(solos)} solo section(s)")
    if args.json:
        print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
