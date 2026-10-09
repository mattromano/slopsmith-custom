"""Rock Band / Clone Hero / YARG drum charts: parse, convert, encode.

Reads the Expert drums part of a ``notes.mid`` (PART DRUMS) or ``notes.chart``
([ExpertDrums]) plus ``song.ini`` and turns it into a flat list of 4-lane
pro-drums hits with absolute times, a tempo map, beats, sections, star power
phrases and drum fills.  The hits are encoded for Slopsmith's drums plugin as
General MIDI drum numbers packed into wire notes (``midi = s * 24 + f``).

The parsing rules are ported from YARG.Core (MoonscraperChartParser:
MidReader / MidReader.ProcessLists / MidIOHelper / ChartReader /
ChartReader.ProcessLists / ChartIOHelper, and
Chart/Loaders/MoonSong/MoonSongLoader.Drums.cs; Parsing/TextEvents.cs).

    Copyright (c) 2016-2020 Alexander Ong (Moonscraper)
    Copyright (c) YARC (YARG) contributors
    Licensed under the GNU Lesser General Public License v3.0
    (https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE).
    Ported to Python and modified for Slopsmith (only the drums rules,
    Expert/Expert+ only, no Elite Drums); distributed here as part of
    Slopsmith under AGPL-3.0, which LGPL-3.0 section 4/5 permits.

Rules implemented (YARG behaviour in brackets):
- MIDI Expert pads 96..101 = kick, red, yellow, blue, orange(4-lane green), green(5-lane);
  95 = 2x kick [InstrumentPlus].  Yellow/blue/orange default to cymbals; tom markers
  110/111/112 XOR the cymbal flag for that pad over [start, end-1] ticks.
- MIDI dynamics only when the track has the ``[ENABLE_CHART_DYNAMICS]`` text event:
  velocity 127 = accent, 1 = ghost, never on kicks.
- .chart ``N 0..5`` = kick..green, ``N 32`` = 2x kick, ``N 66/67/68`` = cymbal markers for
  yellow/blue/orange (pads default to toms), ``N 34..38`` accents and ``N 40..44`` ghosts
  for red..green.  ``S 2`` star power, ``S 64`` drum fill.
- 5-lane charts (any 5-lane green note, or ``five_lane_drums`` in song.ini) are converted
  to 4-lane pro with YARG's table (yellow->Y cym, blue->B tom, orange->G cym,
  green->G tom, orange+green chord -> B cym + G tom).
- Disco flip (``[mix 3 drums<n>d]``) on Expert swaps red <-> yellow cymbal until the
  next mix event.
- Star power = MIDI 116 / .chart S 2; drum fills (activation) = MIDI 120..124 / S 64;
  solos = MIDI 103; sections = ``[section x]`` / ``[prc_x]`` text events.
- ``song.ini`` ``delay`` (ms; .chart ``Offset`` seconds as fallback): chart time =
  audio time - delay [SongRunner.AudioTime], so audio time = chart time + delay.
"""
from __future__ import annotations

import configparser
import re
from dataclasses import dataclass, field
from pathlib import Path

PADS = ("kick", "red", "yellow", "blue", "green")

# 4-lane pro pad (+cymbal) <-> General MIDI drum number.  This is the same note
# set the drums plugin lane presets and the JS engine decode.
GM_KICK, GM_KICK2X, GM_SNARE = 36, 35, 38
PAD_TO_GM = {
    ("kick", False): GM_KICK,
    ("red", False): GM_SNARE,
    ("yellow", True): 42,    # closed hi-hat
    ("yellow", False): 48,   # hi tom
    ("blue", True): 51,      # ride
    ("blue", False): 45,     # mid tom
    ("green", True): 49,     # crash
    ("green", False): 41,    # floor tom
}
# Every GM note the plugin understands -> (pad, cymbal).  Used to read drums back out
# of a sloppak (joiner validation, exporter) and for GP drum tracks.
GM_TO_PAD = {
    35: ("kick", False), 36: ("kick", False),
    37: ("red", False), 38: ("red", False), 40: ("red", False), 39: ("red", False),
    42: ("yellow", True), 44: ("yellow", True), 46: ("yellow", True),
    48: ("yellow", False), 50: ("yellow", False),
    45: ("blue", False), 47: ("blue", False),
    41: ("green", False), 43: ("green", False), 58: ("green", False),
    51: ("blue", True), 53: ("blue", True), 59: ("blue", True),
    49: ("green", True), 57: ("green", True), 55: ("green", True), 52: ("green", True),
}

# MIDI (RB / PS / CH) constants - MidIOHelper.cs
DRUM_TRACK_NAMES = ("PART DRUMS", "PART DRUM", "PART REAL_DRUMS_PS")
DIFF_START = {"easy": 60, "medium": 72, "hard": 84, "expert": 96}
MIDI_STARPOWER, MIDI_SOLO = 116, 103
MIDI_FILLS = (120, 121, 122, 123, 124)
MIDI_TOM_MARKERS = {110: 2, 111: 3, 112: 4}      # -> raw pad index (yellow, blue, orange)
VELOCITY_ACCENT, VELOCITY_GHOST = 127, 1
CHART_DYNAMICS_TEXT = "ENABLE_CHART_DYNAMICS"

# Raw (Moonscraper) pad indices
RAW_KICK, RAW_RED, RAW_YELLOW, RAW_BLUE, RAW_ORANGE, RAW_GREEN = range(6)


@dataclass
class DrumHit:
    time: float          # seconds, audio time (song.ini delay applied)
    pad: str             # kick/red/yellow/blue/green (4-lane pro)
    cymbal: bool = False
    kick2x: bool = False
    dyn: str | None = None   # "accent" | "ghost" | None
    tick: int = 0

    @property
    def gm(self) -> int:
        if self.pad == "kick":
            return GM_KICK2X if self.kick2x else GM_KICK
        return PAD_TO_GM[(self.pad, self.cymbal if self.pad != "red" else False)]


@dataclass
class TempoMap:
    resolution: int
    tempos: list = field(default_factory=lambda: [(0, 120.0)])     # (tick, bpm)
    time_sigs: list = field(default_factory=lambda: [(0, 4, 4)])   # (tick, numerator, denominator)

    def __post_init__(self):
        self.tempos = sorted(self.tempos) or [(0, 120.0)]
        if self.tempos[0][0] != 0:
            self.tempos.insert(0, (0, 120.0))
        self.time_sigs = sorted(self.time_sigs) or [(0, 4, 4)]
        if self.time_sigs[0][0] != 0:
            self.time_sigs.insert(0, (0, 4, 4))
        # cumulative seconds at each tempo change
        self._starts = [0.0]
        for (t0, bpm), (t1, _) in zip(self.tempos, self.tempos[1:]):
            self._starts.append(self._starts[-1] + (t1 - t0) / self.resolution * 60.0 / bpm)

    def tick_to_time(self, tick: float) -> float:
        i = 0
        lo, hi = 0, len(self.tempos) - 1
        while lo <= hi:  # last tempo change at or before tick
            mid = (lo + hi) // 2
            if self.tempos[mid][0] <= tick:
                i, lo = mid, mid + 1
            else:
                hi = mid - 1
        t0, bpm = self.tempos[i]
        return self._starts[i] + (tick - t0) / self.resolution * 60.0 / bpm

    def time_to_tick(self, time: float) -> float:
        i = max(k for k, s in enumerate(self._starts) if s <= time) if time > 0 else 0
        t0, bpm = self.tempos[i]
        return t0 + (time - self._starts[i]) * bpm / 60.0 * self.resolution

    def beats(self, end_tick: float) -> list[tuple[int, int]]:
        """[(tick, measure number or -1)] for every beat up to end_tick (inclusive of the
        measure containing it).  Beat unit = 1/denominator note."""
        out = []
        measure = 0
        sigs = self.time_sigs + [(float("inf"), 4, 4)]
        for (t0, num, den), (t1, _, _) in zip(sigs, sigs[1:]):
            num = max(1, num)
            step = self.resolution * 4 / max(1, den)
            tick = t0
            while tick < t1:
                if tick > end_tick:
                    return out
                measure += 1
                for b in range(num):
                    bt = tick + b * step
                    if bt >= t1:
                        break
                    out.append((int(round(bt)), measure if b == 0 else -1))
                tick += num * step
        return out


@dataclass
class DrumChart:
    hits: list[DrumHit]
    tempo: TempoMap
    offset: float = 0.0                    # seconds added to chart time (song.ini delay)
    sections: list = field(default_factory=list)      # (time, name)
    star_power: list = field(default_factory=list)    # (start, end) seconds
    fills: list = field(default_factory=list)         # (start, end)
    solos: list = field(default_factory=list)         # (start, end)
    source_format: str = ""
    five_lane: bool = False
    dynamics: bool = False

    def beat_list(self) -> list[dict]:
        end = max((h.tick for h in self.hits), default=0)
        return [{"time": round(self.tempo.tick_to_time(t) + self.offset, 3), "measure": m}
                for t, m in self.tempo.beats(end)]


# ── song.ini ────────────────────────────────────────────────────────────────

def load_song_ini(path: Path) -> dict:
    """[song]/[Song] section of a song.ini as a lowercase-key dict ({} if missing)."""
    path = Path(path)
    if not path.exists():
        return {}
    cp = configparser.ConfigParser(interpolation=None, strict=False, comment_prefixes=(";", "#", "//"))
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    try:
        cp.read_string(text)
    except configparser.MissingSectionHeaderError:
        cp.read_string("[song]\n" + text)
    for sec in cp.sections():
        if sec.strip().lower() == "song":
            return {k.strip().lower(): v.strip() for k, v in cp.items(sec)}
    return {}


def ini_bool(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def ini_delay_seconds(ini: dict, chart_offset: float = 0.0) -> float:
    """song.ini ``delay`` (ms) wins; ``delay_seconds`` / .chart Offset are fallbacks."""
    try:
        d = int(float(ini.get("delay", 0) or 0))
    except ValueError:
        d = 0
    if d:
        return d / 1000.0
    try:
        if ini.get("delay_seconds"):
            return float(ini["delay_seconds"])
    except ValueError:
        pass
    return float(chart_offset or 0.0)


# ── shared post-processing (MoonSongLoader.Drums) ───────────────────────────

@dataclass
class _RawNote:
    tick: int
    pad: int                 # raw pad 0..5
    cymbal: bool = False
    plus: bool = False       # 2x kick
    dyn: str | None = None


def _normalize_text(text: str) -> str:
    m = re.search(r"\[(.*?)\]", text)
    return (m.group(1) if m else text).strip()


def _section_name(text: str) -> str | None:
    t = _normalize_text(text)
    for p in ("section", "prc"):
        if t.startswith(p):
            name = t[len(p):].lstrip("_").strip()
            return name.replace("_", " ") or None
    return None


def _mix_event(text: str):
    """('expert'|..., setting) for [mix <d> drums<c><setting>] or None (TextEvents)."""
    m = re.match(r"mix[ _]*([0-3])[ _]*drums[ _]*([0-5])(.*)$", _normalize_text(text))
    if not m:
        return None
    diff = ("easy", "medium", "hard", "expert")[int(m.group(1))]
    s = m.group(3).strip()
    setting = {"d": "disco", "dnoflip": "disco_noflip", "easy": "easy", "easynokick": "easynokick"}.get(s, "none")
    return diff, setting


def _to_four_lane(raw: list[_RawNote], five_lane: bool, mix: list[tuple[int, str]]) -> list[tuple]:
    """Raw notes -> [(tick, pad, cymbal, plus, dyn)] 4-lane pro (GetFourLaneDrumPad)."""
    by_tick: dict[int, list[_RawNote]] = {}
    for n in raw:
        by_tick.setdefault(n.tick, []).append(n)
    mix = sorted(mix)
    out = []
    for n in raw:
        if five_lane:
            pad, cym = {RAW_KICK: ("kick", False), RAW_RED: ("red", False), RAW_YELLOW: ("yellow", True),
                        RAW_BLUE: ("blue", False), RAW_ORANGE: ("green", True),
                        RAW_GREEN: ("green", False)}[n.pad]
            if n.pad == RAW_ORANGE and any(o.pad == RAW_GREEN for o in by_tick[n.tick] if o is not n):
                pad, cym = "blue", True
        else:
            pad = {RAW_KICK: "kick", RAW_RED: "red", RAW_YELLOW: "yellow", RAW_BLUE: "blue",
                   RAW_ORANGE: "green", RAW_GREEN: "green"}[n.pad]
            cym = n.cymbal and pad in ("yellow", "blue", "green")
            setting = "none"
            for t, s in mix:
                if t <= n.tick:
                    setting = s
            if setting == "disco":
                if pad == "red":
                    pad, cym = "yellow", True
                elif pad == "yellow":
                    pad, cym = "red", False
        out.append((n.tick, pad, cym, n.plus and pad == "kick", n.dyn))
    # one gem per (tick, pad, cymbal)
    seen, uniq = set(), []
    for t in sorted(out, key=lambda x: (x[0], PADS.index(x[1]), x[2])):
        k = t[:3] + (t[3],)
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq


def _finish(raw, five_lane, mix, tempo: TempoMap, offset, sections, sp, fills, solos, fmt, dynamics):
    hits = [DrumHit(time=round(tempo.tick_to_time(t) + offset, 4), pad=p, cymbal=c, kick2x=k, dyn=d, tick=t)
            for t, p, c, k, d in _to_four_lane(raw, five_lane, mix)]

    def span(rng):
        return sorted({(round(tempo.tick_to_time(a) + offset, 4), round(tempo.tick_to_time(b) + offset, 4))
                       for a, b in rng})
    return DrumChart(hits=hits, tempo=tempo, offset=offset,
                     sections=[(round(tempo.tick_to_time(t) + offset, 4), n) for t, n in sorted(sections)],
                     star_power=span(sp), fills=span(fills), solos=span(solos),
                     source_format=fmt, five_lane=five_lane, dynamics=dynamics)


# ── notes.mid ───────────────────────────────────────────────────────────────

def parse_mid(path: Path, ini: dict | None = None, difficulty: str = "expert") -> DrumChart:
    import mido
    ini = ini or {}
    mid = mido.MidiFile(str(path))
    if mid.ticks_per_beat <= 0:
        raise ValueError("SMPTE-timed MIDI files are not supported")
    tempos, sigs, sections = [], [], []
    drum_track = None
    drum_name = None
    for tr in mid.tracks:
        name = next((m.name for m in tr if m.type == "track_name"), "").strip()
        tick = 0
        for m in tr:
            tick += m.time
            if m.type == "set_tempo":
                tempos.append((tick, 60_000_000 / m.tempo))
            elif m.type == "time_signature":
                sigs.append((tick, m.numerator, m.denominator))
        if name.upper() == "EVENTS":
            tick = 0
            for m in tr:
                tick += m.time
                if m.type in ("text", "marker", "lyrics"):
                    s = _section_name(m.text)
                    if s:
                        sections.append((tick, s))
        up = name.upper()
        if up in DRUM_TRACK_NAMES:
            # PART DRUMS overrides; the alternates only fill in when it's missing (TrackOverrides)
            if drum_track is None or up == "PART DRUMS":
                drum_track, drum_name = tr, up
    if drum_track is None:
        raise ValueError(f"{path}: no PART DRUMS track")
    # tempo changes at the same tick: last one wins
    tempo = TempoMap(mid.ticks_per_beat, list({t: b for t, b in sorted(tempos)}.items()),
                     list({t: (t, n, d) for t, n, d in sorted(sigs)}.values()))

    base = DIFF_START[difficulty]
    texts, events = [], []     # (tick, text); (start, end, note, velocity)
    open_notes: dict[tuple, list] = {}
    tick = 0
    for m in drum_track:
        tick += m.time
        if m.type in ("text", "marker", "lyrics"):
            texts.append((tick, m.text))
        elif m.type == "note_on" and m.velocity > 0:
            open_notes.setdefault((m.note, m.channel), []).append((tick, m.velocity))
        elif m.type == "note_off" or (m.type == "note_on" and m.velocity == 0):
            q = open_notes.get((m.note, m.channel))
            if q:
                st, vel = q.pop(0)
                events.append((st, tick, m.note, vel))
    for (note, _), q in open_notes.items():   # unterminated: zero length
        events += [(st, st, note, vel) for st, vel in q]
    events.sort()

    dynamics = any(_normalize_text(t) == CHART_DYNAMICS_TEXT for _, t in texts)
    raw, sp, fills, solos, markers = [], [], [], [], []
    for st, en, note, vel in events:
        off = note - base
        if 0 <= off <= 5:
            dyn = None
            if dynamics and off != RAW_KICK:
                dyn = "accent" if vel == VELOCITY_ACCENT else "ghost" if vel == VELOCITY_GHOST else None
            raw.append(_RawNote(st, off, cymbal=off in (RAW_YELLOW, RAW_BLUE, RAW_ORANGE), dyn=dyn))
        elif note == base - 1 and difficulty == "expert":
            raw.append(_RawNote(st, RAW_KICK, plus=True))
        elif note == MIDI_STARPOWER:
            sp.append((st, en))
        elif note in MIDI_FILLS:
            fills.append((st, en))
        elif note == MIDI_SOLO:
            solos.append((st, en))
        elif note in MIDI_TOM_MARKERS:
            markers.append((st, en, MIDI_TOM_MARKERS[note]))
    raw.sort(key=lambda n: (n.tick, n.pad))
    # tom markers toggle the cymbal flag of that pad's notes in [start, end-1]
    for st, en, pad in markers:
        last = en - 1 if en > st else en
        for n in raw:
            if n.pad == pad and st <= n.tick <= last:
                n.cymbal = not n.cymbal
    five = ini_bool(ini.get("five_lane_drums", "")) or any(n.pad == RAW_GREEN for n in raw)
    mix = [(t, s) for t, txt in texts if (ev := _mix_event(txt)) and ev[0] == difficulty for s in [ev[1]]]
    return _finish(raw, five, mix, tempo, ini_delay_seconds(ini), sections, sp, sorted(set(fills)), solos,
                   "mid", dynamics)


# ── notes.chart ─────────────────────────────────────────────────────────────

_CHART_SECTION = re.compile(r"^\s*\[([^\]]+)\]\s*$")


def _chart_sections(text: str) -> dict[str, list[str]]:
    out, cur, body = {}, None, None
    for line in text.splitlines():
        m = _CHART_SECTION.match(line)
        if m and body is None:
            cur = m.group(1).strip()
            continue
        s = line.strip()
        if s == "{":
            body = []
        elif s == "}":
            if cur is not None and body is not None:
                out[cur] = body
            cur, body = None, None
        elif body is not None and s:
            body.append(s)
    return out


def parse_chart(path: Path, ini: dict | None = None, difficulty: str = "expert") -> DrumChart:
    ini = ini or {}
    secs = _chart_sections(Path(path).read_text(encoding="utf-8-sig", errors="replace"))
    song = {}
    for line in secs.get("Song", []):
        k, _, v = line.partition("=")
        song[k.strip()] = v.strip().strip('"')
    res = int(float(song.get("Resolution", 192)))
    tempos, sigs = [], []
    for line in secs.get("SyncTrack", []):
        k, _, v = line.partition("=")
        parts = v.split()
        if not parts:
            continue
        t = int(k.strip())
        if parts[0] == "B":
            tempos.append((t, int(parts[1]) / 1000.0))
        elif parts[0] == "TS":
            den = 2 ** int(parts[2]) if len(parts) > 2 else 4
            sigs.append((t, int(parts[1]), den))
    tempo = TempoMap(res, tempos, sigs)
    sections = []
    for line in secs.get("Events", []):
        k, _, v = line.partition("=")
        parts = v.strip().split(None, 1)
        if len(parts) == 2 and parts[0] == "E":
            s = _section_name(parts[1].strip().strip('"'))
            if s:
                sections.append((int(k.strip()), s))
    name = difficulty.capitalize() + "Drums"
    track = secs.get(name)
    if track is None:
        raise ValueError(f"{path}: no [{name}] section")
    raw, flags, sp, fills, texts = [], [], [], [], []
    for line in track:
        k, _, v = line.partition("=")
        parts = v.split()
        if len(parts) < 2:
            continue
        t = int(k.strip())
        if parts[0] == "N":
            n, length = int(parts[1]), int(parts[2]) if len(parts) > 2 else 0
            if 0 <= n <= 5:
                raw.append(_RawNote(t, n))
            elif n == 32:
                raw.append(_RawNote(t, RAW_KICK, plus=True))
            elif n in (66, 67, 68):
                flags.append((t, n - 64, "cymbal"))
            elif 34 <= n <= 38:
                flags.append((t, n - 33, "accent"))
            elif 40 <= n <= 44:
                flags.append((t, n - 39, "ghost"))
        elif parts[0] == "S":
            p, length = int(parts[1]), int(parts[2]) if len(parts) > 2 else 0
            if p == 2:
                sp.append((t, t + length))
            elif p == 64:
                fills.append((t, t + length))
        elif parts[0] == "E":
            texts.append((t, " ".join(parts[1:]).strip('"')))
    for t, pad, kind in flags:
        for n in raw:
            if n.tick == t and n.pad == pad and not n.plus:
                if kind == "cymbal":
                    n.cymbal = True
                elif n.dyn is None:   # NoteFlagPriority: accent and ghost block each other
                    n.dyn = kind
    raw.sort(key=lambda n: (n.tick, n.pad))
    five = ini_bool(ini.get("five_lane_drums", "")) or any(n.pad == RAW_GREEN for n in raw)
    mix = [(t, s) for t, txt in texts if (ev := _mix_event(txt)) and ev[0] == difficulty for s in [ev[1]]]
    try:
        chart_off = float(song.get("Offset", 0) or 0)
    except ValueError:
        chart_off = 0.0
    return _finish(raw, five, mix, tempo, ini_delay_seconds(ini, chart_off), sections, sp, fills, [],
                   "chart", bool(flags))


# ── song folders ────────────────────────────────────────────────────────────

AUDIO_EXTS = (".ogg", ".opus", ".mp3", ".wav", ".flac", ".m4a")


def find_chart_file(folder: Path) -> Path | None:
    folder = Path(folder)
    for name in ("notes.mid", "notes.midi", "notes.chart"):
        p = folder / name
        if p.exists():
            return p
    hits = sorted(list(folder.glob("*.mid")) + list(folder.glob("*.chart")))
    return hits[0] if hits else None


def load_song_folder(folder: Path, difficulty: str = "expert") -> tuple[DrumChart, dict]:
    folder = Path(folder)
    ini = load_song_ini(folder / "song.ini")
    chart_path = find_chart_file(folder)
    if chart_path is None:
        raise FileNotFoundError(f"{folder}: no notes.mid or notes.chart")
    if chart_path.suffix.lower() == ".chart":
        chart = parse_chart(chart_path, ini, difficulty)
        if not ini.get("name") or not ini.get("artist"):
            secs = _chart_sections(chart_path.read_text(encoding="utf-8-sig", errors="replace"))
            for line in secs.get("Song", []):
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip().strip('"')
                if k == "Name":
                    ini.setdefault("name", v)
                elif k == "Artist":
                    ini.setdefault("artist", v)
                elif k == "Album":
                    ini.setdefault("album", v)
                elif k == "Year":
                    ini.setdefault("year", v.strip(", "))
    else:
        chart = parse_mid(chart_path, ini, difficulty)
    return chart, ini


def song_audio_files(folder: Path) -> dict[str, list[Path]]:
    """CH/YARG stem files grouped by role: song, guitar, rhythm, bass, drums, vocals, keys, crowd."""
    out: dict[str, list[Path]] = {}
    for p in sorted(Path(folder).iterdir()):
        if p.suffix.lower() not in AUDIO_EXTS or p.name.lower().startswith("preview"):
            continue
        stem = p.stem.lower()
        m = re.match(r"^(song|guitar|rhythm|bass|drums|vocals|keys|crowd)(?:_\d+)?$", stem)
        if m:
            out.setdefault(m.group(1), []).append(p)
    return out


# ── Slopsmith encoding ──────────────────────────────────────────────────────

def hit_to_wire(h: DrumHit) -> dict:
    gm = h.gm
    return {"t": round(h.time, 3), "s": gm // 24, "f": gm % 24, "sus": 0.0, "sl": -1, "slu": -1, "bn": 0,
            "ho": False, "po": False, "hm": False, "hp": False, "pm": False,
            "mt": h.dyn == "ghost", "vb": False, "tr": False, "ac": h.dyn == "accent", "tp": False}


def wire_to_hits(notes: list[dict]) -> list[DrumHit]:
    """Read drum hits back from wire notes (unknown GM numbers are dropped)."""
    out = []
    for n in notes:
        gm = int(n.get("s", 0)) * 24 + int(n.get("f", 0))
        pc = GM_TO_PAD.get(gm)
        if pc is None:
            continue
        dyn = "accent" if n.get("ac") else "ghost" if n.get("mt") else None
        out.append(DrumHit(time=float(n["t"]), pad=pc[0], cymbal=pc[1], kick2x=gm == GM_KICK2X, dyn=dyn))
    out.sort(key=lambda h: (h.time, PADS.index(h.pad)))
    return out


def drums_meta(chart: DrumChart, source: dict | None = None) -> dict:
    """The arrangement JSON's ``drums`` block: what the wire notes can't carry."""
    meta = {
        "version": 1,
        "pro": True,
        "kick2x": any(h.kick2x for h in chart.hits),
        "star_power": [[a, b] for a, b in chart.star_power],
        "fills": [[a, b] for a, b in chart.fills],
    }
    if chart.solos:
        meta["solos"] = [[a, b] for a, b in chart.solos]
    if source:
        meta["source"] = source
    return meta


def drums_arrangement(chart: DrumChart, *, name: str = "Drums", with_beats: bool = True,
                      source: dict | None = None) -> dict:
    """Wire-format arrangement dict for a Drums arrangement."""
    notes = sorted((hit_to_wire(h) for h in chart.hits), key=lambda n: (n["t"], n["s"] * 24 + n["f"]))
    arr = {"name": name, "tuning": [0] * 6, "capo": 0, "notes": notes, "chords": [], "anchors": [],
           "handshapes": [], "templates": [], "drums": drums_meta(chart, source)}
    if with_beats:
        arr["beats"] = chart.beat_list()
        arr["sections"] = [{"name": n, "number": i + 1, "time": t} for i, (t, n) in enumerate(chart.sections)]
    return arr


def shift_chart(chart: DrumChart, warp) -> DrumChart:
    """Copy of chart with every time mapped through warp(t) (alignment to other audio)."""
    import copy
    c = copy.deepcopy(chart)
    for h in c.hits:
        h.time = round(float(warp(h.time)), 4)
    c.star_power = [(round(float(warp(a)), 4), round(float(warp(b)), 4)) for a, b in c.star_power]
    c.fills = [(round(float(warp(a)), 4), round(float(warp(b)), 4)) for a, b in c.fills]
    c.solos = [(round(float(warp(a)), 4), round(float(warp(b)), 4)) for a, b in c.solos]
    c.sections = [(round(float(warp(t)), 4), n) for t, n in c.sections]
    return c


# ── star power / activation generation (for sources without them) ──────────

def _lower_bound(xs, v) -> int:
    """Index of the last element <= v, -1 if none (YARG ChartEventExtensions.LowerBound)."""
    import bisect
    return bisect.bisect_right(xs, v + 1e-9) - 1


def auto_star_power(note_times, beats, every_measures: int = 8, length_measures: int = 1,
                    first_measure: int = 4, min_notes: int = 4) -> list[tuple[float, float]]:
    """Slopsmith's own rule (not from YARG, which never invents star power): a one-measure
    phrase every ``every_measures`` measures, starting at measure ``first_measure``,
    skipping measures with fewer than ``min_notes`` hits.  ``beats``: [(time, measure|-1)]."""
    import bisect
    measures = [t for t, m in beats if m != -1]
    nt = sorted(note_times)
    out = []
    i = first_measure
    while i + length_measures < len(measures):
        a, b = measures[i], measures[i + length_measures]
        n = bisect.bisect_left(nt, b - 1e-6) - bisect.bisect_left(nt, a - 1e-6)
        if n >= min_notes:
            out.append((round(a, 4), round(b - 0.001, 4)))
            i += every_measures
        else:
            i += 1
    return out


def auto_fills(note_times, beats, star_power, solos=(), sections=()) -> list[tuple[float, float]]:
    """Drum fill (star power activation) phrases, ported from YARG.Core
    SongChart.AutoGeneration.ParseForActivationPhrases: every 4 measures (2 if that's more
    than 10 s away), snapped to section starts, at least 2 s after the last SP/solo/fill,
    only where 16+ notes follow within 4 measures; the fill spans the measure before the
    activation bar line.  (Time-signature snapping is skipped: sloppak beats carry no
    time signatures.)  Returns nothing when there is no star power, like YARG."""
    MIN_SPACING, MAX_SPACING, SP_MIN_NOTES = 2.0, 10.0, 16
    measures = [t for t, m in beats if m != -1]
    sp = sorted(star_power)
    if not sp or len(measures) < 6:
        return []
    solos = sorted(solos)
    sections = sorted(sections)
    sp_starts = [a for a, _ in sp]
    solo_starts = [a for a, _ in solos]
    last_solo = solos[-1][1] if solos else 0.0
    nt = sorted(note_times)
    import bisect
    spacing_ref = sp[0][1]
    cur = max(0, _lower_bound(measures, spacing_ref))
    sec_i = _lower_bound(sections, spacing_ref)
    sp_i, solo_i = 0, _lower_bound(solo_starts, spacing_ref)
    out = []
    total = len(measures)
    while cur < total - 4:
        per = 4
        if measures[cur + per] - spacing_ref > MAX_SPACING:
            per = 2
        cur += per
        mt = measures[cur]
        new_sec = _lower_bound(sections, mt)
        if new_sec > sec_i:
            sec_i = new_sec
            cur = max(0, _lower_bound(measures, sections[sec_i]))
            mt = measures[cur]
        new_sp = _lower_bound(sp_starts, mt)
        if new_sp > sp_i:
            sp_i = new_sp
            spacing_ref = max(sp[sp_i][1], spacing_ref)
        if solos and mt < last_solo:
            new_solo = _lower_bound(solo_starts, mt)
            if new_solo > solo_i:
                solo_i = new_solo
                spacing_ref = max(solos[solo_i][1], spacing_ref)
        if mt - spacing_ref < MIN_SPACING:
            continue
        end = measures[min(cur + 4, total - 1)]
        n = bisect.bisect_right(nt, end + 1e-6) - bisect.bisect_right(nt, mt + 1e-6)
        if n < SP_MIN_NOTES:
            continue
        spacing_ref = mt
        if cur >= 1:
            out.append((round(measures[cur - 1], 4), round(mt, 4)))
    return out
