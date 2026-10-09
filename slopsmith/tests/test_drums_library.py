"""lib/sngfile.py, lib/chorus.py and scripts/drums_library.py."""
import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import chorus  # noqa: E402
import drumchart  # noqa: E402
import sngfile  # noqa: E402
from drum_fixtures import drum_audio, drum_pattern, make_sloppak, write_audio, write_mid, write_sng  # noqa: E402


def _sng(tmp_path, *, drums_stem=True):
    src = tmp_path / "src"
    src.mkdir()
    write_mid(src / "notes.mid", drum_pattern(20, seed=7) + [(1920 * 4, 116, 100, 1920)])
    chart = drumchart.parse_mid(src / "notes.mid")
    write_audio(src / "a.ogg", drum_audio([(h.time, h.pad, h.cymbal) for h in chart.hits], 44, seed=2))
    files = {"notes.mid": (src / "notes.mid").read_bytes(), "song.ogg": b"x" * 100, "video.mp4": b"v" * 50}
    if drums_stem:
        files["drums_1.ogg"] = (src / "a.ogg").read_bytes()
        files["drums_2.ogg"] = (src / "a.ogg").read_bytes()
    else:
        files["song.ogg"] = (src / "a.ogg").read_bytes()
    p = write_sng(tmp_path / "Band - Song.sng", files, {"name": "Song", "artist": "Band", "delay": "0"})
    return p, chart


def test_sng_read_and_extract(tmp_path):
    p, chart = _sng(tmp_path)
    meta, files = sngfile.read_sng(p)
    assert meta["name"] == "Song" and set(files) >= {"notes.mid", "drums_1.ogg", "video.mp4"}
    out = sngfile.extract_sng(p, tmp_path / "x")
    assert not (out / "video.mp4").exists()                     # videos skipped
    assert (out / "notes.mid").read_bytes() == (tmp_path / "src" / "notes.mid").read_bytes()
    c, ini = drumchart.load_song_folder(out)
    assert ini["artist"] == "Band" and len(c.hits) == len(chart.hits)
    head = p.read_bytes()[:40]
    with pytest.raises(sngfile.NeedMore):
        sngfile.parse_header(head)
    with pytest.raises(sngfile.SngError):
        sngfile.parse_header(b"NOTSNG" + b"\0" * 100)


def test_chorus_fetch_takes_only_chart_and_drum_stems(tmp_path, monkeypatch):
    p, _ = _sng(tmp_path)
    blob = p.read_bytes()
    calls = []

    def fake_range(md5, a, b):
        calls.append((a, b))
        return blob[a:b + 1]
    monkeypatch.setattr(chorus, "_range", fake_range)
    out = chorus.fetch("abc", tmp_path / "cache" / "abc")
    assert sorted(x.name for x in out.iterdir()) == [".complete", "drums_1.ogg", "drums_2.ogg", "notes.mid", "song.ini"]
    n = len(calls)
    chorus.fetch("abc", tmp_path / "cache" / "abc")              # cached: no more requests
    assert len(calls) == n


def test_chorus_search_keeps_only_drum_charts(monkeypatch):
    data = {"data": [{"md5": "a", "notesData": {"instruments": ["guitar"]}, "diff_drums": -1},
                     {"md5": "b", "notesData": {"instruments": ["drums", "guitar"]}, "diff_drums": 3},
                     {"md5": "c", "notesData": None, "diff_drums": 0}]}
    monkeypatch.setattr(chorus, "_req", lambda *a, **k: json.dumps(data).encode())
    assert [r["md5"] for r in chorus.search("x")] == ["b", "c"]


def test_online_candidates_rank_by_name_then_length(monkeypatch):
    import drums_library
    res = [{"md5": "live", "artist": "Band", "name": "Song (Live)", "song_length": 300000, "pro_drums": True},
           {"md5": "studio", "artist": "Band", "name": "Song", "song_length": 201000, "pro_drums": False},
           {"md5": "other", "artist": "Band", "name": "Other Song", "song_length": 200000},
           {"md5": "studio", "artist": "Band", "name": "Song", "song_length": 201000}]
    monkeypatch.setattr(chorus, "search", lambda q: res)
    c = drums_library.online_candidates("Band", "Song", 200.0, 0.86)
    assert [x["md5"] for x in c] == ["studio", "live"]


def test_clean_title():
    import drums_library
    assert drums_library.clean_title("Welcome To The Family (Bass)") == "Welcome To The Family"
    assert drums_library.clean_title("Song [DD] (Remastered 2011)") == "Song"
    assert drums_library.clean_title("Lauren (Track 2)") == "Lauren (Track 2)"


def test_ensure_backup(tmp_path):
    import drums_library
    src = tmp_path / "a.sloppak"
    src.write_bytes(b"1234")
    bd = tmp_path / "bak"
    b1 = drums_library.ensure_backup(src, bd)
    assert b1.read_bytes() == b"1234"
    assert drums_library.ensure_backup(src, bd) == b1 and len(list(bd.iterdir())) == 1
    src.write_bytes(b"123456")                                     # changed since: keep both
    b2 = drums_library.ensure_backup(src, bd)
    assert b2 != b1 and b1.read_bytes() == b"1234" and len(list(bd.iterdir())) == 2


def test_library_run_end_to_end(tmp_path, monkeypatch):
    import drums_library
    sng, chart = _sng(tmp_path)
    lib = tmp_path / "lib"
    lib.mkdir()
    hits = [(h.time + 1.5, h.pad, h.cymbal) for h in chart.hits]
    make_sloppak(lib / "song.sloppak", {"drums": drum_audio(hits, 48, seed=5, noise=0.003)},
                 beats=[{"time": 0.5 * i, "measure": -1} for i in range(90)], title="Song", artist="Band")
    make_sloppak(lib / "nomatch.sloppak", {"drums": drum_audio(hits, 48)}, title="Unknown", artist="Nobody")
    bd = tmp_path / "bak"
    bd.mkdir()
    (bd / "placeholder").write_text("x")
    state = tmp_path / "state.json"
    argv = ["drums_library.py", str(lib), "--backup-dir", str(bd), "--local", str(tmp_path), "--no-online",
            "--workers", "1", "--state", str(state)]
    monkeypatch.setattr(sys, "argv", argv)
    drums_library.main()                                           # dry run first
    s = json.loads(state.read_text())
    assert s["song.sloppak"]["status"] == "would-join" and s["nomatch.sloppak"]["status"] == "no-chart"
    assert "arrangements/drums.json" not in zipfile.ZipFile(lib / "song.sloppak").namelist()
    monkeypatch.setattr(sys, "argv", argv + ["--write"])
    drums_library.main()                                           # would-join songs are redone with --write
    s = json.loads(state.read_text())
    assert s["song.sloppak"]["status"] == "joined"
    assert "arrangements/drums.json" in zipfile.ZipFile(lib / "song.sloppak").namelist()
    assert (bd / "song.sloppak").exists()                          # backed up before the write
    assert "arrangements/drums.json" not in zipfile.ZipFile(bd / "song.sloppak").namelist()
    assert (state.with_suffix(".csv")).read_text().count("\n") == 3
