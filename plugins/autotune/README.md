# Auto-Tuner (Live Retune) — Slopsmith plugin

Pitch-shift the song in real time to a target tuning (E / E♭ / D / C# / C / B …)
so you can play along with a **physically detuned guitar** — without ever
touching your PSARC/DLC files on disk.

This is a **runtime overlay** (Slopsmith Constitution IV): nothing is repacked
or written back to the library. It is the live, non-destructive counterpart to
the offline `lib/retune.py` repack path.

## What "full retune" does

Picking a tuning moves three things together at runtime:

1. **Audio** — the backing track + stems shift by N semitones, tempo preserved.
2. **Highway tuning label** — a badge shows the effective tuning.
3. **note_detect expected pitches** — shifted by the same N, so detection still
   scores correctly against your detuned guitar.

## Dual audio path

The plugin feature-detects the host:

- **Desktop (slopsmith-desktop / JUCE):** calls the native engine IPC
  `window.slopsmithDesktop.audio.setBackingPitchSemitones(n)` — real-time, instant.
- **Web / Docker (`<audio>`):** routes the element through a bundled
  pitch-shift `AudioWorklet` (WASM) — `<audio>` → `MediaElementSource` →
  worklet → `destination`.

Cross-plugin coupling to note_detect is via the event bus:
`window.slopsmith.emit('retune:offset', { semitones, cents: 0, tuningName })`.

## Scope (v1)

Full retune · real-time · **semitone presets only** (no fine ±cents yet).

## Install

This plugin is its own git repo. Clone it into your Slopsmith `plugins/` folder
and restart:

```bash
cd slopsmith/plugins
git clone <this-repo-url> autotune
# restart Slopsmith (docker compose restart, or relaunch the desktop app)
```

The desktop app loads user plugins from
`%APPDATA%\slopsmith-desktop\plugins\` — clone there for the native engine path.

## Constitution compliance

- **I** web path is browser WASM (no new Docker binary); desktop DSP lives in
  `slopsmith-desktop`, not core.
- **II** `screen.js` is vanilla JS; the WASM worklet is a bundled plugin asset.
- **III** routes under `/api/plugins/autotune/...`, `localStorage` keys prefixed
  `autotune.`, cross-plugin via `window.slopsmith.emit/on`.
- **IV** runtime overlay only — **never** writes DLC files.
- **VI** backend uses `context["log"]`, never `print`.
- **VII** per-song offset persisted in prefixed `localStorage`.

## License

[MIT](LICENSE) — AGPL-compatible (curated-plugin eligible).
