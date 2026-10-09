"""sloppak.load_song must order arrangements exactly like extract_meta().

The library index (extract_meta) is what clients such as the multiplayer
plugin pass as the highway WebSocket's `?arrangement=N`, which indexes
`load_song(...).arrangements`. If the two orders diverge, picking e.g.
"Drums" loads a different arrangement.
"""

import json

import yaml

import sloppak


def _make_sloppak(root, names):
    pak = root / "song.sloppak"
    (pak / "arrangements").mkdir(parents=True)
    entries = []
    for name in names:
        rel = f"arrangements/{name.lower()}.json"
        (pak / rel).write_text(json.dumps({"name": name, "notes": [], "chords": []}))
        entries.append({"id": name.lower(), "name": name, "file": rel})
    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": "T", "artist": "A", "duration": 1.0,
        "arrangements": entries,
    }))
    return pak


def test_load_song_order_matches_extract_meta(tmp_path):
    dlc = tmp_path / "dlc"
    pak = _make_sloppak(dlc, ["Drums", "Bass", "Keys", "Lead", "Rhythm"])

    meta_names = [a["name"] for a in sloppak.extract_meta(pak)["arrangements"]]
    loaded = sloppak.load_song("song.sloppak", dlc, tmp_path / "cache")
    song_names = [a.name for a in loaded.song.arrangements]

    assert meta_names == ["Lead", "Rhythm", "Bass", "Drums", "Keys"]
    assert song_names == meta_names
    # Index stability is what the highway `?arrangement=N` relies on.
    for a in sloppak.extract_meta(pak)["arrangements"]:
        assert loaded.song.arrangements[a["index"]].name == a["name"]
