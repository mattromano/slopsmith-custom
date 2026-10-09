# Slopsmith Plugin: Drum Highway

![Drum Highway](screenshot.png)

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that replaces the guitar highway with a lane-based drum view, with MIDI drum pad input and a built-in drum kit synthesizer.

## Features

- **3D drum track** (default when the browser has WebGL2) — a perspective highway with four pad lanes, a full-width kick bar, star power, drum fills and a score HUD, scored by the plugin's drums engine (`engine.js`). See [3D view](#3d-view).
- **2D lane view** — the original lane renderer described below, still available (View setting, or automatically without WebGL2)
- **Lane-based drum highway** — 8 horizontal lanes (Hi-Hat, Snare, Tom 1-3, Crash, Ride, Kick) with notes scrolling right to left
- **Kick drum full-width bars** — kick hits render as wide horizontal bars spanning the highway, like open string notes on the guitar highway
- **Distinct note shapes** — circles for toms/snare, diamonds for cymbals, X shapes for hi-hat, full bars for kick
- **Hi-hat variations** — closed (filled X), pedal (small X at bottom), open (ring with "o" inside)
- **Neon glow effects** — each drum piece has a unique color with multi-layer glow
- **Velocity-based sizing** — louder hits are bigger, ghost notes are smaller
- **Auto-activate** — switches on automatically for Drums/Percussion arrangements
- **MIDI drum pad input** — connect any MIDI drum pad, electronic kit, or controller via Web MIDI API
- **Custom MIDI mapping** — "Learn" mode to assign any MIDI note to any lane, for non-standard drum pads
- **Built-in drum sounds** — WebAudioFont-powered GM drum kit playback on MIDI hit
- **Accuracy scoring** — hit detection with tight +/-50ms timing window, accuracy %, streak counter
- **Inline settings** — MIDI device, volume, channel filter, lane labels, hit detection, and mapping table

## 3D view

![3D drum track](docs/highway3d.png)

| Star power ready, fill ahead | Star power active |
|---|---|
| ![fill](docs/highway3d-fill.png) | ![star power](docs/highway3d-sp.png) |

The 3D view is a WebGL renderer (`highway3d.js`, built on the three.js copy that ships with Slopsmith core)
in the style of the classic drum games:

- **Lanes** — red, yellow, blue and green pad lanes plus an orange kick bar across the whole track. Pad
  targets sit on the strikeline at the bottom; the track recedes into the distance.
- **Gems** — snare and toms are flat round "drum head" pucks; cymbals (hi-hat, ride, crash) are raised domes
  with a bell and a ring, floating over a shadow; kicks are wide orange bars, double-bass (2x) kicks are
  magenta with a white stripe. Accents are bigger and brighter, ghost notes smaller and translucent. Missed
  notes go grey and slide past the strikeline.
- **Feedback** — a hit sends a ring flash and sparks up from its pad; a miss or a hit on an empty lane
  (overhit) flashes the lane red. Beat and measure lines scroll with the chart.
- **Star power** — notes in a star power phrase are silver-white. Completing a phrase fills a quarter of the
  meter; at half a meter, drum-fill sections are highlighted in green and the note that ends the fill gets
  a spinning ring: hit it to activate. While active the track edges glow blue and the multiplier doubles
  (up to x8).
- **HUD** — score, star rating (5 stars + gold), accuracy and notes hit, star power meter, note streak and
  the multiplier badge (x1-x4, x8 in star power, with a ring showing progress to the next multiplier).
  Core draw hooks (`window.highway.fireDrawHooks`) run on the HUD canvas, so overlay plugins still work.

Scoring follows the YARG drums rules ported in `engine.js` (hit window ±70 ms, 10 notes per multiplier
step, star power bar of 8 measures, etc.; see the header of `engine.js`). The 2D view keeps its own simple
±50 ms hit counter.

### Choosing the view

The plugin registers one picker entry, **Drum Highway** (`window.slopsmithViz_drums`), which Slopsmith's
**Auto** mode picks for Drums / Percussion arrangements. Each time it creates a renderer it reads the
**View** setting in the drum settings panel (gear button):

- **Auto** (default) — 3D when WebGL2 is available, otherwise 2D.
- **3D** / **2D** — always that view (3D still falls back to 2D without WebGL2).

Changing the setting swaps the renderer in the main player right away; in splitscreen the panels pick it
up the next time their renderer is created. `window.slopsmithViz_drums3d` / `slopsmithViz_drums2d` are
also exported for hosts that want one view regardless of the setting (they are not in the picker).

### Input

- **MIDI kit** — the same device, channel filter and synth as the 2D view. A pad's MIDI note goes through
  your **Learn / custom mapping** if it has an entry (hi-hat → yellow cymbal, snare → red, tom 1/2/3 →
  yellow/blue/green tom, ride → blue cymbal, crash → green cymbal, kick → kick); otherwise the standard
  General MIDI drum map is used (`DrumsEngine.padFromMidi`: 38/37/40 red, 42/46 hi-hat, 48/50 yellow tom,
  45/47 blue tom, 41/43 green tom, 51/53/59 ride, 49/57/55/52 crash, 36/35 kick; the hi-hat pedal 44 is
  ignored). The 2D lane presets do not apply to the 3D view, which always uses the four-lane pro layout.
  Velocity is passed on for accent/ghost bonus points.
- **Keyboard** (setting **Keys**, on by default) — for trying the view without a kit:

  | Key | Pad |
  |---|---|
  | Space or B | kick |
  | F | red (snare) |
  | J / K / L | yellow / blue / green tom |
  | Shift+J/K/L, or U / I / O | yellow / blue / green cymbal |
  | Enter | activate star power (only when the chart has no drum fills) |

  The keys work only while the 3D view is visible and focused (in splitscreen: the focused panel), and not
  while you type in a text field. While Keys is on, **Space is a kick, not play/pause** — use the player's
  play button, or turn Keys off.
- **Offset** (ms) — subtracted from the song time of every hit in the 3D view. Raise it if your hits register
  late (audio output or MIDI latency). Hits that arrive between frames are placed using the current
  playback rate, so timing is not quantised to the frame rate.

### Where star power and fills come from

Star power phrases and drum-fill (activation) windows are not part of the note stream the highway receives.
The converters store them in the Drums arrangement file's top-level `drums` block:

```json
{"drums": {"version": 1, "pro": true, "kick2x": true,
           "star_power": [[12.0, 15.5], [40.2, 44.0]], "fills": [[30.0, 32.0]]}}
```

When a Drums arrangement loads in the 3D view, the plugin fetches `arrangements/drums.json` from the song
through core's sloppak file route (`GET /api/sloppak/<filename>/file/arrangements/drums.json`). If the song
is not a sloppak, the file is missing or it has no `drums` block, the chart plays without star power
phrases (the engine then allows manual activation, but the meter never fills). `pro: false` switches the
engine to non-pro drums (cymbals count as their tom lane).

### Notes and limits

- Seeking (or an A-B loop jumping back) restarts scoring from the new position; notes you skipped are not
  counted as misses.
- The 3D view does not publish a note-state provider (`highway.setNoteStateProvider`): there is one provider
  slot per page and note_detect uses it for guitar charts, so the drums engine keeps its judgments to itself.
- `engine.js` and `highway3d.js` are loaded on first use from `GET /api/plugins/drums/static/<name>`
  (served by this plugin's `routes.py`, whitelisted to those two files); three.js comes from core's
  `/static/vendor/three/three.module.min.js`.

### Development

- `node --test plugins/drums/tests/highway3d.test.js` (also `engine.test.js`, `screen.test.js`; pass one
  file at a time on Node 25) and `python -m pytest plugins/drums/tests/test_routes.py`.
- `tools/preview.html` renders the 3D view with a synthetic chart (`tools/chart.js`) without a server:
  run `python -m http.server 8765` in the repository root and open
  `http://127.0.0.1:8765/plugins/drums/tools/preview.html` (`?scenario=fill|sp`, `?live=1` to play along
  on the keyboard). `tools/screenshot.mjs` regenerates the images in `docs/` with headless Chromium.
- `tools/app.html` runs the real `screen.js` renderer in a stand-in for the player (fake highway, fake MIDI
  domain); serve it with `python plugins/drums/tools/dev_server.py`, which also mounts `routes.py`.
  `node plugins/drums/tools/app-check.mjs` runs an end-to-end check against it (perfect MIDI play, keyboard,
  settings, 2D/3D switching, re-init).

## Drum Lanes

| Lane | Label | MIDI Notes | Color | Shape |
|------|-------|-----------|-------|-------|
| Hi-Hat | HH | 42, 44, 46 | Blue | X |
| Snare | Sn | 38, 40 | Yellow | Circle |
| Tom 1 | T1 | 48, 50 | Green | Circle |
| Tom 2 | T2 | 45, 47 | Orange | Circle |
| Tom 3 | T3 | 41, 43 | Purple | Circle |
| Crash | Cr | 49, 57 | Cyan | Diamond |
| Ride | Ri | 51, 59 | White | Diamond |
| Kick | Ki | 35, 36 | Red | Full-width bar |

## Requirements

- **Chrome or Edge** for MIDI drum pad input (Firefox does not support Web MIDI)
- MIDI features are optional — the drum view works without a MIDI controller (the 3D view can also be played on the keyboard)
- **WebGL2** for the 3D view (any current desktop browser); without it the plugin uses the 2D view

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/got-feedback/feedback-plugin-drums.git drums
docker compose restart
```

The restart matters: the plugin's `routes.py` (which serves the 3D view's modules) is loaded at server start.

A "Drums" button will appear in the player controls when you play a song. Click the gear icon next to it to configure MIDI input and sound settings.

## How It Works

The plugin reads note data from the highway renderer and maps them to drum lanes. Notes use the MIDI encoding convention `midi = string * 24 + fret`, which the [editor plugin](https://github.com/got-feedback/feedback-plugin-editor) uses when importing drum tracks from Guitar Pro files.

### MIDI Drum Pad

Connect a USB MIDI drum pad or electronic kit and select it from the settings panel. Play along and get real-time visual feedback:

- **Lane flash** — the lane lights up when you hit the correct drum piece
- **Green notes** — correctly hit notes within the timing window
- **Red flash** — wrong drum piece or no matching note
- **Gray notes** — missed notes that passed the now line

### Custom Mapping

Different drum pads send different MIDI note numbers. Use the "Learn" mode in settings to remap:

1. Open settings and expand "MIDI Mapping"
2. Click "Learn" next to a lane (e.g., Snare)
3. Hit the pad you want to assign to that lane
4. The MIDI note is saved to that lane

Click "Reset Map" to return to standard GM mapping.

## License

MIT, except `engine.js` and `tests/engine.test.js`, which are LGPL-3.0 ports of YARG.Core; see
[NOTICE.md](NOTICE.md).
