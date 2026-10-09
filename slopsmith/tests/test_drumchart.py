"""lib/drumchart.py + scripts/ch_to_sloppak.py with synthetic YARG/CH charts."""
import json
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import drumchart  # noqa: E402
from drum_fixtures import TPQ, click_track, write_audio, write_chart, write_ini, write_mid  # noqa: E402

KICK, RED, YEL, BLU, ORG, GRN = 96, 97, 98, 99, 100, 101


def _hits(chart):
    return [(round(h.time, 3), h.pad, h.cymbal, h.kick2x, h.dyn) for h in chart.hits]


# ── MIDI ────────────────────────────────────────────────────────────────────

def test_mid_tempo_map_with_tempo_change(tmp_path):
    p = write_mid(tmp_path / "notes.mid", [(0, KICK, 100, 10), (1920, RED, 100, 10), (2400, RED, 100, 10)],
                  tempos=[(0, 120.0), (1920, 60.0)])
    c = drumchart.parse_mid(p)
    assert [round(h.time, 4) for h in c.hits] == [0.0, 2.0, 3.0]
    assert c.tempo.tick_to_time(1920 + 960) == pytest.approx(4.0)
    assert c.tempo.time_to_tick(3.0) == pytest.approx(2400)


def test_mid_cymbals_default_and_tom_markers_toggle(tmp_path):
    notes = [(0, YEL, 100, 10), (0, BLU, 100, 10), (0, ORG, 100, 10),
             (480, YEL, 100, 10), (480, BLU, 100, 10), (480, ORG, 100, 10),
             (960, YEL, 100, 10),
             (480, 110, 100, 480), (480, 111, 100, 1), (480, 112, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes))
    got = {(round(h.time, 2), h.pad): h.cymbal for h in c.hits}
    assert got[(0.0, "yellow")] and got[(0.0, "blue")] and got[(0.0, "green")]
    # tom markers flip the pads they cover...
    assert not got[(0.5, "yellow")] and not got[(0.5, "blue")] and not got[(0.5, "green")]
    # ...over [start, end-1]: the note on the marker's end tick stays a cymbal
    assert got[(1.0, "yellow")]
    assert not c.five_lane


def test_mid_double_kick_and_gm_encoding(tmp_path):
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", [(0, KICK, 100, 10), (240, 95, 100, 10)]))
    assert _hits(c) == [(0.0, "kick", False, False, None), (0.25, "kick", False, True, None)]
    assert [h.gm for h in c.hits] == [36, 35]
    w = drumchart.hit_to_wire(c.hits[1])
    assert (w["s"], w["f"]) == (1, 11)


def test_mid_dynamics_need_enable_chart_dynamics(tmp_path):
    notes = [(0, RED, 127, 10), (480, RED, 1, 10), (960, KICK, 127, 10), (1440, YEL, 64, 10)]
    off = drumchart.parse_mid(write_mid(tmp_path / "a.mid", notes))
    assert [h.dyn for h in off.hits] == [None, None, None, None]
    on = drumchart.parse_mid(write_mid(tmp_path / "b.mid", notes, texts=[(0, "[ENABLE_CHART_DYNAMICS]")]))
    assert [h.dyn for h in on.hits] == ["accent", "ghost", None, None]   # kicks never get dynamics
    assert on.dynamics
    wires = [drumchart.hit_to_wire(h) for h in on.hits]
    assert wires[0]["ac"] and not wires[0]["mt"] and wires[1]["mt"] and not wires[1]["ac"]


def test_mid_phrases_sections_and_delay(tmp_path):
    notes = [(0, KICK, 100, 10), (1920, RED, 100, 10),
             (960, 116, 100, 1920),          # star power: 1.0 .. 3.0 s
             (2880, 120, 100, 960), (2880, 121, 100, 960),   # one fill (lane notes 120-124 share it)
             (3840, 103, 100, 480)]          # solo
    write_mid(tmp_path / "notes.mid", notes, sections=[(0, "Intro"), (1920, "verse_1")])
    write_ini(tmp_path / "song.ini", name="Song", artist="Band", delay=250)
    c, ini = drumchart.load_song_folder(tmp_path)
    assert ini["name"] == "Song"
    assert c.offset == pytest.approx(0.25)
    assert [round(h.time, 3) for h in c.hits] == [0.25, 2.25]
    assert c.star_power == [(1.25, 3.25)]
    assert c.fills == [(3.25, 4.25)]
    assert c.solos == [(4.25, 4.75)]
    assert c.sections == [(0.25, "Intro"), (2.25, "verse 1")]


def test_mid_five_lane_converts_to_pro_four_lane(tmp_path):
    notes = [(0, YEL, 100, 10), (480, BLU, 100, 10), (960, ORG, 100, 10), (1440, GRN, 100, 10),
             (1920, ORG, 100, 10), (1920, GRN, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes))
    assert c.five_lane
    assert [(h.pad, h.cymbal) for h in c.hits] == [
        ("yellow", True), ("blue", False), ("green", True), ("green", False),
        ("blue", True), ("green", False)]     # orange+green chord -> blue cym + green tom


def test_mid_disco_flip_swaps_red_and_yellow(tmp_path):
    notes = [(0, RED, 100, 10), (480, RED, 100, 10), (480, YEL, 100, 10), (1440, RED, 100, 10)]
    texts = [(480, "[mix 3 drums0d]"), (960, "[mix 3 drums0]")]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes, texts=texts))
    assert [(round(h.time, 2), h.pad, h.cymbal) for h in c.hits] == [
        (0.0, "red", False), (0.5, "red", False), (0.5, "yellow", True), (1.5, "red", False)]


def test_mid_only_part_drums_expert(tmp_path):
    notes = [(0, 60, 100, 10), (0, 72, 100, 10), (0, 84, 100, 10), (480, RED, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes))
    assert _hits(c) == [(0.5, "red", False, False, None)]
    with pytest.raises(ValueError):
        drumchart.parse_mid(write_mid(tmp_path / "g.mid", notes, track_name="PART GUITAR"))


def test_beats_follow_time_signatures(tmp_path):
    notes = [(0, KICK, 100, 10), (TPQ * 10, KICK, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes, sigs=[(0, 4, 4), (TPQ * 4, 3, 4)]))
    beats = c.beat_list()
    assert [b["measure"] for b in beats[:8]] == [1, -1, -1, -1, 2, -1, -1, 3]
    assert beats[4]["time"] == pytest.approx(2.0)
    assert beats[-1]["time"] >= c.hits[-1].time - 0.5


# ── .chart ──────────────────────────────────────────────────────────────────

def test_chart_markers_dynamics_and_phrases(tmp_path):
    R = 192
    lines = [(0, "N", 0, 0), (0, "N", 2, 0), (0, "N", 66, 0),         # kick + yellow cymbal
             (R, "N", 2, 0),                                          # yellow tom (default)
             (2 * R, "N", 1, 0), (2 * R, "N", 34, 0),                 # red accent
             (3 * R, "N", 3, 0), (3 * R, "N", 42, 0), (3 * R, "N", 67, 0),   # blue ghost cymbal
             (4 * R, "N", 32, 0), (4 * R, "N", 4, 0), (4 * R, "N", 68, 0),   # 2x kick + green cymbal
             (5 * R, "N", 4, 0),                                      # green tom
             (0, "S", 2, 4 * R), (4 * R, "S", 64, 2 * R)]
    p = write_chart(tmp_path / "notes.chart", lines, events=[(0, "Intro")], offset=0.1)
    write_ini(tmp_path / "song.ini", pro_drums="True")
    c, ini = drumchart.load_song_folder(tmp_path)
    assert c.source_format == "chart" and ini["name"] == "Song" and ini["artist"] == "Band"
    assert c.offset == pytest.approx(0.1)
    assert [(round(h.time - 0.1, 3), h.pad, h.cymbal, h.kick2x, h.dyn) for h in c.hits] == [
        (0.0, "kick", False, False, None), (0.0, "yellow", True, False, None),
        (0.5, "yellow", False, False, None),
        (1.0, "red", False, False, "accent"),
        (1.5, "blue", True, False, "ghost"),
        (2.0, "kick", False, True, None), (2.0, "green", True, False, None),
        (2.5, "green", False, False, None)]
    assert c.star_power == [(0.1, 2.1)]
    assert c.fills == [(2.1, 3.1)]
    assert c.sections == [(0.1, "Intro")]
    assert p.exists()


def test_ini_delay_beats_chart_offset(tmp_path):
    write_chart(tmp_path / "notes.chart", [(0, "N", 1, 0)], offset=0.5)
    write_ini(tmp_path / "song.ini", delay=-120)
    c, _ = drumchart.load_song_folder(tmp_path)
    assert c.hits[0].time == pytest.approx(-0.12)


# ── wire encoding ───────────────────────────────────────────────────────────

def test_wire_round_trip_every_pad():
    hits = [drumchart.DrumHit(1.0, "kick"), drumchart.DrumHit(1.0, "kick", kick2x=True),
            drumchart.DrumHit(1.0, "red", dyn="ghost"), drumchart.DrumHit(1.0, "yellow", True),
            drumchart.DrumHit(1.0, "yellow", False), drumchart.DrumHit(1.0, "blue", True, dyn="accent"),
            drumchart.DrumHit(1.0, "blue", False), drumchart.DrumHit(1.0, "green", True),
            drumchart.DrumHit(1.0, "green", False)]
    wires = [drumchart.hit_to_wire(h) for h in hits]
    assert [w["s"] * 24 + w["f"] for w in wires] == [36, 35, 38, 42, 48, 51, 45, 49, 41]
    back = drumchart.wire_to_hits(wires)
    key = lambda h: (h.pad, h.cymbal, h.kick2x, h.dyn)  # noqa: E731
    assert sorted(map(key, back)) == sorted(map(key, hits))


def test_wire_notes_survive_slopsmith_note_model():
    """Drum wire notes must round-trip through lib/song.py unchanged (that's how the server streams them)."""
    from song import note_from_wire, note_to_wire
    for h in [drumchart.DrumHit(2.5, "blue", True, dyn="accent"), drumchart.DrumHit(2.5, "red", dyn="ghost"),
              drumchart.DrumHit(2.5, "kick", kick2x=True)]:
        w = drumchart.hit_to_wire(h)
        assert note_to_wire(note_from_wire(w)) == w


# ── end to end ──────────────────────────────────────────────────────────────

def _song_folder(tmp_path, *, stems=False):
    folder = tmp_path / "Band - Song"
    folder.mkdir()
    notes = [(i * 480, KICK if i % 2 == 0 else RED, 100, 10) for i in range(16)]
    notes += [(i * 240, YEL, 100, 10) for i in range(32)]
    notes += [(0, 116, 100, 1920)]
    write_mid(folder / "notes.mid", notes, sections=[(0, "Intro"), (3840, "Verse")])
    write_ini(folder / "song.ini", name="Song", artist="Band", album="Record", year="2004", delay=0, charter="me")
    y = click_track([i * 0.5 for i in range(16)], 9.0)
    if stems:
        write_audio(folder / "drums.ogg", y)
        write_audio(folder / "song.ogg", 0.2 * y)
        write_audio(folder / "crowd.ogg", 0.1 * y)
    else:
        write_audio(folder / "song.ogg", y)
    return folder


def test_convert_folder_to_sloppak_and_load(tmp_path):
    import ch_to_sloppak
    from sloppak import load_song
    folder = _song_folder(tmp_path)
    out = tmp_path / "dlc" / "Song_-_Band.sloppak"
    out.parent.mkdir()
    s = ch_to_sloppak.convert(folder, out)
    assert s["notes"] == 48 and s["stems"] == ["full"] and s["star_power"] == 1
    with zipfile.ZipFile(out) as z:
        man = yaml.safe_load(z.read("manifest.yaml"))
        arr = json.loads(z.read("arrangements/drums.json"))
    assert man["title"] == "Song" and man["artist"] == "Band" and man["year"] == 2004
    assert man["arrangements"] == [{"id": "drums", "name": "Drums", "file": "arrangements/drums.json",
                                    "tuning": [0] * 6, "capo": 0}]
    assert man["duration"] >= 8.9
    assert arr["drums"]["star_power"] == [[0.0, 2.0]]
    assert arr["drums"]["source"]["format"] == "mid"
    assert arr["beats"][0] == {"time": 0.0, "measure": 1}
    assert [s["name"] for s in arr["sections"]] == ["Intro", "Verse"]

    loaded = load_song(out.name, out.parent, tmp_path / "cache")
    a = loaded.song.arrangements[0]
    assert a.name == "Drums" and len(a.notes) == 48
    assert {n.string * 24 + n.fret for n in a.notes} == {36, 38, 42}
    assert loaded.song.beats and loaded.song.sections


def test_convert_maps_ch_stems(tmp_path):
    import ch_to_sloppak
    folder = _song_folder(tmp_path, stems=True)
    out = tmp_path / "x.sloppak"
    s = ch_to_sloppak.convert(folder, out)
    assert s["stems"] == ["drums", "other"]    # crowd dropped, song -> other
    with zipfile.ZipFile(out) as z:
        assert {"stems/drums.ogg", "stems/other.ogg"} <= set(z.namelist())
