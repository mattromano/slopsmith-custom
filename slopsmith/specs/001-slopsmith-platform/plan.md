# Implementation Plan: Slopsmith Platform

**Branch**: `main` (retrospective — no branch) | **Date**: 2026-05-09
**Spec**: [`spec.md`](./spec.md)
**Input**: existing implementation under `/home/byron/Repositories/slopsmith`

> Retrospective plan: this documents the architecture as it currently
> exists, with the rationale pulled from `CLAUDE.md`. Future "should-be"
> work goes in `tasks.md` as OPEN items.

## Summary

Slopsmith is a FastAPI + vanilla-JS web app, packaged as a single Docker
image, that turns a Rocksmith 2014 DLC folder into a browseable,
playable, practice-friendly library. The backend (`server.py`) is a
single FastAPI module that owns the library API, the highway WebSocket,
plugin discovery, and settings/diagnostics endpoints. The frontend
(`static/`) is a single-page app driven by `app.js`, with the highway
itself in `highway.js`. Shared Python helpers live in `lib/` (flat
imports, no `__init__.py`). Extension lives in `plugins/<name>/`,
discovered at startup from `plugin.json` manifests. SQLite (`meta.db`)
is the only persistent data store; PSARC archives are scanned in-memory.

## Technical Context

| Aspect | Value | Source |
|---|---|---|
| Language/Version | Python 3.12 (backend), JavaScript ES2020+ (frontend) | `pyproject.toml`, `Dockerfile` |
| Backend framework | FastAPI + uvicorn | `server.py:17` |
| Frontend framework | None — vanilla JS, Canvas 2D, WebGL2 | Constitution II, `CLAUDE.md` |
| Style framework | Tailwind CSS via CDN + `static/style.css` | `static/index.html` |
| Storage | SQLite via `MetadataDB` (`server.py:226`) for library + loops + favourites; YAML/JSON config files in `CONFIG_DIR`; browser `localStorage` for UI state | `server.py:226`, `CLAUDE.md` |
| WebSocket | `/ws/highway/{filename}` (song stream), `/ws/retune` (retune progress) | `server.py:2906`, `server.py:2576` |
| Audio decode | `vgmstream-cli` + `ffmpeg`; FluidSynth for MIDI render; `rubberband` for pitch shift | README "Tech Stack" |
| SNG decoder | F# CLI wrapping `Rocksmith2014.NET` (bundled in image) | README "Tech Stack" |
| Concurrency | sync handlers + `threading.Lock` on `MetadataDB`; background threads for scan/retune/sloppak conversion | `CLAUDE.md` "Backend Conventions" |
| Logging | stdlib `logging` configured by `lib/logging_setup.py`; `LOG_LEVEL` / `LOG_FORMAT` (text\|json) / `LOG_FILE` env vars; `X-Request-ID` correlation header | `CHANGELOG.md` "Structured logging bootstrap" |
| Testing | `pytest` (`tests/`, Python 3.12 in CI on push/PR to `main`); Playwright for browser (`tests/browser/`) | README "Running tests" |
| Target platform | Docker (Linux container, AMD64 + ARM64), running on any host with Docker; consumer is the user's browser | `Dockerfile`, `docker-compose.yml` |
| Project type | Web service (single backend + bundled static frontend + plugin tree) | n/a |
| Performance goals | 60 fps highway @ 1080p on integrated GPU (empirical, not a hard SLA); 80,000+ songs in library; non-blocking initial scan | README, `[NEEDS CLARIFICATION]` |
| Constraints | Single-user, no auth, must run in Docker, must read existing PSARCs unmodified, plugins must be drop-in | Constitution I/IV |
| Scale/scope | ~3,400 LOC in `server.py`; ~20 modules in `lib/`; ~40 published plugin repos (~30 in-tree at the time of writing) | `wc -l`, `ls plugins/` |

## Constitution Check

*GATE: must pass before any non-trivial change to the platform.*

| Principle | Subsystem upholding it | Notes |
|---|---|---|
| I. Self-hosted, single-user, Docker-first | `Dockerfile`, `docker-compose.yml`, `server.py` (no auth middleware), `_demo_mode_guard` (`server.py:179`) | Demo-mode guard exists for hosted demos but production is single-user. |
| II. Vanilla frontend | `static/app.js`, `static/highway.js`, `static/index.html`, `static/style.css` | No bundler, no framework, Tailwind via CDN. |
| III. Plugins are the extension point | `plugins/__init__.py` (discovery), `plugin.json` schema, `context["load_sibling"]` (per-plugin module namespace) | 30+ in-tree plugin dirs prove the pattern; `update_manager` plugin manages installs/updates. |
| IV. Backwards-compatible CDLC library | `lib/psarc.py` (in-memory scan), `lib/sloppak.py` (open format), `MetadataDB` (additive schema) | Retune is the only mutating op and is opt-in per song. |
| V. Pure-function lib + tests | `lib/song.py`, `lib/tunings.py`, `lib/gp2midi.py`, `lib/sloppak_convert.py`; `tests/test_*.py` runs in CI | Coverage is partial (README explicitly calls out `tunings.py` + `song.py` as covered targets, with `sloppak_convert.py` and `gp2rs.py` as natural follow-ups). |
| VI. Observability | `lib/logging_setup.py`, `CorrelationIdMiddleware`, `lib/diagnostics_bundle.py`, `lib/diagnostics_redact.py`, `lib/diagnostics_hardware.py`, `static/diagnostics.js` | Phase-1 of #155 done; phase-2 (`print()` migration) ongoing — counts as an OPEN task in `tasks.md`. |
| VII. Versioned settings | `GET/POST /api/settings/export|import` (`server.py:2087`/`2125`), two-phase atomic import, `settings.server_files` allowlist, `VERSION` file + `/api/version` | Slopsmith #113 implementation. |

No violations. The single area of in-flight work is the `print()` →
`logging` migration called out in `CHANGELOG.md` "Structured logging
bootstrap" — tracked as an OPEN polish task.

## Architecture

### Component layout

```
slopsmith/
├── server.py                       # FastAPI app — single 3.4k-LOC module
│   ├─ middleware: CorrelationIdMiddleware, _demo_mode_guard
│   ├─ MetadataDB (SQLite, threading.Lock)
│   ├─ /api/library, /api/library/artists, /api/library/stats,
│   │   /api/library/tuning-names, /api/favorites/toggle,
│   │   /api/loops, /api/settings, /api/settings/export|import,
│   │   /api/diagnostics/export|preview|hardware, /api/version,
│   │   /api/scan-status, /api/rescan, /api/rescan/full
│   ├─ /ws/highway/{filename}       # main highway data stream
│   ├─ /ws/retune                   # retune progress stream
│   └─ plugin loader entry          # delegates to plugins/__init__.py
├── lib/                            # flat imports, pythonpath = [".", "lib"]
│   ├─ song.py                      # Note/Chord/Arrangement/Song wire format
│   ├─ psarc.py                     # PSARC AES-CFB-128 read + in-memory scan
│   ├─ sloppak.py                   # open-format zip+dir reader
│   ├─ sloppak_convert.py           # PSARC → sloppak via Demucs stem split
│   ├─ audio.py / wem_decode.py     # WEM/OGG/MP3 audio
│   ├─ retune.py                    # rubberband pitch shift + SNG rewrite
│   ├─ tunings.py                   # tuning name/offset utilities
│   ├─ gp2rs.py / gp2midi.py        # Guitar Pro → Rocksmith XML / MIDI
│   ├─ midi_import.py / sng_vocals.py / patcher.py / cdlc_builder.py
│   ├─ logging_setup.py             # stdlib logging + structured/json mode
│   ├─ diagnostics_bundle.py        # zip composer for support bundles
│   ├─ diagnostics_redact.py        # PII redaction rules
│   ├─ diagnostics_hardware.py      # CPU/RAM/GPU probe
│   └─ tools/                       # bundled binaries (RsCli etc.)
├── static/
│   ├─ index.html                   # SPA shell
│   ├─ app.js                       # screens, library, player, plugin loader
│   ├─ highway.js                   # createHighway() Canvas/WebGL renderer
│   ├─ audio-mixer.js               # registerFader registry
│   ├─ diagnostics.js               # console wrap + diagnostics.contribute
│   ├─ tour-engine.js / tour-engine.css
│   ├─ style.css                    # custom CSS supplementing Tailwind
│   ├─ vendor/, art/, lottie/       # bundled assets
│   └─ audio_*.mp3                  # demo audio for marketing/docs/tour
├── plugins/
│   ├─ __init__.py                  # discovery, requirements install, load_sibling
│   └─ <plugin>/                    # ~30 in-tree plugin dirs (gitlinks)
├── tests/                          # pytest suite (lib/), Playwright (browser/)
├── docs/                           # sloppak-spec.md, diagnostics-bundle-spec.md, …
├── Dockerfile, docker-compose.yml
├── pyproject.toml, requirements.txt, requirements-test.txt
├── VERSION, CHANGELOG.md, README.md, CLAUDE.md
└── .specify/                       # spec-kit templates + this constitution
```

### Data flow

#### Cold start

1. Docker compose mounts DLC folder + config volume → uvicorn boots
   `server.py`.
2. `@app.on_event("startup")` (`server.py:1031`) opens `MetadataDB`,
   discovers plugins via `plugins/__init__.py`, registers their routes,
   kicks off `_background_scan()` (`server.py:914`).
3. `_background_scan` walks the DLC folder, calls `_extract_meta_fast`
   (`server.py:690`) for PSARC and `_extract_meta_sloppak`
   (`server.py:781`) for sloppak, commits rows in batches.
4. `_set_startup_status` (`server.py:867`) pushes progress through an
   `asyncio.Queue` consumed by `/api/startup-status/stream`
   (SSE, `server.py:1366`); the frontend renders the progress banner.
5. Periodic rescan timer (`_periodic_rescan`, `server.py:1331`) catches
   files added/removed at runtime.

#### Library browse

1. `static/app.js` calls `/api/library?q=&page=&size=&sort=&...filters`.
2. `list_library` (`server.py:1456`) joins `MetadataDB` with the
   filter args, returns `{rows, total}`. The artist tree, stats,
   and tuning list have their own endpoints
   (`/api/library/artists` `:1478`, `/api/library/stats` `:1499`,
   `/api/library/tuning-names` `:1518`).
3. `app.js` renders cards / tree, talks to `/api/favorites/toggle`
   (`:1550`) for hearts.

#### Player + highway

1. User clicks a card → `app.js` navigates to the player screen,
   constructs the highway via `createHighway()` in `highway.js`.
2. Highway opens `/ws/highway/{filename}?arrangement=N` (`:2906`).
3. Server unpacks the PSARC to a temp dir (or reads sloppak in
   place), parses the SNG/XML/JSON, sends the message sequence
   documented in `CLAUDE.md` "WebSocket Protocol Reference":
   `loading → song_info → beats → sections → anchors →
    chord_templates → lyrics → tone_changes? → notes → chords →
    phrases? → ready`.
4. Highway renders frame-by-frame in `requestAnimationFrame`,
   reading playback time from the `<audio>` element. Renderers are
   pluggable via `setRenderer(factory())` against
   `window.slopsmithViz_<id>` factories.

#### Plugin lifecycle

1. `plugins/__init__.py` walks `plugins/` directories, parses
   `plugin.json`, runs `pip install -r requirements.txt` if present,
   imports `routes.py` and calls `setup(app, context)`.
2. Static manifests (nav entry, screen HTML, settings HTML, viz
   declaration) are exposed to the frontend via API endpoints; the
   frontend injects HTML fragments and `<script>` tags lazily when
   the user navigates to the plugin screen.
3. `context` provides `config_dir`, `get_dlc_dir`, `meta_db`,
   `extract_meta`, `get_sloppak_cache_dir`, `load_sibling`, `log`.
4. Plugin `screen.js` runs in global scope; can hook
   `window.playSong`, register fader/shortcut/diagnostics, and
   read/write `localStorage`.

### Key design decisions (with rationale)

| Decision | Rationale (from `CLAUDE.md` / repo) |
|---|---|
| Single 3.4k-LOC `server.py` instead of split routers | Simpler import graph, no `__init__.py` packaging headaches; FastAPI's `@app.get` decorator pattern is fine without modularization at this scale. Pragmatic single-user app. |
| Flat `lib/` (no `__init__.py`) | Lets `from song import Song` work from server.py, plugin routes, tests, and CLI tools without aware-of-package gymnastics. `pyproject.toml` sets `pythonpath = [".", "lib"]`. |
| Vanilla JS, no build step | Edit-refresh dev loop, no node toolchain in the container, no transpiler version drift, plugins ship plain `.js` files. Constitution II. |
| In-memory PSARC scanning | PSARC is encrypted (AES-CFB-128) and large; full extraction of every file at scan time is wasteful when we only need manifest + metadata bytes. `read_psarc_entries` peeks at the table-of-contents without unpacking. |
| SQLite over server-side state | Zero-config, single-file, embedded, perfect for single-user. Survives container restarts via volume mount. `threading.Lock` is enough — no contention at one user's load. |
| Plugins as separate git repos / gitlinks | Each plugin can move at its own pace, have its own issue tracker, and be installed/uninstalled without touching core. Cost: branch-switch hazards (documented as a pitfall in `CLAUDE.md`). |
| `load_sibling` namespace per plugin | Prevents two plugins shipping `extractor.py` from colliding in `sys.modules`. Bijective id encoding (`_` → `_5f_`, `.` → `_2e_`) handles reverse-DNS-style ids. Documented in `CLAUDE.md` "Sibling imports" with a concrete failure mode. |
| `setRenderer` contract for viz plugins | Lets viz authors replace the highway draw function without re-implementing WebSocket parsing or the rAF loop. Canvas context-type swap (`cloneNode(false)` + `replaceWith`) lets 2D ⇄ WebGL swaps work mid-session. |
| Two-phase settings import (validate-all → write-all) | Single-user means catastrophic mid-import failure leaves the user with a half-written config they can't recover from. Two-phase validation makes failure transactional. Plugin state mismatches are warnings, not errors, to handle "exported on a host with plugin X, imported on a host without" gracefully. |
| Diagnostics bundle as a zip with `manifest.json` schema dispatch | AI agents and maintainers need a stable schema-versioned format. Each JSON file carries a `schema` field (`system.hardware.v1`, `client.console.v1`, …) so dispatch by version is mechanical. Redaction-on-by-default protects users from accidentally sharing DLC paths or tokens. |
| `VERSION` auto-bumped from `slopsmith-desktop` | Avoids drift between the web app version and the desktop wrapper that bundles it. `repository_dispatch`-driven workflow is the only sanctioned exception to "no direct pushes to `main`". |

## Project Structure

### Source code (repository root)

This is a **single-project / web-service** layout — backend (Python),
frontend (vanilla JS in `static/`), shared libs (`lib/`), and plugin
tree (`plugins/`) all live in one repo. There is no `backend/` /
`frontend/` split because there is no build step that would benefit
from one.

```text
slopsmith/
├── server.py                     # FastAPI app
├── lib/                          # shared Python (flat imports)
├── static/                       # vanilla JS SPA + assets
├── plugins/                      # discovered at startup
├── tests/                        # pytest + Playwright
├── docs/                         # spec docs + bundle schemas
├── .specify/                     # constitution + spec-kit templates
├── specs/001-slopsmith-platform/ # this retrospective spec
├── Dockerfile
├── docker-compose.yml
├── pyproject.toml
├── requirements.txt
├── requirements-test.txt
├── VERSION
├── CHANGELOG.md
├── README.md
└── CLAUDE.md
```

**Structure decision**: keep the flat layout. The repo's small surface
area (one server module, one frontend, flat libs, a plugin tree) is a
feature — it lets a new contributor or AI agent see the entire system
in `ls`. Splitting into `backend/` / `frontend/` / `shared/` would
fight Principle II (no build step) and Principle V (flat imports) for
no benefit.

## Complexity Tracking

| Item | Why it exists | Why a simpler alternative was rejected |
|---|---|---|
| 3.4k-LOC `server.py` | All HTTP + WebSocket + plugin glue in one place | Splitting into routers adds import-graph complexity and a `__init__.py` package, which would break flat-import convention. At one user's scale, monolithic FastAPI is fine. |
| Custom AES-CFB-128 PSARC reader (`lib/psarc.py`) | Rocksmith PSARC uses a non-standard encryption scheme; no off-the-shelf Python reader handles it correctly + in-memory | Calling out to RsCli for every metadata read would be 10–100× slower for an 80k-song library. The custom in-memory reader is the scalability lever. |
| F# `RsCli` subprocess for SNG → XML | Rocksmith2014.NET is the canonical SNG decoder; reimplementing in Python is a multi-month risk | Subprocess + bundled binary is one Dockerfile line and the right tradeoff. |
| Plugin tree as gitlinks | Each plugin needs an independent release cadence and issue tracker | A monorepo for 40+ plugins would couple their release cycles and bloat clones. Gitlink hazards are documented in `CLAUDE.md` "Common Pitfalls" #2 and accepted. |
| Two-phase settings import | All-or-nothing safety on the only critical-config write path the user can trigger | One-phase write-as-you-go would corrupt config on a mid-import failure with no rollback. Two-phase validation is the cheapest possible transactional model without a full DB transaction. |
| `load_sibling` indirection | Without it, two plugins shipping generic `extractor.py` collide in `sys.modules` (real failure mode encountered in slopsmith#33) | `sys.path` insertion alone doesn't namespace; per-plugin venvs would solve this and many other problems but add a 30-second-per-plugin install cost and complicate diagnostics. The namespace trick is the cheapest fix that keeps the single shared interpreter. |
