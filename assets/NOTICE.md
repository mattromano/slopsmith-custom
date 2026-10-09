# Bundled audio assets — provenance & licensing

## `pitch-shift-worklet.js`

- **Source:** original work, written for this plugin.
- **License:** MIT (same as the plugin — see [`../LICENSE`](../LICENSE)).
- **Algorithm:** constant-overlap-add (COLA) granular pitch shifter — a
  time-domain technique using two Hann-windowed read taps over a circular
  buffer, offset by half a window. The read head advances at the pitch ratio
  relative to the write head while output is generated at the real-time rate,
  so **pitch changes and tempo is preserved**. Two Hann windows offset by W/2
  sum to exactly 1.0, eliminating amplitude modulation. This is a textbook
  real-time pitch-shift method (see e.g. Zölzer, *DAFX: Digital Audio Effects*,
  "Time-domain pitch shifting / delay-line modulation").

### Why not vendor SoundTouch / Rubberband?

PLAN.md T4 suggested vendoring a SoundTouch or Rubberband AudioWorklet (WASM).
We evaluated those and chose an original MIT worklet instead:

| Option | Blocker for this plugin |
|---|---|
| [`@soundtouchjs/audio-worklet`](https://github.com/cutterbl/SoundTouchJS) (MPL-2.0) | **Buffer-oriented** — designed to play a fully-decoded `AudioBuffer` through the worklet, not to filter a live `<audio>` → `MediaElementSource` stream. Using it would mean bypassing the `<audio>` element that the highway uses as its playback clock, a large sync/integration risk. Also pulls a multi-package ESM build chain, and MPL adds mixed-licensing to an otherwise-MIT repo. |
| `soundtouchjs` core (LGPL-2.1) | LGPL mixing; same buffered-source design. |
| Rubberband WASM | Requires a WASM build step / vendored binary; heavier than needed for v1 semitone presets. `lib/retune.py` already uses rubberband for the **offline** repack path. |

The Slopsmith Constitution's actual requirement (Principle II) is "the worklet
ships as a bundled plugin asset, **no build step in core**." A pure-JS,
self-authored worklet satisfies that intent better than a vendored WASM blob:
no build step, no binary, no third-party license, and it operates directly on
the live streaming graph the plan describes.

### Upgrade path

The worklet exposes a stable control surface — AudioParam `pitchSemitones`
(k-rate) and a `{ type: 'pitch', value }` port message. A higher-quality engine
(phase vocoder, or a streaming SoundTouch/Rubberband WASM build) can be dropped
in later behind the same interface without touching the main-thread graph code
in `screen.js`.
