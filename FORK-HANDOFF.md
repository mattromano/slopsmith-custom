# Handoff: our own feedBack fork

**Status:** paused on 2026-10-09, before any merging started.

**Goal:** stop relying on got-feedBack, which has merged nothing since 2026-07-23. Rebuild our own feedBack from the `mattromano/*` forks with all of our customizations, and end up with something playable that replaces the installed Slopsmith 0.2.9.

This builds on the work in [UPSTREAM.md](UPSTREAM.md). Every customization is already ported to feedBack 0.3.0-alpha.1 on its own branch, and every branch is pushed to the fork.

## Decisions still open

Ask these when work resumes; the last attempt was interrupted.

1. **Fork layout.** Recommended: make `main` on each fork the combined build and keep tracking `upstream/main`. The alternative is a separate `custom` branch.
2. **The 31 open upstream PRs.** Recommended: leave them open, since it costs nothing. The alternative is to close them with a note.
3. **Personal pieces left out of the PRs.** Include any of these in our build?
   - `tone_pack`
   - Steam profile play counts (play_counts' Rocksmith 2014 profile decrypt)
   - Drums/piano view takeover (`_instrumentVizOverride`)
   - Drum align + Chorus Encore downloads (`drumalign`/`drumjoin`/`chorus`/`drums_library`)
   - The original LAN relay (`lan_relay.py`)
   - Count-in extras
4. **End state.** Recommended: a Windows installer built from the forks with our plugins bundled. The alternative is just merged repos.

## Where everything is

Clones are in `C:\Users\mattr\Desktop\repos\feedback-upstream\`. Each has `origin` = `mattromano` fork and `upstream` = `got-feedBack`. Every branch below is pushed to its fork.

### feedBack (core)

Each branch is based on upstream `eef58c8`.

| Branch | What it is | Merge note |
|---|---|---|
| `fix/1082-gp-import-articulations` | GP import articulations | |
| `fix/1084-gp-import-anchors` | GP import anchors | |
| `fix/1086-feedpak-arrangement-order` | Feedpak arrangement order | |
| `fix/1088-default-arrangement-not-drums` | Default arrangement never Drums | |
| `fix/1098-capability-inspector-hidden-render` | Capability inspector only renders while visible | |
| `feature/49-plays-sort-and-badges` | Most Played sort + play badges | Merge before the table view |
| `feature/1093-library-table-view` | Table library view | Stacked on 49 |
| `feature/1095-queue-album-artist` | Album/artist queue | |
| `feature/1100-solo-sections` | Solo sections detection | |
| `feature/1090-drum-chart-import` | Drum chart import | |
| `feature/1104-stream-drum-gameplay-metadata` | Stream drum gameplay metadata | Stacked on 1090 |

### Plugins and desktop

| Repo | Branches (in merge order where stacked) |
|---|---|
| feedBack-plugin-notedetect | `feature/24-follow-retune-offset`, `fix/73-capo-expected-pitch`, `fix/75-fast-chord-runs`, `feature/77-richer-judgment-events`, `fix/79-technique-flags-misread`, `fix/81-sections-on-engine-path` |
| feedBack-plugin-nam-tone | `fix/16-edit-preset-keeps-model`, `feature/18-player-preset-picker` |
| feedBack-plugin-multiplayer | `fix/21-add-button-apostrophe`, then `feature/23-real-arrangement-picker` (stacked); `feature/6-join-links`, then `feature/26-lan-players` (stacked) |
| feedBack-plugin-drums | `feature/19-yarg-scoring-engine`, then `feature/21-rock-band-3d-view`, then `feature/3-sampled-kits`, then `feature/1-drums-settings-page`. Fully stacked: merging the last one brings in all four. |
| feedBack-desktop | `feature/131-backing-pitch-shift` |
| feedpak-spec | `feature/67-drums-gameplay-metadata` (spec 1.20.0) |

### Our own new plugins

These are on `main`, already public:
- [mattromano/feedBack-plugin-autotune](https://github.com/mattromano/feedBack-plugin-autotune)
- [mattromano/feedBack-plugin-scorecard](https://github.com/mattromano/feedBack-plugin-scorecard)

## Known merge conflicts

- **Core `CHANGELOG.md` `[Unreleased]`:** every core branch touches it. Its line endings are CRLF.
- **Core `static/v3/songs.js`:** the plays, table and queue branches all touch it.
- **notedetect:** every branch bumps the version to 1.33.0. capo and retune both edit the engine hand-off functions. chord-runs and judgment both edit `_ndFinalizeChordVerdict`. judgment duplicates the section and technique helpers from the sections and techflags branches; unify them.
- **nam-tone:** both branches add an identical `tests/_load_screen.js`, and both bump the version.
- **Core and the drums plugin:** core still bundles `drum_highway_3d`, which wins Auto for drum parts. In our build, remove it or reorder it so the `drums` plugin wins.

## Building the app

- **Desktop clone list:** `feedBack-desktop/scripts/build-common.sh` (around lines 133–180) is the list of plugins the desktop build clones. Point it at our forks, and add autotune and scorecard.
- **Core version:** the core version is bumped by the desktop release process. Pick our own version suffix so we can tell builds apart.
- **Desktop build:** it works on this PC with MSVC 2022 Build Tools (`npm install`, `npm run build:audio`, `npm test`; ctest passes). See `wt-desk-pitch`.

## Testing notes

- **Commit identity:** GitHub rejects the gmail address. Commit as `mattromano <42412983+mattromano@users.noreply.github.com>` with `git commit -s`.
- **Known Windows failures:** core pytest has 10–12 tests that also fail on unmodified `main` on Windows (symlink, tailwind, packaging, feedpak_extension). CI runs on Ubuntu.
- **No audio in tests:** never play audio in browser tests. Seek while paused.
