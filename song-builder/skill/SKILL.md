---
name: slopsmith-song-builder
description: Build, grade and fix Rocksmith-style Slopsmith charts (.sloppak) from Guitar Pro tabs plus the user's own album MP3s, with Demucs stems and merged guitar parts. Use when the user wants songs or albums turned into playable Slopsmith songs, wants tabs downloaded from Songsterr, asks how good a built song is, wants a drifting/out-of-sync chart fixed (incl. with feedBack Studio), or adds new albums/targets to build.
---

# Slopsmith song builder

Everything lives in the user's custom Slopsmith checkout: `C:\Users\mattr\Desktop\slopsmith`
(do not suggest upgrading it to upstream feedBack; the user prefers this version).
Library: `C:\Program Files (x86)\Steam\steamapps\common\Rocksmith2014\dlc\sloppak\`.
Interpreter for everything below: `_build\.mirvenv\Scripts\python.exe`. It's a venv with
system site-packages (GPU torch, demucs, beat_this, pyguitarpro, librosa) plus basic-pitch
(installed --no-deps, ONNX model) and livechord-beat-refiner. Run from the slopsmith folder.

## Repo and setup

Everything is backed up in the private GitHub repo **mattromano/slopsmith-custom**
(local clone `C:\Users\mattr\Desktop\repos\slopsmith-custom`):
- `slopsmith/`: this custom Slopsmith (upstream history + the song builder).
- `plugins/`: note_detect, nam_tone, autotune.
- `slopsmith-desktop/`: patches + base commit.
- `song-builder/`: skill, `setup.ps1`, feedBack Studio setup, album YAMLs, notes.

Work happens in the live Desktop checkouts. Commit there (slopsmith branch `custom`), then run
`sync_from_local.ps1` in the repo and push. New machine: clone the repo, then run
`song-builder\setup.ps1 -Slopsmith <path>`. It installs host packages, the `.mirvenv`, this skill
and the album YAMLs. Never commit tabs, audio, built sloppaks or `.env`.

## The pipeline (what each piece does)

| Script | Job |
|---|---|
| `scripts/song_builder.py` | **Entry point.** Album YAML → plan tracks → build every song → grade → report. |
| `scripts/gp_to_sloppak.py` | One song: GP tab + MP3 → sloppak. Syncs the tab to the recording (beat_this beats, beat-level DTW, constant-tempo fallback), polishes sustains and hand shapes, fills gaps from extra guitar parts, splits 6 Demucs stems, records `x_build` in the manifest. |
| `scripts/tab_check.py` | Grades a sloppak: Basic Pitch on its own guitar/bass stems vs chart notes → `lift` (hit rate ÷ luck), `best_shift`, weak bar ranges. |
| `scripts/rebuild_song.py` | Rebuilds a song from its `x_build` recipe, picking up feedBack Studio sync points as `--anchors`. Backs up the old file. |
| `scripts/gp7_to_gp5.py` | Songsterr/GP7/8 `.gp` → `.gp5` (song_builder does this automatically). |
| `lib/gp2rs.py` | GP → RS XML. Patched 2026-10: ties extend sustain, H/P resolved on the destination note by fret direction, slide targets, slide-outs, ghost notes no longer muted, bends scaled right (quarter-tones/2), anchors one-per-chord at the index finger (`_compute_anchors`; the old per-note "fret-1" anchors shifted chord frames 2 frets). Backup: `_build/backup/gp2rs.py.bak`. |

Album YAMLs already written: `_build/albums/*.yaml` (5 Prince Daddy albums, Dirty Nil *Fuck Art*,
Cheap 52 *Vermont*). Copy one to start a new album. The format is in song_builder's docstring.

## Workflow for a new album / batch

1. **Audio.** The user drops MP3s in a Desktop folder, one folder per album
   (`Desktop\P-Daddy Albums\…`, `Desktop\Slopsmith Targets\…`). Tags usually give album and year;
   the cover comes from `cover.jpg` or the art embedded in the MP3.
2. **Find tabs on Songsterr** (the user has Songsterr Plus and is logged in in Chrome). Search with the
   API from a songsterr.com tab: `fetch('/api/songs?size=250&pattern=<artist>')`. Check
   `/api/meta/<id>` for `aiGenerated` and track count. Tell the user which songs exist, which are
   AI-made, and which are missing.
3. **Download** (ask the user first; it's a file download). Navigate to
   `https://www.songsterr.com/a/wsa/song-tab-s<ID>`, wait about 3 s, open the panel with JS
   `document.getElementById('control-export').click()`, wait 1.5 s, **take a screenshot**, then
   do a *real* `left_click` on the Guitar Pro button. Get its coordinates from
   `#control-export-gp`'s rect ÷ (innerWidth / screenshot width); it's been about (1480-1492, 770-786).
   A JS `.click()` on the GP button is blocked by Chrome because it isn't a real user click. A click
   without a fresh screenshot after navigating also misses. Batch 10 songs per `browser_batch`.
   Files land in `Downloads` as `<Artist>-<Title>-<date>.gp`; move them into the album's `tabs/` folder.
4. **Write the album YAML**, then `song_builder.py plan ALBUM.yaml` and sanity-check the picks:
   - Lead = the "lead"-named or least chordy part; Rhythm = the chordiest/longest part; extra
     guitar parts fill runs of ≥2 empty bars (`"2+1+5:Lead"`). Parts covering <25% of bars only fill.
   - Vocal/synth/kalimba/etc. tracks are skipped. **Drums are never Bass**: Songsterr drum tracks
     pass gp2rs' bass test, and that bug once hit 21 songs.
   - With several tab versions, list them (`tab: [A, B]`) and the one whose length matches the
     recording wins.
   - Override a bad pick with an explicit `tracks:` spec.
5. **Build** with `song_builder.py build ALBUM.yaml` (stems always on: the user wants full stems).
   **After converter/chart-only changes, rebuild with `--notation-only`.** It reuses each build's stems,
   cover and stored sync map (`x_sync.json`), takes about 1-2 s a song instead of about 60, and gives
   identical timing. A full build is only needed for new audio, a changed tab structure, or a different
   sync method. Anchors work in both modes.
   About 40-70 s a song on the RTX 5070 Ti. Run it in the background, use a Monitor on the output,
   and report each song as it lands.
6. **Tune.** Run `song_builder.py tune ALBUM.yaml`. gp_to_sloppak picks beat-DTW vs constant-tempo
   by onset score with a 10% margin, and about 15 of 39 songs were within that margin (a coin flip).
   `tune` builds the other method for those, keeps whichever has the higher tab_check lift, and saves
   the choice in `ALBUM_tuning.json` so later builds reuse it. That's how Big-Box Store Heart went
   from C to B.
7. **Grade.** `build`/`tune` end with a report (also `ALBUM_report.json`); `song_builder.py check` regrades.
8. Update `_build/HANDOFF.md`; then give the user the graded list.

## Reading the grades

- **lift** (from tab_check) is the main signal. 1.0 = no better than luck.
  - Good lead and bass parts: 1.6-4.
  - Rhythm (distorted chords) runs lower because Basic Pitch smears thick chords: Rhythm A ≥1.4,
    C <1.2. Lead/Bass A ≥1.5, C <1.3.
  - Low Rhythm lift has mostly meant an AI tab.
- **bars on downbeats** (gp_to_sloppak) is only a hint. Songs at 50% had lift 2+: the beat tracker
  counted half-time. Don't call a song bad on bars alone.
- **onset score** (gp_to_sloppak): above 1.6 is fine.
- **best_shift**: Basic Pitch lags about +0.02-0.04 s, so that's normal. Beyond about ±0.08 from
  that = global offset; rebuild with `--offset`.
- **weak bars**: bar ranges where the chart stops matching. That's where to place anchors.

## Fixing a weak song

1. **Wrong or AI tab** (low lift everywhere, few weak-bar runs): look for another tab version
   (Songsterr often has several; UG), or accept it as B/C.
2. **Drift in sections** (weak-bar runs, good lift elsewhere): fix with anchors in feedBack Studio.
   - Start it: `Desktop\feedback-studio-src\start_feedback_local.bat` → http://localhost:8010
     (run from source; the user didn't want the unsigned installer).
   - Copy the sloppak to `Desktop\feedback-studio-work\` and rename it `.feedpak`. feedBack only
     opens that extension; the format is byte-identical.
   - **Open feedpak**, then in the **Arrangements** tab drag the yellow bar markers onto the real
     downbeats in the weak bars, then **Write to original feedpak**.
   - Run `rebuild_song.py EDITED.feedpak --check`. It reads the recipe from `x_build`, or from the
     title for older builds, and uses the edited sync points as anchors. Bar k = k-th measure of the
     tab, the same numbering feedBack uses.
3. **Global offset**: rebuild with `--offset ±s`.
4. **Wrong sync method**: force it with `--method dtw|linear` (or a `method:` key in the YAML song entry).
5. `--refine-beats` (livechord refiner) exists, but a controlled A/B on 12 weak songs gave identical
   lift with and without it (98% same downbeats). Not worth it by default.

## feedBack Studio: what it is and isn't good for

- **Good for:** hand-fixing notes and frets, the sync-point anchors above, notation PDFs.
- **Not good for:**
  - AutoSync: a global scale+shift only.
  - Stem → arrangement: monophonic pyin, useless for chords.
  - Sync points move no notes by themselves; that's why we rebuild with anchors.
- **Saves:** they load in this Slopsmith identically; rename back to `.sloppak`.

## Highway display notes (highway_3d plugin)

- Chord frames and the lit lane come from the arrangement's **anchors**, so bad anchors look like
  notes "shifted" or frames with extra space.
- Flying gems never carry fret digits. Ghost digits show on the fretboard for chord notes only, unless
  the highway setting fret-number scope is "all".
- `hd` repeat chords draw as frames only. A slide's destination gem is hidden, and its trail shows instead.
- Bend chevrons need `bn` > 0 (semitones). `gp7_to_gp5` must map GPIF bend 100 → 4 quarter-tones.

## Hard-won rules

- Keep the user's playtested builds. Rebuilds of an existing song from a different tab get a
  `variant` (e.g. "(Songsterr)") so they're separate files.
- Never run bulk edits on the 2,000+ library sloppaks without explicit approval. The stem
  `default` fix for 539 songs is still waiting for it.
- Bash `$(ls …)` breaks on apostrophes in paths: pass Windows paths from Python globbing.
- `--only` titles may contain commas; matching is on all comma parts.
- A song's tab length should be within a few seconds of the MP3. If not, it's the wrong recording
  or version.
- No lyrics: whisperx isn't installed and lyrics text must come from the user (don't fetch lyrics).
