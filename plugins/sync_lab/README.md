# Sync Lab (private user plugin)

Measured calibration of the three offsets that decide whether notes are judged when you actually play them:

| Offset | Setting it changes |
|---|---|
| A/V offset (picture vs sound, one per computer) | core `av_offset_ms` via `setAvOffsetMs` |
| Guitar latency | Note Detection `latencyOffset`, applied to every detector (main + split-view panels) |
| Drums input offset | drums `drums_input_offset_ms` (`window.__drumsSetInputOffset`) |

Nav → **Sync**: pick Guitar / Bass / Drums / Split guitar+drums / Split two guitars. That opens the
**Sync Calibration** song (written into the library by `routes.py` as `sloppak/_Sync_Calibration_v<N>.sloppak`,
pure Python, no tools needed). 100 BPM, one note per beat (open A string on Lead/Bass, snare on Drums):

1. **Listen** (32 notes): the screen is blanked; play on the clicks, by ear.
2. **Watch** (32 notes): no clicks; play when the gems hit the line.
3. **Play** (24 notes): normal, as a check.

During the song: drum pad sounds are muted (`window.__drumsMutePads`, they arrive ~50 ms late) and the drum hit
window is ±250 ms (`window.__drumsCalibrationWindow`), so far-off hits are measured instead of missed.

## The maths

Judgments are made on the highway's visual clock (render clock = song clock + A/V offset) by both Note Detection and
the drum engine. With song clock = Web Audio's render clock, which runs R ms ahead of the speakers:

    eye error = display latency + input latency            (A/V offset cancels)
    ear error = input latency + R + A/V offset

Ear and eye agree when **A/V = current A/V + (eye − ear)** (weighted over all players, one value per computer).
The **eye median is the input offset** for that player (it does not depend on the A/V offset). Samples are kept
offset-free (error + the offset in use), so applying one value doesn't invalidate the others.

## A/V auto-follow

`__hwtRenderAheadMs` (highway_tweaks' stems clock patch) is R, measured live from `getOutputTimestamp()`. On Apply
(or any manual A/V change) `{av, R}` is saved; when a later song shows R changed by ≥ 10 ms (other headphones /
speakers), the A/V offset is shifted by the same amount and a toast says so. Toggle on the Sync screen.

## Logs

Every calibration (with all raw samples) and every auto-follow change is appended to `sync_log.jsonl` next to this
file (`GET /api/plugins/sync_lab/log?n=20` reads the tail).

## Tests

`tools/sync-bench/calibrate.mjs` (muted browser, real player and drum engine, simulated drummer with known
latencies): `MODE=drums` and `MODE=split-gd` (adds a simulated guitarist in panel 1). Results 2026-10-10
(input 20 ms, display 25 ms, jitter 8 ms, R ≈ 48 ms): suggested A/V −22 (expected −23..−25); drums offset 43–46
(expected 45); after Apply all, play-section error drums +1.5..+3.5 ms, guitar −1.6 ms; A/V re-suggestion stable.
