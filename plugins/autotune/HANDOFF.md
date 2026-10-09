# Auto-Tuner build — handoff (paused 2026-05-21)

Single entry point for resuming the Auto-Tuner (Live Retune) build. Full task
list is in `PLAN.md`; running task log is in `PROGRESS.md`. This doc is the
"where we are / how to pick up" summary.

## Status: 12 of 15 tasks done — Phases 1–4 complete

| Phase | Tasks | State |
|-------|-------|-------|
| 1 Plugin scaffold | T1–T3 | ✅ done |
| 2 Web real-time path | T4–T6 | ✅ done — web MVP, validated headlessly |
| 3 Desktop native path | T7–T9 | ✅ done — built + addon exports verified |
| 4 Full-retune coupling | T10–T12 | ✅ done — note_detect + tuning badge |
| 5 Polish & contribution | **T13–T15** | ⬜ **remaining** |

## The 3 repos (all committed, clean working trees)

| Repo | Path | Branch | HEAD |
|------|------|--------|------|
| Plugin (A) | `C:\Users\mattr\Desktop\slopsmith-plugin-autotune` | `main` | `6a29c0b` |
| Desktop engine (B) | `C:\Users\mattr\Desktop\slopsmith-desktop` | `feat/backing-pitch-shift` | `febffac` |
| note_detect (C) | `C:\Users\mattr\Desktop\slopsmith\plugins\note_detect` | `feat/retune-offset` | `944350b` |

The plugin repo (`main`) has 12 signed commits (T1–T12). Desktop has 2 (T7, T8).
note_detect has 1 (T10). No PRs opened yet (that's T15).

## What's left

- **T13 — keyboard shortcuts.** In the plugin `screen.js`, register via
  `window.registerShortcut`: `[` / `]` step the offset ∓1 semitone, `\` reset to
  0. Scope `'player'`. Mirror the existing `window.autotune.setOffset`. Clean up
  with `window.unregisterShortcut` if needed. (Note: core already uses `[`/`]`
  for audio offset ±10 ms — decide whether to override in player scope or pick
  different keys; check `_listShortcuts()` and the help panel for collisions.)
- **T14 — tests.** Node unit test for the semitone→factor math (`2^(n/12)`) and
  offset→cents. Most of the suite already exists in `test/` (DSP, worklet-sync,
  integration — run `node test/*.test.js`); T14 is the explicit math test +
  wiring a `package.json` `test` script (`node --test` or a runner) + pytest
  only if a server fallback route gets added (none yet — `routes.py` is a stub).
- **T15 — docs + PRs.** README install section (mostly done), CHANGELOG, DCO.
  Open 3 PRs to `byrongamatos/*`: plugin (curated list), slopsmith-desktop
  (engine), note_detect. **Then delete the resume cron.**

## How to resume

1. `cd C:\Users\mattr\Desktop\slopsmith-plugin-autotune`
2. Read `PROGRESS.md` (last completed / next task) and this file.
3. Re-create the 5-hour resume cron if you want autonomous continuation
   (it was deleted at pause — see below). Use `CronCreate`, schedule
   `0 */5 * * *`, prompt = the resume prompt in `PLAN.md` §8.
4. Start at T13.

Run the plugin test suite anytime: `node test/*.test.js` (all green at pause).

Rebuild the native addon (only needed if you touch slopsmith-desktop C++):
```
cd ..\slopsmith-desktop
export PATH="/c/Program Files/CMake/bin:$PATH"; export CMAKE_POLICY_VERSION_MINIMUM=3.5
bash scripts/build-audio.sh Release      # ~done in a few min; addon → build/Release/slopsmith_audio.node
```
Run the desktop app: `cd ..\slopsmith-desktop; $env:DLC_DIR="C:\Program Files (x86)\Steam\steamapps\common\Rocksmith2014\dlc"; npm run dev`

## Key decisions (don't re-litigate — rationale in commit messages / NOTICE.md)

- **Web pitch engine**: authored an MIT constant-overlap-add granular AudioWorklet
  (`assets/pitch-shift-worklet.js`) instead of vendoring SoundTouch/rubberband
  (buffer-oriented, can't filter the live `<audio>` stream; license/build). It's
  **inlined in `screen.js` + loaded via Blob URL** because core serves no generic
  plugin-asset route; `test/worklet-sync.test.js` enforces the two copies match.
- **Desktop pitch engine**: signalsmith-stretch (MIT) submodule **pinned to tag
  1.0.0** (self-contained; main needs external signalsmith-linear). Engine reports
  backing position **minus shifter latency** (~120 ms) so the chart stays aligned.
- **Engine selection**: plugin `_engine()` feature-detects
  `window.slopsmithDesktop.audio.setBackingPitchSemitones` → native (preferred),
  else web worklet. On desktop it never taps `<audio>`, sidestepping the conflict
  where `highway_3d` owns `createMediaElementSource`.
- **Coupling ordering**: autotune emits `retune:offset` **deferred** on song load
  (queueMicrotask) so it lands after note_detect's synchronous `song:loaded` clear.

## Caveats / known limitations (carry into T15 README + PR notes)

- **Desktop latency**: ~120 ms added by the shifter; position is compensated but
  the user may still want to nudge the A/V offset when retune is on.
- **Stems on desktop**: native engine has a single backing track, so v1 desktop
  retune covers the backing track only (no separate stem voices).
- **Browser fallback vs 3D Highway**: in Docker/browser, enabling web retune and
  3D-Highway audio-reactivity can't share the `<audio>` source; web retune
  disables gracefully if 3D grabbed it first. Not an issue on desktop.

## Manual verifications still pending (can't run headless)

1. **Web**: pick E♭ in a browser/Docker session → backing drops 1 semitone,
   tempo unchanged.
2. **Desktop**: `npm run dev`, play a CDLC, pick a preset → native backing track
   shifts; confirm `window.slopsmithDesktop.audio.setBackingPitchSemitones` exists.
3. **Full retune**: physically detune guitar to E♭, set E♭ preset, play an
   E-standard chart → note_detect hits score green; tuning badge shows effective
   tuning.

## Resume cron

The 5-hour auto-resume cron (`0 */5 * * *`) was **deleted at pause** so work
doesn't continue unattended. Re-create it from `PLAN.md` §8 when resuming if you
want autonomous continuation; otherwise just start at T13 manually.
