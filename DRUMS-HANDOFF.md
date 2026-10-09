# Drums — handoff for the next session (2026-10-09, Windows PC)

Read `PROGRESS.md` first for the original drums build (Mac session: chart converter, joiner, YARG engine
port, 3D highway, library run). This file covers what changed on the Windows PC afterwards, how the
setup is wired, and where to start on the four next tasks.

## How Matt's setup actually runs (important)

- **The app Matt plays in is the installed Slopsmith desktop, v0.2.9** (`C:\Program Files\Slopsmith\current`).
  It bundles its own core + plugins. Do **not** patch `Program Files` (needs admin, app updates overwrite it).
- **Our plugins are user plugins** in `%APPDATA%\slopsmith-desktop\plugins\<id>` (they override bundled
  plugins with the same id, except ones marked `"bundled": true`). Deploy = copy the files there; Ctrl+R in
  the app reloads JS, **Python `routes.py` changes need an app restart**.
  Installed from this repo: `drums`, `multiplayer`, `highway_tweaks`, `play_counts` (the last two exist only
  there + in this repo).
- Core gaps in 0.2.9 are patched **from plugins at startup**, not in core:
  - no `window.slopsmith.midiInput` domain → `drums/screen.js` has a Web MIDI fallback provider (`_webMidiShim`);
  - library filter whitelists only Lead/Rhythm/Bass/Combo → `drums/routes.py` `allow_drums_library_filter()`;
  - sloppak unpack race (concurrent multiplayer loads) → `highway_tweaks/routes.py` `_guard_sloppak_unpack()`;
  - stock `drum_highway_3d` (bundled, can't be shadowed) → retired client-side in `drums/screen.js`;
  - Drums arrangement through a guitar view → `_drumsTakeover()` in `drums/screen.js`.
- `C:\Users\mattr\Desktop\slopsmith` = fork checkout (branch `custom`, **origin is upstream byrongamatos —
  never push there**). Its `lib/` + `scripts/` are where the drum tools live (`drumchart.py`, `drumjoin.py`,
  `drumalign.py`, `chorus.py`, `sngfile.py`, `scripts/drums_library.py`, `drums_join.py`, `song_builder.py`).
  Commit there, then bring it into this repo with
  `git subtree pull -q --prefix=slopsmith C:/Users/mattr/Desktop/slopsmith custom -m "Sync slopsmith: ..."`
  (`sync_from_local.ps1` does the same plus the other plugins). Push `slopsmith-custom/main` (Matt's rule:
  commit/push straight to main when asked).
- Python for the tools: system `python` 3.12 (has numpy/scipy/librosa/soundfile/yaml/fastapi; ffmpeg on PATH).
  Windows quirks already fixed: no `fcntl` (chorus throttle uses `msvcrt`), libsndfile rejects some Opus chart
  stems (`drumalign.load_audio` falls back to ffmpeg), no `cp -c`.

## Data

- Library: `C:/Program Files (x86)/Steam/steamapps/common/Rocksmith2014/dlc/sloppak/` (2,257 sloppaks).
  861 have a Drums arrangement (`arrangements/drums.json` + manifest entry), copied from the Mac's library run.
  Pre-drums originals: `Desktop\sloppak_backup_pre-drums\` (never overwrite a file already there).
- Drum data: `drums.json` = wire notes (GM drum number `midi = s*24 + f`) + a `drums` block:
  `{version, pro, kick2x, star_power, fills, levels: {easy|medium|hard: [[t, gm, flag]]}, levels_generated, source}`.
  `levels_generated` lists levels made by `drumchart.reduce_level` (software) instead of the chart.
- Current coverage on the PC (scan of all 861): 731 all levels hand-charted, **124 lower levels all
  auto-generated (chart was Expert-only)**, 1 partly generated, **5 no lower levels at all**.
- Mac (`ssh mattromano@192.168.4.107`, key auth set up; Full Disk Access for remote users may need
  re-enabling in Sharing → Remote Login ⓘ to read `~/Desktop`): library `~/Desktop/rocksmith/dlc/sloppak`,
  run state + report `~/drums-work/library/drums_state.{json,csv}` (statuses: 856 joined, 5 has-drums,
  310 flagged, 1044 no-chart). Copy of the CSV used here: re-fetch with `scp`.
- Clone Hero kit profile (used as the default MIDI map): `Documents\Clone Hero\MIDI Profiles\CH 2.yaml`
  (active per `profiles.ini`). Mac: `~/Clone Hero/MIDI Profiles/Alesis Drum Module.yaml`.

## Testing without touching Matt's running app

`.claude/launch.json` in `C:\Users\mattr\Desktop\repos` has **`installed-app-test`**: the installed app's own
Python + core on port 8002 with a scratch `CONFIG_DIR` and Matt's AppData plugins dir (pre-mark heavy plugin
requirements in `<config>/pip_packages/.installed_<id>` = sha256 of requirements.txt, or it downloads torch).
Start with the browser pane's `preview_start`. The browser pane blocks mic + Web MIDI, so real-kit and
pitch-detection checks are Matt's. Turn the multiplayer LAN switch off (`POST /api/plugins/multiplayer/lan
{"enabled":false}`) before stopping a test server if a test enabled it.

Tests: `node --test plugins/drums/tests/<file>.test.js` (one file at a time), `python -m pytest
plugins/drums/tests plugins/multiplayer/tests/test_lan_relay.py`, core `python -m pytest` in
`Desktop\slopsmith` (1 known pre-existing failure: `test_run_demucs_preserves_windows_path_var_casing`).

---

## Next tasks

### 1. Re-search drum charts that are Expert-only; prefer multi-difficulty charts; catch missed songs

**"In Too Deep" (`sum41deep.sloppak`) is NOT Expert-only in the data** — it has hand-charted Easy/Medium/Hard
(584/964/1171 notes vs 1358 Expert). It is the only sloppak that also ships a `drum_tab.json`
(manifest `drum_tab:`), and `drums/screen.js` gives the drum tab precedence over the Drums arrangement
(~line 3004 "drum_tab takes precedence…"; difficulty options get `drumTab: true` → Expert only). Fix that
first: when the loaded arrangement is the Drums arrangement, use it (and its levels) over the drum tab;
keep the drum tab for non-drum arrangements / songs without a Drums arrangement.

Then the real re-search:
- Targets: the **124 songs whose lower levels are all generated** + the **5 with no levels** (list them by
  scanning `drums.json` → `drums.levels` / `drums.levels_generated`), plus `--retry flagged,no-chart` from the
  Mac state, plus **44 PC-only sloppaks never searched** (mostly Matt's own Prince Daddy / Dirty Nil builds —
  overlap with task 4).
- Ranking: `scripts/drums_library.py` `online_candidates()` sorts by name match, length, pro drums only. Add
  "number of drum difficulties in the chart" (Chorus Encore search results carry per-difficulty info — check
  the API response, e.g. `notesData` / `diff_drums`; else probe the downloaded chart: .mid tracks 60/72/84
  or .chart `[EasyDrums]`…, see `lib/drumchart.py`). For a song that already has drums, only replace when the
  new chart validates (same thresholds) **and** has more hand-charted levels; keep the old file in the backup
  dir first (`ensure_backup`).
- `drums_library.py` needs `--write` + a populated `--backup-dir` (outside the library). Run with
  `--state` in a scratch dir, dry run first.

### 2. Better drum sounds + a kit picker in the app

- Today: WebAudioFont player + 22 GM drum notes of the **JCLive** set, bundled in `plugins/drums/sounds/`
  (828 KB), served by `routes.py` `/api/plugins/drums/sounds/{name}` (whitelist regex `_SOUND_NAME` — only
  JCLive file names now). Synth code: `drums/screen.js` `WAF_*`, `_drumWafVar/_drumWafUrl`, `_synthInit`,
  `_synthLoadDrumKit`, `DRUM_MIDI_NOTES`. Playback follows the MIDI note the pad sent.
- Options to research and compare (Matt is fine with a lot more data in the plugin):
  - other WebAudioFont percussion sets (`https://surikov.github.io/webaudiofontdata/sound/128<note>_<n>_<Set>.js`,
    e.g. FluidR3_GM, Chaos, SBLive, GeneralUserGS… — check which exist for all notes; webaudiofontdata is MIT,
    note each set's soundfont origin);
  - real multi-sample kits (free SFZ / Hydrogen / Salamander-style kits) as audio files with velocity layers —
    much better sound; check licences (CC-BY / CC0 / GPL) and record them in `NOTICE.md`.
- Build: a "Kit" selector in the drum settings (⚙), saved per browser, lazy-load only the chosen kit, extend
  the routes whitelist per kit folder, velocity-sensitive playback. Keep Matt's latency note: Web Audio adds
  delay vs the kit module's own sound.

### 3. Accessibility drum settings (auto floor tom / auto cymbal etc.)

- Goal: make drums very accessible. Ideas to confirm with Matt: auto-kick, auto floor tom (green tom),
  auto crash/ride (green/blue cymbal), auto any-lane, no-fail, hit-window presets, Pro cymbals already exists
  (`_cfg.proCymbals`, `highway3d.js` session `setProDrums`).
- Engine: `plugins/drums/engine.js` (LGPL port of YARG.Core). Two approaches: (a) remove the auto lanes from
  the chart before `Engine.create` (YARG "No Kicks" style — simplest, scores reflect it), or (b) auto-hit those
  notes at their time and render them as played. Settings live in `STORE_KEYS` / `_cfg` / settings panel like
  `proCymbals`; per-browser so each multiplayer player has their own. Add tests in `tests/highway3d.test.js`.

### 4. Drums from the Guitar Pro tabs (+ automatic Easy–Expert)

- Most pieces exist: `lib/gp2rs.py` `convert_drum_track()` (GP drum track → same GM encoding),
  `lib/drumchart.py` `reduce_level()` (Easy/Medium/Hard reduction fitted on 136 hand charts),
  `scripts/drums_join.py --gp TAB.gp5` and `scripts/song_builder.py drums ALBUM.yaml` (source priority
  chart → GP; GP placed with the song's `x_sync.json` / `x_build.offset`; generated star power + fills).
- Tabs from the guitar builds: `Desktop\gc pro tabs\songsterr\` (+ `gp5\`) and `Desktop\Slopsmith Targets\tabs\`.
  Album recipes: `Desktop\slopsmith\_build\albums\*.yaml` (adult_summers, cheap52_vermont,
  cosmic_thrill_seekers, dirty_nil_fuck_art, hotwire_trip_switch, itydel, pdath_2022; `tab_dir` / `tab` per song).
- Start with `song_builder.py drums _build/albums/<album>.yaml --dry-run` (run from `Desktop\slopsmith`), read
  the validation table, then write. Make sure GP-sourced joins always get Easy/Medium/Hard via `reduce_level`
  (mark them in `levels_generated`). Fold it into the **song-builder skill** (`song-builder/skill/SKILL.md`,
  copy in `.claude/skills/slopsmith-song-builder/`, user skill at `~/.claude/skills/slopsmith-song-builder/`) so
  new album builds produce drums automatically. Note: GP drum maps vary (Songsterr kits) — check note numbers
  against the GM/pro-drums mapping in `PROGRESS.md` ("Drum data in a sloppak").
