# Analysis — NAM Tone Engine

## Coverage

| Spec area | Implementation | Notes |
|---|---|---|
| FR-001 (schema) | `_get_conn` | OK; both tables created on first connect. |
| FR-002 (models CRUD) | `list_models / upload_model / delete_model` | OK; no validation on upload (any extension stored if it's `.nam`). |
| FR-003 (IRs CRUD + FFmpeg) | `upload_ir` | OK; raw-bytes fallback; 30 s timeout. |
| FR-004 (presets CRUD + cascade) | preset routes | OK; manual cascade. |
| FR-005 (mappings CRUD) | mapping routes | OK; `(filename, tone_key)` unique. |
| FR-006 (song-tones) | `get_song_tones` | **DRIFT** — does not handle sloppaks. |
| FR-007 (`/file/...`) | `serve_file` | OK; MIME types informational. |
| FR-008 (`/worklet/...`) | `serve_worklet` | OK; walks `worklet/` then `wasm/`. |
| FR-009 (WAL + lock) | OK. |
| FR-010 (signal chain) | `screen.js` | OK; matches README diagram. |
| FR-011 (100 ms tone polling) | `screen.js` | OK. |
| FR-012 (stem ducking) | `screen.js` | OK; toggleable. |

## Drift

1. **Sloppak handling on `/song-tones`** — the route doesn't
   short-circuit; will 500 / raise on sloppak input. T307. Sibling
   plugin `midi_amp` has the right pattern.
2. **README's mapping example shows separate Bank MSB / Bank LSB /
   Program columns** — that's actually from the `midi_amp`
   plugin's README. This plugin's README is correct on that score
   (no mention of MIDI), but the two READMEs share confusing
   tooling-adjacent content. Worth a stylistic pass at some point.
3. **`screen.js` is 912 lines** with no internal section markers
   visible from the head. Future audits would benefit from
   `// ── SECTION ──` separators.

## Gaps

1. **No upload validation**: `upload_model` accepts any filename and
   any payload as a model. A malformed `.nam` will only fail later
   when the worklet tries to load it. Consider a header check on
   upload (the first ~256 bytes of a `.nam` are JSON-parsable).
2. **No tests** in repo. Backend is straightforward to test; the
   signal chain is harder.
3. **No CPU-load indicator** on the AMP UI — users on weaker
   machines have no signal to switch to a smaller model.
4. **WASM rebuild instructions** are in README but no CI rebuild;
   the binary artefacts in `wasm/` are essentially black boxes
   from a maintenance standpoint.
5. **Latency offset is exposed as a setting but is per-user** —
   could it be auto-measured (loopback test) instead?
6. **No way to share a preset between Slopsmith installs** other
   than re-uploading model + IR + reconfiguring mapping.

## Recommendations

1. **Fix T307** — early-return `{tones: []}` for sloppaks.
2. **Add a basic header check on `.nam` upload** to reject obviously
   malformed files before they hit the worklet.
3. **Add backend tests** (pytest with tmp `config_dir`).
4. **Consider a CPU-load HUD** in the player — a single % readout
   based on the worklet's `process()` time would help a lot.
5. **Document that `wasm/nam-core.{js,wasm}` are committed
   binaries** and link to the rebuild command for reproducibility.
6. **Future**: a "preset export" route that dumps preset JSON +
   embedded IR/model file references would let users share presets
   between installs.
