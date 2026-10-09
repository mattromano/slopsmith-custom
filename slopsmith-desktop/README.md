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
