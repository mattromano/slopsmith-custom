"""Export song-builder sloppaks as DLC Builder projects (.rs2dlc) for Rocksmith 2014 CDLC.

For each sloppak (built by gp_to_sloppak.py, so it has an `x_build` recipe and `x_sync.json`):
  1. re-run the converter notation-only (--reuse) with --export-rs to get the synced Rocksmith XML,
  2. make the XML DLC Builder / CustomsForge friendly: empty COUNT phrase before the first note,
     END phrase after the last, Rocksmith section names, bendValues for bends, sustains that reach
     linkNext targets, tails on slide/bend notes, header fields + arrangementProperties + tonebase,
  3. write a full-length WAV, a 30 s preview WAV and a 512x512 cover PNG,
  4. write <Artist> - <Title>.rs2dlc (DLC Builder 3.x project JSON) next to them.

Then in DLC Builder: open the project, Generate DD (on by default), adjust tones / volume if wanted,
Build -> .psarc. Audio is converted to .wem by DLC Builder (needs Wwise per its docs).

Usage (MIR venv not required):
  python scripts/export_dlcbuilder.py SONG.sloppak [...] --out "C:/.../DLC Builder" [--author mattromano]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

RS_SECTIONS = ["intro", "outro", "verse", "chorus", "bridge", "solo", "breakdown", "buildup", "fadein",
               "fadeout", "hook", "interlude", "melody", "modbridge", "modchorus", "modverse", "noguitar",
               "postbridge", "postchorus", "postvs", "prebridge", "prechorus", "preverse", "riff", "silence",
               "tapping", "transition", "vamp", "variation", "ambient"]

ARR_ENUM = {"Lead": (0, 1), "Rhythm": (2, 2), "Bass": (3, 4)}  # name -> (ArrangementName, RouteMask)

# Default tones from DLC Builder's own integration-test project (adjust in DLC Builder if wanted).
TONE_GUITAR = {
    "GearList": {
        "Amp": {"Type": "Amps", "Key": "Amp_OrangeAD50",
                "KnobValues": {"Amp_OrangeAD50_Bass": 40, "Amp_OrangeAD50_Gain": 60,
                               "Amp_OrangeAD50_Mid": 85, "Amp_OrangeAD50_Treble": 80}},
        "Cabinet": {"Type": "Cabinets", "Key": "Cab_OrangePPC212OB_Condenser_Cone", "KnobValues": {}},
        "PostPedal1": {"Type": "Pedals", "Key": "Pedal_SpringReverb", "Category": "Reverb",
                       "KnobValues": {"Pedal_SpringReverb_Depth": 50, "Pedal_SpringReverb_Mix": 20,
                                      "Pedal_SpringReverb_Time": 60}},
    },
    "ToneDescriptors": ["$[35722]DISTORTION"], "NameSeparator": " - ", "IsCustom": True,
    "Volume": "-19.8", "Key": "guitar", "Name": "guitar",
}
TONE_BASS = {
    "GearList": {
        "Amp": {"Type": "Amps", "Key": "Bass_Amp_CH350B", "Skin": "urn:image:dds:gear_bass_amp_ch350b_2",
                "SkinIndex": 2,
                "KnobValues": {"Bass_Amp_CH350B_15000": -1, "Bass_Amp_CH350B_250": -1, "Bass_Amp_CH350B_2500": 1,
                               "Bass_Amp_CH350B_30": 3, "Bass_Amp_CH350B_7500": -1, "Bass_Amp_CH350B_800": 1,
                               "Bass_Amp_CH350B_90": 0, "Bass_Amp_CH350B_Bass": 75, "Bass_Amp_CH350B_Gain": 10,
                               "Bass_Amp_CH350B_Treble": 46}},
        "Cabinet": {"Type": "Cabinets", "Key": "Bass_Cab_CH410BC_57_OffAxis",
                    "Skin": "urn:image:dds:gear_bass_cab_ch410bc_2", "SkinIndex": 2, "KnobValues": {}},
    },
    "ToneDescriptors": ["$[35715]BASS"], "NameSeparator": " - ", "IsCustom": True,
    "Volume": "-21.9", "Key": "bass", "Name": "bass",
}


# ── XML fix-ups ─────────────────────────────────────────────────────────────

def rs_section_name(name: str) -> str:
    n = re.sub(r"[^a-z]", "", name.lower())
    if n in RS_SECTIONS:
        return n
    for pre, base in (("pre", "chorus"), ("post", "chorus"), ("pre", "verse"), ("pre", "bridge"), ("post", "bridge")):
        if pre in n and base in n:
            return pre + base
    for key in ("solo", "chorus", "verse", "bridge", "intro", "outro", "breakdown", "interlude", "riff", "hook"):
        if key in n:
            return key
    return "riff"


def _f(x) -> float:
    return float(x or 0)


def count_in_pad(paths) -> float:
    """Seconds of silence to prepend so every arrangement gets a full bar (4 beats) before its
    first note - Rocksmith needs an empty COUNT phrase, and many songs start on beat one."""
    first, beat_len = 1e9, 0.5
    for p in paths:
        root = ET.parse(p).getroot()
        beats = [float(e.get("time")) for e in root.find("ebeats")]
        if len(beats) > 4:
            beat_len = sorted(b - a for a, b in zip(beats[:8], beats[1:9]))[len(beats[1:9]) // 2]
        lv = root.find("levels")[0]
        ts = [float(n.get("time")) for n in lv.find("notes")] + [float(c.get("time")) for c in lv.find("chords")]
        if ts:
            first = min(first, min(ts) - beats[0])
    return round(4 * beat_len, 3) if first < 4 * beat_len - 0.01 else 0.0


def shift_xml(root, pad: float):
    """Move everything `pad` seconds later and prepend one 4-beat count-in bar."""
    if pad <= 0:
        return
    for el in root.iter():
        for k in ("time", "startTime", "endTime"):
            if k in el.attrib:
                el.set(k, f"{float(el.get(k)) + pad:.3f}")
    for tag in ("songLength", "startBeat"):
        e = root.find(tag)
        if e is not None and e.text:
            e.text = f"{float(e.text) + pad:.3f}"
    eb = root.find("ebeats")
    old = list(eb)
    for e in old:
        if e.get("measure", "-1") != "-1":
            e.set("measure", str(int(e.get("measure")) + 1))
    first = float(old[0].get("time"))
    step = pad / 4
    for i in range(4):
        eb.insert(i, ET.Element("ebeat", time=f"{first - pad + i * step:.3f}", measure="1" if i == 0 else "-1"))
    eb.set("count", str(len(eb)))


def finalize_xml(path: Path, arr_name: str, meta: dict, pad: float = 0.0) -> dict:
    tree = ET.parse(path)
    root = tree.getroot()
    shift_xml(root, pad)
    beats = [(float(e.get("time")), int(e.get("measure", -1))) for e in root.find("ebeats")]
    downbeats = [t for t, m in beats if m != -1]
    song_len = _f(root.findtext("songLength"))
    level = root.find("levels")[0]
    notes = list(level.find("notes"))
    chords = list(level.find("chords"))
    onsets = sorted([_f(n.get("time")) for n in notes] + [_f(c.get("time")) for c in chords])
    if not onsets:
        raise ValueError(f"{path.name}: no notes")
    ends = [_f(n.get("time")) + _f(n.get("sustain")) for n in notes]
    for c in chords:
        ends += [_f(c.get("time")) + _f(cn.get("sustain")) for cn in c.findall("chordNote")] or [_f(c.get("time"))]
    first_note, last_end = onsets[0], max(ends)
    start_beat = beats[0][0]

    # per-string note timeline (single notes + chord notes) for linkNext / technique tails
    by_string: dict[int, list] = {}
    for n in notes:
        by_string.setdefault(int(n.get("string")), []).append((_f(n.get("time")), n))
    for c in chords:
        for cn in c.findall("chordNote"):
            by_string.setdefault(int(cn.get("string")), []).append((_f(c.get("time")), cn))
    for lst in by_string.values():
        lst.sort(key=lambda x: x[0])
    fixes = {"bendValues": 0, "linkNext_fixed": 0, "linkNext_dropped": 0, "tails": 0}
    for s, lst in by_string.items():
        for k, (t, el) in enumerate(lst):
            nxt = lst[k + 1] if k + 1 < len(lst) else None
            gap = (nxt[0] - t) if nxt else 1.0
            if el.get("linkNext") == "1":
                if nxt and gap <= 3.0:
                    el.set("sustain", f"{gap:.3f}")
                    fixes["linkNext_fixed"] += 1
                else:
                    el.set("linkNext", "0")
                    fixes["linkNext_dropped"] += 1
            technique = (el.get("slideTo", "-1") != "-1" or el.get("slideUnpitchTo", "-1") != "-1"
                         or _f(el.get("bend")) > 0)
            if technique and _f(el.get("sustain")) <= 0:
                el.set("sustain", f"{max(0.1, min(0.5, gap * 0.9)):.3f}")
                fixes["tails"] += 1
            bend = _f(el.get("bend"))
            if bend > 0 and el.find("bendValues") is None:
                sus = _f(el.get("sustain"))
                bv = ET.SubElement(el, "bendValues", count="1")
                ET.SubElement(bv, "bendValue", time=f"{t + min(0.1, sus / 3):.3f}", step=f"{bend:g}")
                fixes["bendValues"] += 1

    # phrases: empty COUNT up to the bar holding the first note, END after the last note
    bar_of_first = max([d for d in downbeats if d <= first_note + 1e-6] or [start_beat])
    if bar_of_first <= start_beat + 1e-6:
        bar_of_first = first_note  # first note on the very first beat: start the first phrase on it
    end_t = next((d for d in downbeats if d >= last_end + 0.05), min(song_len - 0.05, last_end + 0.5))
    old_phr = [p.get("name") for p in root.find("phrases")]
    old_it = [(_f(i.get("time")), int(i.get("phraseId"))) for i in root.find("phraseIterations")]
    sections = [(rs_section_name(s.get("name")), _f(s.get("startTime"))) for s in root.find("sections")]
    # keep iterations inside [bar_of_first, end_t); the one covering the first note moves to bar_of_first
    kept = []
    for i, (t, pid) in enumerate(old_it):
        nxt_t = old_it[i + 1][0] if i + 1 < len(old_it) else 1e9
        if nxt_t <= bar_of_first + 1e-6 or t >= end_t - 1e-6:
            continue
        kept.append((max(t, bar_of_first), old_phr[pid]))
    phrase_names = ["COUNT"] + [rs_section_name(n) for _, n in kept] + ["END"]
    uniq = list(dict.fromkeys(phrase_names))
    iters = [(start_beat, "COUNT")] + [(t, rs_section_name(n)) for t, n in kept] + [(end_t, "END")]
    new_sections, counts = [], {}
    for name, t in sections:
        if t >= end_t - 1e-6:
            continue
        t = max(t, bar_of_first)
        if new_sections and abs(new_sections[-1][1] - t) < 1e-6:
            new_sections[-1] = (name, t)  # two sections squeezed onto the same start: keep the later name
            continue
        new_sections.append((name, t))

    def replace(tag, attrs_list, child, count=True):
        old = root.find(tag)
        idx = list(root).index(old) if old is not None else len(root)
        if old is not None:
            root.remove(old)
        el = ET.Element(tag, count=str(len(attrs_list))) if count else ET.Element(tag)
        for a in attrs_list:
            ET.SubElement(el, child, {k: str(v) for k, v in a.items()})
        root.insert(idx, el)

    replace("phrases", [dict(disparity=0, ignore=0, maxDifficulty=0, name=n, solo=1 if n == "solo" else 0)
                        for n in uniq], "phrase")
    replace("phraseIterations", [dict(time=f"{t:.3f}", phraseId=uniq.index(n), variation="")
                                 for t, n in iters], "phraseIteration")
    for name, _ in new_sections:
        counts[name] = 0
    sec_attrs = []
    for name, t in new_sections:
        counts[name] += 1
        sec_attrs.append(dict(name=name, number=counts[name], startTime=f"{t:.3f}"))
    replace("sections", sec_attrs, "section")

    # header fields DLC Builder / Rocksmith expect
    def set_text(tag, value, after=None):
        el = root.find(tag)
        if el is None:
            el = ET.Element(tag)
            pos = list(root).index(root.find(after)) + 1 if after is not None and root.find(after) is not None else 0
            root.insert(pos, el)
        el.text = str(value)
    set_text("title", meta["title"])
    set_text("arrangement", arr_name)
    set_text("part", 1, after="arrangement")
    set_text("centOffset", 0, after="offset")
    set_text("startBeat", f"{start_beat:.3f}")
    set_text("artistName", meta["artist"])
    set_text("artistNameSort", meta["artist"], after="artistName")
    set_text("albumName", meta.get("album", ""))
    set_text("albumYear", meta.get("year") or "")
    set_text("crowdSpeed", 1, after="albumYear")
    tone = "bass" if arr_name == "Bass" else "guitar"
    set_text("tonebase", tone, after="crowdSpeed")
    tuning = [int(root.find("tuning").get(f"string{i}", 0)) for i in range(6)]
    props = {k: 0 for k in ("represent bonusArr standardTuning nonStandardChords barreChords powerChords dropDPower "
                            "openChords fingerPicking pickDirection doubleStops palmMutes harmonics pinchHarmonics "
                            "hopo tremolo slides unpitchedSlides bends tapping vibrato fretHandMutes slapPop "
                            "twoFingerPicking fifthsAndOctaves syncopation bassPick sustain pathLead pathRhythm "
                            "pathBass").split()}
    allnotes = notes + [cn for c in chords for cn in c.findall("chordNote")]
    props.update(represent=1, standardTuning=int(all(x == 0 for x in tuning)), powerChords=int(bool(chords)),
                 palmMutes=int(any(n.get("palmMute") == "1" for n in allnotes)),
                 hopo=int(any(n.get("hammerOn") == "1" or n.get("pullOff") == "1" for n in allnotes)),
                 slides=int(any(n.get("slideTo", "-1") != "-1" for n in allnotes)),
                 unpitchedSlides=int(any(n.get("slideUnpitchTo", "-1") != "-1" for n in allnotes)),
                 bends=int(any(_f(n.get("bend")) > 0 for n in allnotes)),
                 vibrato=int(any(n.get("vibrato") not in (None, "0") for n in allnotes)),
                 tremolo=int(any(n.get("tremolo") == "1" for n in allnotes)),
                 sustain=int(any(_f(n.get("sustain")) > 0 for n in allnotes)),
                 bassPick=0, **{f"path{arr_name}": 1})
    ap = root.find("arrangementProperties")
    if ap is None:
        ap = ET.Element("arrangementProperties")
        root.insert(list(root).index(root.find("tonebase")) + 1, ap)
    ap.attrib = {k: str(v) for k, v in props.items()}
    for tag in ("newLinkedDiffs", "linkedDiffs", "phraseProperties", "fretHandMuteTemplates", "events"):
        if root.find(tag) is None:
            root.append(ET.Element(tag, count="0"))
    ET.indent(tree, "  ")
    tree.write(path, encoding="utf-8", xml_declaration=True)
    return {"tuning": tuning, "first_note": first_note, "end": end_t, "sections": new_sections, **fixes}


# ── project ─────────────────────────────────────────────────────────────────

def dlc_key(artist: str, title: str) -> str:
    a = "".join(w[:1] for w in re.findall(r"[A-Za-z0-9]+", artist)).upper()
    t = "".join(w.capitalize() for w in re.findall(r"[A-Za-z0-9]+", title))
    return ("MR" + a + t)[:30]


def sortable(value: str) -> dict:
    sort = re.sub(r"^(the|a|an)\s+", "", value, flags=re.I)
    return {"Value": value, "SortValue": sort}


def export(sloppak: Path, out_root: Path, author: str) -> Path:
    with zipfile.ZipFile(sloppak) as z:
        man = yaml.safe_load(z.read("manifest.yaml"))
        cover_bytes = z.read(man["cover"]) if man.get("cover") else None
    rec = man.get("x_build")
    if not rec:
        raise SystemExit(f"{sloppak.name}: no x_build recipe (rebuild it with song_builder first)")
    # the "(Songsterr)" style variant tags only tell library copies apart; keep them out of the CDLC
    title = re.sub(r"\s*\((?:Songsterr|UG|v\d+)\)$", "", rec["title"])
    artist = rec["artist"]
    safe = re.sub(r'[<>:"/\\|?*]', "", f"{artist} - {title}").strip()
    d = out_root / safe
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    xml_dir = d / "_xml"

    # 1. synced RS XML via a notation-only rebuild into a throwaway sloppak
    with tempfile.TemporaryDirectory() as td:
        cmd = [sys.executable, str(ROOT / "scripts" / "gp_to_sloppak.py"), rec["gp"], rec["audio"],
               str(Path(td) / "tmp.sloppak"), "--tracks", rec["tracks"], "--title", rec["title"], "--artist", artist,
               "--album", str(rec.get("album", "")), "--year", str(rec.get("year", 0)),
               "--reuse", str(sloppak), "--export-rs", str(xml_dir), "--no-stems"]
        if rec.get("fill_min_bars"):
            cmd += ["--fill-min-bars", str(rec["fill_min_bars"])]
        if rec.get("offset"):
            cmd += ["--offset", str(rec["offset"])]
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f"{title}: converter failed\n{r.stdout[-1500:]}\n{r.stderr[-1500:]}")

    meta = {"title": title, "artist": artist, "album": rec.get("album", ""), "year": rec.get("year", 0)}
    # Rocksmith has no drums: Drums arrangements (drums_join / ch_to_sloppak) stay out of the CDLC
    rs_arrs = [e for e in man["arrangements"] if not re.search(r"\b(?:drums?|percussion)\b", e["name"], re.I)]
    pad = count_in_pad([xml_dir / f"{e['id']}_RS2.xml" for e in rs_arrs])
    arrangements, report = [], {}
    names = [a["name"] for a in rs_arrs]
    for ent in rs_arrs:
        src = xml_dir / f"{ent['id']}_RS2.xml"
        name = ent["name"] if ent["name"] in ARR_ENUM else "Lead"
        dst = d / f"arr_{name.lower()}_RS2.xml"
        shutil.move(src, dst)
        info = finalize_xml(dst, name, meta, pad)
        report[name] = {k: v for k, v in info.items() if k != "sections"}
        enum, route = ARR_ENUM[name]
        arrangements.append({"Case": "Instrumental", "Fields": [{
            "XML": dst.name, "Name": enum, "RouteMask": route, "Priority": 0, "ScrollSpeed": 1.3,
            "BassPicked": False, "Tuning": info["tuning"], "TuningPitch": 440,
            "BaseTone": "bass" if name == "Bass" else "guitar", "Tones": [],
            "MasterID": random.randint(10_000_000, 2_000_000_000), "PersistentID": str(uuid.uuid4())}]})
    shutil.rmtree(xml_dir, ignore_errors=True)

    # 2. audio + preview + cover
    dur = float(man.get("duration") or 0) + pad
    sec_times = [t for n, t in info["sections"] if n == "chorus"] if arrangements else []
    preview_start = round(sec_times[0] if sec_times else max(0.0, dur * 0.3), 3)  # already includes pad
    ms = int(round(pad * 1000))
    lead_in = [f"adelay={ms}|{ms}"] if ms else []
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", rec["audio"], *(["-af", ",".join(lead_in)] if lead_in else []),
                    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(d / "audio.wav")], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(preview_start), "-t", "30", "-i", str(d / "audio.wav"),
                    "-af", "afade=t=in:d=1,afade=t=out:st=28:d=2", "-c:a", "pcm_s16le",
                    str(d / "audio_preview.wav")], check=True)
    if cover_bytes:
        src = d / "_cover_src.jpg"
        src.write_bytes(cover_bytes)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf",
                        "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2",
                        str(d / "cover.png")], check=True)
        src.unlink()

    tones = []
    if any(n != "Bass" for n in names):
        tones.append(TONE_GUITAR)
    if "Bass" in names:
        tones.append(TONE_BASS)
    project = {
        "Version": "1", "Author": author, "DLCKey": dlc_key(artist, title),
        "ArtistName": sortable(artist), "Title": sortable(title), "AlbumName": sortable(str(rec.get("album", ""))),
        "Year": int(rec.get("year") or 0), "AlbumArtFile": "cover.png" if cover_bytes else "",
        "AudioFile": {"Path": "audio.wav", "Volume": -7.0},
        "AudioPreviewFile": {"Path": "audio_preview.wav", "Volume": -7.0},
        "AudioPreviewStartTime": preview_start, "AudioFileLength": round(dur, 3),
        "Arrangements": arrangements, "Tones": tones,
    }
    proj = d / f"{safe}.rs2dlc"
    proj.write_text(json.dumps(project, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{title}: {proj}" + (f"  (added {pad:.2f}s count-in)" if pad else ""))
    for n, rinfo in report.items():
        print(f"   {n:<6} first note {rinfo['first_note']:.2f}s, END {rinfo['end']:.2f}s, tuning {rinfo['tuning']}, "
              f"bends+{rinfo['bendValues']} linkNext fixed {rinfo['linkNext_fixed']} dropped "
              f"{rinfo['linkNext_dropped']} tails+{rinfo['tails']}")
    return proj


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sloppaks", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--author", default="mattromano")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for p in a.sloppaks:
        export(Path(p), out, a.author)


if __name__ == "__main__":
    main()
