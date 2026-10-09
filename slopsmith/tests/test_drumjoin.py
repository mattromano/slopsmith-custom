"""Drum-chart joiner (lib/drumalign.py, lib/drumjoin.py, scripts/drums_join.py) on synthetic
charts + audio with known offsets and tempo warps."""
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import drumalign  # noqa: E402
import drumchart  # noqa: E402
import drumjoin  # noqa: E402
from drum_fixtures import (click_track, drum_audio, drum_pattern, make_gp5, make_sloppak,  # noqa: E402
                           write_audio, write_ini, write_mid)

N_MEASURES = 30          # 60 s at 120 BPM


def _chart_folder(tmp_path, *, delay=0, audio="drums", seed=1, name="Song", artist="Band"):
    folder = tmp_path / f"{artist} - {name}"
    folder.mkdir()
    notes = drum_pattern(N_MEASURES, seed=seed) + [(4 * 1920, 116, 100, 1920), (12 * 1920, 116, 100, 1920)]
    write_mid(folder / "notes.mid", notes, sections=[(0, "Intro"), (8 * 1920, "Verse")])
    write_ini(folder / "song.ini", name=name, artist=artist, delay=delay)
    chart, _ = drumchart.load_song_folder(folder)
    hits = [(h.time, h.pad, h.cymbal) for h in chart.hits]   # chart-audio time (delay applied)
    if audio == "drums":
        write_audio(folder / "drums.ogg", drum_audio(hits, N_MEASURES * 2 + 3, seed=11))
    elif audio == "mix":
        y = drum_audio(hits, N_MEASURES * 2 + 3, seed=11) + click_track(
            np.arange(0.3, N_MEASURES * 2, 0.77), N_MEASURES * 2 + 3, freq=[220, 330, 440], seed=3)
        write_audio(folder / "song.ogg", y)
    return folder, chart


def _our_sloppak(tmp_path, hits, *, dur=None, name="ours.sloppak", other=None, **kw):
    """hits: DrumHits / (time, pad, cymbal) tuples / bare times, already on our timeline."""
    hits = [(h.time, h.pad, h.cymbal) if hasattr(h, "pad") else (h if isinstance(h, tuple) else (h, "red", False))
            for h in hits]
    dur = dur or (max(h[0] for h in hits) + 4)
    stems = {"drums": drum_audio(hits, dur, seed=99, noise=0.005)}
    if other is not None:
        stems["other"] = other
    beats = [{"time": round(0.5 * i, 3), "measure": i // 4 + 1 if i % 4 == 0 else -1} for i in range(int(dur * 2))]
    return make_sloppak(tmp_path / name, stems, beats=beats, **kw)


def _moved(h, t):
    return (float(t), h.pad, h.cymbal)


def _read(sp):
    with zipfile.ZipFile(sp) as z:
        man = yaml.safe_load(z.read("manifest.yaml"))
        arr = json.loads(z.read("arrangements/drums.json")) if "arrangements/drums.json" in z.namelist() else None
    return man, arr


# ── xcorr / validation primitives ───────────────────────────────────────────

def test_xcorr_recovers_lag_subframe():
    t = np.sort(np.random.default_rng(0).uniform(1, 40, 120))
    a = drumalign.onset_env(click_track(t, 50))
    b = drumalign.onset_env(click_track(t + 2.345, 50, seed=5))
    lag, conf, ratio = drumalign.xcorr(b, a, 10)
    assert lag == pytest.approx(2.345, abs=0.006)
    assert conf > 10 and ratio > 1.05


def test_validate_reports_offset_and_drift():
    nt = np.arange(0, 60, 0.25)
    good = drumalign.validate(nt, nt + 0.008)
    assert good.ok and good.within_30ms == 1.0 and good.median_offset == pytest.approx(0.008, abs=1e-6)
    late = drumalign.validate(nt, nt + 0.06)
    assert not late.ok and late.within_30ms == 0.0 and late.within_30ms_centered == 1.0
    drift = drumalign.validate(nt, nt + nt * 0.0012)            # 72 ms over a minute
    assert not drift.ok and any("drifts" in r for r in drift.reasons)
    assert drift.drift_ms_per_min == pytest.approx(72, abs=2)


# ── source a: charts ────────────────────────────────────────────────────────

def test_join_chart_with_known_offset(tmp_path):
    folder, chart = _chart_folder(tmp_path)
    true_off = 1.237
    sp = _our_sloppak(tmp_path, [_moved(h, h.time + true_off) for h in chart.hits])
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",), backup_dir=tmp_path / "bak")
    cand = rep["candidates"][0]
    assert rep["written"] == "chart"
    assert cand["alignment"]["method"] == "offset"
    assert cand["alignment"]["offset"] == pytest.approx(true_off, abs=0.006)
    assert cand["validation"]["within_30ms"] > 0.9
    man, arr = _read(sp)
    assert [a["name"] for a in man["arrangements"]] == ["Lead", "Drums"]
    assert "beats" not in arr                     # song-level beats stay on Lead
    assert arr["drums"]["star_power"][0][0] == pytest.approx(4 * 2 + true_off, abs=0.01)
    assert arr["drums"]["fills"], "YARG-style activation fills generated from star power"
    got = sorted(n["t"] for n in arr["notes"])
    want = sorted(round(h.time + true_off, 3) for h in chart.hits)
    assert np.max(np.abs(np.array(got) - np.array(want))) < 0.01
    assert man["x_drums"]["source"] == "chart" and not man["x_drums"]["forced"]
    assert list((tmp_path / "bak").glob("ours.*.sloppak")), "original backed up"


def test_join_honours_song_ini_delay(tmp_path):
    folder, chart = _chart_folder(tmp_path, delay=300)
    assert chart.offset == pytest.approx(0.3)
    sp = _our_sloppak(tmp_path, [_moved(h, h.time + 0.5) for h in chart.hits])
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",))
    assert rep["written"] == "chart"
    assert rep["candidates"][0]["alignment"]["offset"] == pytest.approx(0.5, abs=0.006)
    _, arr = _read(sp)
    first = min(n["t"] for n in arr["notes"])
    assert first == pytest.approx(chart.hits[0].time + 0.5, abs=0.01)  # chart time 0 + delay + offset


def test_join_full_mix_when_chart_has_no_drum_stem(tmp_path):
    folder, chart = _chart_folder(tmp_path, audio="mix")
    other = click_track(np.arange(0.3, N_MEASURES * 2, 0.77) + 0.8, N_MEASURES * 2 + 4, freq=[220, 330, 440],
                        seed=3)
    sp = _our_sloppak(tmp_path, [_moved(h, h.time + 0.8) for h in chart.hits], other=other)
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",))
    c = rep["candidates"][0]
    assert c["chart_audio"] == "mix"
    assert c["alignment"]["offset"] == pytest.approx(0.8, abs=0.01)
    assert rep["written"] == "chart"


def test_join_synthetic_envelope_when_chart_has_no_audio(tmp_path):
    folder, chart = _chart_folder(tmp_path, audio=None)
    sp = _our_sloppak(tmp_path, [_moved(h, h.time + 3.1) for h in chart.hits])
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",))
    c = rep["candidates"][0]
    assert c["chart_audio"] == "synthetic"
    assert c["alignment"]["offset"] == pytest.approx(3.1, abs=0.01)
    assert rep["written"] == "chart"


def test_join_tempo_warp_falls_back_to_beat_warp(tmp_path):
    folder, chart = _chart_folder(tmp_path)

    def warp(t):          # a different master: 1.5% slower plus a wobble
        return 0.7 + 1.015 * t + 0.12 * np.sin(2 * np.pi * t / 37)
    sp = _our_sloppak(tmp_path, [_moved(h, warp(h.time)) for h in chart.hits])
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",))
    c = rep["candidates"][0]
    assert c["alignment"]["method"] == "warp"
    assert c["validation"]["within_30ms"] > 0.85, c["validation"]
    assert rep["written"] == "chart"
    _, arr = _read(sp)
    got = np.array(sorted(n["t"] for n in arr["notes"]))
    want = np.array(sorted(warp(h.time) for h in chart.hits))
    assert np.median(np.abs(got - want)) < 0.02


def test_offset_only_on_warped_audio_is_flagged(tmp_path):
    folder, chart = _chart_folder(tmp_path)
    sp = _our_sloppak(tmp_path, [_moved(h, 0.7 + 1.015 * h.time) for h in chart.hits])
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",), force_method="offset")
    v = rep["candidates"][0]["validation"]
    assert not v["ok"] and rep["written"] is None
    man, arr = _read(sp)
    assert arr is None and [a["name"] for a in man["arrangements"]] == ["Lead"]


def test_wrong_song_is_flagged_not_written_unless_forced(tmp_path):
    folder, chart = _chart_folder(tmp_path)
    other_song = drumchart.parse_mid(write_mid(tmp_path / "x.mid", drum_pattern(N_MEASURES, seed=42)))
    sp = _our_sloppak(tmp_path, [_moved(h, h.time * 0.93 + 0.4) for h in other_song.hits])
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",))
    assert rep["written"] is None
    assert not rep["candidates"][0]["validation"]["ok"]
    assert _read(sp)[1] is None
    rep = drumjoin.join(sp, chart_folder=folder, sources=("chart",), force=True)
    assert rep["written"] == "chart"
    man, arr = _read(sp)
    assert man["x_drums"]["forced"] and arr is not None


def test_rejoin_replaces_existing_drums(tmp_path):
    folder, chart = _chart_folder(tmp_path)
    sp = _our_sloppak(tmp_path, [_moved(h, h.time + 1.0) for h in chart.hits], zip_form=False)   # directory form too
    for _ in range(2):
        assert drumjoin.join(sp, chart_folder=folder, sources=("chart",))["written"] == "chart"
    man = yaml.safe_load((sp / "manifest.yaml").read_text())
    assert [a["name"] for a in man["arrangements"]] == ["Lead", "Drums"]
    assert sorted(p.name for p in (sp / "arrangements").iterdir()) == ["drums.json", "lead.json"]


# ── fuzzy matching ──────────────────────────────────────────────────────────

def test_fuzzy_match_against_chart_dir(tmp_path):
    root = tmp_path / "charts"
    for artist, name in [("The Dirty Nil", "Doom Boy"), ("Prince Daddy & The Hyena", "Lauren (Track 2)"),
                         ("Dirty Nil", "Possession"), ("Other Band", "Doom Bay")]:
        d = root / f"{artist} - {name}"
        d.mkdir(parents=True)
        write_ini(d / "song.ini", name=name, artist=artist)
    (root / "Folder Only - Song Title").mkdir()
    (root / "Folder Only - Song Title" / "notes.chart").write_text("")
    idx = drumjoin.index_chart_dir(root)
    assert len(idx) == 5
    e, s = drumjoin.best_match(idx, "Dirty Nil", "Doom Boy (Songsterr)")
    assert e.title == "Doom Boy" and e.artist == "The Dirty Nil" and s > 0.9
    e, _ = drumjoin.best_match(idx, "Prince Daddy and the Hyena", "Lauren (Track 2)")
    assert e.title == "Lauren (Track 2)"
    e, _ = drumjoin.best_match(idx, "folder only", "song title")
    assert e.title == "Song Title"
    e, s = drumjoin.best_match(idx, "Nobody", "Completely Different")
    assert e is None and s < 0.82


# ── source b: GP drum track ─────────────────────────────────────────────────

def _gp_slots(m, slot):
    out = [36] if slot % 4 == 0 else []
    if slot in (2, 6):
        out.append(38)
    if (m * 8 + slot) % 3 != 1:
        out.append(42)
    if slot == 0 and m % 4 == 0:
        out.append(49)
    return out


def test_gp_drum_track_placed_with_stored_sync_map(tmp_path):
    n = 24
    gp = make_gp5(tmp_path / "tab.gp5", n, _gp_slots)
    tab_beats = [0.5 * i for i in range(n * 4 + 1)]
    audio_beats = [1.3 + 0.52 * i for i in range(n * 4 + 1)]       # band ~4% slower, 1.3 s intro
    expect = []
    for m in range(n):
        for slot in range(8):
            if _gp_slots(m, slot):
                expect.append(1.3 + 0.52 * (m * 4 + slot / 2))
    sp = _our_sloppak(tmp_path, expect, x_build={"tool": "gp_to_sloppak", "gp": str(gp)},
                      x_sync={"tab_beats": tab_beats, "audio_beats": audio_beats, "report": {"method": "beat-dtw"}})
    rep = drumjoin.join(sp, sources=("chart", "gp"))
    assert rep["written"] == "gp"
    c = rep["candidates"][0]
    assert c["track_name"] == "Drums" and c["sync_method"] == "beat-dtw"
    man, arr = _read(sp)
    gms = {n["s"] * 24 + n["f"] for n in arr["notes"]}
    assert gms == {36, 38, 42, 49}
    assert min(n["t"] for n in arr["notes"]) == pytest.approx(1.3, abs=0.005)
    assert arr["drums"]["star_power"], "auto star power for sources without it"
    assert arr["drums"]["source"]["source"] == "gp"


def test_chart_preferred_over_gp_and_gp_used_when_chart_fails(tmp_path):
    folder, chart = _chart_folder(tmp_path)
    gp = make_gp5(tmp_path / "tab.gp5", 4, _gp_slots)
    sp = _our_sloppak(tmp_path, [_moved(h, h.time + 0.25) for h in chart.hits], x_build={"gp": str(gp)},
                      x_sync={"tab_beats": [0, 1], "audio_beats": [0, 1]})
    rep = drumjoin.join(sp, chart_folder=folder)
    assert rep["written"] == "chart" and len(rep["candidates"]) == 1


# ── transcription hook ──────────────────────────────────────────────────────

def test_transcriber_hook(tmp_path):
    times = list(np.arange(1, 50, 0.37))
    sp = _our_sloppak(tmp_path, times)
    drumjoin.register_transcriber("fake", lambda path, sr: [drumchart.DrumHit(t, "red") for t in times])
    rep = drumjoin.join(sp, sources=(), transcriber="fake")
    assert rep["written"] == "transcribe:fake"
    rep = drumjoin.join(sp, sources=(), transcriber="missing")
    assert rep["written"] is None


# ── generators ──────────────────────────────────────────────────────────────

def test_auto_star_power_and_fills():
    beats = [(0.5 * i, i // 4 + 1 if i % 4 == 0 else -1) for i in range(400)]
    notes = list(np.arange(0, 200, 0.25))
    sp = drumchart.auto_star_power(notes, beats)
    assert sp[0] == (8.0, 9.999) and sp[1][0] == pytest.approx(24.0)
    fills = drumchart.auto_fills(notes, beats, sp, sections=[0.0])
    assert fills and all(b - a == pytest.approx(2.0) for a, b in fills)
    assert fills[0][1] - sp[0][1] >= 2.0
    assert not any(a < e and b > s for a, b in fills for s, e in sp)   # never inside a SP phrase
    assert drumchart.auto_fills(notes, beats, []) == []


# ── song builder integration ────────────────────────────────────────────────

def test_notation_only_rebuild_keeps_drums(tmp_path):
    import gp_to_sloppak
    drums = {"name": "Drums", "notes": [{"t": 1.0, "s": 1, "f": 12}]}
    sp = make_sloppak(tmp_path / "s.sloppak", {"drums": click_track([1.0], 3)},
                      x_sync={"tab_beats": [0, 1], "audio_beats": [0, 1]},
                      extra_arrangements=[({"id": "drums", "name": "Drums", "file": "arrangements/drums.json",
                                            "tuning": [0] * 6, "capo": 0}, drums)])
    r = gp_to_sloppak.load_reuse(sp)
    assert [e["id"] for e in r["keep_arrangements"]] == ["drums"]
    assert sorted(p.name for p in (r["dir"] / "arrangements").iterdir()) == ["drums.json"]


def test_tab_check_skips_drum_arrangements():
    import logging
    try:
        import tab_check          # disables logging at import (basic_pitch noise)
        assert tab_check.DRUMS_ARR.search("Drums drums") and not tab_check.DRUMS_ARR.search("Lead lead")
    finally:
        logging.disable(logging.NOTSET)
