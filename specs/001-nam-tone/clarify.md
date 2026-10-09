# Clarifications — NAM Tone Engine

## Q1. Why single-threaded WASM (no SharedArrayBuffer)?

**A.** SAB requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers on every
response. Slopsmith's docker setup doesn't ship those headers, and
adding them would break embedded iframes / third-party scripts. NAM
inference fits in a regular `AudioWorkletProcessor` thread on
modern CPUs at acceptable latency, so single-threaded is the
pragmatic choice.

## Q2. Why does IR upload normalise via FFmpeg?

**A.** `decodeAudioData` in browsers is picky about WAV variants
(non-standard chunks, 24-bit PCM, ADPCM, etc.) and silently fails
on a surprising fraction of "real-world" IR files. Re-encoding to
PCM float32 / 48 kHz / mono guarantees `ConvolverNode` will accept
it. Falls back to raw bytes if FFmpeg fails or times out (30 s) —
better to ship the file and have the user troubleshoot than reject
the upload.

## Q3. What happens if I run `/song-tones` against a sloppak?

**A.** Currently the route does not pre-check `is_sloppak`. It
forwards the path to `read_psarc_entries`, which will raise on the
sloppak's magic bytes. The frontend likely surfaces a generic
"File not found" or 500. The `midi_amp` sibling plugin handles this
better (returns `{tones: []}`); this plugin should match. Treating
as a [NEEDS CLARIFICATION] / drift item.

## Q4. Why does `GET /file/model/...` claim
`application/json`?

**A.** `.nam` files are JSON-with-binary-tensors at the top level —
the file extension is `.nam` but the bytes are JSON. The MIME type
is informational; the browser fetches them as ArrayBuffer regardless.

## Q5. Why poll tone changes at 100 ms instead of subscribing to a
song-bus event?

**A.** Slopsmith's player exposes `highway.getToneChanges()` as a
synchronous accessor; there is no event for tone boundaries. 100 ms
is a comfortable trade-off — fast enough that a tone-change feels
"on the beat", slow enough that the polling cost is invisible
(<0.1 % CPU on a modern machine).

## Q6. Why is preset deletion a manual cascade?

**A.** SQLite enforces foreign keys only when `PRAGMA
foreign_keys = ON` is set per connection — and the connection here
does not. Rather than depend on a runtime PRAGMA, `delete_preset`
explicitly removes dependent `tone_mappings` first. Same effect, no
hidden runtime requirement.

## Q7. Why does the plugin serve worklet + wasm via a custom route?

**A.** The plugin loader serves only the files referenced by
`plugin.json` — `screen.html`, `screen.js`, `settings.html`,
`routes.py`. The WASM core and the worklet processor are loaded by
the worklet/`AudioWorklet` machinery from URLs, so they need an
HTTP endpoint. The `/worklet/<filename>` route walks `worklet/`
then `wasm/` (in that order) and returns the right MIME type.

## Q8. Why mute (not gate) the guitar stem when AMP is active?

**A.** A gate would let the original recording leak through during
silences in the user's playing. Hard mute is the cleanest UX —
the user expects "I'm playing through the amp now" to mean their
playing replaces the recording's guitar entirely.
