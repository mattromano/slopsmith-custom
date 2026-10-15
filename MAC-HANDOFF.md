# Handoff: our own feedBack build, continued on the Mac

Written 2026-10-15 on the PC. For picking this up on the Mac. Read this first, then `feedback-fork/README.md`
(how the forks and the `custom` branches work, plus a 2026-10-15 update section).

## Where things stand

- **Upstream is inactive.** got-feedBack has merged nothing since 2026-07-23, and no maintainer has commented
  since. We build our own app from Matt's forks instead of waiting.
- **All 43 got-feedBack repos are forked** under `mattromano/`. Each fork's build branch is `custom`: upstream
  `main` plus our work. `main` mirrors upstream. Each fork's previous `custom` is tagged `custom-backup-2026-10-15`.
- **The app builds from the forks.** Run the Build workflow (`build.yml`) on `mattromano/feedBack-desktop`,
  branch `custom`. It bundles `mattromano/feedBack@custom` plus all plugins from `mattromano/*`: `custom` for
  drums, multiplayer, nam-tone, notedetect and stems, the default branch for the rest.
  - The desktop fork's default branch is now `custom`, which registers the workflows.
  - Nightly and rc are disabled on the fork.
  - The updater only checks `mattromano/feedBack-desktop`.
- **Latest good build:** [run 38783736763](https://github.com/mattromano/feedBack-desktop/actions/runs/38783736763),
  green on win/mac/linux. Its artifacts **expire 2026-10-22**: `slopsmith-mac-arm64` (538 MB),
  `slopsmith-win-x64` (1.7 GB, Setup.exe) and `slopsmith-linux-x64`. The Mac zip was inspected:
  - 58 plugins
  - drums 4.5.1, notedetect 1.33.0, live_retune 2.0.0, song_cents 2.0.0, rs_profile_counts 1.0.0
  - multiplayer 1.1.0, nam_tone 1.3.0, stems 0.9.0 (with #42)
  - highway_tweaks 2.1.0, sync_lab 2.0.1, autotune, scorecard, tone_pack, guitar_volume
  - core 0.3.0-alpha.1

```bash
gh run download 38783736763 -R mattromano/feedBack-desktop -n slopsmith-mac-arm64
```

## Installing on the Mac (not done yet)

1. Unzip the artifact, then unzip `release/feedback-macos-arm64.zip` inside it.
2. **The app is `feedback.app`, not `fee[dB]ack.app`.** It doesn't overwrite the stock app, but both use
   bundle id `com.byron.slopsmith-desktop` and display name fee[dB]ack.
   - Quit the stock app and move `/Applications/fee[dB]ack.app` to the Trash.
   - Keep `~/Library/Application Support/...`: library path, settings and play history carry over.
3. Drag `feedback.app` into Applications, then clear the quarantine flag (the build is unsigned):

   ```bash
   xattr -dr com.apple.quarantine /Applications/feedback.app
   ```

4. If a plugin appears twice (an old user-installed copy plus the bundled one, e.g. `live_retune`), delete the user copy.

The stock app showed Drums parts on the guitar 3D highway (frets 9–21). In our build the drums plugin should take
Drums parts. That's the first thing to check.

## What's in `custom` now (by repo)

- **feedBack (core) @ 1274246:**
  - everything from the 10-13 port
  - upstream #974 (phase-locked render clock, plus highway_tweaks 2.1 putting the stems clock in front of it)
  - upstream #1046 (A/V offset ±300, exact entry, not clobbered by auto-calibrate)
  - upstream #1017 (drums stay in the picker)
  - highway_3d verdict windows measured from the sustain end (late hits now flash)
  - the PSARC CentOffset fix (converted songs keep e.g. +45c)
  - the #1083 and #1087 review fixes
  - personal pieces: drum downloads + align (Chorus Encore, drum join, drums library), `rs_profile_counts`
    (Rocksmith 2014 profile plays → native play count), instrument views taking over Drums/keys parts, count-in
    extras (only when needed, none on queue advance), `song_cents` (`window.__songCents.current` + `songcents:change`)
- **feedBack-desktop @ 8d77e69:**
  - backing-track pitch transpose removed (#131 reverted)
  - Live Retune ported with real IPC: `feedBackDesktop.audio.setLivePitch({semitones, cents, windowMs})` and
    `getLivePitch()`, ±500c. The plugin is in-tree at `src/renderer/live-retune/`.
  - the build points at the forks
  - nothing from `feat/open-source-pedals`. Matt: it turned out terrible, so never bring it in.
- **feedBack-plugin-drums @ 2bd2b7c (4.5.1):**
  - the session owns the input offset (applied to update/hit/activate)
  - velocity is passed as /127
  - star power via Enter, or a pad (`drums_sp_pad_v1`)
  - failed script loads can be retried
  - everything else from 5.18.3 kept (sampled kits, direct MIDI, settings page, split view)
- **feedBack-plugin-notedetect @ 2702faf (1.33.0):** = the consolidated scoring branch (got-feedBack PR #84).
- **feedBack-plugin-nam-tone @ 96150c4:** keeps a "(missing)" model/IR when the dropdowns refresh.
- **feedBack-plugin-stems @ 768ef13:** upstream #42 (under-run nudge rate limit).
- **feedBack-plugin-multiplayer:** unchanged. Matt decided to keep it: picker, join links, LAN, and the 1.1.0
  clock-stamp sync.

## To test hands-on (needs Matt with the kit / guitar)

- **Drums:**
  - Re-check the input offset with the timing meter's Apply button. The default is 0, and the engine-clock fix
    changes what a given offset means; the old measured value was +30 ms.
  - Star power: try Enter, or set a pad. If it's the hi-hat pedal (44), check the Alesis doesn't fire it on every
    pedal close.
  - Ghost/accent dynamics with the velocity scaling.
- **Live Retune:**
  - ±1–5 semitones and cents in Tight / Balanced / Smooth, and how the latency feels.
  - The tuner should still read the real strings.
- **Match song + note detection:** notedetect always applies the chart's `centOffset`. With the CentOffset
  converter fix, a +45c Oasis chart now expects +45c. If Live Retune shifts only what you hear (not the
  detector's input), real strings at A440 may score as off.
  - Check this on Don't Look Back in Anger.
  - Fix options: song_cents/live_retune publish a chart-transform provider, or notedetect reads the live pitch.
- **Split view:** a drum panel next to a guitar panel (hit routing, per-panel clocks).
- **Highway:** check that #974's clock and our stems clock don't fight; look for shimmer or jumps after seeks.

## Open items

1. **Make the build permanent.** Publish a GitHub release on `mattromano/feedBack-desktop`, so the download doesn't
   expire and the in-app updater can find it. Ask Matt first: it's public.
2. **Soundfonts** still download from got-feedBack. To switch, publish a `soundfonts-v1` release on
   `mattromano/feedBack-soundfonts` (`GeneralUser-GS.sf2`, `FluidR3_GM.sf2`). Then change `.build-config.json` and
   `src/main/soundfont-manager.ts` in the desktop fork.
3. **Two core tests** (`tests/test_drumchart.py::test_convert_cli_reports_errors`,
   `tests/test_sloppak_to_ch.py::test_export_cli_without_drums`) fail only in the full Windows pytest run. The cause:
   caplog / the `seen` list come back empty after earlier tests. They pass alone and in every subset tried
   (plugins dir, drumjoin, drums_library). Not yet bisected, and it doesn't affect the app.
   - 10 other Windows-only failures are known (symlink, tailwind, feedpak_extension, packaging).
4. **Not ported yet:**
   - the library "Drums" chart filter vs the "Drum audio" stem pill
   - split-view score boxes in scorecard
   - the song builder, which still runs on the old core in this repo
5. **Community fork, later.** `get-flashbacks` (cchacs) is the only other active fork: keys/piano, security,
   dependencies, CI. We may want to contact them, or take their security commits. If this goes public: a new
   org/name, transfer the repos, CONTRIBUTING.

## Added after this doc was first written

- **Drum kits (drums 4.5.2, drums fork `custom` e254e4f):** the DRS kit and the 15-mic Crocell rebuild are now in the
  drums fork, so every app build ships them. Build [38796960768](https://github.com/mattromano/feedBack-desktop/actions/runs/38796960768)
  includes them; use it instead of 38783736763 (still running when this was written: check it went green).
- **Guitar tones:** the private repo `mattromano/feedback-tones` holds the 0.2.9 app's tones, pushed from the PC
  (commit a96bac2):
  - 74 presets, 66 mappings, 51 NAM models, 457 IRs (tone_pack included), rig-builder data
  - all 13,248 referenced files found; no third-party VSTs
  - `pull-tones.sh` on the Mac **replaces** the Mac's tone DB (6,057 presets → 74), with a backup taken first.
    Decide before pulling whether those 6,057 matter.

## Song library over the LAN (set up 2026-10-15)

The PC shares its library as an SMB share, so the Mac uses the same songs with no copying.

- **Share:** `smb://192.168.4.77/RSDLC` → `C:\Program Files (x86)\Steam\steamapps\common\Rocksmith2014\dlc`.
  - 2,331 `.psarc` + 2,271 `.sloppak`, 38 GB total.
  - Only the PC account `mattr` has access, with read/write. Sign in with the Windows login password, or
    `MATT_PC_2\mattr` if the plain name fails.
  - The PC network (Ethernet 3, 10 GbE) is now Private, with File and Printer Sharing on.
- **Mac side:**
  - Finder ⌘K → `smb://192.168.4.77/RSDLC` (use the IP: the underscore in the PC name breaks Mac name lookup).
    It mounts at `/Volumes/RSDLC`.
  - In fee[dB]ack, set the library folder to `/Volumes/RSDLC`.
  - Add the mounted drive to Login Items so it reconnects at login.
  - Test with `nc -vz 192.168.4.77 445`.
- **Caveats:**
  - The PC must be on and awake while playing on the Mac.
  - Reserve 192.168.4.77 for the PC in the router's DHCP.
  - The File and Printer Sharing SMB-In rule is also enabled for the Public profile; consider disabling it.

## PC-only plugins and user data (done 2026-10-15)

Both go through the private repo `mattromano/feedback-tones`, with the same two commands as the tones:

```bash
cd ~/Desktop/repos/feedback-tones && git pull && ./pull-tones.sh
```

Run it with fee[dB]ack quit, the library share mounted, and after one library scan in the app.

- **Plugins**, in `plugins/` in the repo. `pull-tones.sh` installs five into
  `~/Library/Application Support/feedback-desktop/plugins/`, moving older copies to `tone-backups/plugins-<ts>/`.
  This repo is now the only copy of most of them: the original GitHub repos for disc_extract, rs1_extract,
  ultimate_guitar, slopscale and Theory Lab are gone (404).
  - **disc_extract:** ported. It now writes sloppaks via a new pure-Python SNG reader. It needs the RS2014 game
    folder, so it's PC-only, and all 70 base-game songs are already in the library anyway.
  - **rs1_extract:** ported. The RS1 disc pack works anywhere, including over the share. **51 of the 52 RS1 disc
    songs aren't in the library yet**; run it in the app on the PC to add them. The DLC pack needs the game, so PC only.
  - **ultimate_guitar ("Create from Tab"):** ported, and now escapes UG text before showing it.
  - **midi_capo:** ported. Its badge is in the v3 plugin slot, and 4/5-string bass tunings now shift properly.
  - **slopscale:** ported, using 0.3's names to borrow the 3D highway / Jumping Tab. Its 16 Playwright suites pass.
  - **guitar_theory (Theory Lab):** backup only, not installed. 0.3 bundles a newer copy, and a user copy would
    shadow it.
- **User data**, snapshotted from the PC's 0.2.9 config:
  - `practice_journal.db`, 675 sessions: merged, deduped on filename + started_at.
  - `midi_mappings.db`: merged; `bank_number` → `bank_msb`.
  - `song_cents.json`, 84 entries: merged, PC wins. Entries stay valid while the pack's size and mtime match.
  - `tuner.json`: custom tunings only.
  - **286 play_counts runs:** converted into scorecard runs (all 286), and into core `song_stats` in `web_library.db`
    (plays, play_count for runs of 30 s or more, best score/accuracy, seconds, last played).
    - Drum runs (16) go to scorecard only.
    - Runs whose song isn't scanned yet wait and retry on the next pull.
    - A ledger, `feedback_tones_import.db`, prevents double counting. Restore it together with `web_library.db` /
      `scorecard.db` if you ever restore those from a backup.
  - Possible change: play_count counts scored runs (240). 0.2.9 showed 578 "plays" from journal sessions; ask Matt
    if he'd rather use that.
- **Not carried, by design:** calibration (A/V offset, guitar latency, drums input offset). Redo it on the Mac with
  Sync Lab and the drums timing meter.
- **PC-only by nature:** the direct MIDI (WinMM) fallback, the Rocksmith profile play-count import (Steam save),
  and the game-file extractors.
- **Song builder** (`song-builder/`, Demucs + Whisper) needs its Python dependencies installed on the Mac.

## Upstream PRs still open (got-feedBack)

Left open on purpose:
- feedBack #1083, #1085, #1087, #1089, #1091, #1099, #1101, #1105
- drums #25 (scoring), #26 (3D highway, stacked on #25)
- notedetect #84
- nam-tone #17, #19
- multiplayer #22
- feedpak-spec #68

#1091, #1105 and spec #68 are the drum-metadata chain that drums #25 uses.
`PR-REVIEW-HANDOFF.md` has the details. Nothing more is needed unless a maintainer reappears.

## Mac setup to keep developing

```bash
cd ~/Desktop/repos/slopsmith-custom && git pull
cd feedback-fork && ./setup.sh
```

`setup.sh` clones every fork into `~/Desktop/repos/feedback-upstream/` on `custom` and links the plugins into
`dev-plugins/`. `./run-dev.sh` runs it from source at http://localhost:8000.

Conventions:
- Commit as `mattromano <42412983+mattromano@users.noreply.github.com>` with `-s`.
- Push to `mattromano/*` only; never to got-feedBack.
- Never play audio in browser tests; seek while paused.
- To rebuild the app, run Build on the desktop fork's `custom` branch:

```bash
gh workflow run build.yml -R mattromano/feedBack-desktop --ref custom
```
