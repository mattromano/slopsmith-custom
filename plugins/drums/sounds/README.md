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

- `kits/<kit>/` — real multi-sampled acoustic kits with velocity layers (screen.js `DRUM_KITS` entries with
  `type: 'samples'`), served by `routes.py` at `/api/plugins/drums/sounds/kits/<kit>/<file>` (folder and file
  names whitelisted by `_KIT_DIR` / `_KIT_FILE`, the path must resolve inside `sounds/kits`):
  - `crocell/` — CrocellKit 1.1 (DrumGizmo) stereo mix, **CC BY 4.0**, rock/metal kit (default kit). 4.7 MB.
  - `virtuosity/` — Virtuosity Drums (Versilian Studios / Karoryfer), **CC0**, jazz kit. 3.6 MB.

  Each holds `kit.json` + `<piece>_v<layer>_<a|b>.ogg` (Ogg Vorbis q5, 48 kHz stereo). `kit.json`:
  `{"format": 1, "name", "notes": {"<GM note>": {"piece", "layers": [{"lo", "hi", "files": [...]}]}},
  "chokes": {"42": [46], "44": [46]}}` — layers split the velocity range 1–127, `files` are round-robins,
  chokes make a closed/pedal hi-hat cut a ringing open hi-hat. Rebuild from the source libraries with
  `python -I plugins/drums/tools/build_sample_kit.py <crocell|virtuosity> <source folder>` (downloads:
  https://drumgizmo.org/kits/CrocellKit/CrocellKit_Stereo_MIX.rar, extract it; and
  https://github.com/sfzinstruments/virtuosity_drums). The script documents how hits are picked and trimmed.
  Licences and credits: `../NOTICE.md`.

The WebAudioFont files were downloaded unmodified on 2026-10-09. To add a WebAudioFont kit: download its 22 files, add the set to
`DRUM_KITS`, `_SOUND_NAME` and the kit test in `tests/test_routes.py`. To add a sampled kit: add it to
`tools/build_sample_kit.py` `KITS`, build it into `kits/<id>/`, add a `DRUM_KITS` entry
`{ type: 'samples', dir: '<id>' }`, `SAMPLED_KITS` in `tests/test_routes.py` and its licence to `NOTICE.md`.
