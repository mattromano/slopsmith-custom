# Auto-Tuner (Live Retune) — Build Plan

**Repo:** `slopsmith-plugin-autotune` (this dir, `C:\Users\mattr\Desktop\slopsmith-plugin-autotune`)
**Status:** planned, not started. Track progress in `PROGRESS.md`.
**Scope v1 (locked):** full retune · real-time · semitone presets only (no fine ±cents yet).

---

## 1. What & why

A player control that **pitch-shifts the song in real time** to a target tuning (E / E♭ / D / C# / B …) so you can play along with a detuned guitar. **Full retune** = three things move together at runtime:
1. **Audio** — backing track + stems shift by N semitones, **tempo preserved**.
2. **Highway tuning label** — shows the effective tuning.
3. **note_detect expected pitches** — shift by the same N so detection still scores a detuned guitar.

**Hard rule (Constitution IV):** this is a **runtime overlay only — NEVER rewrite the user's PSARC/DLC files.** That's the key difference from the offline `lib/retune.py` (which repacks a `_EStd_p.psarc`). We do not touch disk.

---

## 2. Architecture — 3 deliverables across 3 repos

| # | Repo | What | Why there |
|---|------|------|-----------|
| **A** | `slopsmith-plugin-autotune` (this) | UI control, persistence, audio-source orchestration, **web pitch-shift worklet**, optional server-side fallback | Constitution III — features ship as plugins |
| **B** | `slopsmith-desktop` (`C:\Users\mattr\Desktop\slopsmith-desktop`) | **Real-time pitch DSP** on the JUCE backing+stems bus + IPC `audio.setBackingPitchSemitones(n)` | Desktop song audio is the native engine (`loadBackingTrack`), not `<audio>` |
| **C** | `note_detect` plugin (`...\slopsmith\plugins\note_detect`) | Consume a `retune:offset` event → shift expected MIDI | "Full retune" needs detection to follow; cross-plugin via `window.slopsmith.emit` |

**Dual audio path (the core complexity, same split note_detect faces):**
- **Desktop (JUCE):** call deliverable B's IPC. Real-time, instant.
- **Web/Docker (`<audio>`):** route `<audio>` → `MediaElementSource` → **SoundTouch/rubberband WASM AudioWorklet** → destination; set the `pitchSemitones` param live. WASM ships as a bundled plugin asset (Constitution II allows it).

Plugin **feature-detects** `window.slopsmithDesktop?.audio?.setBackingPitchSemitones` and uses B when present, else the web worklet.

---

## 3. Constitution compliance (must hold)

- **I (Docker-first):** web path = browser WASM worklet, no new Docker binary. Desktop DSP lives in slopsmith-desktop, not core. ✓
- **II (vanilla FE):** plugin `screen.js` is vanilla; WASM worklet is a bundled plugin asset, no build step in core. ✓
- **III (plugin extension):** routes under `/api/plugins/autotune/...`; backend siblings via `context["load_sibling"]`; `localStorage` keys prefixed `autotune.`; cross-plugin via `window.slopsmith.emit('retune:offset', …)`. ✓
- **IV (no DLC writes):** runtime overlay only. ✓ **Do not call `lib/retune.py`'s repack path.**
- **VI (logging):** backend uses `context["log"]`, never `print`. ✓
- **VII (settings):** per-song offset in prefixed `localStorage`; opt server files into the bundle via `settings.server_files` if any. ✓

License: **MIT** (AGPL-compatible → curated-list eligible). All commits **`git commit -s`** (DCO). PRs to `byrongamatos/*`, feature branches, never `main`.

---

## 4. Cross-component contracts

- **Event (A → C):** `window.slopsmith.emit('retune:offset', { semitones:int, cents:0, tuningName:string })` on change and on song load. note_detect listens, adds `semitones*100` cents to every expected MIDI. Emit `{semitones:0}` to clear.
- **IPC (A → B, desktop):** `window.slopsmithDesktop.audio.setBackingPitchSemitones(n)` — applies to backing + all stem voices. `getBackingPitchSemitones()` for state. `n=0` = bypass.
- **Web worklet (A):** `AudioWorkletNode` param `pitchSemitones`; rebuild graph on song/source change; restore `currentTime` on any source swap.
- **Highway label (A → core, read-only):** overlay a tuning badge; do NOT mutate chart data. If a core hook for the label isn't available, render a small DOM badge in `#player-controls`.

---

## 5. Phased tasks (implement in order; check off in PROGRESS.md)

### Phase 1 — Plugin scaffold (Deliverable A)
- [ ] T1 `plugin.json` (id `autotune`, name "Auto-Tuner", `script: screen.js`, `routes: routes.py`, `settings.html`), `LICENSE` (MIT), `README.md`, `.gitignore`, `git init`.
- [ ] T2 `screen.js` IIFE skeleton: load guard, `window.slopsmith.on('song:loaded'…)`, state object, `localStorage` load/save (`autotune.<songHash>`).
- [ ] T3 UI: a **"TUNE" pill** injected into `#player-controls` (mirror nam_tone's button-injection) → popover with semitone preset buttons (E 0, E♭ −1, D −2, C# −3, C −4, B −5; +1/+2). Reuse `lib/tunings.py` names.

### Phase 2 — Web real-time path (Deliverable A)
- [ ] T4 Vendor a SoundTouch (or rubberband) **AudioWorklet** WASM into `assets/`; document source + license.
- [ ] T5 Build graph: `<audio>` → `MediaElementSource` → worklet → `destination`; `setPitch(semitones)`; teardown/rebuild on song change; **re-seek to saved `currentTime`** after any swap.
- [ ] T6 Wire presets → `setPitch`; persist; auto-apply on load. **Acceptance: pick E♭, song drops 1 semitone, tempo unchanged.**

### Phase 3 — Desktop real-time path (Deliverable B, slopsmith-desktop)
- [ ] T7 Add a real-time pitch shifter to the JUCE backing/stems bus. **Library: signalsmith-stretch (MIT, header-only, realtime)** preferred; SoundTouch (LGPL) fallback. Add as a submodule under `src/audio/third_party/`.
- [ ] T8 IPC: `audio:setBackingPitchSemitones` / `getBackingPitchSemitones` in `audio-bridge.ts` + `NodeAddon.cpp` + preload; apply in the backing render path (and each stem voice).
- [ ] T9 Rebuild: `bash scripts/build-audio.sh Release` (CMake on PATH + `CMAKE_POLICY_VERSION_MINIMUM=3.5`, see slopsmith.md memory). Plugin feature-detects and prefers this path. **Acceptance: same as T6 but through the native engine, instant slider.**

### Phase 4 — Full retune coupling (Deliverable C, note_detect)
- [ ] T10 note_detect: listen for `retune:offset`; add `semitones*100` cents to expected MIDI in the matcher (single + chord paths). Clear on `{semitones:0}` / song change.
- [ ] T11 autotune emits `retune:offset` on every preset change + on song load (re-emit current offset). **Acceptance: detune guitar to E♭, set E♭ preset, play the E-standard chart shapes → hits score green.**
- [ ] T12 Highway tuning badge reflects effective tuning (`tuning_name(base+offset)`).

### Phase 5 — Polish & contribution
- [ ] T13 Keyboard shortcuts (`window.registerShortcut`): `[`/`]` step semitone, `\` reset.
- [ ] T14 Tests: Node unit test for semitone→factor math (`2^(n/12)`) + offset→cents; pytest if a server fallback route is added.
- [ ] T15 README (install: clone into `plugins/`, restart), CHANGELOG, DCO sign-off. Open PRs: plugin (curated list), slopsmith-desktop (engine), note_detect.

### Optional later (NOT v1)
- Fine ±cents slider (worklet param already continuous; just expose UI + finer event).
- Server-side offline fallback reusing `lib/retune.py`'s rubberband for browsers without AudioWorklet.

---

## 6. Acceptance (v1 done when)
1. Semitone presets shift desktop **and** web playback, tempo intact.
2. Highway badge shows the effective tuning.
3. With a physically-detuned guitar + matching preset, note_detect scores correctly.
4. Offset persists per song. No DLC files modified (verify mtimes unchanged).

---

## 7. Kickoff for a fresh context window

Start a new Claude Code session in `C:\Users\mattr\Desktop\slopsmith-plugin-autotune` and paste:

> Read `PLAN.md` and `PROGRESS.md` in this repo. Continue the Auto-Tuner build from the first unchecked task. The three repos are: this plugin, `..\slopsmith-desktop` (JUCE engine, deliverable B), and `..\slopsmith\plugins\note_detect` (deliverable C). Honor the Slopsmith constitution (runtime overlay, never write DLC files). After each task: update `PROGRESS.md`, `git commit -s`. The desktop app launches with `cd ..\slopsmith-desktop && $env:DLC_DIR="C:\Program Files (x86)\Steam\steamapps\common\Rocksmith2014\dlc"; npm run dev` (rebuild the native addon with CMake on PATH + `CMAKE_POLICY_VERSION_MINIMUM=3.5`). First action: set up the 5-hour resume loop in §8.

Key prior context lives in `C:\Users\mattr\.claude\projects\C--Users-mattr\memory\slopsmith.md` (build gotchas, launch commands, plugin layout).

## 8. Auto-resume loop (every 5 hours, for limit resets)

As the **first action** in the implementation session, create a cron so work resumes each time the 5-hour usage window resets:

- Tool: `CronCreate`
- Schedule: every 5 hours (cron `0 */5 * * *`)
- Prompt:
  > Resume Auto-Tuner build. Read `PROGRESS.md` for the last completed task and `PLAN.md` for the task list. Implement the next 1–2 unchecked tasks until done or limit-blocked. After each: check it off in `PROGRESS.md` and `git commit -s`. Do not modify any files under the Rocksmith DLC folder. If all tasks are done, delete this cron.

The loop is **stateful via `PROGRESS.md`** (idempotent — a fire that lands mid-limit just no-ops and the next fire continues). Each run does a small, committed increment so nothing is lost between resets. Delete the cron when Phase 5 completes.
