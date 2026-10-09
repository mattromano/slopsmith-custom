# Feature Specification: Slopsmith — CDLC Browse & Play Platform

**Feature Branch**: `main` (retrospective — no branch)
**Created**: 2026-05-09
**Status**: Retrospective (documents shipping behaviour up to `VERSION` 0.2.7)
**Input**: User description: "the entire Slopsmith umbrella repo as a single
spec-kit feature, retrofitted from the existing implementation"

> This is a retrospective spec. The product already exists. The intent is to
> capture what shipped — the user-facing behaviour of `server.py`, `lib/`,
> `static/`, and the in-tree plugins under `plugins/` — in spec-kit form so
> future contributors and AI agents have a single ordered description of the
> system to align against. Anything we cannot infer from `CLAUDE.md`,
> `README.md`, `CHANGELOG.md`, or the source is marked
> `[NEEDS CLARIFICATION]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Browse a personal CDLC library at scale (Priority: P1)

A guitarist with thousands of Rocksmith 2014 CDLCs (custom + on-disc)
points Slopsmith at their `Rocksmith2014/dlc` folder, waits for the
first scan to populate, and then browses by artist/album/tuning, filters
by arrangement (Lead/Rhythm/Bass/Combo), stems, lyrics, and tunings,
searches by free text, sorts by recently-added or year, and pins
favorites — without ever leaving the browser.

**Why this priority**: This is the irreducible product. With nothing
else, Slopsmith is already a better library browser than the Rocksmith
in-game UI for users with 80,000+ songs.

**Independent Test**: Mount any folder of `.psarc` files via
`DLC_PATH`, run `docker compose up -d`, open `http://localhost:8000`,
confirm the library populates progressively, search/filter/sort all
work, and favourites persist across container restarts.

**Acceptance Scenarios**:

1. **Given** an empty `meta.db` and a DLC folder with N PSARCs,
   **When** the user opens the library page,
   **Then** a progress banner shows scan progress and rows appear in
   the grid as soon as their metadata is committed (non-blocking scan).
2. **Given** a populated library with mixed custom + official DLC,
   **When** the user types into the search box,
   **Then** results are filtered server-side via `/api/library?q=`
   over title, artist, and album within ~200 ms.
3. **Given** a library with songs in multiple tunings,
   **When** the user opens the Filters drawer and ticks
   "Tuning: Eb Standard" + "Lead",
   **Then** only Eb Standard songs that have a Lead arrangement are
   shown, and the active-filter count badge reflects the selection.
4. **Given** a song the user has favourited,
   **When** they restart the container,
   **Then** the heart icon and Favourites view still show the song.

### User Story 2 — Play a song on the note highway (Priority: P1)

The user clicks a song card. The player screen opens, audio loads, the
note highway renders synchronized notes, sustains, chords, slides,
bends, palm mutes, harmonics, lyrics, and section anchors as the song
plays. They can switch between Lead/Rhythm/Bass mid-song, change speed
(0.25×–1.50×), adjust volume, and pick a visualization (built-in 2D, 3D
highway, or any installed viz plugin) from the picker.

**Why this priority**: Browsing is table stakes; the highway is what
makes Slopsmith more than a file lister. P1 because a working highway
is the proof that everything downstream of the WebSocket protocol is
sound.

**Independent Test**: Click any successfully-scanned song; verify
audio plays, notes scroll in time, the arrangement switcher works, the
viz picker swaps renderers without a reload, and Space/←/→/Esc
shortcuts behave per the help panel.

**Acceptance Scenarios**:

1. **Given** a PSARC with Lead+Rhythm+Bass arrangements,
   **When** the user opens the player,
   **Then** the default arrangement (per Settings) loads, and the
   arrangement switcher exposes the other two without reloading audio.
2. **Given** the highway is rendering on the default 2D renderer,
   **When** the user picks "3D Highway" from the viz picker,
   **Then** `setRenderer` swaps the renderer, the canvas element is
   replaced (because contextType differs from `2d` to `webgl2`), and
   plugins listening on `highway:canvas-replaced` re-acquire it.
3. **Given** the song has lyrics,
   **When** the lyrics toggle is on,
   **Then** karaoke-style highlighted lyrics render in sync with the
   playback time supplied by `highway.getTime()`.
4. **Given** the user presses `?`,
   **When** the help panel opens,
   **Then** every plugin-registered shortcut (player/library/global)
   is listed with description and scope.

### User Story 3 — Practice with loops and metronome (Priority: P2)

The user finds a hard passage, sets A and B points, optionally names
and saves the loop, plays the section in repeat with a tempo-matched
4-count click before each repetition, and the highway smoothly rewinds
to A on each pass. They can adjust speed independently and resume
saved loops in future sessions.

**Why this priority**: This is what makes Slopsmith useful for
*practice* rather than just *playback*. P2 because it builds on the
P1 player — without the highway, loops are not playable.

**Independent Test**: Open any song, set A/B, hit save, name the
loop, refresh the page, reopen the song, and confirm the loop is
restored and replays correctly with click-in.

**Acceptance Scenarios**:

1. **Given** a loop is saved via `POST /api/loops`,
   **When** the user reopens the song,
   **Then** `GET /api/loops?filename=...` returns the saved loop and
   the UI exposes it in the loop dropdown.
2. **Given** a loop is active and playing,
   **When** playback reaches B,
   **Then** the highway rewinds visually to A and the 4-count click
   plays at the song's local tempo before audio resumes.

### User Story 4 — Import + scan new CDLC (Priority: P2)

A user drops a new `.psarc` (or `.sloppak`) into the DLC folder and
either waits for the periodic rescan or hits "Rescan" / "Full Rescan"
in Settings. New songs appear in the library; corrupt files are
skipped with a warning, not a crashed scan.

**Why this priority**: Library churn is normal — without a rescan
path, the product gradually goes stale. P2 because the initial scan
covers the bootstrap case.

**Independent Test**: Add a file, click Rescan, watch the scan
progress, confirm the new song appears with correct artist/title/art.

**Acceptance Scenarios**:

1. **Given** a new PSARC has been added to the DLC folder,
   **When** the user clicks Rescan,
   **Then** `POST /api/rescan` is called, the scan banner reappears,
   and the new song is queryable via `/api/library` once committed.
2. **Given** a corrupt PSARC in the folder,
   **When** the scanner reaches it,
   **Then** the scan logs a warning and continues; other songs in the
   batch still land in `meta.db`.

### User Story 5 — Extend Slopsmith via plugins (Priority: P2)

A user (or developer) drops a plugin folder containing a `plugin.json`
into `plugins/`, restarts the container, and the plugin's nav link,
screen, settings panel, API routes, viz factory, keyboard shortcuts,
and audio mixer fader all appear automatically. Two plugins shipping
generic module names (`extractor.py`, `util.py`) coexist without
collision via `context["load_sibling"]`.

**Why this priority**: Plugins are the constitutionally-mandated
extension point — they are how 30+ shipping features get added without
bloating core. P2 because the platform has to load before plugins can
extend it.

**Independent Test**: `git clone` any of the published plugin repos
(e.g. `slopsmith-plugin-fretboard`) into `plugins/<name>`, restart,
verify the plugin appears in the nav and behaves per its README.

**Acceptance Scenarios**:

1. **Given** two plugins each ship an `extractor.py`,
   **When** both are loaded at startup,
   **Then** each plugin's `setup()` resolves its own copy via
   `context["load_sibling"]("extractor")` (namespaced module name)
   without a `cannot import name` collision.
2. **Given** a viz plugin declares `type: "visualization"` and exports
   `window.slopsmithViz_<id>`,
   **When** the user opens the viz picker,
   **Then** the plugin is listed and can be selected; "Auto" mode
   switches to it on `song:ready` if `matchesArrangement` returns
   truthy.

### User Story 6 — Retune to E Standard (Priority: P3)

A song was published in Eb/D/C# Standard but the user's guitar is in E
Standard. They click "Retune to E Standard"; the server pitch-shifts
audio via `rubberband` (`/ws/retune`), rewrites the SNG/note data, and
saves a new playable PSARC alongside the original. Original file is
left untouched.

**Why this priority**: Quality-of-life feature for non-standard
tunings. P3 because it is destructive (creates files) and not on the
critical play path.

**Independent Test**: Pick a song in Eb Standard, click Retune,
watch the WebSocket progress, confirm a new file appears in the DLC
folder, open it, verify it plays at E Standard pitch.

**Acceptance Scenarios**:

1. **Given** a `.sloppak` file,
   **When** the user clicks Retune,
   **Then** the server rejects with "Retune is not supported for
   .sloppak files" rather than silently corrupting the archive
   (`server.py:2598`).

### User Story 7 — Export and re-import settings (Priority: P3)

A user calibrates their setup (audio offset, default arrangement,
favourites, plugin settings, saved loops), exports a single bundle
from Settings, and later restores it on a different machine or after
a reinstall. Plugin state for plugins not yet installed is preserved
in the bundle and applied lazily once they appear.

**Why this priority**: Migration / backup. P3 because most users go
months between exports.

**Acceptance Scenarios**:

1. **Given** a bundle that references a plugin not present on the
   importing host,
   **When** the user clicks Import,
   **Then** the relevant files are skipped with a warning and the
   rest of the bundle is committed atomically (`server.py` import
   handler is two-phase).
2. **Given** a bundle with a path-traversal entry (`../etc/passwd`),
   **When** validation runs,
   **Then** import aborts before any file is written.

### User Story 8 — Export diagnostics for support (Priority: P3)

When something breaks, the user clicks Settings → Diagnostics →
Export Diagnostics, optionally previews the bundle, and ships a single
zip to a maintainer. The bundle contains redacted server logs, system
info, hardware probe, plugin inventory with git SHAs, browser console
transcript, browser hardware, filtered `localStorage`, and per-plugin
contributed diagnostics.

**Why this priority**: Triage tooling — invaluable when present, but
the product works without it. P3.

**Acceptance Scenarios**:

1. **Given** a plugin with `diagnostics.callable: "diagnostics:collect"`
   that raises an exception,
   **When** the user clicks Export,
   **Then** the bundle still exports, the exception is appended to
   `manifest.notes`, and other plugins' diagnostics are unaffected.

### Edge Cases

- **Corrupt or partial PSARC**: scan logs a warning per file and
  continues; the file does not appear in the library.
- **Audio decode fails** (vgmstream/ffmpeg error): `song_info` is sent
  with `audio_url: null` and a non-null `audio_error`; the highway
  still renders so the user can study the chart silently.
- **Empty `tunings` list / extended-range GP imports**: server-side
  `getStringCount()` derives string count from
  `max(notes-max-string + 1, name-based fallback, len(tuning))` — see
  `CLAUDE.md`.
- **Viz auto-mode picks a WebGL renderer on a 2D-locked canvas**:
  `setRenderer` swaps the canvas via `cloneNode(false)` +
  `replaceWith`; plugins must listen for `highway:canvas-replaced`.
- **Two plugins ship same-named sibling modules**: loader prints a
  startup warning; `load_sibling` namespaces the imports so neither
  plugin breaks.
- **Plugin requirements.txt fails to install**: scan continues, the
  plugin is marked as orphaned in the diagnostics inventory.
- **Browser private mode disables `localStorage`**: viz picker
  selection falls back to the `<option>` value for the page lifetime.
- **`LOG_FILE` not set**: diagnostics bundle still ships
  system+hardware+console; the `logs/` section is empty.

## Requirements *(mandatory)*

### Functional Requirements

#### Library

- **FR-001**: System MUST scan a user-supplied DLC folder
  (`DLC_DIR` env or Settings) for `.psarc` and `.sloppak` files,
  extract metadata in-memory, and persist it to a SQLite `meta.db`.
- **FR-002**: System MUST keep the library browseable while a scan is
  in progress (non-blocking scan with progress banner).
- **FR-003**: System MUST expose `/api/library` with paginated,
  server-side search (q), sort
  (artist/title/recently-added/tuning/year), and filters
  (arrangement IDs, stem IDs, lyrics, tuning).
- **FR-004**: System MUST expose `/api/library/artists` and
  `/api/library/stats` for the artist/album tree and letter bar
  (A–Z), and `/api/library/tuning-names` for the tuning filter
  control.
- **FR-005**: System MUST persist favourites and song metadata
  edits across container restarts.
- **FR-006**: System MUST tolerate corrupt PSARCs without aborting a
  scan batch and MUST log per-file warnings via stdlib `logging`.
- **FR-007**: System MUST run a periodic background rescan and
  expose `POST /api/rescan` (incremental) and `POST /api/rescan/full`
  (rebuild) for user-triggered rescans.

#### Player + Highway

- **FR-008**: System MUST stream song data (song_info, beats,
  sections, anchors, chord_templates, lyrics, tone_changes, notes,
  chords, phrases, ready) over a WebSocket at
  `/ws/highway/{filename}?arrangement={index}` in the order
  documented in `CLAUDE.md`.
- **FR-009**: System MUST support arrangement switching mid-session
  via the `arrangement` query parameter.
- **FR-010**: Highway renderer MUST display: fret-positioned notes,
  string colours, open-string bars, chord brackets with chord names,
  sustains, bends, unison bends, slides, hammer-on/pull-off/tap,
  palm mutes, tremolo, accents, harmonics, pinch harmonics.
- **FR-011**: Highway MUST support speed control (0.25×–1.50×),
  volume control, A-B looping with named saved loops, 4-count click,
  rewind effect, dynamic anchor zoom.
- **FR-012**: Highway MUST support pluggable renderers via
  `window.slopsmithViz_<id>` factories with the `setRenderer`
  contract (init/draw/resize/destroy + `contextType`).
- **FR-013**: Highway MUST support overlay plugins that own their
  rAF and canvas and read state via the public `highway.get*`
  getters (notes, chords, beats, songInfo, lefty, inverted,
  stringCount).
- **FR-014**: Highway MUST swap the underlying `<canvas>` element
  when renderer `contextType` differs from the currently-bound
  context, and emit `highway:canvas-replaced` on `window.slopsmith`.
- **FR-015**: Highway MUST gracefully degrade when audio fails
  (`audio_url: null`, non-null `audio_error`); chart rendering
  MUST still proceed.

#### Practice

- **FR-016**: System MUST persist named loops keyed by filename via
  `GET/POST/DELETE /api/loops`.
- **FR-017**: 4-count click MUST be tempo-matched to the local song
  tempo at the loop start.

#### Plugins

- **FR-018**: System MUST discover plugins under `plugins/<name>/`
  at startup, parse their `plugin.json` manifests, and load
  `routes.py` (backend) + `screen.html`/`screen.js` (frontend) +
  `settings.html` (settings panel) when present.
- **FR-019**: System MUST namespace plugin API routes under
  `/api/plugins/<plugin_id>/...`.
- **FR-020**: System MUST provide `context["load_sibling"](name)` to
  plugin `setup()` functions for collision-free sibling imports
  (per-plugin `sys.modules` namespace `plugin_<encoded_id>.<name>`).
- **FR-021**: System MUST provide `context["log"]` (a
  `slopsmith.plugin.<id>` logger) and `context["meta_db"]`,
  `context["get_dlc_dir"]`, `context["extract_meta"]`,
  `context["get_sloppak_cache_dir"]`, `context["config_dir"]` to
  plugins.
- **FR-022**: System MUST expose `window.slopsmith` event emitter,
  `window.slopsmith.audio.registerFader`,
  `window.slopsmith.diagnostics.contribute`,
  `window.registerShortcut`, and `window.createShortcutPanel` to
  frontend plugin scripts.
- **FR-023**: System MUST install plugin Python requirements
  (`requirements.txt`) on first load and surface install failures
  in logs + diagnostics without blocking other plugins.
- **FR-024**: Plugin load order MUST be alphabetical by directory
  name to give the `playSong` wrapper chain a deterministic order.

#### Formats

- **FR-025**: System MUST read PSARC archives via `lib/psarc.py`
  (`read_psarc_entries` for in-memory metadata, `unpack_psarc` for
  full extraction on play).
- **FR-026**: System MUST auto-convert SNG binaries to XML via the
  bundled RsCli (Rocksmith2014.NET CLI) for official disc DLC.
- **FR-027**: System MUST read sloppak archives (zip and directory
  forms) via `lib/sloppak.py` per `docs/sloppak-spec.md`.
- **FR-028**: System MUST support sloppak stems (`stems/<name>.ogg`)
  with a `stems` array on `song_info` (empty for non-sloppak).

#### Retune

- **FR-029**: System MUST pitch-shift PSARC audio + rewrite SNG/note
  data to a target tuning via `lib/retune.py` over `/ws/retune`,
  saving a new file alongside the original. Sloppak retune is
  rejected.

#### Settings, Diagnostics, Versioning

- **FR-030**: System MUST expose `GET /api/settings` and
  `POST /api/settings` for server-side config (DLC dir, default
  arrangement, audio offset, etc.).
- **FR-031**: System MUST expose `GET /api/settings/export` and
  `POST /api/settings/import` for whole-bundle backup/restore with
  two-phase atomic import (validate-all → write-all).
- **FR-032**: System MUST expose `POST /api/diagnostics/export`,
  `GET /api/diagnostics/preview`, `GET /api/diagnostics/hardware`
  per `docs/diagnostics-bundle-spec.md`, with redaction on by
  default.
- **FR-033**: System MUST expose `GET /api/version` returning the
  contents of the `VERSION` file, displayed as a navbar badge.
- **FR-034**: System MUST honour `LOG_LEVEL`, `LOG_FORMAT`,
  `LOG_FILE` env vars and stamp every HTTP response with
  `X-Request-ID`.

#### Compatibility

- **FR-035**: System MUST run as a single Docker container with
  only `DLC_DIR` and `CONFIG_DIR` configured — no external
  dependencies.
- **FR-036**: System MUST support both custom CDLC (CustomsForge
  etc.) and official Rocksmith DLC. Arrangement names MUST be read
  from manifest JSON for accurate Lead/Rhythm/Bass identification.

#### Open / Ambiguous

- **FR-037**: System MUST handle [NEEDS CLARIFICATION: target browser
  matrix — `CLAUDE.md` mentions Chrome/Edge for Web MIDI but
  doesn't list a baseline; Safari WebGL2 support implied but not
  asserted].
- **FR-038**: System MUST scale to [NEEDS CLARIFICATION: README
  claims 80,000+ songs; no documented upper bound or memory
  ceiling].
- **FR-039**: Concurrent WebSocket count limit
  [NEEDS CLARIFICATION: `CLAUDE.md` says "many simultaneous"
  connections supported but does not enumerate a tested ceiling].

### Key Entities

- **Song**: a row in `meta.db` with title, artist, album, year,
  tuning, arrangement IDs, stem IDs, lyrics flag, source path,
  scan timestamp, favourite flag.
- **Arrangement**: Lead / Rhythm / Bass / Combo / Keys (plugin) etc.
  with notes, chords, anchors, beats, sections, tone changes,
  phrases (multi-difficulty when source supports it).
- **Note / Chord / Anchor / Beat / Section**: the wire format
  payloads enumerated in `CLAUDE.md` "WebSocket Protocol Reference"
  and codified in `lib/song.py`.
- **Loop**: `(filename, start_time, end_time, name)` keyed in
  `meta.db`.
- **Plugin**: a directory under `plugins/` with `plugin.json` and
  any combination of `routes.py`, `screen.html`, `screen.js`,
  `settings.html`, `requirements.txt`, `diagnostics.py`.
- **Sloppak**: open-format song package
  (`manifest.yaml + arrangements/*.json + stems/*.ogg + cover.jpg
   + lyrics.json`); see `docs/sloppak-spec.md`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Cold-start scan of a 1,000-song DLC folder completes
  with the full library queryable within
  [NEEDS CLARIFICATION: target time — README's "8-thread metadata
  extraction" implies <2 min for 1k songs but no benchmark is
  published].
- **SC-002**: First note paints within 2 seconds of clicking a song
  card on a previously-played song (PSARC already extracted to
  cache).
- **SC-003**: Highway sustains 60 fps on the built-in 2D renderer
  on a 2018-class integrated GPU at 1080p [NEEDS CLARIFICATION:
  no perf budget published; observed empirically].
- **SC-004**: A new plugin dropped into `plugins/` and `docker
  compose restart`-ed appears in the nav within one container
  restart, with no edits to core files.
- **SC-005**: Settings export/import round-trips with zero data
  loss for core settings + plugins that declare
  `settings.server_files`.
- **SC-006**: Diagnostics export produces a bundle that a
  maintainer can use to identify the failing plugin (via git
  SHA + console transcript + per-plugin diagnostics) without
  asking the user follow-up questions [aspirational; no SLA].

## Assumptions

- Single trusted local user. No auth, no rate limiting, no
  multi-tenant data partitioning.
- Docker (or Docker-compatible runtime — Slopsmith Desktop wraps
  the same image inside Electron) is available on the host.
- Users supply their own legally-acquired Rocksmith 2014 DLC.
  Slopsmith does not redistribute song content.
- Browser is a modern evergreen Chromium / Firefox / Safari with
  WebGL2 (for 3D highway and other WebGL viz plugins). Web MIDI
  features (drums, piano, MIDI amp) require Chromium-family.
- The plugin ecosystem (~30 published repos listed in README) is
  out of scope for this spec. Each plugin owns its own contract
  with the user; this spec only governs the platform that hosts
  them.
- `slopsmith-desktop` is a downstream consumer of this repo; this
  spec describes the Docker-first web app, not the desktop bundle.
