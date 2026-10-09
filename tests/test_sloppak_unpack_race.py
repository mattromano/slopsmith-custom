"""Concurrent loads of the same zipped sloppak must not unpack it over each other.

Multiplayer loads the queued song in every player's window at once. Before the
per-song unpack lock, each request rmtree'd and re-extracted the same cache dir,
so one could read manifest.yaml while another had just deleted or truncated it
("manifest.yaml must contain a mapping at the top level", blank highway).
"""
import threading
import time
import zipfile

import sloppak


def _make_sloppak(path):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("manifest.yaml", "title: T\nartist: A\narrangements: []\n")
        for i in range(20):
            z.writestr(f"stems/s{i}.bin", b"x" * 50_000)


def test_concurrent_resolve_unpacks_once(tmp_path, monkeypatch):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    _make_sloppak(dlc / "song.sloppak")
    cache = tmp_path / "cache"
    sloppak._source_cache.clear()

    calls = []
    real_unpack = sloppak._unpack_zip

    def slow_unpack(src, dest):
        calls.append(dest)
        time.sleep(0.05)          # widen the window the race needs
        real_unpack(src, dest)

    monkeypatch.setattr(sloppak, "_unpack_zip", slow_unpack)

    results, errors = [], []

    def load():
        try:
            d = sloppak.resolve_source_dir("song.sloppak", dlc, cache)
            results.append(sloppak._read_manifest(d)["title"])
        except Exception as e:  # pragma: no cover - the failure we guard against
            errors.append(e)

    threads = [threading.Thread(target=load) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert results == ["T"] * 6
    assert len(calls) == 1, "the song was unpacked more than once"
    assert sloppak._UNPACK_SERIALISED is True
