"""lib/beatalign: RockForge's beam-search beat alignment, ported for the song builder."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

import beatalign  # noqa: E402

HOP = beatalign.ALIGN_HOP_S


def envelope(onsets, dur):
    """An onset envelope with a sharp peak at every given time (plus a little noise)."""
    rng = np.random.default_rng(1)
    env = rng.random(int(dur / HOP) + 1) * 0.05
    for t in onsets:
        env[int(round(t / HOP))] = 1.0
    return env.tolist()


def drifting_beats(n, start=0.5, beat=0.5, drift=0.0006):
    """A band speeding up / slowing down slowly: each beat a little longer than the last."""
    t, out = start, []
    for i in range(n):
        out.append(t)
        t += beat + drift * i
    return np.array(out)


def test_pulls_a_drifting_recording_back_onto_the_chart():
    true = drifting_beats(64)
    # notes on every beat and halfway between: what the chart says, in tab time
    true_notes = sorted(set(true.tolist()) | set(((true[:-1] + true[1:]) / 2).tolist()))
    env = envelope(true_notes, true[-1] + 2)
    seed = 0.6 + 0.5 * np.arange(64)  # constant tempo, started 0.1 s late
    notes = sorted(set(seed.tolist()) | set(((seed[:-1] + seed[1:]) / 2).tolist()))
    r = beatalign.align_beats(env, HOP, seed.tolist(), notes)
    err = np.abs(np.array(r["times"]) - true)
    assert len(r["times"]) == 64
    assert np.all(np.diff(r["times"]) > 0)
    assert np.median(err) <= HOP + 1e-9
    assert np.percentile(err, 90) <= 2 * HOP + 1e-9
    assert np.abs(seed - true).max() > 0.5            # the seed was far off by the end
    assert r["evidence_after"] > r["evidence_before"]


def test_a_correct_grid_stays_put():
    true = 0.5 + 0.5 * np.arange(32)
    notes = true.tolist()
    r = beatalign.align_beats(envelope(notes, 18), HOP, true.tolist(), notes)
    assert np.abs(np.array(r["times"]) - true).max() <= HOP + 1e-9
    assert r["ratio_min"] >= 0.97 and r["ratio_max"] <= 1.03


def test_flags_the_first_beat_after_a_long_rest():
    beats = (0.5 + 0.5 * np.arange(24)).tolist()
    notes = beats[:8] + beats[16:]           # two bars of rests in the middle
    r = beatalign.align_beats(envelope(notes, 14), HOP, beats, notes)
    assert 16 in r["after_gap"]
    assert r["support"][10] is None          # no chart note on a rest beat


def test_needs_two_beats():
    with pytest.raises(ValueError):
        beatalign.align_beats([0.0] * 10, HOP, [0.5], [0.5])


def test_refine_map_keeps_the_tab_side_and_moves_audio_beats():
    tab = 0.5 * np.arange(40)
    audio = 1.0 + tab * 1.02                 # current map: slightly wrong tempo
    true = 1.0 + tab * 1.0
    notes_tab = tab.tolist()
    env = envelope(true.tolist(), 25)
    new_audio, info = beatalign.refine_map(env, HOP, tab, audio, notes_tab)
    assert new_audio.shape == audio.shape
    assert np.median(np.abs(new_audio - true)) <= HOP + 1e-9
    assert info["evidence_after"] >= info["evidence_before"]


def test_maps_with_stacked_or_crowded_beats_do_not_crash():
    # beat-DTW can map two tab beats onto one audio time (a skip) or a few ms apart
    tab = 0.5 * np.arange(20)
    audio = 1.0 + tab.copy()
    audio[8] = audio[7]            # stacked
    audio[12] = audio[11] + 0.005  # crowded
    env = envelope((1.0 + tab).tolist(), 14)
    new_audio, info = beatalign.refine_map(env, HOP, tab, audio, tab.tolist())
    assert new_audio.shape == audio.shape
    assert np.all(np.diff(new_audio) > 0)


def test_align_beats_survives_a_beat_too_short_to_move():
    beats = [0.5, 1.0, 1.005, 1.5, 2.0]
    r = beatalign.align_beats(envelope(beats, 3), HOP, beats, beats)
    assert len(r["times"]) == 5


def test_keep_rule_rejects_big_moves_and_lost_downbeats():
    keep = beatalign.keep_refinement
    assert keep(1.70, 1.80, 0.95, 0.95, 18.0)            # small move, better onsets
    assert not keep(1.70, 1.80, 0.95, 0.95, 320.0)       # locked onto the wrong beat
    assert not keep(1.70, 1.65, 0.95, 0.95, 18.0)        # onsets got worse
    assert not keep(1.70, 1.80, 0.95, 0.85, 18.0)        # lost >5 pt of bars on downbeats
    assert keep(1.70, 1.80, 0.95, 0.91, 18.0)            # a small downbeat dip is fine


def plucks(onsets, dur, sr=22050, seed=0):
    """Plucked-string notes (a short pick noise, then decaying harmonics) starting at the given times."""
    rng = np.random.default_rng(seed)
    y = np.zeros(int(dur * sr))
    n = int(0.35 * sr)
    tt = np.arange(n) / sr
    for t in onsets:
        f = rng.choice([82.4, 110.0, 147.0, 196.0])
        s = sum(np.sin(2 * np.pi * f * k * tt + rng.uniform(0, 6)) / k for k in range(1, 10)) * np.exp(-tt * 9)
        s[:int(0.004 * sr)] += rng.normal(0, 0.6, int(0.004 * sr))
        i = int(round(t * sr))
        y[i:i + n] += s[:len(y) - i]
    return y


@pytest.mark.parametrize("seed_off", [-0.04, 0.0, 0.04])
def test_beats_are_not_pulled_after_the_attack(seed_off):
    # librosa's onset strength peaks after the attack starts (~10 ms on these plucks, ~20 ms
    # on band mixes). Scored raw, every beam-refined beat landed that much late: +9 ms here,
    # a median +19 ms on library songs, GP drums 17-23 ms behind the drum stem on the
    # 2026-10-16 --beam trial. onset_envelope now moves the envelope ONSET_LAG_S earlier.
    pytest.importorskip("librosa")
    sr = 22050
    true = 0.5 + 0.5 * np.arange(40) + np.random.default_rng(3).uniform(0, 0.003, 40)
    env, hop = beatalign.onset_envelope(plucks(true, 22, sr), sr)
    seed = true + seed_off
    r = beatalign.align_beats(env, hop, seed.tolist(), seed.tolist())
    err = np.median(np.array(r["times"]) - true)
    assert -0.015 <= err <= 0.003          # never late; the 20 ms (band-mix) lag may read early here
    raw, _ = beatalign.onset_envelope(plucks(true, 22, sr), sr, lag=0.0)
    r_raw = beatalign.align_beats(raw, hop, seed.tolist(), seed.tolist())
    assert np.median(np.array(r_raw["times"]) - true) > 0.005   # the bias this guards against


def test_onset_envelope_is_moved_earlier_by_the_lag():
    pytest.importorskip("librosa")
    sr = 22050
    y = plucks([0.5, 1.0, 1.5], 2.5, sr)
    raw, hop = beatalign.onset_envelope(y, sr, lag=0.0)
    env, _ = beatalign.onset_envelope(y, sr)
    k = int(round(beatalign.ONSET_LAG_S / hop))
    assert len(env) == len(raw)
    assert env[:-k] == raw[k:]


def test_keep_rule_rejects_a_map_moved_one_way():
    keep = beatalign.keep_refinement
    assert keep(1.70, 1.80, 0.95, 0.95, 18.0, 4.0)
    assert not keep(1.70, 1.80, 0.95, 0.95, 20.0, 19.0)   # whole map 19 ms late
    assert not keep(1.70, 1.80, 0.95, 0.95, 20.0, -19.0)  # or early
