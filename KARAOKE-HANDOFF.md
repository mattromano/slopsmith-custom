# Handoff: Rock Band–style karaoke for our feedBack build

Written 2026-10-16 on the Mac, at the end of a long session. The goal is to make feedBack's vocals play like Rock Band. Tier 1 is done and working in the real app. This doc is for starting Tier 2 onward in a fresh session.

## Read this first: how to test

**Test in the installed desktop app, never in the Claude app's built-in browser or the `run-dev.sh` web server.** The browser version caused most of the confusion in this session:
- it has no native JUCE audio engine;
- it can't open mics;
- it reports different device labels (Electron adds `(0b0e:0301)` and `(Built-in)` suffixes);
- a hidden tab kept playing a song on the user's speakers.

The built-in browser is now **denied** in `.claude/settings.json` in both `feedback-upstream/` and this repo.

How to test:
- **Guide:** [`feedback-fork/debug/README.md`](feedback-fork/debug/README.md).
- **Launch:** `launch-debug.sh` opens the installed app with DevTools on port 9333.
- **Drive it:** `node cdp.mjs "<js>"` runs JS in the live page (`http://127.0.0.1:18000/`), and `cdp-reload.mjs` reloads it after installing changes.
- **Check devices:** `audio-in-use.swift` and `mic-levels.swift` show which macOS devices are busy, plus mic input volume and mute.
- **Watch the karaoke plugin:** `window.lyricsKaraokeDiag()` gives a live readout of mic level, voiced frames, last pitch, monitor gain, routing and howl ducks.
- **Get ground truth:** record the mic in parallel with `ffmpeg -f avfoundation -i ":0" -t 20 out.wav` and FFT it (numpy is in the batch venv). This is what settled the feedback questions.
- **Ask before quitting the user's running copy.** After any audio test, pause playback, stop the mic, and leave nothing playing.

Also see `feedback-upstream/CLAUDE.md`: line endings, test commands, commit identity.

## The user's setup

- MacBook Pro.
- Jabra EVOLVE 20 USB headset (mono mic, 48 kHz). It has a hardware mute button on the cord, which once caused "no voice at all".
- The guitar interface ("USB Audio Device") is often **unplugged**.
- The user wants their voice to come out of **whatever device plays the game**, usually the MacBook speakers, not the headset.
- Measured with auto-gain off, the Jabra delivers about -37 dB RMS while singing.

## What exists now (Tier 1, done)

### lyrics_karaoke plugin (`feedback-upstream/feedBack-plugin-lyrics-karaoke`)

- **v1.5.0 on `main`:** [PR #1](https://github.com/mattromano/feedBack-plugin-lyrics-karaoke/pull/1), merged. Follow-up branch `feature/batch-pitch-tool`: [PR #2](https://github.com/mattromano/feedBack-plugin-lyrics-karaoke/pull/2), open.
- **ES-module layout:** `screen.js` imports `src/main.js` (the UI and audio, large). The pure logic, all unit-tested, lives in:
  - `src/pitch.js`: YIN, octave-agnostic cents, difficulty table, `foldToTarget`, `monitorGainFor`, `isHowling`;
  - `src/phrases.js`: phrase segmentation;
  - `src/scoring.js`: scorer state machine;
  - `src/prefs.js`: settings, mic constraints and options, output matching, warnings.
- **Scoring:**
  - Octave-agnostic matching.
  - Phrase ratings: Awesome, Strong, Good, OK, Messy, Awful.
  - Multiplier up to 4×; stars 1 to 5.
  - Easy to Expert set the tolerance (±250 / 175 / 125 / 75 cents) and the share of each note to cover (50 to 80%).
  - Seek-aware. Clock jitter under 1 s is ignored. Phrases that were already under way when you joined are left unrated.
- **Mic:**
  - It only opens the mic the user picked; there is no system default. Picker next to 🎤, and in Settings → Microphone & Detection.
  - "Pick a microphone first" when none is chosen. An unplugged chosen mic is reported; there is no fallback.
  - The 🎤 tooltip names the mic. A warning shows for a built-in mic.
- **Hearing yourself:**
  - mic → gain → limiter → the game's output device.
  - 🔊 slider: 50% = +12 dB, 100% = +18 dB.
  - **Howl guard:** when one pitch is held within 10 cents for about 1 s, at any frequency, it cuts 6 dB and shows a notice.
  - **Echo cancellation must stay OFF.** With monitoring through speakers it scrubs the singer's voice; only about 4% of frames still had a pitch.
  - At +12 dB through laptop speakers a faint 2.2 kHz ring remains, so recommend 25 to 40%.
- **Pitch feedback:** an arrow at the playhead plus a trail, green when in tune and orange when off, folded to the target octave. The active note glows while held in tune.
- **Batch tool:** `tools/batch_generate_pitch.py` runs the plugin's own pYIN over a library.
  - Backups go to `~/Desktop/rocksmith/karaoke-pitch-backup-2026-10-16/`. The song list is there as `karaoke-songs.txt`, and `--restore` undoes a run.
  - It needs a venv with `librosa numpy soundfile pyyaml fastapi`. The one used this session lived in a temporary scratchpad and won't survive, so recreate it.

### Core (`feedback-upstream/feedBack`, branch `custom`, pushed)

- The library's dead Arrangements → **Vocals** pill was removed; the server never accepted it.
- A new **Karaoke-ready** filter shows songs with lyrics plus a vocals stem.

### Desktop (`feedback-upstream/feedBack-desktop`)

- Branch `fix/missing-saved-input-fail-closed`: [PR #1](https://github.com/mattromano/feedBack-desktop/pull/1), open against `custom`.
- **The native engine never captures a mic the user didn't configure as guitar input.** The bug: the constructor opened the OS default device, and bare `startAudio()` calls from note detection, the tuner, Rig Builder and NAM then used that mic.
- The engine module was built locally and **installed in `/Applications/feedback.app`**:
  - replaced file: `app.asar.unpacked/build/Release/slopsmith_audio.node`
  - backup: `~/Desktop/rocksmith/sync-backups/slopsmith_audio.node.2026-10-16.bak`
- A future CI build from `custom` needs this PR merged first, or the fix is lost.

### Library state

- 620 songs have lyrics plus a vocals stem.
- When this was written, 177 had pitch data, and a background batch was filling in the other 443 (about 65 minutes).
- Check with `tools/batch_generate_pitch.py ... --dry-run`, which reports how many still need pitch.

## Known gaps and open items

- **Singing-detection quality over speakers isn't confirmed by ear.** In the last real-app test the user didn't sing, according to the parallel recording. Re-check with `lyricsKaraokeDiag()` and an ffmpeg recording while they sing.
- **The private email is in one commit message.** `slopsmith-custom` commit `899fc5c` on `main` carries a `Signed-off-by` with the gmail address. Fixing it means amending and force-pushing `main`; ask the user.
- **Detection stops while paused.** Samples are dropped when the playhead doesn't move, so there's no live arrow while paused. A tuner-style arrow during pause would be nice.
- **Other plugins open default mics in plain browser mode.** That's note_detect, tuner, nam_tone WASM, minigames, bongocat and virtuoso. On desktop the engine fix covers them, so this is harmless there.
- **Upstream got-feedBack plugins** that call bare `startAudio()` (rig_builder etc.) now silently get "no audio" without a guitar input. The audio panel says why; the plugins don't.
- **Core still filters Vocals arrangements out and ignores `vocal_pitch.json`.** Only the plugin reads it.

## Roadmap: the remaining Rock Band tiers

Keep the plugin's pattern: pure logic in `src/*.js` with node tests first, then wiring in `src/main.js`, then verification in the real app.

### Tier 2: content and charts

1. **Rock Band / Clone Hero `PART VOCALS` import.** The most important item: it brings hand-authored vocal charts.
   - Parse `notes.mid` lyrics events, note pitches (36–84), phrase markers (note 105/106), talkies (`#` suffix) and slides (`+`).
   - Write `lyrics.json` plus `vocal_pitch.json` plus phrase data into the sloppak.
   - `feedBack/lib/drumchart.py` already parses the same MIDI files for drums. Reuse its MIDI reader.
2. **Keep authored pitches from Rocksmith vocals XML.** The `note` attribute is dropped in `feedBack/lib/routers/ws_highway.py:850`. Write `vocal_pitch.json` when converting psarc to sloppak (`psarc2sloppak`).
3. **Phrase data in the format.** feedpak-spec has no phrase objects; the `+` line-end suffix is the only marker. Add an optional `vocal_phrases.json` (start, end, optional overdrive flag) and prefer it over the heuristic in `src/phrases.js`.
4. **Talkies:** unpitched syllables scored on rhythm and loudness, not pitch. Mark them in the data (Rock Band `#`) and score with an RMS gate.
5. **Make Vocals a selectable part** in multiplayer and splitscreen, so one person sings while others play.
6. **Generate karaoke data in-app.** "Generate Karaoke" fails without librosa or a stem server. Either bundle pYIN-capable Python in the app or point `demucs_server_url` at a server.

### Tier 3: Rock Band presentation and feel

7. **Scrolling note-tube lane** (Rock Band style): notes travel toward a fixed now-line on a horizontal tube, with pitch slides drawn between notes and lyrics under the tube. It replaces the ribbon in `drawFrame()`, and could become a visualization provider in core (`docs/` covers capability-native viz).
8. **Vocal overdrive (star power):** build it in marked phrases, deploy it by making noise during the gaps between phrases, double the score while active, and add a visual meter.
9. **End-of-song results screen:** score, stars, rating breakdown, and best phrase streak. Integrate with the scorecard plugin and its play history.
10. **Monitor quality:** an optional reverb or "Rock Band mic" effect (ConvolverNode), lower-latency monitoring, and a better feedback guard with a notch filter at the howl frequency instead of a blanket 6 dB cut.
11. **Calibration:** a mic latency calibration routine (sing or clap to a click) instead of a manual slider.

### Tier 4: Rock Band 3 harmonies

12. **Harmonies (HARM1 to HARM3):** a format change for multiple vocal parts, a lane per part with colours, and scoring per singer.
13. **Multiple mics:** more than one karaoke mic, each with its own picker, part and score.

## Suggested next steps

1. Re-verify singing detection by ear with the user in the real app.
2. Tier 2.1, the `PART VOCALS` importer. It unlocks real charts and phrase/talkie/overdrive data that later tiers need.
3. Tier 3.7, the note-tube lane, for the Rock Band look.
