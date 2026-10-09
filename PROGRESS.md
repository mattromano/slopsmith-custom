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
| 5 | Rock Band–style 3D drum highway (`plugins/drums/highway3d.js`) | done — 27 node + 2 pytest + headless app check |
| 6 | Exporter sloppak → YARG/CH folder (`scripts/sloppak_to_ch.py`) | done — 3 tests incl. round trip |

## How to run things

```bash
cd slopsmith
# 1. convert a YARG / Clone Hero song folder into a new drums sloppak
python scripts/ch_to_sloppak.py "Band - Song/" "Song_-_Band.sloppak"
# 3. add Drums to existing builds (album) or one song
python scripts/song_builder.py drums _build/albums/ALBUM.yaml --chart-dir "D:/Clone Hero/Songs" [--dry-run] [--force]
python scripts/drums_join.py SONG.sloppak --chart-dir "D:/Clone Hero/Songs" [--gp TAB.gp5] [--report r.json]
# 6. export a sloppak as a YARG / Clone Hero song folder
python scripts/sloppak_to_ch.py SONG.sloppak "Songs/Band - Song" [--no-guitar] [--no-pro]
```
Tests: `pytest` in `slopsmith/` (879 pass); `node --test plugins/drums/tests/<file>.test.js` per file
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

### M6 exporter (`scripts/sloppak_to_ch.py`)
- Tempo map rebuilt from the sloppak beat grid, one tempo event per beat (deduplicated), x/4 time
  signatures from measure starts. A lead-in shorter than half a beat with no notes in it becomes
  `song.ini delay`; a longer one a pickup measure.
- PART DRUMS exactly mirrors M1's reading rules (cymbal default + tom markers, 95 = 2x kick, velocity
  127/1 + `[ENABLE_CHART_DYNAMICS]`, 116 SP, 120–124 fills, 103 solos). Round trip CH → sloppak → CH →
  parse reproduces every hit, phrase, section and beat within 2 ms (tested with tempo and TS changes).
- Guitars: 5-fret PART GUITAR / RHYTHM / BASS are a pitch-contour reduction (rank of each onset's pitch
  among onsets ±4 s, chords → 2–3 adjacent lanes, sustains ≥ 0.3 s kept) — playable, not hand-charted.
  PART REAL_GUITAR_22 / REAL_BASS_22 are exact (96+string, velocity 100+fret, muted ch 3, harmonic ch 5),
  tuning in `real_guitar_tuning` / `real_bass_tuning`. No vocals/HOPO forcing/star power for guitars.
- Hi-hat + hi-tom at the same instant (possible from GP tabs) collapse to one yellow gem (MIDI can't
  hold both on one pad).

### M5 3D renderer (sub-agent; reviewed, one change, merged)
- Screenshots (headless Chromium, software WebGL): `plugins/drums/docs/highway3d.png` (normal play, x4),
  `highway3d-fill.png` (star power ready + fill/activator), `highway3d-sp.png` (star power active, x8).
- One viz entry ("Drum Highway", `slopsmithViz_drums`) — the picker/Auto find one factory per plugin id —
  that builds 3D or 2D from a new **View** setting in the gear panel: Auto (3D when WebGL2 exists) / 3D /
  2D. Auto mode still routes Drums arrangements here, so each multiplayer player's own highway decides.
- The plugin gained a `routes.py` (`/api/plugins/drums/static/{engine.js,highway3d.js}`) because core has
  no route for plugin files; three.js is core's vendored copy. **Restart the server once** to load it.
- MIDI: same device/channel/synth as the 2D view; a Learn/custom mapping entry wins, else the GM map;
  hi-hat pedal (44) ignored; velocity passed to the engine (dynamics bonus). New **Offset (ms)** setting.
- Keyboard fallback (on by default): B kick, F red, J/K/L toms, Shift+J/K/L or U/I/O cymbals, Enter =
  star power. **Changed after review:** the agent mapped Space to kick, which would have broken
  play/pause on every Drums song; Space stays play/pause.
- Star power/fills are fetched from `arrangements/drums.json`; without it, no SP. Seeks/loops restart
  scoring from the new position.
- Not published as a note-state provider (one slot per page; note_detect uses it on guitar charts).
- Headless end-to-end check of the real `screen.js` (`plugins/drums/tools/app-check.mjs` with
  `dev_server.py`): perfect simulated MIDI play → 213 hits, 0 misses, zero page errors.

## Library run (2026-10-09): drums for the whole sloppak library

- Library: `~/Desktop/rocksmith/dlc/sloppak` (2,215 zipped sloppaks, 19 GB; 684 have a Demucs drums stem,
  1,531 only a full mix).
- **Backup:** `~/Desktop/rocksmith/sloppak_backup_2026-10-09_pre-drums` (APFS clone of every file, taken
  before any write; outside `dlc/` so Slopsmith doesn't list duplicates). `drums_library.py --write`
  refuses to run without a populated backup dir and re-checks each song's copy right before writing.
  Writes only add `arrangements/drums.json` + manifest entries; every other file stays byte-identical
  (spot-checked). To undo one song: copy it back from the backup folder.
- Chart sources: `~/Desktop/clone_hero_songs` (Beatles/Green Day Rock Band folders + .sng packages),
  `~/Clone Hero/Songs`, then **Chorus Encore** (enchor.us) search. `.sng` packages are read directly;
  online charts are fetched with HTTP range requests (only notes.mid + drum stems or the mix, ~2 MB).
  Cache: `~/.cache/slopsmith-drums/`.
- Command (resumable; state + CSV report in `~/drums-work/library/`):
  ```
  python scripts/drums_library.py ~/Desktop/rocksmith/dlc/sloppak \
      --backup-dir ~/Desktop/rocksmith/sloppak_backup_2026-10-09_pre-drums \
      --local ~/Desktop/clone_hero_songs --local "~/Clone Hero/Songs" --write --workers 6
  # later passes: --retry no-chart,flagged  (new charts appear on Chorus all the time)
  ```
- **Run your custom Slopsmith on this Mac:** `./run-mac.sh` (repo root) → http://localhost:8000. Native
  Python (venv `~/drums-work/.venv`), `DLC_DIR=~/Desktop/rocksmith/dlc` (PSARCs + the sloppak library),
  config in `~/.local/share/slopsmith-custom`, and the repo's `plugins/` (drums, multiplayer, note_detect,
  nam_tone, autotune) as user plugins. Verified headlessly in the real app
  (`plugins/drums/tools/real-app-check.mjs`): 1979 on Drums renders the Rock Band view, Lead right after
  gets the 3D guitar highway back.
- (I had first installed the plugins into the feedBack desktop app by mistake; that's been removed — the
  desktop app is back to its own plugins.)
- **Instrument override (core change, `static/app.js`):** this core's fresh-install picker default is the
  3D *guitar* highway (not Auto), which drew Drums as fret gems. Now, when the picked view is a guitar
  view (3D Highway / Classic 2D) and an instrument viz claims the arrangement (`matchesArrangement`:
  drums, piano…), that viz takes over for that song only; the picker and saved choice don't change, and
  an explicit pick during the song wins.
- **Windows PC:** `git fetch && git checkout drums-rockband` in the repo, then sync `slopsmith/` and the
  `plugins/drums` + `plugins/multiplayer` folders into the live checkout (`C:\Users\mattr\Desktop\slopsmith`)
  the way `sync_from_local.ps1` works in reverse; the sloppak library changes are in the files themselves.

## Difficulty levels (Easy / Medium / Hard / Expert / Expert+)

- Data: Expert stays the arrangement's wire notes; `drums.levels = {easy|medium|hard: [[t, gm, flag]]}` in
  the drums block (flag 1 accent, 2 ghost), `levels_generated` lists software-made ones. Charts' own
  levels are used when present (.mid 60/72/84, .chart [EasyDrums]…; most Chorus/RB charts have all
  four). Otherwise a reduction fitted on 136 hand-authored charts (F1 vs human levels Easy 0.67,
  Medium 0.78, Hard 0.89; note counts 1.12× / 0.98× / 1.05×): Easy quarter grid, ≤2 hands, no kick with
  hands; Medium quarter grid + off-grid 8ths where there's room, ≤2 gems; Hard 8th grid + room-permitting
  16ths, ≤3 gems; no 2x kick or ghosts below Expert. Exporter writes every level.
- Plugin (5.1.0): per-player choice saved in the browser (`drums_difficulty_v1`), gear-panel selector,
  clickable HUD badge ("HARD", "MEDIUM · AUTO" for generated), **D / Shift+D** to step harder/easier,
  mid-song switching restarts scoring from the current position, 2D and 3D views. Missing levels are
  greyed with a reason and that song plays Expert without overwriting your saved choice.
- **Behaviour change:** plain Expert now hides 2x-kick notes (GM 35); pick **Expert+** for double bass.
- Joins store their chart→audio warp (`source.warp`) so future backfills don't need re-alignment.

## Open issues
- ~~Beat-ambiguous alignments pass validation~~ → mitigated: validation now also checks kick notes against
  kick-band (<150 Hz) onsets and cymbal notes against cymbal-band (>5 kHz) onsets of the drum stem
  (`min_pad_within_30ms`, default 35%). A chart an 8th off on a steady groove scores >90% on the plain
  check but fails this one (tested). Not applied when validating against a full mix (bass guitar in the
  low band). The 35% bar is a guess for Demucs stems — tune on real songs.
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
- Difficulty: switch levels mid-song from the badge and with D / Shift+D; check that generated (AUTO)
  levels feel playable, and Expert vs Expert+ on a double-bass song.
- **Real chart joins:** run `song_builder.py drums ALBUM.yaml --chart-dir … --dry-run` on an album you
  have charts for; look at the table (median offset, % within 30 ms, drift) before writing. Then play a
  few joined songs and check the feel at the start, middle and end (drift).
- Check a song whose chart came from a different master/edit (radio edit, remaster) — that's the warp path.
- **GP drums:** a song with a Songsterr drum track and no chart → check the joiner's validation numbers.
- Multiplayer with two browsers (from M2): Drums appears in the dropdown only for songs with drums; each
  player loads only their own pick; mid-song switching; pick Drums then a song without drums.
- **Real kit (M5):** latency feel and the right Offset value; whether your kit's notes match the GM map
  (some kits send other numbers for toms / 2nd crash — use Learn); hi-hat open/closed/pedal; accent/ghost
  velocity thresholds; 2x-kick charts with one pedal; activating star power from the kit when a chart has
  star power but no fills (only Enter works today — charts from ch_to_sloppak/joiner get fills generated).
- **Real app (M5):** restart the server (new `routes.py`); Auto picks 3D for a Drums song; the
  `drums.json` fetch (song_info has no filename, it falls back to `window.slopsmith.currentSong.filename`);
  HUD overlay position in the player and splitscreen; swapping 2D ↔ 3D ↔ the 3D guitar highway between
  songs; performance on your GPU; other plugins' keyboard shortcuts vs B/F/J/K/L/U/I/O/Enter.
- **Multiplayer:** one drummer + one guitarist in the same room.
- Play an exported folder (`sloppak_to_ch.py`) in YARG / Clone Hero: drums, 5-fret guitar reduction, pro
  guitar/bass tracks, and the delay/pickup tempo map.
