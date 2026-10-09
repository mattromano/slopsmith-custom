# Slopsmith Constitution

> Slopsmith is a self-hosted, single-user web app for browsing, playing, and
> practicing Rocksmith 2014 Custom DLC. This constitution captures the
> non-negotiable principles that govern its core (`server.py`, `lib/`,
> `static/`) and that all in-tree plugins (`plugins/<name>/`) inherit by
> default. It is a *retrospective* document — the codebase came first, the
> principles below were distilled from `CLAUDE.md`, `README.md`, and the
> shape of the existing implementation.

## Core Principles

### I. Self-Hosted, Single-User, Docker-First

Slopsmith targets one user running one container against a personal
Rocksmith 2014 DLC folder. There is no multi-tenant model, no
authentication, no rate limiting, and no shared backend. Deployment is
expressed as a single `docker compose up -d` against the bundled
`Dockerfile`; everything required (vgmstream, FFmpeg, FluidSynth,
RsCli, Python, F#) is baked into the image so the host machine needs
only Docker. Native (non-Docker) launch is supported for development
but not the primary supported path.

**Non-negotiable rules**

- Do not introduce a user/account model, multi-tenant data partitioning,
  or auth middleware. All endpoints assume one trusted local user.
- New runtime dependencies (binaries, Python modules) must be installable
  inside the existing `Dockerfile`. If something cannot run in the
  container, it does not ship in core.
- `DLC_DIR` and `CONFIG_DIR` are the only required configuration inputs.
  Adding a new mandatory path/env var is a constitutional change.

### II. Vanilla Frontend — No Frameworks

The frontend (`static/app.js`, `static/highway.js`, `static/index.html`,
`static/style.css`) is plain JavaScript with the `fetch` API, direct DOM
manipulation, and the Canvas 2D / WebGL2 APIs. The only style framework
is Tailwind CSS loaded from a CDN. No React, Vue, Svelte, build step,
bundler, transpiler, or TypeScript appears in the core static tree. New
features extend `app.js` and the existing globals (`window.playSong`,
`window.showScreen`, `window.createHighway`, `window.slopsmith`).

**Non-negotiable rules**

- Do not introduce a frontend framework, JSX, or a JS build pipeline in
  core. Plugins MAY ship their own bundled assets but core MUST remain
  source-served.
- New UI state lives in `localStorage` (or a backend endpoint), not in a
  framework store.
- Naming: camelCase JS, kebab-case CSS, snake_case plugin IDs. Player
  layout invariants (`#player` flex-column, `#highway` flex:1,
  `#player-controls` at the bottom) MUST be preserved.

### III. Plugins Are the Extension Point — Isolated by `load_sibling`

Functionality that is not part of the irreducible "browse + play CDLC"
loop ships as a plugin under `plugins/<name>/`, not as core code. Each
plugin is its own directory (typically a separate git repo), discovered
at startup via `plugin.json`, and free to add nav links, screens,
settings panels, and `/api/plugins/<id>/...` routes. Plugins MUST
isolate their backend Python imports via `context["load_sibling"]` so
two plugins shipping a generic `extractor.py` / `util.py` / `client.py`
do not collide in `sys.modules`.

**Non-negotiable rules**

- Generic features (practice journal, setlist, metronome, tone player,
  tab view, MIDI control, stem mixing, editors, etc.) belong in a plugin
  repo, not in `lib/` or `server.py`.
- Plugin backend modules MUST use `context["load_sibling"]("name")` for
  sibling imports. Bare `import sibling` works during transition but
  triggers a startup warning when a name collides.
- Plugins MUST register routes under `/api/plugins/<plugin_id>/...`,
  use `window.slopsmith.emit/on` for cross-plugin communication, and
  prefix their `localStorage` keys with their plugin id.
- Plugins inherit this constitution and may layer additional rules in
  their own `CLAUDE.md`, but MUST NOT relax core principles (e.g. a
  plugin cannot require a frontend framework in core).

### IV. Backwards-Compatible CDLC Library

The whole point of Slopsmith is that a user points it at an existing
Rocksmith 2014 DLC folder and it Just Works. PSARC archives are
read-only, scanned in-memory via `lib/psarc.py` (`read_psarc_entries`)
without unpacking, and indexed in `meta.db` (SQLite via `MetadataDB`).
Both custom CDLC (CustomsForge etc.) and official Rocksmith DLC must
keep playing across releases; SNG binaries are auto-converted to XML
via the bundled RsCli tool. The Sloppak format (`lib/sloppak.py`,
`docs/sloppak-spec.md`) is the preferred *new* format but never
displaces PSARC support.

**Non-negotiable rules**

- Never modify, move, or delete files inside the user's DLC folder
  without an explicit user-initiated action (retune, edit metadata,
  convert-to-sloppak). PSARC scanning is in-memory only.
- A library scan MUST be non-blocking: the user can browse already-
  scanned songs while import continues. Scans MUST tolerate corrupt or
  partial PSARCs without aborting the batch.
- Schema migrations on `meta.db` MUST be additive and idempotent;
  unrecognized columns from a newer build MUST not crash an older one.
- Existing arrangement IDs, sloppak manifests, and the highway
  WebSocket message shape are stable contracts. Breaking changes
  require a CHANGELOG entry under "Migration notes".

### V. Pure-Function Core Libraries, Tested

The shared Python in `lib/` (`song.py`, `tunings.py`, `psarc.py`,
`sloppak.py`, `gp2rs.py`, `gp2midi.py`, `retune.py`, etc.) is written
as flat-importable, side-effect-light modules — no `__init__.py`
package, no implicit IO at import time, no global mutable state beyond
the explicit `MetadataDB` and config singletons in `server.py`. The
pytest suite under `tests/` covers pure-function helpers (note/tempo/
tick math, tuning lookups, song wire format) and runs in CI on every
push and PR to `main` against Python 3.12.

**Non-negotiable rules**

- New `lib/` modules MUST be importable with `from <module> import X`
  (flat imports, `pyproject.toml` sets `pythonpath = [".", "lib"]`).
- Pure helpers added to `lib/` SHOULD ship with pytest coverage in
  `tests/test_<module>.py`. Network/filesystem-heavy code is exempt
  but should be split so the pure parts are testable.
- CI MUST stay green on `main`. A failing test on `main` is a P0.

### VI. Observability Over Chattiness

All backend output goes through the stdlib `logging` pipeline configured
by `lib/logging_setup.py`, controlled by `LOG_LEVEL` / `LOG_FORMAT` /
`LOG_FILE`. Plugins receive a pre-configured `context["log"]` namespaced
to `slopsmith.plugin.<id>` and MUST use it instead of `print`. HTTP
responses carry a `X-Request-ID` header from `CorrelationIdMiddleware`
and the same id appears as `request_id` in JSON log lines. The
"Settings → Export Diagnostics" bundle (`lib/diagnostics_bundle.py`)
collects logs, hardware, plugin inventory, browser console, and per-
plugin contributed diagnostics into a single redacted zip.

**Non-negotiable rules**

- New backend code MUST use `logging.getLogger(...)` (or the plugin
  `context["log"]`). `print()` and `traceback.print_exc()` are legacy
  and being migrated; do not add new ones.
- Diagnostic redaction is on by default. Anything that ships in the
  bundle (DLC paths, song filenames, IPs, bearer tokens) MUST be
  redacted via `lib/diagnostics_redact.py` rules before export.
- Plugins that contribute diagnostics MUST embed a versioned
  `schema` field (e.g. `"my_plugin.diag.v1"`) and keep payloads
  under 100 KB. Diagnostics is not a backup channel — that is
  `settings.server_files`.

### VII. Versioned, Migration-Aware Settings

User configuration lives in two places: server-side under `CONFIG_DIR`
(SQLite `meta.db`, `config.yaml`, plugin opted-in files) and client-
side in browser `localStorage`. Both can be exported and re-imported
as a single bundle (`POST /api/settings/import`,
`GET /api/settings/export`, slopsmith#113). Import is two-phase:
phase-1 validates the entire bundle (schema, paths, encoding) and
phase-2 commits each file atomically via temp+rename. Plugins opt
their server-side files into the bundle via
`settings.server_files` in `plugin.json` (relpaths under `CONFIG_DIR`,
no `..`, no absolute paths).

**Non-negotiable rules**

- Server-side settings imports MUST be all-or-nothing on safety-critical
  failures (path traversal, schema mismatch, decode failure). Plugin
  state mismatches between export and import are recoverable warnings,
  not hard failures.
- Plugins are responsible for their own internal data migration.
  Importing a bundle whose schema predates the running plugin's code
  MUST restore bytes verbatim — the plugin copes at next load.
- The `VERSION` file is the single source of truth for the running
  release; it is auto-bumped from `slopsmith-desktop` releases via
  `.github/workflows/sync-version.yml`. Manual edits are reserved for
  out-of-band recovery only.

## Operating Constraints

- **Concurrency model**: FastAPI + uvicorn, sync handlers for the bulk
  of routes, WebSockets for the highway data stream
  (`/ws/highway/{filename}`) and retune progress (`/ws/retune`).
  `MetadataDB` uses a `threading.Lock`; long-running work (rescan,
  retune, sloppak conversion) is dispatched via background threads or
  separate processes, never inline on the request path.
- **Data flow**:
  `DLC folder → in-memory PSARC scan (psarc.py) → MetadataDB (SQLite) →
   /api/library*  → static/app.js → /ws/highway → static/highway.js`.
  Sloppak follows the same path with `sloppak.py` substituting for
  `psarc.py` and arrangements served from `arrangements/<id>.json`.
- **Frontend layout invariants**: `#player` is `display:flex;
  flex-direction:column; position:fixed; inset:0`; `#highway` is
  `flex:1`; `#player-controls` sits at the bottom. Hiding the highway
  collapses the layout — use `margin-top: auto` on controls if you
  need to hide it.
- **Plugin load order**: alphabetical by directory name. The
  `playSong` wrapper chain runs outermost-first (last-loaded wrapper
  runs first). Plugins MUST tolerate dependent globals being absent
  at load time and check at runtime
  (`typeof window.X === 'function'`).

## Development Workflow

- **Branching**: never push directly to `main`. Always feature branch
  + PR. Exception: the automated `VERSION` bump from
  `slopsmith-desktop`'s release job, which commits to `main` as
  `github-actions[bot]`.
- **Reviews**: PRs run the local Codex review loop
  (`feedback_codex_preflight.md`) and the GitHub Copilot review pass
  (`feedback_copilot_review.md`) before being eligible to merge.
  After pushing a fix, the CodeRabbit loop
  (`feedback_coderabbit_review.md`) runs to silence.
- **Testing**: `pytest` for backend (`requirements-test.txt`),
  Playwright for browser interactions (`tests/browser/`), CI runs both
  on every push/PR to `main`.
- **CHANGELOG**: every PR updates `[Unreleased]`. Releases rename
  `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` (the VERSION bump itself is
  automated).
- **Plugin gitlinks**: plugins under `plugins/` are typically separate
  git repos. Branch switches on the main repo can clobber plugin
  directories. Use `git update-index --assume-unchanged` and avoid
  `git clean -fd` near `plugins/`.

## Governance

- This constitution governs the core repo (`server.py`, `lib/`,
  `static/`, `tests/`, `.github/`, `Dockerfile`, `docker-compose.yml`).
- Plugins inherit these principles by default. A plugin MAY add
  stricter rules in its own `CLAUDE.md` / `README.md`, but MUST NOT
  weaken a core principle. A plugin requesting a relaxation (e.g.
  shipping its own SQLite DB outside `CONFIG_DIR`) requires an
  explicit constitutional amendment in this file.
- Amendments require: (a) a PR that updates this file alongside the
  code change, (b) an entry in `CHANGELOG.md` under "Migration notes"
  if user-visible, and (c) a corresponding update to `CLAUDE.md` so
  AI agents and humans see the same source of truth.
- The principles are listed in priority order. When two principles
  conflict (e.g. "vanilla frontend" vs. a plugin that wants to ship
  React), the lower-numbered principle wins by default; the
  higher-numbered principle's escape hatch is to live in a plugin
  with its own bundled assets.

**Version**: 1.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
