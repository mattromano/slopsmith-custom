# Bundled drum sounds

Served by `routes.py` at `/api/plugins/drums/sounds/<file>` so the drum synth works offline and loads
nothing from third-party sites.

- `WebAudioFontPlayer.js` — WebAudioFont player by Sergey Surikov, GPL-3.0
  (https://github.com/surikov/webaudiofont, `npm/dist/WebAudioFontPlayer.js`).
- `128<note>_0_JCLive_sf2_file.js` — General MIDI drum samples (JCLive sound set) from webaudiofontdata
  by Sergey Surikov, MIT (https://github.com/surikov/webaudiofontdata, `sound/`). One file per GM drum
  note the plugin uses (35–59). Pure data: each defines one `_drum_<note>_0_JCLive_sf2_file` preset.

Downloaded unmodified on 2026-10-09.
