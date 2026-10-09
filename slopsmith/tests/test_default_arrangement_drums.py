"""The highway's no-preference default must not land guitar players on a Drums chart."""
from song import Arrangement, Chord, Note

import server


def _arr(name, n):
    return Arrangement(name=name, notes=[Note(time=i * 0.1, string=0, fret=0) for i in range(n)])


def test_most_notes_skips_drums():
    arrs = [_arr("Lead", 100), _arr("Rhythm", 300), _arr("Drums", 2000)]
    assert server._most_notes_arrangement(arrs) == 1


def test_only_drums_still_picks_drums():
    assert server._most_notes_arrangement([_arr("Drums", 10)]) == 0
    assert server._most_notes_arrangement([_arr("Drums", 10), _arr("Percussion", 30)]) == 1


def test_chord_notes_count():
    lead = _arr("Lead", 5)
    rhythm = Arrangement(name="Rhythm", chords=[Chord(time=0, chord_id=0, notes=[Note(time=0, string=s, fret=2)
                                                                                for s in range(3)])] * 3)
    assert server._most_notes_arrangement([lead, rhythm, _arr("Drum Kit", 99)]) == 1
