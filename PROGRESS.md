# Drums (Rock Band–style) — overnight progress log

Branch: `drums-rockband`. Work tree: `~/drums-work/slopsmith-custom`.
Python env for tests: `~/drums-work/.venv` (uv; slopsmith requirements + numpy/scipy/librosa/soundfile).

## Status

| # | Milestone | State |
|---|-----------|-------|
| 0 | Import feedBack drums (871eb0e) + multiplayer (c9267ae) plugins into `plugins/` | done |
| 1 | `scripts/ch_to_sloppak.py` chart converter (`lib/drumchart.py`) | done — 15 tests |
| 2 | Multiplayer arrangement dropdown from the song's real arrangements | done — 11 node + 2 pytest + 1 core |
| 3 | Drum-chart joiner (`scripts/drums_join.py`, `song_builder.py drums`) | done — 17 tests (+3 server) |
| 4 | JS drum engine ported from YARG.Core (`plugins/drums/engine.js`) | done — 44 node tests |
| 5 | 3D Rock Band–style renderer | in progress |
| 6 | Exporter sloppak → YARG/CH folder (stretch) | pending |

## How to run things

```bash
cd slopsmith
# 1. convert a YARG / Clone Hero song folder into a new drums sloppak
python scripts/ch_to_sloppak.py "Band - Song/" "Song_-_Band.sloppak"
# 3. add Drums to existing builds (album) or one song
python scripts/song_builder.py drums _build/albums/ALBUM.yaml --chart-dir "D:/Clone Hero/Songs" [--dry-run] [--force]
python scripts/drums_join.py SONG.sloppak --chart-dir "D:/Clone Hero/Songs" [--gp TAB.gp5] [--report r.json]
```
Tests: `pytest` in `slopsmith/` (874 pass); `node --test plugins/drums/tests/<file>.test.js` per file
(Node 25 won't take a directory); multiplayer: `node --test plugins/multiplayer/tests/arrangements.test.js`.
The multiplayer pytest suite needs pytest-asyncio + pytest-timeout (see M2 notes).

## Decisions

### General
- Baseline before any change: core `pytest` 838 passed; drums plugin 16 node tests passed.
- Plugins copied without `.git` (plain dirs like the other plugins here). Upstream commits recorded above.
- Milestones 2, 4 and 5 were built by sub-agents in git worktrees and merged with `--no-ff`, so each
  milestone is one reviewable merge commit.
- No Co-Authored-By/Claude trailers on commits (your standing rule).

### Drum data in a sloppak
- A **"Drums" arrangement** (`arrangements/drums.json`, manifest `id: drums, name: Drums`), not `drum_tab`.
  Notes are the drums plugin's encoding: General MIDI drum number `midi = s*24 + f`. Pro-drums mapping:
  kick 36, **2x kick 35**, snare 38, yellow cym 42 / tom 48, blue cym 51 / tom 45, green cym 49 / tom 41.
  `ac` = accent, `mt` = ghost (the plugin's own convention). Verified they survive `lib/song.py`'s
  Note model unchanged (that's what the server streams).
- Star power, drum fills and solos can't ride in wire notes, so they live in the arrangement JSON's extra
  top-level **`drums` block** (`{"version":1,"pro":true,"kick2x":…,"star_power":[[s,e]],"fills":[[s,e]],"source":{…}}`).
  The loader ignores unknown keys; the plugin fetches the raw file through the existing
  `/api/sloppak/{file}/file/arrangements/drums.json` route. No core protocol change.
- `beats`/`sections` stay on the first (guitar) arrangement; a joined Drums arrangement carries none.
  `ch_to_sloppak` (Drums is the only arrangement) writes them from the chart's tempo map.
- Manifest gets `x_drums` (source, validation summary, forced?) next to `x_build`.

### M1 converter (`lib/drumchart.py`, LGPL-3.0 port notice in its header)
- Rules ported from YARG.Core MidReader/ChartReader/MoonSongLoader.Drums: PART DRUMS (PART DRUM /
  PART REAL_DRUMS_PS as fallbacks), Expert 96–100 (+101 5-lane green), 95 = 2x kick; yellow/blue/green
  default to cymbals in .mid and tom markers 110–112 XOR that over [start, end-1]; .chart pads default
  to toms and 66–68 mark cymbals; dynamics only with `[ENABLE_CHART_DYNAMICS]` (vel 127/1, never kick) in
  .mid, `N 34–38/40–44` in .chart; 5-lane → pro 4-lane table incl. orange+green → blue cym + green tom;
  disco flip `[mix 3 drums<n>d]`; SP 116 / `S 2`; fills 120–124 / `S 64`; solos 103; sections
  `[section x]`/`[prc_x]`.
- **`delay` sign:** YARG's SongRunner uses chart time = audio time − delay, so notes are written at
  `chart_time + delay/1000`. `song.ini delay` wins over `delay_seconds` and the .chart `Offset`.
- When a chart has star power but no fills, YARG's own activation-phrase generator
  (`SongChart.AutoGeneration.ParseForActivationPhrases`) is ported and applied (time-signature snapping
  skipped; sloppak beats don't carry time signatures).
- Audio: lone `song.ogg` → `stems/full.ogg`; separate CH stems → sloppak stems (guitar+rhythm → guitar,
  keys → piano, song → other, drums_1..4 mixed, crowd dropped), all `default: true` like Demucs output.

### M2 multiplayer (sub-agent; reviewed + merged)
- Dropdown options come from the queue item's `arrangements` (captured from the library at queue time),
  then a cached `GET /api/song/{file}`, then Lead/Rhythm/Bass. Ordered Lead, Combo, Rhythm, Bass, then
  others (Drums). Names escaped.
- A pick that isn't in the next song stays as the player's pick ("Drums (not in this song)") and the song
  loads the server's default; the player goes back to Drums on the next drum song.
- Mid-song arrangement changes now switch in place (keeps position/play state).
- **Core fix:** `lib/sloppak.load_song` now sorts arrangements Lead > Combo > Rhythm > Bass > others,
  matching the library index (it used manifest order, so library index N could load the wrong part).

### M3 joiner (`lib/drumalign.py`, `lib/drumjoin.py`)
- Alignment works on **3-band onset envelopes** (low/mid/high flux ≈ kick / snare+toms / cymbals).
  Single-band envelopes locked onto spurious lags on repetitive grooves; bands fixed it.
- Global offset = whole-song cross-correlation, cross-checked by independent 12 s window votes (a
  drifting song smears the whole-song peak — in one synthetic case it picked −31 s).
- Weak correlation (peak ratio < 1.08) or drift (> 35 ms between 24 s windows) → **beat-level warp**:
  lag tracking by dynamic programming over 4 s windows (Viterbi over a lag grid, a DTW in lag space),
  global tempo ratio from the track's Theil–Sen slope with a second pass, sampled at the chart's beats,
  then gp_to_sloppak-style per-beat onset refinement. **Deviation from the brief:** plain log-mel DTW
  (what gp_to_sloppak does for tabs) had 10% of beats > 250 ms off on drum stems, so it was replaced.
- Final **snap**: shift by the median (onset − note) so notes sit on detected attacks (envelope xcorr is
  only good to ~5–10 ms because flux peaks depend on timbre).
- Onset detection for validation is pulled back from the flux peak to the waveform attack (30% of local
  peak); before that it read ~10 ms late. On clean synthetic drums: median −0.4 ms, 100% within 30 ms.
- Validation thresholds (defaults, CLI-overridable): ≥ 50% notes within ±30 ms, |median| ≤ 25 ms,
  drift (spread of per-quarter medians) ≤ 40 ms. Failing joins are reported and not written unless `--force`.
- Source priority: chart → GP drum track (`gp2rs.convert_drum_track`, same `s*24+f` encoding the editor
  plugin uses; placed with `x_sync.json` + `x_build.offset`) → transcription hook. First candidate that
  validates wins.
- Fuzzy match: normalised artist/title (accents, "the", "&", `(Songsterr)`/remaster/live tags dropped),
  0.65·title + 0.35·artist SequenceMatcher, threshold 0.82. Folder name "Artist - Title" fallback.
- GP/transcribed sources get generated star power (Slopsmith's own rule: a 1-measure phrase every 8
  measures with ≥ 4 notes — YARG never invents SP) and YARG's activation fills.
- Writes back to zip atomically, backup in `_build/backup/`; re-joining replaces the old Drums.
- Side fixes: notation-only rebuilds (`--reuse`) keep the Drums arrangement (warns to re-join GP-sourced
  drums after an anchor rebuild); `tab_check` skips drum arrangements (would have graded them against
  the guitar stem → every song C); `export_dlcbuilder` skips them; the server's "most notes" default
  arrangement ignores Drums unless that's all there is (`_most_notes_arrangement`, tested).

Synthetic alignment benchmark (2-min charts, 2 seeds, % of notes within 30 ms after the warp):

| scenario | seed 1 | seed 2 |
|---|---|---|
| same tempo, offset | 100% | 100% |
| 1.5% tempo + ±120 ms wobble | 100% | 100% |
| 3% slower master | 100% | 89% |
| 4 s section cut out | 98% | 96% |
| 3.3 s gap inserted | 94% | 53% |

### M4 engine (`plugins/drums/engine.js`, sub-agent; LGPL-3.0, `LICENSE.LGPL-3.0` + `NOTICE.md`)
- YARG defaults: ±70 ms window (140 ms total, not dynamic; "Precision" dynamic preset available),
  multiplier min(combo/10+1, 4) ×2 in SP, 60 pts/note pro (50 non-pro), +25 dynamics bonus, SP bar = 8
  measures, phrase = +2, activate at 4, drains 1 measure/measure, star thresholds from YARG DrumsPlayer.
- Pro drums: cymbal vs tom of the same colour are different lanes (no fallback in YARG) → wrong one is an
  overhit. Overhit = combo reset + fails the current SP phrase, no score change.
- Fill activation per YARG (rightmost activator note); manual activation when a chart has no fills.
- Deviations listed at the top of engine.js (seconds + measure map instead of ticks, immediate hit/update
  API, no lanes/BRE/solos/unison, whole SP phrase fails on any miss incl. chord child notes, …).

## Open issues
- **Beat-ambiguous alignments pass validation.** If the warp/offset lands a whole beat or bar off on a
  steady groove, notes still sit on onsets and validation is happy (synthetic "gap inserted" seed 2).
  Idea: pad-aware validation (kick notes vs low-band onsets, cymbals vs high-band).
- Chart notes in a section that our recording cut out are still placed (somewhere near the cut); no
  deletion of unmatched sections yet.
- Validation thresholds are calibrated on synthetic audio only. Real Demucs drum stems will have bleed,
  missed ghost notes and cymbal washes — expect lower "% within 30 ms". Tune after the first real batch.
- GP-sourced drums are placed with the guitar sync map; if you later rebuild with feedBack Studio anchors,
  re-run `song_builder.py drums` (the rebuild prints a reminder).
- Multiplayer pytest suite needs `pytest-asyncio pytest-timeout`; one test
  (`test_audio_grace_expiry_closes_highway_with_4408`) times out before and after these changes.
- `node --test plugins/drums/tests/` (directory) fails on Node 25; run files individually.

## Automatic transcription (source c) — research, not built
Hook: `drumjoin.register_transcriber(name, fn)`, `fn(drums_wav_path, sr) -> [DrumHit]`, used via
`--transcriber NAME`. Findings (web, 2026-10-08):

- **Top pick: ADTOF-pytorch** (github.com/xavriley/ADTOF-pytorch): PyTorch port of ADTOF (models trained
  on rhythm-game charts), 5 classes (kick, snare, toms, hi-hat, cymbals — crash/ride merged), MDB F1 ≈ 0.885,
  only needs torch/librosa/pretty_midi, `--device cuda`. **Caveat: weights derive from ADTOF's
  CC BY-NC-SA release (non-commercial) and the port has no code license file** — fine as a personal hook,
  don't redistribute; keep it a user-installed optional dependency.
- Fallback: **YourMT3+** (GPL-3.0 code, multi-instrument incl. drums, finer classes) — heavy, old pins.
- Watch: ADT_STR (2026 transformer, claims SOTA on ENST/MDB; check weights are public).
- Skip: Magenta O&F-Drums / MT3 (archived, TF/JAX), Omnizart (TF pins vs Py3.11), ADTLib (dormant).
- LarsNet (kit-piece separation) is a useful pre-step for the crash/ride split, but has no license.
- Integration sketch: call ADTOF-pytorch's model + peak picking in-process (not via MIDI) on the Demucs
  drum stem; velocity from activation height or local onset strength; split crash/ride by decay length /
  spectral centroid; map hi-hat → yellow cymbal, toms → toms lanes; merge hits < 30 ms; cache per song;
  torch with CUDA ≥ 12.8 for the 5070 Ti. Benchmark on 3–5 of your own stems first.

## Test by hand (needs real hardware / real songs)
- **Real chart joins:** run `song_builder.py drums ALBUM.yaml --chart-dir … --dry-run` on an album you
  have charts for; look at the table (median offset, % within 30 ms, drift) before writing. Then play a
  few joined songs and check the feel at the start, middle and end (drift).
- Check a song whose chart came from a different master/edit (radio edit, remaster) — that's the warp path.
- **GP drums:** a song with a Songsterr drum track and no chart → check the joiner's validation numbers.
- Multiplayer with two browsers (from M2): Drums appears in the dropdown only for songs with drums; each
  player loads only their own pick; mid-song switching; pick Drums then a song without drums.
- MIDI kit, latency feel, mapping: see M5 once it lands.
