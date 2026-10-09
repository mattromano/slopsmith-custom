# Tasks — NAM Tone Engine

## US1 — Play through NAM in browser (P1)

- [DONE] T101 WASM build + bundled artefacts under `wasm/`.
- [DONE] T102 `worklet/nam-processor.js` AudioWorkletProcessor.
- [DONE] T103 `screen.js` signal chain wiring.
- [DONE] T104 `/file/<type>/<name>` route to serve assets back to
  browser.
- [DONE] T105 `/worklet/<filename>` route to serve worklet + wasm
  with correct MIME types.
- [DONE] T106 Input gain / output gain / noise-gate threshold
  exposed.

## US2 — Auto-switch on tone change (P1)

- [DONE] T201 100 ms tone-change polling.
- [DONE] T202 Worklet `loadModel` message protocol.
- [DONE] T203 ConvolverNode buffer hot-swap.
- [DONE] T204 IR buffer cache to avoid re-fetching on every swap.

## US3 — Manage models, IRs, presets, mappings (P1)

- [DONE] T301 Schema (presets + tone_mappings).
- [DONE] T302 Models CRUD.
- [DONE] T303 IRs CRUD with FFmpeg normalisation + raw-bytes
  fallback.
- [DONE] T304 Presets CRUD with manual cascade on delete.
- [DONE] T305 Mappings CRUD.
- [DONE] T306 Song-tones via PSARC JSON walk.
- [OPEN] T307 [P] Sloppak handling for `/song-tones` — currently
  the route does not check `is_sloppak`, will hand sloppak bytes to
  `read_psarc_entries` which raises. Mirror `midi_amp`'s approach
  (early-return `{tones: []}`). See clarify.md Q3.

## US4 — Stem ducking (P2)

- [DONE] T401 Save / restore guitar stem volume on AMP toggle.
- [DONE] T402 Settings flag to disable.

## US5 — Settings panel (P2)

- [DONE] T501 Input device picker.
- [DONE] T502 Channel selector (mono / L / R).
- [DONE] T503 Latency offset.
- [DONE] T504 Gate threshold.

## Cross-cutting

- [DONE] T601 SQLite WAL + write lock.
- [OPEN] T602 [P] Tests — no test harness in repo. Backend lends
  itself to pytest (in-memory DB + tmp upload dirs); the frontend
  signal chain is hard to unit-test without a Web Audio harness.
- [OPEN] T603 [P] Multi-threaded WASM build option (would require
  COOP/COEP headers in Slopsmith; out-of-scope per constitution).
- [OPEN] T604 [P] ToneHunt model browser — direct download into
  `nam_models/` instead of upload.
- [OPEN] T605 [P] Wet output recording (likely belongs in a
  sibling plugin).
- [OPEN] T606 [P] CPU-load indicator (helps users on weaker
  machines pick smaller models).
