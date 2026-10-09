# Bundled drum sounds

Served by `routes.py` at `/api/plugins/drums/sounds/<file>` so the drum synth works offline and loads
nothing from third-party sites.

- `WebAudioFontPlayer.js` — WebAudioFont player by Sergey Surikov, GPL-3.0
  (https://github.com/surikov/webaudiofont, `npm/dist/WebAudioFontPlayer.js`).
- `128<note>_0_<set>.js` — General MIDI drum samples from webaudiofontdata by Sergey Surikov, MIT
  (https://github.com/surikov/webaudiofontdata, `sound/`), one file per GM drum note the plugin uses
  (35–59) for each kit in the Kit setting (`screen.js` `DRUM_KITS`): `JCLive_sf2_file`,
  `FluidR3_GM_sf2_file`, `SBLive_sf2`, `Chaos_sf2_file`. Pure data: each defines one
  `_drum_<note>_0_<set>` preset. `routes.py` `_SOUND_NAME` whitelists exactly these sets.

Downloaded unmodified on 2026-10-09. To add a kit: download its 22 files, add the set to `DRUM_KITS`,
`_SOUND_NAME` and the kit test in `tests/test_routes.py`.
