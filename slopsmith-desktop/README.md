# slopsmith-desktop (custom)

The desktop app's upstream history is about 530 MB (it vendors JUCE), so this folder keeps only the custom
work as a patch series on top of upstream:

- Upstream: https://github.com/byrongamatos/slopsmith-desktop
- Base commit: see `BASE_COMMIT` (`14ffe61`, "fix(main): allow same-origin window.open so plugin pop-outs sync")
- `patches/`: the `feat/backing-pitch-shift` branch, real-time pitch shift on the backing bus (Auto-Tuner B) + IPC
- `Launch Slopsmith.cmd`: double-click dev launcher (points DLC_DIR at the Rocksmith 2014 dlc folder)

Recreate it:

```bash
git clone https://github.com/byrongamatos/slopsmith-desktop.git
cd slopsmith-desktop
git checkout -b feat/backing-pitch-shift 14ffe61098e3e085d1734ca9610479a3d92bf11a
git am ../slopsmith-custom/slopsmith-desktop/patches/*.patch
```

The `git am` path assumes slopsmith-custom sits next to slopsmith-desktop; adjust it to wherever you cloned it.

## Live guitar retune (installed-app engine)

`patches-live-pitch/` is a separate series on a different base: the feedBack-desktop **0.2.9 snapshot**
(`bd603184d51d435890f2f990e8b9f6c0b677776e`, https://github.com/mattromano/feedBack-desktop), which is what the
installed Slopsmith 0.2.9 app runs. It adds the live pitch shift for the guitar you play (LivePitchShifter,
controlled by `plugins/live_retune`). Only `slopsmith_audio.node` changes, so it drops into the installed app:

```bash
git -C feedBack-desktop worktree add -b feat/live-pitch-shift ../wt-live-pitch bd60318
cd wt-live-pitch && git submodule update --init --recursive
git am ../slopsmith-custom/slopsmith-desktop/patches-live-pitch/*.patch
npm install && npm run build:audio          # then: cd build && ctest -C Release
python -I ../slopsmith-custom/tools/install_native_audio.py   # backs up + swaps the app's .node; --restore undoes
```

Offline listening check: build `tests/live_pitch/render.cpp` with `src/audio/LivePitchShifter.cpp` and run
`render <out_dir> [di.wav]` to get dry vs shifted WAVs per latency mode.
