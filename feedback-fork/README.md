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

Both scripts clone every fork into `~/Desktop/repos/feedback-upstream/` (the list is in `repos.txt`) and check out `custom`. They also link the plugin checkouts into `dev-plugins/` and create the core venv. Re-run them any time to update; a repo with uncommitted changes is left alone.

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
