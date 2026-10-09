# Tone Pack (private plugin)

Gives the Audio plugin's **Tone Automation** a preset for every category, built from the NAM captures and
cab IRs already on this computer (Rig Builder's `slopsmith-config/nam_models` and `nam_irs`).

| Category | Preset | Chain |
|---|---|---|
| Clean | Auto · Clean (Twin Reverb) | Fender Twin Reverb Ch1 → Rocksmith TW 1x12 cab (SM57 cone) |
| OD | Auto · Crunch (Marshall DSL40) | Marshall DSL40 crunch → Marshall 1960A |
| Dist | Auto · Distortion (5153) | EVH 5153 → Marshall 1960AX (SM57 edge) |
| Solo | Auto · Lead (Mesa Mark V) | Mesa Mark V lead → Marshall 1960A |
| Bass | Auto · Bass (Ampeg SVT) | Ampeg SVT clean → Ampeg 8x10 |
| Acoustic | Auto · Acoustic (emulator) | acoustic-emulator pedal capture |
| Mod | Auto · Clean Chorus (Twin) | chorus capture → Twin → cab; with Kilohearts Essentials installed it becomes **Auto · Clean Chorus + Delay (Kilohearts)**: Twin → cab → kHs Chorus → kHs Delay → kHs Reverb |
| Idle | your own preset (e.g. Main Lead) | — |

- Missing files fall back to alternatives (see `RECIPES` in `routes.py`); a preset without any capture is skipped.
- Output gain is level-matched from each amp capture's NAM loudness metadata (to about Main Lead's level).
- `screen.js` merges at startup: adds missing pack presets, refreshes pack presets when the pack changes
  (keeping your gain / gate tweaks), never touches presets you made, never overrides targets you set,
  and keeps a pack preset you deleted deleted. First run with no Tone Automation config turns it on.
- No knob state is stored: NAM / IR stages have none, and the Kilohearts plugins start at their defaults.

Tests: `node --test plugins/tone_pack/tests/merge.test.js`.
