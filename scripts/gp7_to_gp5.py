"""Convert a Guitar Pro 7/8 file (.gp — zip holding Content/score.gpif) to .gp5
so pyguitarpro / lib/gp2rs can read it.

Covers what charts need: tracks + tuning, time signatures, section markers,
repeats / alternate endings, tempo changes, rhythms (dots, tuplets), rests,
ties, dead notes, palm mutes, slides, bends, harmonics, vibrato, let ring,
hammer-ons/pull-offs, accents, and drum kits (MIDI note numbers).

Usage: python scripts/gp7_to_gp5.py IN.gp OUT.gp5
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
import zipfile

import guitarpro as gp
from guitarpro import models as m

NOTE_VALUES = {"Whole": 1, "Half": 2, "Quarter": 4, "Eighth": 8, "16th": 16,
               "32nd": 32, "64th": 64, "128th": 128}


def _props(el):
    out = {}
    pr = el.find("Properties")
    if pr is None:
        return out
    for p in pr.findall("Property"):
        child = list(p)
        if not child:
            out[p.get("name")] = True
            continue
        c = child[0]
        if c.tag == "Enable":
            out[p.get("name")] = True
        elif c.tag == "Pitch":
            out[p.get("name")] = c
        else:
            out[p.get("name")] = (c.text or "").strip()
    return out


def _ids(text):
    return [t for t in (text or "").split() if t != "-1"]


def _durations(rhythm):
    """GPIF rhythm -> list of gp Durations (double dots split into two beats)."""
    value = NOTE_VALUES[rhythm.findtext("NoteValue")]
    dots = int(rhythm.find("AugmentationDot").get("count")) if rhythm.find("AugmentationDot") is not None else 0
    tup = rhythm.find("PrimaryTuplet")
    tuplet = m.Tuplet(enters=int(tup.get("num")), times=int(tup.get("den"))) if tup is not None else m.Tuplet(1, 1)
    if dots <= 1:
        return [m.Duration(value=value, isDotted=dots == 1, tuplet=tuplet)]
    # double dot = dotted value + value*4
    return [m.Duration(value=value, isDotted=True, tuplet=tuplet),
            m.Duration(value=min(value * 4, 128), isDotted=False, tuplet=m.Tuplet(tuplet.enters, tuplet.times))]


def convert(src, dst):
    with zipfile.ZipFile(src) as z:
        root = ET.fromstring(z.read("Content/score.gpif"))

    score = root.find("Score")
    tracks_x = list(root.find("Tracks"))
    master_bars = list(root.find("MasterBars"))
    bars = {b.get("id"): b for b in root.find("Bars")}
    voices = {v.get("id"): v for v in root.find("Voices")}
    beats = {b.get("id"): b for b in root.find("Beats")}
    notes = {n.get("id"): n for n in root.find("Notes")}
    rhythms = {r.get("id"): r for r in root.find("Rhythms")}

    song = gp.Song()
    song.title = (score.findtext("Title") or "").strip()
    song.artist = (score.findtext("Artist") or "").strip()
    song.album = (score.findtext("Album") or "").strip()

    # tempo automations: bar -> [(position, bpm)]
    tempos = {}
    for a in root.findall("MasterTrack/Automations/Automation"):
        if a.findtext("Type") != "Tempo":
            continue
        bpm, unit = (a.findtext("Value") or "120 2").split()[:2]
        bpm = float(bpm)
        if unit == "1":      # eighth-note tempo
            bpm /= 2
        elif unit == "3":    # dotted quarter
            bpm *= 1.5
        tempos.setdefault(int(a.findtext("Bar")), []).append((float(a.findtext("Position") or 0), bpm))
    song.tempo = int(round(tempos.get(0, [(0, 120)])[0][1]))

    # measure headers
    song.measureHeaders = []
    for i, mb in enumerate(master_bars):
        num, den = (mb.findtext("Time") or "4/4").split("/")
        h = m.MeasureHeader(number=i + 1)
        h.timeSignature = m.TimeSignature(numerator=int(num), denominator=m.Duration(value=int(den)))
        sec = mb.find("Section")
        if sec is not None:
            title = (sec.findtext("Text") or sec.findtext("Letter") or "").strip()
            if title:
                h.marker = m.Marker(title=title)
        rep = mb.find("Repeat")
        if rep is not None:
            h.isRepeatOpen = rep.get("start") == "true"
            if rep.get("end") == "true":
                h.repeatClose = max(1, int(rep.get("count", "2")) - 1)
        alt = mb.findtext("AlternateEndings")
        if alt:
            mask = 0
            for n in alt.split():
                mask |= 1 << (int(n) - 1)
            h.repeatAlternative = mask
        song.measureHeaders.append(h)

    song.tracks = []
    for ti, tx in enumerate(tracks_x):
        is_drums = (tx.findtext("InstrumentSet/Type") or "") == "drumKit"
        props = {}
        staff = tx.find("Staves/Staff")
        if staff is not None:
            for p in staff.findall("Properties/Property"):
                props[p.get("name")] = p
        pitches = []
        if "Tuning" in props and not is_drums:
            pitches = [int(x) for x in props["Tuning"].findtext("Pitches").split()]
        if not pitches:
            pitches = [0] * 6 if is_drums else [40, 45, 50, 55, 59, 64]
        capo = 0
        if "CapoFret" in props:
            capo = int(props["CapoFret"].findtext("Fret") or 0)
        track = m.Track(song, number=ti + 1, name=(tx.findtext("Name") or f"Track {ti + 1}").strip())
        track.isPercussionTrack = is_drums
        # gp strings: number 1 = highest
        track.strings = [m.GuitarString(number=k + 1, value=v) for k, v in enumerate(reversed(pitches))]
        track.offset = capo
        prog = tx.findtext("Sounds/Sound/MIDI/Program")
        ch = 9 if is_drums else min(ti * 2, 15)
        if ch == 9 and not is_drums:
            ch = 10
        track.channel = m.MidiChannel(channel=ch, effectChannel=ch,
                                      instrument=int(prog) if prog and prog.isdigit() else 25)
        track.measures = []
        nstr = len(pitches)
        for bi, mb in enumerate(master_bars):
            header = song.measureHeaders[bi]
            meas = m.Measure(track, header)
            meas.voices = [m.Voice(meas), m.Voice(meas)]
            bar_ids = (mb.findtext("Bars") or "").split()
            bar = bars.get(bar_ids[ti]) if ti < len(bar_ids) else None
            vids = _ids(bar.findtext("Voices")) if bar is not None else []
            if not vids:
                # whole-measure rest, one rest per beat of the time signature
                rest_beats = []
                for _ in range(header.timeSignature.numerator):
                    b = m.Beat(meas.voices[0], status=m.BeatStatus.rest)
                    b.duration = m.Duration(value=header.timeSignature.denominator.value)
                    rest_beats.append(b)
                meas.voices[0].beats = rest_beats
            for vi, vid in enumerate(vids[:2]):
                voice = meas.voices[vi]
                first_beat = True
                for bid in _ids(voices[vid].findtext("Beats")):
                    bx = beats[bid]
                    durs = _durations(rhythms[bx.find("Rhythm").get("ref")])
                    nids = _ids(bx.findtext("Notes"))
                    for di, dur in enumerate(durs):
                        beat = m.Beat(voice, status=m.BeatStatus.normal if nids else m.BeatStatus.rest)
                        beat.duration = dur
                        if first_beat and vi == 0 and ti == 0 and bi in tempos and di == 0:
                            mtc = m.MixTableChange()
                            mtc.tempo = m.MixTableItem(value=int(round(tempos[bi][0][1])))
                            beat.effect.mixTableChange = mtc
                        for nid in nids:
                            beat.notes.append(_note(beat, notes[nid], nstr, is_drums, tie=di > 0))
                        voice.beats.append(beat)
                    first_beat = False
            track.measures.append(meas)
        song.tracks.append(track)

    gp.write(song, dst, version=(5, 1, 0))


def _note(beat, nx, nstr, is_drums, tie=False):
    p = _props(nx)
    n = m.Note(beat)
    gstr = int(p.get("String", 0))
    if is_drums:
        n.value = int(p.get("Midi", 0) or p.get("Fret", 0) or 0)
        n.string = 1 + (gstr % 6)
    else:
        n.value = int(p.get("Fret", 0))
        n.string = nstr - gstr
    n.velocity = 95
    n.type = m.NoteType.normal
    tie_el = nx.find("Tie")
    if tie or (tie_el is not None and tie_el.get("destination") == "true"):
        n.type = m.NoteType.tie
    if p.get("Muted"):
        n.type = m.NoteType.dead
    eff = n.effect
    if p.get("PalmMuted"):
        eff.palmMute = True
    if nx.find("Vibrato") is not None:
        eff.vibrato = True
    if nx.find("LetRing") is not None:
        eff.letRing = True
    if nx.find("Accent") is not None:
        acc = int(nx.findtext("Accent") or 0)
        eff.accentuatedNote = bool(acc & 4)
        eff.heavyAccentuatedNote = bool(acc & 8)
        eff.staccato = bool(acc & 1)
    if p.get("HopoOrigin"):
        eff.hammer = True
    if "Slide" in p:
        flags = int(p["Slide"] or 0)
        slides = []
        if flags & 1:
            slides.append(m.SlideType.shiftSlideTo)
        if flags & 2:
            slides.append(m.SlideType.legatoSlideTo)
        if flags & 4:
            slides.append(m.SlideType.outDownwards)
        if flags & 8:
            slides.append(m.SlideType.outUpwards)
        if flags & 16:
            slides.append(m.SlideType.intoFromBelow)
        if flags & 32:
            slides.append(m.SlideType.intoFromAbove)
        eff.slides = slides
    if p.get("Bended"):
        # GPIF: 100 = one full tone; pyguitarpro bend values are quarter-tones (4 = full tone)
        pts = []
        for key_o, key_v in (("BendOriginOffset", "BendOriginValue"),
                             ("BendMiddleOffset1", "BendMiddleValue"),
                             ("BendMiddleOffset2", "BendMiddleValue"),
                             ("BendDestinationOffset", "BendDestinationValue")):
            if key_v in p:
                pos = round(float(p.get(key_o, 0) or 0) / 100 * m.BendEffect.maxPosition)
                pts.append(m.BendPoint(position=pos, value=round(float(p[key_v]) / 25)))
        if pts:
            eff.bend = m.BendEffect(type=m.BendType.bend, value=max(pt.value for pt in pts) * 25, points=pts)
    if p.get("Harmonic"):
        ht = (p.get("HarmonicType") or "Natural").lower()
        if ht == "pinch":
            eff.harmonic = m.PinchHarmonic()
        elif ht == "artificial":
            eff.harmonic = m.ArtificialHarmonic()
        elif ht == "tap":
            eff.harmonic = m.TappedHarmonic()
        elif ht == "semi":
            eff.harmonic = m.SemiHarmonic()
        else:
            eff.harmonic = m.NaturalHarmonic()
    return n


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
    s = gp.parse(sys.argv[2])
    print(f"wrote {sys.argv[2]}: {len(s.tracks)} tracks, {len(s.measureHeaders)} measures, tempo {s.tempo}")
