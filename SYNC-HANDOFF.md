# Sync handoff: guitar + drums + split view (2026-10-10, Windows PC)

Read `DRUMS-HANDOFF.md` first for how Matt's setup runs (the installed Slopsmith desktop 0.2.9 app; our
plugins are user plugins in `%APPDATA%\slopsmith-desktop\plugins\<id>`, copied there from this repo; Ctrl+R
reloads JS, `routes.py` changes need an app restart; commit and push straight to `main`; never push the
`Desktop\slopsmith` fork, whose origin is upstream).

## GOAL (paste as the session goal)

> Make song audio, guitar note detection and drums **perfectly in sync**, Rock Band-LAN tight, in
> **split view first**, then in LAN multiplayer and single-player. Specifically:
> 1. **Auto-sync that actually works:** a guided calibration that measures and sets, per machine,
>    (a) the A/V offset (picture vs sound), (b) guitar input latency (Note Detection `latencyOffset`) and
>    (c) drums input offset (`drums_input_offset_ms`), and keeps them right during play.
> 2. **Suggested offsets for both guitar and drums, also in split view and multiplayer** (per panel /
>    per player), with one-click Apply.
> 3. **Split view is the priority:** two players (guitar + drums, or two guitars) on one machine, each
>    judged on the same song clock, both feeling dead-on.
> 4. **Drums must feel like Clone Hero:** find and close every source of the gap (input timing, hit
>    window, highway clock smoothness, pad sound latency), and give the kits much fuller, less "2D"
>    sound (better samples, stereo room/ambience, velocity layers, mixing).
> Verify everything with measurements (logged judgments, timestamps, test harnesses), not by feel alone.
> Never play song audio in browser-pane tests (seek while paused, or silence Web Audio output).

## Overnight session 2026-10-10: what changed (read this first)

All measured with `tools/sync-bench/` (headed Edge launched by Playwright with `--mute-audio`, so songs really
play but nothing reaches the speakers; server `sync-test` on :8003 uses a scratch copy of the AppData plugins).
Everything is committed to `main` and deployed to `%APPDATA%\slopsmith-desktop\plugins` (drums 5.14.0,
highway_tweaks 1.20.0, multiplayer 1.1.0, **new sync_lab 1.0.0**). **Restart the app** (new plugin + routes).

**Found and fixed (numbers are before → after):**
1. Drum highway drew from the 60 Hz `bundle.currentTime` sample: per-frame step error sd 3.67 ms, p95 13 ms
   (visible judder) → sd 0.09, p95 0.16 (frame-exact clock, `__hwtFrameTime`).
2. **Split view never applied the A/V offset** to panel highways (core only sets it on the main highway) and
   panels mixed in the main highway's timer: at A/V +30 the drum panel drew at −8 ms (sd 3.8), the guitar 3D panel
   at 0 ms (sd 4.8) → both +30.03 (sd 0.05). Split-view drum hits were judged −29.6 ms (sd 4.3) → 0.0 ± 0.07.
3. Drum engine clamped back-dated hits to the frame time (YARG QueueInput): +9 ms late bias + up to a frame of
   jitter → engine now trails the frame clock by 60 ms; hits keep their MIDI strike time.
4. **Pad sounds reach the ears ~50 ms after the stick** (Web Audio on the Realtek output: 10 ms buffer + 40 ms
   device, plus up to a frame of main-thread delay). Matt's app uses the SB Live! GM kit at the default volume.
   Clone Hero plays no pad sounds (you hear the module). Fix options on the Sync screen: "Pad sounds off" + plug
   the PC's headphone out into the module's AUX IN and wear headphones on the module.
5. Drum sounds were "2D": SB Live! was mono (L/R correlation 1.00), bone dry. New drum bus: per-piece panning for
   the GM kits, stereo convolution room (generated IR), low shelf + presence, **Room** setting (default 35 %), no
   added delay on the dry path → snare correlation 0.59, room tail −24 → −14 dB.
6. Multiplayer: guests ignored transit time and output latency and never corrected < 50 ms; its ±0.2 % speed
   nudges toggled the stems pitch worklet (any rate ≠ 1 engages it, adding its buffering delay). Now: host clock
   stamps + output-latency difference, min-RTT clock sync with re-syncs, seek-only correction (> 30 ms for 3
   heartbeats, learned seek lead; stems play/seek freezes the clock 120–160 ms). Two browsers on one PC:
   −6..−9 ms steady (sd 0.07), knocked 80 ms off → back in ~1 s. (The Mac needs the same plugins for this.)
7. highway_tweaks stems patch: speed changes re-anchored on the coarse `ctx.currentTime` (±5 ms clock-vs-audio
   jump per speed change) → anchored on the precise clock.
8. **MIDI**: at session start the Alesis was visible to WinMM again (Unicode call OK), but later the kit
   **powered itself off** (gone from Device Manager), so the browser couldn't be re-checked with it on. New
   fallback in drums: **direct MIDI input** (`native_midi.py`, WinMM ANSI via ctypes → loopback WebSocket with
   driver timestamps). Shown as "Alesis Drum Module · direct" in the MIDI list when Web MIDI doesn't list the
   kit. Verified with a fake input only (40/40 hits judged, stamps within a 2 ms window).

**New: Sync Lab (nav → Plugins → Sync).** Guided calibration through the real player (works in split view, one
result per panel): a 64 s "Sync Calibration" song (written into the library as
`sloppak/_Sync_Calibration_v2.sloppak`): Listen (screen black, play by ear) → Watch (no clicks) → Play. Ear vs eye
gives the A/V offset; eye gives each player's input offset (guitar latency for every detector, drums input
offset). Results card with Apply / Apply all; logged to `plugins/sync_lab/sync_log.jsonl` with every raw sample.
**A/V auto-follow**: if Web Audio's output latency changes (other headphones), the A/V offset moves with it.
Simulated end to end (drummer + guitarist with known latencies): suggestions match the model within ~3 ms and
converge to ±3 ms after Apply all.

**For Matt in the morning (needs a human):**
1. Restart Slopsmith. Turn the kit on (it auto-powers off); check Plugins → Drums shows it (Web MIDI or "· direct").
2. Plugins → Sync → **Split: guitar + drums** (or Drums / Guitar alone). Play the three parts honestly (eyes
   really closed in Listen), then **Apply all**. Run it again to confirm it says "already right".
3. Decide on pad sound: try "Pad sounds off" + module AUX IN; else try kit Crocell and Room 35 %.
4. Analyse `sync_lab/sync_log.jsonl` and `highway_tweaks/jank_log.jsonl` (judgments) after a few songs.

**Still open:** real-kit timing check (needs hits), guitar detection delay of the native engine (Sync Lab measures
it in place), the 2D drum view still judges on the frame time (3D view is the default), per-panel guitar latency is
one shared Note Detection setting, multiplayer test across two real machines (Mac needs the new plugins).

## Where things stood before the overnight session

### Clocks: how time flows
- **Song clock:** core `static/highway.js` `setTime(t)` is driven by app.js's 60 Hz tick from
  `_audioTime()` (the `<audio>` element, shimmed by the **stems** plugin's Web Audio transport for
  sloppaks). The render clock is `bundle.currentTime = chartTime + avOffset`.
- **highway_tweaks patches** (`plugins/highway_tweaks/screen.js` PATCHERS):
  - `stems`: precise playhead from `ctx.getOutputTimestamp()` (was ~10 ms steps);
  - `highway_3d`: `smoothNow` reads that clock at draw time (frame-exact) instead of the 60 Hz sample;
  - `hw.setTime` is wrapped to record `window.__hwtLastSetT`.
  The JUCE smoothing path is **disabled** (Matt's songs play via HTML5/stems, `_juceMode` false).
- **Split view** (bundled `plugins/splitscreen/screen.js`): one `<audio>`, every panel gets
  `p.hw.setTime(audio.currentTime)` at 60 Hz (`startTimeSync` ~SS:2275). Each panel has its own highway,
  renderer, and Note Detection instance (`createNoteDetector({highway, container, channel})`).
- **Multiplayer** (`plugins/multiplayer`): NTP-style clock sync + heartbeat drift correction by
  playbackRate (`_doClockSync` ~MP:3795, `_onHeartbeat` ~MP:3903). One player per window/machine.
  It has no per-player offset calibration and no shared scoring.

### Offsets that exist (all per browser profile)
| Offset | Where | Meaning |
|---|---|---|
| **A/V offset** | core player-bar slider, `/api/settings av_offset_ms` (global) | + = audio plays ahead of visuals; shifts the render clock |
| **Guitar latency** | Note Detection `latencyOffset` (s), localStorage `slopsmith_notedetect` | subtracted from detection time |
| **Drums input offset** | `drums_input_offset_ms` (−250..250) | subtracted from each drum hit's song time |

Important: Note Detection judges against the **visual** clock (`hw.getTime() + avOffset − latencyOffset`),
so a wrong A/V offset cancels out for a player following the highway. Judgments alone can't separate A/V
from input latency. The highway_tweaks timing meter has an "A/V check" (play ~12 notes by ear, eyes off
the highway: ear-vs-eye median difference → A/V suggestion). See the long comment at the timing gauge
(section 4) and the agent analysis summarised there.

### Matt's numbers (from `%APPDATA%\slopsmith-desktop\plugins\highway_tweaks\jank_log.jsonl`, kind "judgments")
- With **A/V +24 ms, guitar latency 0**: ~1,150 hits across 5 songs, median timing error **0 ms**. Recommended
  keeping A/V at +24. He later moved it to −13 (Accidentally in Love, Uptown Girl), and the gems "feel off".
- The log also has per-string engine verdicts (`verdicts`: heard?, cents, SNR) since highway_tweaks 1.12.1.
- Chord misses: Chord Leniency was 0.40, and 1-of-3 / 2-of-6 strings heard failed. Recommended 0.30.

### Drums: what was done this session (drums 5.6–5.10)
- Rock Band look, bonus score, end card, drum solos, early/late **timing meter** in the 3D HUD (last 24 hits,
  median, suggested Input offset + Apply; `session.getBonus().offsets`, `view.timingRect`).
- **Hit timing rewrite (5.10.1, untested with the real kit):** hit song time = `audio.currentTime + _audioOff
  − (now − MIDIMessageEvent.timeStamp)`, where `_audioOff = bundle.currentTime − __hwtLastSetT` from the last
  frame; falls back to `H.estimateTime(_clock, now)`. The Web MIDI shim now passes `e.timeStamp`.
  Code: `screen.js` `_inputTime(ts)`, `_handleDrumHit(note, vel, ts)`, shim `onmidimessage`.
- Split view: hits route to the on-screen drum panel (`_routeTarget`), per-panel difficulty picker,
  plain "Drums" auto-opens the Drum Highway, `window.__drumsPanelResults`, `window.__drumsDebug`
  (`midi([0x99,38,100])`, `routeTarget()`).
- Engine: `engine.js` (LGPL YARG port), hit window presets (Relaxed ±130 / Forgiving ±100 / Normal ±70 /
  Precision), `session.setParams`.
- Sounds: WebAudioFont GM kits + sampled kits (**crocell** default, **virtuosity**), built by
  `tools/build_sample_kit.py` (4 velocity layers × 2 round-robins, Ogg). AudioContext `latencyHint: 'interactive'`.
  There is a separate **pad volume** (can be 0 so the Alesis module makes the sound) and auto-note volume.

### Known open problems (start here)
1. **Kit not listed in the MIDI dropdown (Windows):** the Alesis is connected and free, but WinMM's Unicode
   `midiInGetDevCapsW` / `midiOutGetDevCapsW` return `MMSYSERR_BADDEVICEID` for it (ANSI works; built-in synth
   works). Chromium enumerates with the W call, so it drops the device. It's routed through the **Windows MIDI
   Service** (`MidiSrv.exe`, updated 2026-09-09). Asked Matt to re-plug the kit / restart the service / reboot.
   If it persists: MIDI-OX → loopMIDI bridge (both installed), or a native MIDI helper (Python routes.py
   reading WinMM ANSI / rtmidi and forwarding over a WebSocket with timestamps). The PowerShell P/Invoke
   check used this session lives in the transcript; easy to rewrite (midiInGetNumDevs + GetDevCapsA/W + midiInOpen).
2. **Drums feel worse than Clone Hero.** Candidates to measure:
   - input-to-judgment latency and jitter (now timestamp-based; verify with the real kit);
   - the drum highway clock: it uses `bundle.currentTime` per frame (+ `estimateTime`), not the frame-exact
     `smoothNow` highway_3d gets: gems may judder or lag;
   - pad sound latency through Web Audio (`outputLatency`); Clone Hero plays samples with tiny buffers;
   - hit window and engine leniency vs CH;
   - visual A/V: the drum view uses the same render clock (A/V offset).
3. **Drum tones "too 2D":** the current samples are dry close-mic'd mono-ish kits. Ideas: stereo overheads +
   room mics in the sample build (DrumGizmo kits have multitrack: DRSKit / MuldjordKit are CC BY 4.0 but
   multi-GB, so mix our own stereo with room), convolution reverb (a small room IR), per-piece panning like a
   kit image, cymbal decay and choke, better velocity curves. Licences go in `plugins/drums/NOTICE.md`.
4. **Split view sync:** both panels get `audio.currentTime` at 60 Hz (not frame-exact). Each panel's Note
   Detection judges on its own highway clock. There is one latency/offset set for all panels (global
   settings): no per-player calibration. Per-panel score boxes exist (highway_tweaks `scoreEngineFor`,
   `window.__hwtPanelScores`) and the results card (section 8).
5. **Multiplayer:** clock sync exists, but no per-player offsets/calibration and no shared results.

## Testing tools
- `.claude/launch.json` in `C:\Users\mattr\Desktop\repos`: `installed-app-test` (installed core on :8002, Matt's
  AppData plugins, scratch config) and `drums-harness` (`plugins/drums/tools/dev_server.py` :8766,
  `tools/app.html?view=auto&paused=1`, `window.__harness.setTime/play/frame`).
- **Never play song audio** (Matt hears it in his headphones). Silence first:
  `AudioNode.prototype.connect` drop-to-destination patch + mute media elements; drive time by seeking while paused.
- The browser pane only renders frames during a screenshot; `requestAnimationFrame` stalls when hidden.
- Note Detection headless harness: `plugins/notedetect/tools/harness.js` (JS path only; the desktop engine
  verifier is native and not reproducible offline).
- Matt's live app has no reachable DevTools port (the `DevToolsActivePort` file is stale).
- Drums tests: `node --test plugins/drums/tests/<file>.test.js`.

## Versions at handoff
highway_tweaks 1.17.0 · drums 5.10.1 · play_queue 1.0.1 · play_counts 1.3.0 (main @ c3e9272 + this doc).
After the overnight session: highway_tweaks 1.20.0 · drums 5.14.0 · multiplayer 1.1.0 · sync_lab 1.0.0.
