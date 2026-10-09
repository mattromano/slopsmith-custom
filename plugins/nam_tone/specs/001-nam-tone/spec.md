# Feature Specification: NAM Tone Engine

**Feature Branch**: `001-nam-tone`
**Created**: 2026-05-09 (retrospective)
**Status**: Implemented (v1.0.0)
**Input**: `README.md`, `routes.py`, `screen.html`, `screen.js`,
`settings.html`, `worklet/nam-processor.js`, `wasm/nam-core.{js,wasm}`.

## User Scenarios & Testing

### User Story 1 — Play through a NAM model in the browser (P1)

As a guitarist with a USB audio interface, I want to plug in, click
AMP, and hear my guitar processed through a Neural Amp Modeler model
+ cabinet IR running entirely in my browser, with no external software.

**Why this priority**: Headline feature.

**Independent Test**: Upload a `.nam` model and a `.wav` IR. Create a
preset combining them. Pick the input device in settings. Open a
song, click AMP. Strum — confirm processed signal at the output
within the latency budget.

**Acceptance Scenarios**:

1. **Given** a saved preset with a model + IR, **When** AMP is
   engaged, **Then** `getUserMedia` opens the configured device,
   the AudioWorklet runs WASM inference, the ConvolverNode applies
   the IR, and processed audio reaches `AudioContext.destination`.
2. **Given** the user adjusts input gain, **When** the slider
   moves, **Then** the gain node updates without dropping audio.
3. **Given** the noise gate threshold is crossed below, **When**
   input falls quiet, **Then** the worklet attenuates output
   correspondingly.

---

### User Story 2 — Auto-switch presets on tone change (P1)

As a player, I want my preset to switch automatically when the song
crosses a tone boundary (Clean → Distortion → Lead) so I don't need
to manage it manually.

**Acceptance Scenarios**:

1. **Given** the song has tones with mappings, **When**
   `highway.getToneChanges()` reports a new active tone, **Then**
   the worklet loads the new model and the ConvolverNode buffer
   swaps to the mapped IR within ~200 ms.
2. **Given** a tone has no mapping, **When** the song hits that
   tone, **Then** the previous preset is held (no silence).

---

### User Story 3 — Manage models, IRs, and presets (P1)

As a user, I want a config screen where I upload `.nam` and `.wav`
files, build presets that combine them with gain / gate settings,
and assign presets to song tones.

**Acceptance Scenarios**:

1. **Given** the user uploads a `.nam` file, **When** the upload
   POST returns, **Then** the file is on disk under
   `<config_dir>/nam_models/` and listed by `GET /models`.
2. **Given** the user uploads a `.wav` IR, **When** the upload
   completes, **Then** the file is normalised to PCM float32 /
   48 kHz / mono via FFmpeg before storage. (Falls back to raw
   bytes if FFmpeg fails.)
3. **Given** the user deletes a preset, **When** the DELETE fires,
   **Then** all `tone_mappings` referencing it are removed first
   (FK cascade is manual, see `delete_preset`).
4. **Given** a sloppak song, **When** `/song-tones` is called,
   **Then** a `404`/file-not-found error short-circuits cleanly.
   [NEEDS CLARIFICATION: unlike the `midi_amp` plugin which
   returns `{tones: []}` for sloppaks, this plugin's
   `get_song_tones` does not check `is_sloppak` — it will hand a
   sloppak to `read_psarc_entries` which will likely raise. Confirm
   intended behaviour.]

---

### User Story 4 — Duck the song's guitar stem when AMP is active (P2)

As a sloppak user, when I play through my own amp model I don't want
the original recording's guitar stem competing with me.

**Acceptance Scenarios**:

1. **Given** a sloppak song with a guitar stem and AMP is engaged,
   **When** AMP enables, **Then** the guitar stem volume is saved
   then set to 0.
2. **Given** AMP disables, **When** the toggle fires, **Then** the
   stem volume is restored.
3. **Given** the user disables stem ducking in settings, **When**
   AMP engages, **Then** the stem volume is left untouched.

---

### User Story 5 — Inline settings panel (P2)

As a user, I want to adjust input device, channel (mono / L / R),
input gain, output gain, gate threshold, latency offset, and stem
ducking from a settings panel without leaving the player.

**Acceptance Scenarios**:

1. **Given** the settings panel is open, **When** the user picks
   the dry/DI channel (typically Left), **Then** subsequent
   `getUserMedia` calls use that channel.

## Functional Requirements

- **FR-001**: Schema —
  ```
  CREATE TABLE presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    model_file TEXT,
    ir_file TEXT,
    input_gain REAL NOT NULL DEFAULT 1.0,
    output_gain REAL NOT NULL DEFAULT 0.5,
    gate_threshold REAL NOT NULL DEFAULT -60.0,
    settings_json TEXT NOT NULL DEFAULT '{}'
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
- **FR-002**: `GET/POST /models`, `DELETE /models/<name>` for `.nam`
  files under `<config_dir>/nam_models/`.
- **FR-003**: `GET/POST /irs`, `DELETE /irs/<name>` for `.wav` IRs
  under `<config_dir>/nam_irs/`. POST normalises via
  `ffmpeg -y -i ... -ar 48000 -ac 1 -c:a pcm_f32le ...` (30 s
  timeout). Failure / timeout falls back to raw bytes.
- **FR-004**: `GET/POST /presets`, `DELETE /presets/<id>` (cascade
  delete on `tone_mappings`).
- **FR-005**: `GET/POST /mappings/<filename>`,
  `DELETE /mappings/<id>` — `(filename, tone_key)` unique.
- **FR-006**: `GET /song-tones/<filename>` walks PSARC JSON for
  tone keys. (See clarify.md / NEEDS CLARIFICATION on sloppak
  handling.)
- **FR-007**: `GET /file/<model|ir>/<name>` serves uploaded assets
  back to the browser. Models served as `application/json`, IRs as
  `audio/wav`.
- **FR-008**: `GET /worklet/<filename>` serves files from `worklet/`
  or `wasm/` (in that order). MIME types `application/javascript` /
  `application/wasm`.
- **FR-009**: SQLite uses WAL mode; module-level `_lock` for writes.
- **FR-010**: Frontend signal chain (per FR-rationale in
  `screen.js`):
  ```
  getUserMedia → input gain → AudioWorklet (NAM WASM)
                 → ConvolverNode (IR) → output gain → destination
  ```
- **FR-011**: Tone polling: `highway.getToneChanges()` polled every
  100 ms; preset swap on tone change.
- **FR-012**: Stem ducking: save then mute the guitar stem volume
  on AMP enable; restore on disable. Must be toggle-able in
  settings.

## Out of Scope

- Multi-threaded WASM (would require COOP/COEP headers).
- ToneHunt model browser.
- DSP post-stages other than the IR (no parametric EQ, no delay/
  reverb in this plugin).
- Recording the wet output (use the `multiplayer` plugin or a
  loopback for that).
