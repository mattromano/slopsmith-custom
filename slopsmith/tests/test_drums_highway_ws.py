"""End to end: a sloppak with Lead + Drums streams over /ws/highway the way the drums plugin
expects, and a player with no preference doesn't land on Drums."""
import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drumchart  # noqa: E402
from drum_fixtures import click_track, make_sloppak  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    hits = [drumchart.DrumHit(1.0 + 0.25 * i, ("kick", "red", "yellow", "blue")[i % 4], cymbal=i % 4 == 2,
                              dyn="accent" if i == 1 else "ghost" if i == 5 else None) for i in range(200)]
    drums = drumchart.drums_arrangement(drumchart.DrumChart(hits=hits, tempo=drumchart.TempoMap(480),
                                                            star_power=[(2.0, 4.0)]), with_beats=False)
    make_sloppak(dlc / "Song_-_Band.sloppak", {"guitar": click_track([1.0], 6), "drums": click_track([1.0], 6)},
                 beats=[{"time": 0.5 * i, "measure": -1} for i in range(10)],
                 extra_arrangements=[({"id": "drums", "name": "Drums", "file": "arrangements/drums.json",
                                       "tuning": [0] * 6, "capo": 0}, drums)])
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("SLOPSMITH_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    c = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield c
    finally:
        c.close()
        conn = getattr(getattr(server, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        sys.modules.pop("server", None)


def _stream(client, url):
    msgs = {}
    with client.websocket_connect(url) as ws:
        while True:
            m = ws.receive_json()
            if "error" in m:
                raise AssertionError(m)
            msgs.setdefault(m["type"], []).append(m)
            if m["type"] == "ready":
                return msgs


def test_default_is_not_drums_and_drums_stream_intact(client):
    msgs = _stream(client, "/ws/highway/Song_-_Band.sloppak")
    info = msgs["song_info"][0]
    names = [a["name"] for a in info["arrangements"]]
    assert names == ["Lead", "Drums"]
    assert info["arrangement"] == "Lead"          # Drums has 200 notes vs Lead's 1, still not the default

    msgs = _stream(client, f"/ws/highway/Song_-_Band.sloppak?arrangement={names.index('Drums')}")
    assert msgs["song_info"][0]["arrangement"] == "Drums"
    notes = [n for m in msgs["notes"] for n in m["data"]]
    assert len(notes) == 200
    gm = [n["s"] * 24 + n["f"] for n in notes[:4]]
    assert gm == [36, 38, 42, 45]
    assert notes[1]["ac"] and notes[5]["mt"] and not notes[0]["ac"]
    raw = client.get("/api/sloppak/Song_-_Band.sloppak/file/arrangements/drums.json").json()
    assert raw["drums"]["star_power"] == [[2.0, 4.0]]   # what the plugin fetches for SP/fills
