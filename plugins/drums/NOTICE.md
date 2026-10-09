# Licensing notice for the drums plugin

Most of this plugin is original code under the **MIT** license (see `README.md`). That includes
`screen.js`, `plugin.json`, the assets and `tests/screen.test.js`.

Two files are ports of [YARG.Core](https://github.com/YARC-Official/YARG.Core) and are licensed under the
**GNU Lesser General Public License v3.0** (full text in [`LICENSE.LGPL-3.0`](LICENSE.LGPL-3.0)):

| File | Status |
|------|--------|
| `engine.js` | LGPL-3.0. JavaScript port, with modifications, of YARG.Core's drums engine (`Engine/Drums/DrumsEngine.cs`, `Engine/Drums/Engines/YargDrumsEngine.cs`, `DrumsEngineParameters.cs`, `DrumsStats.cs`, `Engine/BaseEngine*.cs`, `BaseStats.cs`, `HitWindowSettings.cs`, `Chart/Notes/DrumNote.cs`, `Note.cs`, drum activation flags from `InstrumentDifficultyExtensions.cs`, and defaults from `Game/Presets/EnginePreset*.cs`). It also takes the drum star thresholds from YARG's `DrumsPlayer.cs` (LGPL-3.0). Copyright (c) YARC (YARG) contributors. |
| `tests/engine.test.js` | LGPL-3.0. Tests for `engine.js`, partly ported from `YARG.Core.UnitTests/Engine/DrumEngineTester.cs` and `DrumsStatsTests.cs`. |

`engine.js` is a standalone, unminified module with no dependencies. `screen.js` only uses it through its
public API (`window.DrumsEngine` / `require('./engine.js')`), so it remains a separate MIT work that
"uses the Library" under LGPL-3.0 section 4. You may replace `engine.js` with a modified version. If you
distribute changes to `engine.js`, they must stay under LGPL-3.0 and their source must stay available.

The header of `engine.js` lists every behaviour that deviates from YARG ("Deviations from YARG").
