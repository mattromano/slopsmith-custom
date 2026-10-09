# Implementation Plan — NAM Tone Engine

## Files

- `plugin.json` — id `nam_tone`, screen + script + settings + routes.
- `routes.py` (285 lines) — backend.
- `screen.html` (103 lines) — config screen UI.
- `screen.js` (912 lines) — signal chain, tone switching, stem
  ducking, UI logic.
- `settings.html` (78 lines) — inline settings panel template.
- `worklet/nam-processor.js` — `AudioWorkletProcessor` running NAM
  inference via WASM.
- `wasm/nam-core.{js,wasm}` — Emscripten-built NAM core
  (single-threaded, `ALLOW_MEMORY_GROWTH=1`, `FILESYSTEM=0`,
  exports `_nam_create / _destroy / _load_model / _process /
  _is_loaded`). Build command in `README.md`.

## Backend

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/plugins/nam_tone/models` | GET | List `.nam`. |
| `/api/plugins/nam_tone/models` | POST | Upload `.nam`. |
| `/api/plugins/nam_tone/models/<name>` | DELETE | Remove `.nam`. |
| `/api/plugins/nam_tone/irs` | GET | List IRs. |
| `/api/plugins/nam_tone/irs` | POST | Upload IR; FFmpeg-normalise. |
| `/api/plugins/nam_tone/irs/<name>` | DELETE | Remove IR. |
| `/api/plugins/nam_tone/presets` | GET | List presets. |
| `/api/plugins/nam_tone/presets` | POST | Upsert preset (UNIQUE name). |
| `/api/plugins/nam_tone/presets/<id>` | DELETE | Cascade delete. |
| `/api/plugins/nam_tone/mappings/<filename>` | GET/POST | Per-song mappings. |
| `/api/plugins/nam_tone/mappings/<id>` | DELETE | Remove. |
| `/api/plugins/nam_tone/song-tones/<filename>` | GET | PSARC tone walk. |
| `/api/plugins/nam_tone/file/<type>/<name>` | GET | Serve uploaded model / IR back to browser. |
| `/api/plugins/nam_tone/worklet/<filename>` | GET | Serve `worklet/*` and `wasm/*`. |

### Schema

```sql
CREATE TABLE presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  model_file TEXT,
  ir_file TEXT,
  input_gain REAL DEFAULT 1.0,
  output_gain REAL DEFAULT 0.5,
  gate_threshold REAL DEFAULT -60.0,
  settings_json TEXT DEFAULT '{}'
);
CREATE TABLE tone_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  tone_key TEXT NOT NULL,
  preset_id INTEGER NOT NULL,
  UNIQUE(filename, tone_key),
  FOREIGN KEY (preset_id) REFERENCES presets(id)
);
```

### Setup

```python
def setup(app, context):
    config_dir = context["config_dir"]
    _db_path = config_dir / "nam_tone.db"
    _models_dir = config_dir / "nam_models"
    _irs_dir = config_dir / "nam_irs"
```

### IR normalisation

```bash
ffmpeg -y -i <upload> -ar 48000 -ac 1 -c:a pcm_f32le <dest>
```
30 s timeout; falls back to raw bytes on failure.

## Frontend

### Signal chain (screen.js)

```
getUserMedia(deviceId, channelCount=2)
  → ChannelSplitterNode
  → input GainNode
  → AudioWorkletNode (nam-processor)
       └ on message: load WASM module, decode .nam, init runtime
       └ process(inputs, outputs): WASM run + noise gate
  → ConvolverNode (IR buffer from /file/ir/<name>)
  → output GainNode
  → AudioContext.destination
```

### Tone switching

- 100 ms `setInterval` reads `highway.getToneChanges()`.
- On change: look up `(filename, tone_key)` in mappings, fetch
  preset by id, post a `loadModel` message to the worklet, swap the
  ConvolverNode's `buffer` to the new IR (lazily fetched and cached).

### Stem ducking

- On AMP enable on a sloppak song: read current guitar-stem
  volume, store, set to 0.
- On disable: restore.
- Toggleable in settings (`auto_mute_guitar_stem`).

### Settings panel

Inline `settings.html` template. Persists per-browser settings
(input device, channel, gain values, gate, latency offset, stem
ducking) via `localStorage`. Some settings (preset definitions,
mappings) are server-side and don't live in `localStorage`.

## Integration with Slopsmith Core

- `setup(app, context)` with `config_dir` and `get_dlc_dir`.
- PSARC parsing via shared `psarc.read_psarc_entries`.
- Highway hooks: `getToneChanges()`, stem volume control (assumed
  via the existing stems plugin's surface).
- Player controls: AMP button injection.

## Out of Scope

- Multi-threaded WASM.
- Full DAW post-chain.
- Wet recording (delegated to `multiplayer` or external loopback).
- Tests — none in repo.
