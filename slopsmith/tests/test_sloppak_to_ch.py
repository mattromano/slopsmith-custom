"""scripts/sloppak_to_ch.py, incl. a round trip through scripts/ch_to_sloppak.py."""
import json
import sys
from pathlib import Path

import mido
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import drumchart  # noqa: E402
from drum_fixtures import TPQ, click_track, drum_pattern, make_sloppak, write_audio, write_ini, write_mid  # noqa: E402

KICK, RED, YEL, BLU, ORG = 96, 97, 98, 99, 100


def _key(h):
    return (round(h.time, 2), h.pad, h.cymbal, h.kick2x, h.dyn)


def _source_folder(tmp_path):
    folder = tmp_path / "src"
    folder.mkdir()
    notes = drum_pattern(12, seed=4)
    notes += [(TPQ * 3, 95, 100, 10),                                   # 2x kick
              (TPQ * 5, BLU, 100, 10), (TPQ * 5, 111, 100, 10),          # blue tom
              (TPQ * 6, ORG, 100, 10), (TPQ * 6, 112, 100, 10),          # green tom
              (TPQ * 7, RED, 127, 10), (TPQ * 9, RED, 1, 10),            # accent, ghost
              (TPQ * 8, 116, 100, TPQ * 4), (TPQ * 20, 120, 100, TPQ * 4)]
    write_mid(folder / "notes.mid", notes, tempos=[(0, 120.0), (TPQ * 16, 150.0), (TPQ * 32, 96.0)],
              sigs=[(0, 4, 4), (TPQ * 24, 3, 4), (TPQ * 30, 4, 4)],
              texts=[(0, "[ENABLE_CHART_DYNAMICS]")], sections=[(0, "Intro"), (TPQ * 16, "Verse")])
    write_ini(folder / "song.ini", name="Round Trip", artist="Band", year=1999, delay=40)
    dur = 30.0
    write_audio(folder / "drums.ogg", click_track(np.arange(0, dur, 0.5), dur))
    write_audio(folder / "song.ogg", click_track(np.arange(0.25, dur, 1.0), dur, freq=440))
    return folder


def test_round_trip_ch_sloppak_ch(tmp_path):
    import ch_to_sloppak
    import sloppak_to_ch
    folder = _source_folder(tmp_path)
    orig, _ = drumchart.load_song_folder(folder)
    sp = tmp_path / "rt.sloppak"
    ch_to_sloppak.convert(folder, sp)
    out = tmp_path / "out"
    s = sloppak_to_ch.export(sp, out)
    assert s["parts"]["PART DRUMS"] == len(orig.hits)
    assert s["stems"] == ["drums", "song"]
    assert (out / "drums.ogg").exists() and (out / "song.ogg").exists()
    back, ini = drumchart.load_song_folder(out)
    assert ini["name"] == "Round Trip" and ini["pro_drums"] == "True"
    assert ini["delay"] == "40"       # first beat 40 ms in -> exported as delay, not a pickup beat
    assert sorted(map(_key, back.hits)) == sorted(map(_key, orig.hits))
    np.testing.assert_allclose(sorted(h.time for h in back.hits), sorted(h.time for h in orig.hits), atol=0.002)
    assert back.dynamics
    # lower levels: the source has none, so ch_to_sloppak generated them; they export as real
    # Easy/Medium/Hard parts and come back identical
    import zipfile
    meta = json.loads(zipfile.ZipFile(sp).read("arrangements/drums.json"))["drums"]
    assert sorted(meta["levels_generated"]) == ["easy", "hard", "medium"]
    for lv in ("easy", "medium", "hard"):
        want = sorted(map(_key, drumchart.rows_to_hits(meta["levels"][lv])))
        assert sorted(map(_key, back.levels[lv])) == want, lv
    np.testing.assert_allclose(back.star_power, orig.star_power, atol=0.002)
    np.testing.assert_allclose(back.fills, orig.fills, atol=0.002)
    assert [n for _, n in back.sections] == ["Intro", "Verse"]
    np.testing.assert_allclose([t for t, _ in back.sections], [t for t, _ in orig.sections], atol=0.002)
    # tempo map survives well enough that beats line up
    b0 = [b["time"] for b in orig.beat_list()]
    b1 = [b["time"] for b in back.beat_list()]
    n = min(len(b0), len(b1))
    np.testing.assert_allclose(b1[:n], b0[:n], atol=0.002)
    # and a second conversion gives the same sloppak notes
    sp2 = tmp_path / "rt2.sloppak"
    ch_to_sloppak.convert(out, sp2)
    import zipfile
    a1 = json.loads(zipfile.ZipFile(sp).read("arrangements/drums.json"))
    a2 = json.loads(zipfile.ZipFile(sp2).read("arrangements/drums.json"))
    assert [(n["s"], n["f"], n["ac"], n["mt"]) for n in a1["notes"]] == \
        [(n["s"], n["f"], n["ac"], n["mt"]) for n in a2["notes"]]


def _guitar_sloppak(tmp_path):
    beats = [{"time": round(0.3 + 0.5 * i, 3), "measure": i // 4 + 1 if i % 4 == 0 else -1} for i in range(40)]
    lead_notes = [{"t": round(0.3 + 0.25 * i, 3), "s": 3 + (i % 3), "f": 5 + (i * 7) % 10, "sus": 0}
                  for i in range(60)]
    lead_notes[10]["mt"] = True
    lead_notes[20]["sus"] = 1.0
    lead = {"name": "Lead", "notes": lead_notes,
            "chords": [{"t": 16.0, "id": 0, "notes": [{"s": 0, "f": 3}, {"s": 1, "f": 5}, {"s": 2, "f": 5}]}]}
    bass = {"name": "Bass", "notes": [{"t": round(0.3 + 0.5 * i, 3), "s": i % 4, "f": i % 5} for i in range(30)]}
    drums = {"name": "Drums", "notes": [drumchart.hit_to_wire(drumchart.DrumHit(0.3 + 0.5 * i, "kick"))
                                        for i in range(30)], "drums": {"star_power": [], "fills": []}}
    ents = [({"id": "bass", "name": "Bass", "file": "arrangements/bass.json", "tuning": [-2, 0, 0, 0, 0, 0],
              "capo": 0}, bass),
            ({"id": "drums", "name": "Drums", "file": "arrangements/drums.json", "tuning": [0] * 6, "capo": 0},
             drums)]
    sp = make_sloppak(tmp_path / "g.sloppak", {"guitar": click_track([1.0], 21), "drums": click_track([1.0], 21)},
                      beats=beats, extra_arrangements=ents)
    # make_sloppak's Lead is minimal; swap in ours
    import zipfile
    import shutil
    tmp = tmp_path / "unz"
    with zipfile.ZipFile(sp) as z:
        z.extractall(tmp)
    lead.update({"beats": beats, "sections": [{"name": "Intro", "number": 1, "time": 0.3}]})
    (tmp / "arrangements" / "lead.json").write_text(json.dumps(lead))
    sp.unlink()
    shutil.make_archive(str(sp.with_suffix("")), "zip", tmp)
    sp.with_suffix(".zip").rename(sp)
    return sp


def _track(mid, name):
    return next(t for t in mid.tracks if t.name == name)


def _ons(track):
    tick, out = 0, []
    for m in track:
        tick += m.time
        if m.type == "note_on" and m.velocity > 0:
            out.append((tick, m.note, m.velocity, m.channel))
    return out


def test_guitar_bass_parts(tmp_path):
    import sloppak_to_ch
    sp = _guitar_sloppak(tmp_path)
    s = sloppak_to_ch.export(sp, tmp_path / "o")
    assert set(s["parts"]) == {"PART DRUMS", "PART GUITAR", "PART BASS", "PART REAL_GUITAR_22", "PART REAL_BASS_22"}
    mid = mido.MidiFile(str(tmp_path / "o" / "notes.mid"))
    g = _ons(_track(mid, "PART GUITAR"))
    lanes = {n for _, n, _, _ in g}
    assert lanes <= set(range(96, 101)) and len(lanes) == 5            # all five frets used
    chord = [n for t, n, _, _ in g if t == g[-1][0]]
    assert len(chord) == 3 and sorted(chord) == list(range(min(chord), min(chord) + 3))
    pro = _ons(_track(mid, "PART REAL_GUITAR_22"))
    first = pro[0]
    assert first[1] == 96 + 3 and first[2] == 100 + 5 and first[3] == 0
    assert pro[10][3] == 3                                               # muted note -> channel 3
    ini = (tmp_path / "o" / "song.ini").read_text()
    assert "real_bass_tuning = -2 0 0 0" in ini and "diff_guitar = -1" in ini
    # pickup: first beat at 0.3 s -> 1 pickup beat, beat 1 lands on tick 480 at 0.3 s
    clock = sloppak_to_ch.BeatClock([{"time": 0.3 + 0.5 * i, "measure": -1} for i in range(4)])
    assert clock.pickup == 1 and clock.tick(0.3) == TPQ and clock.tick(0.0) == 0 and clock.tick(0.8) == 2 * TPQ
    # YARG/CH can read the drums back
    back, _ = drumchart.load_song_folder(tmp_path / "o")
    assert len(back.hits) == 30 and all(h.pad == "kick" for h in back.hits)
    assert back.hits[0].time == pytest.approx(0.3, abs=0.002)


def test_drums_only_export_flag(tmp_path):
    import sloppak_to_ch
    sp = _guitar_sloppak(tmp_path)
    s = sloppak_to_ch.export(sp, tmp_path / "d", guitars=False)
    assert set(s["parts"]) == {"PART DRUMS"}
