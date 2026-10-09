# Handoff: Prince Daddy custom songs for Slopsmith (2026-10-08)

## Goal
Build playable Slopsmith charts (sloppaks) for Prince Daddy & The Hyena songs from
Guitar Pro tabs, synced to the user's own MP3s, with split stems.

## Tools (all in `C:\Users\mattr\Desktop\slopsmith\scripts\`, uncommitted)
- `gp_to_sloppak.py`: GP3/4/5 tab + MP3 → sloppak. Syncs the tab to the recording,
  cleans up the chart (sustains, hand shapes, repeat chords), then splits stems with
  Demucs on the GPU. Read the docstring for details.
  ```
  python scripts/gp_to_sloppak.py TAB.gp5 SONG.mp3 OUT.sloppak --tracks "1:Lead,2:Rhythm,3:Bass" \
    --title T --artist "Prince Daddy & The Hyena" --album A --year Y --cover cover.jpg --report r.json
  ```
  - `--merge-into EXISTING.sloppak` with audio `-` adds arrangements to an existing song.
  - `--no-stems` skips the stem split.
  - Output goes to `C:\Program Files (x86)\Steam\steamapps\common\Rocksmith2014\dlc\sloppak\`.
  - Before building, use `gp2rs.list_tracks()` to pick tracks. Name the track that is mostly
    single notes "Lead" and the one that is mostly chords "Rhythm".
- `gp7_to_gp5.py IN.gp OUT.gp5`: converts newer `.gp` files (Guitar Pro 7/8, a zip holding
  score.gpif) first. Songsterr downloads may come in this format.
- Paths with apostrophes break in bash `$(ls ...)`. Pass Windows paths from Python glob instead.

## How to judge sync (logged by the script)
- "bars on downbeats" ≥ 85–90% is good. When the beat tracker counts in half time, ~50% in
  those sections is expected.
- The onset score is relative to random (1.0). Above 1.6 is fine.
- The script picks beat-level DTW or a constant-tempo fit automatically.

## Done and installed (all have 6 stems)
- Wacky Misadventures of the Passenger, Cosmic Thrill Seeking Forever, C'mon & Smoke Me Up
  (from the *Cosmic Thrill Seekers* album)
- Black Mold (2022 self-titled album). The Lead part is tuned E♭ standard with the G string at G.
- Bromeo // Always Good: a Guitar arrangement merged into the existing bass-only chart.
  Original backed up in `_build/backup/`.
- The user playtested Wacky and said it looks good after the sustain fix.

## Cleanup done
- Removed AI/MIDI junk duplicates. They were moved, not deleted, to
  `_build/backup/removed_midi/`.

## Session 2 (2026-10-08 evening)
- All 40 Songsterr tabs downloaded to `Desktop\gc pro tabs\songsterr\` (.gp, GP7 format) and
  converted to `songsterr\gp5\` with a track survey in `gp5\_survey.json` (`_build/survey_tabs.py`).
  Download trick: open #control-export via JS, take a screenshot, then a real click on
  #control-export-gp. A JS click alone gets blocked by Chrome because it isn't a real user click.
- New albums in `Desktop\P-Daddy Albums\` (Cosmic, ITYDEL, Adult Summers, Hotwire). PDATH is still at Desktop\PDATH.
- `gp_to_sloppak.py --tracks "2+1+5:Lead"` now fills runs of ≥2 empty bars in track 2 from 1, then 5
  (`--fill-min-bars`). The user wants extra guitar parts merged this way and full stems always.
- `_build/plan_pdath.py` auto-picks Lead/Rhythm/Bass plus fillers (skipping vocal/synth tracks) and builds
  22 songs (`--run`, `--only`). Logs and reports go to `_build/logs/`, summary to `_build/logs/_summary.json`.
  Skipped: Dialogue and 30days (tabs barely started), Thrashville 1 and 2/3 (no audio), Rory /
  Still Broke By Christmas / Moo Moo Meadows (release unknown), Really? (the library already has a CDLC),
  and the 5 already built.
- All 22 built and installed with 6 stems. Songsterr drum tracks pass gp2rs._is_bass_track, so the
  planner now excludes drums from Bass. Collector, Lauren, Pop Song and Ctrl+Alt+Del were rebuilt after that fix.
- Sync to check in playtest: Ctrl+Alt+Del (53% bars, probably downbeat phase; onset 1.82), Luna Project (72%),
  Nika (74%, 27 skips), Meds (75%), Klonopin (80%), Lauren (84%). Tab and audio lengths match on all of them.

- Drums were also picked as Bass in 17 more builds (bass sorted by note count). All rebuilt; no
  drum-as-bass left (check: grep "Bass:" logs for tuning -23,-28…). Clever Girl has no Bass part.
- Songsterr rebuilds of the first 5 are separate files titled "(Songsterr)". Sync: Bromeo 98%, C'mon 93%,
  CTSF 75%, Wacky 73%, Black Mold 52%. The UG originals are untouched.
- Planner: parts covering <25% of bars are only fillers. `--only` matches titles that contain commas.

## Session 3: Slopsmith Targets (`Desktop\Slopsmith Targets`)
- Dirty Nil *Fuck Art* (2021): 10 of 11 are on Songsterr (Hello Jealousy isn't). Cheap 52 *Vermont* (2024):
  My Fault and Wish in Twos. Both Cheap 52 tabs are AI; Wish in Twos uses the 1565256 version, whose length
  matches the recording. Tabs are in `Slopsmith Targets\tabs\` (+ gp5/_survey.json).
  `_build/plan_targets.py` builds them as `<Title>_-_Dirty_Nil.sloppak` / `_-_Cheap_52.sloppak`.
- All 12 built with stems. Check: To The Guy Who Stole My Bike (50% bars, AI tab), Done With Drugs (79%),
  Doom Boy (82%).

## feedBack Studio (evaluated 2026-10-08)
- Source in `Desktop\feedback-studio-src` (cloned, NOT the unsigned installer). The venv uses system
  site-packages (GPU torch/demucs). Run `start_feedback_local.bat` → http://localhost:8010. Scratch copies live in
  `Desktop\feedback-studio-work`.
- feedpak = sloppak byte-for-byte. It only opens `.feedpak`, so copy and rename. Saved files reload identically in
  our Slopsmith; extra manifest keys bpm/meter/sync and sync/*.json are ignored.
- Its AutoSync is only a global scale+shift (Nika gave scale 1.0 / offset 0.0), so it can't fix drift inside a song.
  Stem→arrangement is monophonic pyin, so it's useless for chords. Sync points are bar→time markers that DON'T move notes.
- Useful for: hand-fixing notes and frets (AI tabs), tones, notation PDF. Idea: use its sync-point markers as
  anchors for a gp_to_sloppak `--anchors` rebuild.

## Song-builder workflow (2026-10-08 late): skill `slopsmith-song-builder`
- Skill at `~/.claude/skills/slopsmith-song-builder/SKILL.md` documents the whole flow.
- `scripts/song_builder.py plan|build|check ALBUM.yaml`; album YAMLs in `_build/albums/`. Run with
  `_build/.mirvenv/Scripts/python.exe`, a venv with system site-packages plus basic-pitch (ONNX) and livechord refiner.
- `scripts/tab_check.py`: Basic Pitch grading (lift vs luck, weak bars). It showed bars-on-downbeats is
  misleading: Ctrl+Alt+Del (50%) has lift 2.2+. The genuinely weak songs are AI-tab Rhythm parts and Black Mold Rhythm.
- `gp_to_sloppak.py`: new `--anchors` (feedBack sync points; tested: moving bar 20 by +0.3 s moves exactly
  that bar), `--refine-beats` (A/B on 12 songs: about no effect, off by default), and an `x_build` recipe in the manifest
  (survives feedBack saves). `scripts/rebuild_song.py EDITED.feedpak` = rebuild with anchors + backup.
- `lib/gp2rs.py` technique fixes: ties, H/P on the destination, slide targets/outs, ghost≠mute (backup in _build/backup/).
- All albums rebuilt with song_builder after these fixes (reports `_build/albums/*_report.json`).
- `song_builder.py tune`: about 15 songs were close DTW-vs-constant-tempo calls. Choosing by tab_check lift
  switched Pop Song (1.21→1.60, C→A), Hundo Pos (1.78→2.27), Klonopin, and Big-Box back to constant-tempo (C→B).
  Choices live in `_build/albums/*_tuning.json`.
- Final grades for the 39 song_builder songs: 30 A, 6 B, 3 C. The C's are Birthday B4, Broc Ched and Black Mold (Songsterr);
  all of them have a Rhythm lift of about 1.1 and fine Lead/Bass. Most likely a wrong or AI rhythm tab.
- Ideas not done: headless stem tone segmentation (feedBack's stem_arrangement_jobs_service), bend curves
  (`bt`/`bnv`), whisperx lyrics (needs user-supplied lyric text).

## Highway glitch fixes (2026-10-08 ~19:10), tested on Done With Drugs only
- Bends never showed: gp2rs divided pyguitarpro bend values (quarter-tones) by 100 -> /2 now; gp7_to_gp5
  also halved Songsterr bends (/50 -> /25). **Every Songsterr .gp5 must be reconverted** (delete gp5/, song_builder redoes it).
- Chord frames shifted ~2 frets between a chord and its repeats, plus extra space left of chords: gp2rs anchors
  were set per note with a "fret-1" pad. Now `_compute_anchors` works one event per chord at the index-finger
  fret, with lookahead. The 3D highway draws chord frames/lane from the anchor window.
- "Blank" gems are partly by design: highway_3d never puts digits on flying gems; ghost digits only for chord notes
  (setting fretNumberGhostScope 'rocksmith'; 'all' shows single notes too), hd repeat chords = frame only,
  slide-destination gems suppressed.
- Notation-only rebuilds: `gp_to_sloppak.py --reuse OLD.sloppak` keeps stems/cover/sync map and only redoes charts
  (~1-2 s/song). Every build now stores `x_sync.json` (tab→audio beat map) inside the sloppak. Use
  `song_builder.py build ALBUM.yaml --notation-only` or `rebuild_song.py --notation-only`. Verified identical output to a full rebuild.
- All 53 Songsterr gp5 were reconverted (bend fix) and all 39 songs rebuilt notation-only (4.5 min): 296 bend notes,
  279 slides with targets. Grades: 30 A / 5 B / 4 C. The C's are Birthday B4, Broc Ched, Black Mold (Songsterr) and I'm A Bum
  (Rhythm lift 1.18, borderline); all are weak Rhythm parts.

## Open items
1. **Songsterr downloads.** The user has Songsterr Plus. There are 40 entries listed with
   links in `Desktop\gc pro tabs\_songsterr_list.txt` ([AI] = AI-generated).
   - The plan is to download each GP file through the user's logged-in Chrome (claude-in-chrome),
     but browser tools were not enabled in the old session. The user should run `/chrome`.
   - Priority, since the audio is already on hand:
     - From *Prince Daddy & The Hyena* (2022, `Desktop\PDATH`): The Collector (655602),
       Keep Up That Talk (778785), Hollow As You Figured (6641935, solo missing).
     - From *Cosmic Thrill Seekers* (`Desktop\Cosmic Thrill Seekers - PDaddy`):
       I Lost My Life (5272768), Fuckin' A (6463359 / 3296769).
   - Also worth comparing the Songsterr versions of the four songs already built against the
     Ultimate Guitar tabs used.
2. **More albums.** The user is finding more albums (likely *I Thought You Didn't Even Like
   Leaving*, *Sweet Dreams, Tough Cookie*, singles). Each album goes in its own Desktop folder.
3. **Text-tab converter (not started).** Some songs only have text tabs on UG: Lauren (Track 2),
   Jesus Fucking Christ, El Dorado, Something Special, Prototype of the Ultimate Lifeform. The plan:
   - Parse bars and notes from the text.
   - Lay out the song order by hand from the structure notes.
   - Fit the bars to downbeats in the audio, then snap notes to onsets in the guitar stem.
   - Write a .gp5 with PyGuitarPro and run it through `gp_to_sloppak.py`.
   - Research notes on this are in the user's memory.
4. **Library stem fix: blocked.** 539 library sloppaks list the `full` stem together with the
   split stems, all on by default, so muting guitar does nothing in those songs. The Stems plugin
   v0.5.0 plays every stem it lists. A bulk manifest edit (setting full's default to false) was
   **denied by the permission classifier**. Only do it if the user explicitly approves or adds a
   permission rule. A user-side alternative is the Stems plugin's default-muted setting.
   Bromeo is already fixed.
5. Ursula Merger needs a paid tab ($16, PaidTabs). Links were given to the user, who hasn't bought it.

## Environment notes
- Host Python 3.12 has: pyguitarpro, librosa, beat-this (git), demucs 4.1, and
  torch 2.14.1+cu130 (GPU works on the RTX 5070 Ti).
- Neither Slopsmith instance (Docker at :8000, desktop at :18000) was running. The library picks
  up new or changed sloppaks on the next scan.
