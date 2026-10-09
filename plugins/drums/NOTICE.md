# Licensing notice for the drums plugin

Most of this plugin is original code under the **MIT** license (see `README.md`). That includes
`screen.js`, `highway3d.js` (the 3D view), `routes.py`, `plugin.json`, the assets, `docs/`, `tools/`,
`tests/screen.test.js`, `tests/highway3d.test.js` and `tests/test_routes.py`. The 3D view imitates the
general look of rhythm-game drum tracks but uses no artwork, fonts, logos or code from those games or from
YARG; its scoring comes only from `engine.js`'s public API.

Two files are ports of [YARG.Core](https://github.com/YARC-Official/YARG.Core) and are licensed under the
**GNU Lesser General Public License v3.0** (full text in [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0)):

| File | Status |
|------|--------|
| `engine.js` | LGPL-3.0. JavaScript port, with modifications, of YARG.Core's drums engine (`Engine/Drums/DrumsEngine.cs`, `Engine/Drums/Engines/YargDrumsEngine.cs`, `DrumsEngineParameters.cs`, `DrumsStats.cs`, `Engine/BaseEngine*.cs`, `BaseStats.cs`, `HitWindowSettings.cs`, `Chart/Notes/DrumNote.cs`, `Note.cs`, drum activation flags from `InstrumentDifficultyExtensions.cs`, and defaults from `Game/Presets/EnginePreset*.cs`). It also takes the drum star thresholds from YARG's `DrumsPlayer.cs` (LGPL-3.0). Copyright (c) YARC (YARG) contributors. |
| `tests/engine.test.js` | LGPL-3.0. Tests for `engine.js`, partly ported from `YARG.Core.UnitTests/Engine/DrumEngineTester.cs` and `DrumsStatsTests.cs`. |

`engine.js` is a standalone, unminified module with no dependencies. `screen.js` and `highway3d.js` only use it through its
public API (`window.DrumsEngine` / `require('./engine.js')`), so they remain separate MIT works that
"use the Library" under LGPL-3.0 section 4. You may replace `engine.js` with a modified version. If you
distribute changes to `engine.js`, they must stay under LGPL-3.0 and their source must stay available.

The header of `engine.js` lists every behaviour that deviates from YARG ("Deviations from YARG").

## Bundled drum sounds (`sounds/`)

| Files | License |
|-------|---------|
| `sounds/WebAudioFontPlayer.js` | **GPL-3.0**. WebAudioFont player, unmodified, by Sergey Surikov (https://github.com/surikov/webaudiofont). It is a separate script the synth loads at runtime; the rest of the plugin only calls its public `WebAudioFontPlayer` API. |
| `sounds/128*_0_JCLive_sf2_file.js`, `sounds/128*_0_FluidR3_GM_sf2_file.js`, `sounds/128*_0_SBLive_sf2.js`, `sounds/128*_0_Chaos_sf2_file.js` | **MIT**. General MIDI drum samples (JCLive, FluidR3 GM, SB Live! and Chaos sets) from https://github.com/surikov/webaudiofontdata, unmodified. |

| `sounds/kits/crocell/*` | **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Derived from **CrocellKit 1.1** for DrumGizmo, stereo mix (`CrocellKit_Stereo_MIX.rar`, https://drumgizmo.org/wiki/doku.php?id=kits:crocellkit). Kit of the Danish band Crocell; kit setup by Andreas (Crocell, crocell.dk), mic setup by Jacob Olsen (JBOSound, jbosound.com), sampled, edited and prepared by Lars Muldjord / the DrumGizmo team (drumgizmo.org). **Changes:** a subset of hits (4 velocity layers × 2 per piece) picked, trimmed, faded, level-balanced and re-encoded to Ogg Vorbis by `tools/build_sample_kit.py`; some pieces are reused for other GM notes. |
| `sounds/kits/virtuosity/*` | **CC0 1.0** (public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/). Derived from **Virtuosity Drums** by Versilian Studios and Karoryfer Samples, played by Austin McMahon (https://github.com/sfzinstruments/virtuosity_drums). Mixed from its overhead, kick and snare mics like the library's "basic kit", trimmed and re-encoded by `tools/build_sample_kit.py`; the mid tom is the high tom tuned down 4 semitones. Credit given as a courtesy. |

When you use the plugin's drum sounds in a recording, CC BY 4.0 asks that the CrocellKit credit above goes
with it. See `sounds/README.md`.
