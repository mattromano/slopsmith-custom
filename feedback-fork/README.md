# Our feedBack build

The app we run on both machines is built from the `mattromano/*` forks of [got-feedBack](https://github.com/got-feedBack). It replaces the Slopsmith 0.2.9 setup in the rest of this repo.

- **Forks:** each fork has `origin` = `mattromano/<repo>` and `upstream` = `got-feedBack/<repo>`.
- **`main`:** mirrors `upstream/main` and is left untouched.
- **`custom`:** our build branch. It is `upstream/main` plus our open PR branches, merged in, plus `custom:` commits for our own work.
- **Own plugins:** autotune and scorecard live in their own repos on `main`. Personal plugins ship in-tree in the core fork (`feedBack@custom`, under `plugins/`).

| Repo | Merged into `custom` |
|---|---|
| feedBack | `fix/1082-gp-import-articulations`, `fix/1084-gp-import-anchors`, `fix/1086-feedpak-arrangement-order`, `fix/1088-default-arrangement-not-drums`, `fix/1098-capability-inspector-hidden-render`, `feature/1093-library-table-view` (brings in `feature/49-plays-sort-and-badges`), `feature/1095-queue-album-artist`, `feature/1100-solo-sections`, `feature/1104-stream-drum-gameplay-metadata` (brings in `feature/1090-drum-chart-import`) |
| feedBack-desktop | `feature/131-backing-pitch-shift`, plus the build pointing at our forks |
| feedpak-spec | `feature/67-drums-gameplay-metadata` |
| feedBack-plugin-drums | `feature/1-drums-settings-page` (stacked: brings in 19, 21, 3) |
| feedBack-plugin-multiplayer | `feature/23-real-arrangement-picker` (brings in 21), `feature/26-lan-players` (brings in 6) |
| feedBack-plugin-nam-tone | `fix/16-edit-preset-keeps-model`, `feature/18-player-preset-picker` |
| feedBack-plugin-notedetect | `feature/24-follow-retune-offset`, `fix/73-capo-expected-pitch`, `fix/75-fast-chord-runs`, `fix/79-technique-flags-misread`, `fix/81-sections-on-engine-path`, `feature/77-richer-judgment-events` |

The upstream PRs stay open. See [../UPSTREAM.md](../UPSTREAM.md).

## Set up a machine

```bash
./setup.sh        # Mac
```

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1   # PC
```

Both scripts clone every fork, plus the stock stems and splitscreen plugins for dev runs, into `~/Desktop/repos/feedback-upstream/` (the list is in `repos.txt`) and check out `custom`. They also link the plugin checkouts into `dev-plugins/` and create the core venv. Re-run them any time to update; a repo with uncommitted changes is left alone.

## Day to day

- **Run from source in a browser:** `./run-dev.sh` or `run-dev.ps1`, then open http://localhost:8000. Core runs with `FEEDBACK_PLUGINS_DIR=dev-plugins`, so a plugin edit is live after Ctrl+R (or a restart for `routes.py`).
- **Change something:** commit on `custom` in that fork and push. On the other machine, `git pull` (or re-run setup).
- **Change something meant for upstream:** make a branch off `upstream/main`, open the PR, then merge that branch into `custom`.
- **Commit identity:** `mattromano <42412983+mattromano@users.noreply.github.com>`, `git commit -s`. GitHub rejects the gmail address.

## Build the app (CI)

Go to `mattromano/feedBack-desktop`, open Actions, choose **Build**, then **Run workflow** on branch `custom`. The defaults bundle `mattromano/feedBack@custom` and the plugin list in `scripts/build-common.sh`.

- **Windows:** download the Velopack `Setup.exe`.
- **Mac:** download `fee[dB]ack-macos-arm64.zip`. It is unsigned, so clear Gatekeeper once:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/fee[dB]ack.app"
  ```

- **Updates:** don't switch the app's update channel to Nightly. That would replace our build with stock upstream.

## When upstream moves

For each fork:

1. Run `git fetch upstream`.
2. On `custom`, run `git merge upstream/main`.
3. If one of our PRs got merged upstream, its branch is already in `upstream/main` and the merge is a no-op for it.

## Ported from the PC (2026-10-13)

The PC's Slopsmith 0.2.9 work through `fef43a0` (2026-10-12) is on the `custom` branches.

| Piece | Where now | Notes |
|---|---|---|
| drums 5.10 → 5.18.3 | feedBack-plugin-drums 4.5.0 | Timing, split view, sounds, MIDI monitor, direct MIDI (WinMM), auto kick/cymbals, one drum highway, Clone Hero kit map. In Auto it leaves guitar parts alone. |
| multiplayer 1.1.0 | feedBack-plugin-multiplayer 1.1.0 | Clock stamps, output latency, min-RTT sync, seek-only correction. |
| highway_tweaks | core `plugins/highway_tweaks` 2.0.0 | Only the parts 0.3 doesn't already do. It still provides `__hwtFrameTime`, `__hwtStemsSmooth` and `__hwtRenderAheadMs`. |
| sync_lab | core `plugins/sync_lab` 2.0.0 | Also fixes the A/V suggestion drifting after Apply. |
| tone_pack, guitar_volume | core `plugins/tone_pack`, `plugins/guitar_volume` | Desktop app only. |
| play_counts, play_queue, player_bar | dropped | Covered by core #49 / #1093 / #1095, scorecard and the v3 player. |
| `tools/patch_chain_lock.py` | not needed | 0.3's native engine serialises chain ops itself (`chainMutationMutex`). Don't run it on 0.3. |

Core fixes we added on `custom`:
- **Split view:** panel highways now get the A/V offset.
- **MIDI timing:** Web MIDI listeners get each message's arrival time.
- **MIDI discovery:** a hung `requestMIDIAccess` no longer blocks other MIDI providers.
- **Drum views in Auto:** the bundled `drum_highway_3d` steps aside when the drums plugin is installed.

### Still open

- **Kit samples:** the DRS and 15-mic Crocell `.ogg` files exist only on the PC, and they are not committed. Copy `%APPDATA%\slopsmith-desktop\plugins\drums\sounds\kits\drs` (and `crocell`) into the drums checkout's `assets/sounds/kits/`, or build them with `tools/build_drumgizmo_kit.py`.
- **tone_pack IRs:** these are EQ'd Rocksmith cab IRs, kept out of the public fork. Copy the old `plugins/tone_pack/irs/*.wav` to `<config>/nam_irs/tone_pack/` on each machine.
- **Library Drums filter:** a Drums arrangement filter, and renaming the stems "Drums" pill to "Drum audio" (old d65ac91), would need a core library change.
- **Split-view score boxes / results card:** these need panel support in scorecard.
- **play_queue extras:** count-in Auto mode and skipping the count-in on queue advance. Track numbers should come from writing `track:` in song-builder.
- **Song builder:** still lives in this repo, on the old core.
- **Needs a real kit and guitar:** the stems clock with real audio, split view, and drum timing are only covered by unit tests so far.
