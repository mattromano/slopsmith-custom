# Cross-Artifact Analysis: Slopsmith Platform

**Date**: 2026-05-09
**Inputs**:
- [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md)
- [`spec.md`](./spec.md)
- [`plan.md`](./plan.md)
- [`tasks.md`](./tasks.md)
- [`clarify.md`](./clarify.md)
- Repo: `/home/byron/Repositories/slopsmith` (VERSION 0.2.7)

> Cross-artifact consistency report on the four spec-kit artifacts above
> against the actual implementation. Sections: **Coverage** (does the
> spec describe what the code does?), **Drift** (do the artifacts agree
> with each other?), **Gaps** (where the code has behaviour the spec is
> silent on), **Recommendations**.

## Coverage

| Repo capability | Constitution | Spec | Plan | Tasks | Status |
|---|:-:|:-:|:-:|:-:|:-:|
| Library scan + browse + filter + sort + favourites | I, IV | US1 / FR-001..007 | "Library browse" data flow | T020–T034 | Covered |
| PSARC in-memory metadata reading | IV | FR-025 | `lib/psarc.py` | T020 | Covered |
| Sloppak format support | IV | FR-027,028 | `lib/sloppak.py` | T022, T115 | Covered |
| Highway + WebSocket protocol | I, II | US2 / FR-008..015 | "Player + highway" | T050–T069 | Covered |
| `setRenderer` viz contract | III | FR-012, US2 AS#2 | "Plugin lifecycle", "Key design decisions" | T063–T065, T150 | Covered |
| Overlay viz contract | III | FR-013 | (mentioned in plan) | T066 | Covered (lighter than setRenderer in plan — mentioned only by getter list) |
| Loops + 4-count click | I | US3 / FR-016,017 | n/a | T090–T095 | Covered |
| Rescan (incremental + full) + SSE progress | IV | FR-006,007 / US4 | "Cold start" data flow | T110–T119 | Covered |
| Plugin loading + `load_sibling` + `context["log"]` | III, VI | US5 / FR-018..024 | "Plugin lifecycle" | T140–T152 | Covered |
| Frontend plugin hooks (`window.slopsmith.audio`, shortcuts, diagnostics.contribute) | III, VI | FR-022 | "Key design decisions" | T148, T149, T218 | Covered |
| Retune | IV | US6 / FR-029 | n/a | T170–T173 | Covered |
| Settings export/import (two-phase) | VII | US7 / FR-030,031 | "Two-phase settings import" | T190–T196 | Covered |
| Diagnostics bundle | VI | US8 / FR-032 | "Diagnostics bundle" | T210–T220 | Covered |
| `VERSION` + `/api/version` + auto-bump workflow | VII | FR-033 | "Versioning" | T007 | Covered |
| Structured logging + `X-Request-ID` correlation | VI | FR-034 | (in plan technical context) | T003, T008/T245 | Covered |
| Demo-mode guard middleware (`_demo_mode_guard`) | I (single-user) | not mentioned | mentioned in plan "Constitution Check" | not in tasks | **Partial** — see Gaps |
| Edit metadata from library | IV | US1 list | not mentioned in plan | T032 | Covered |
| Multiplayer plugin (in `plugins/multiplayer/`) | III | not mentioned | not mentioned | not mentioned | **Gap** — see Gaps |
| `the_daily` plugin (in `plugins/the_daily/`) | III | not mentioned | not mentioned | not mentioned | **Gap** — see Gaps |
| `transpose_chords` plugin | III | not mentioned | not mentioned | not mentioned | **Gap** — see Gaps |
| Tour engine (`static/tour-engine.js` + CSS) | II (frontend) | not mentioned | not mentioned | not mentioned | **Gap** — see Gaps |
| Bundled audio demo files (`static/audio_*.mp3`) | II (frontend) | not mentioned | mentioned in plan repo tree | not mentioned | Cosmetic gap |

**Summary**: the four spec artifacts cover the user-facing behaviour
that ships in `server.py`, `static/`, and `lib/` very thoroughly. The
gaps are at the edges: undocumented in-tree plugins, the demo-mode
guard, and the marketing tour engine.

## Drift

Inconsistencies between artifacts:

1. **Constitution Principle V vs. README on test targets.** The
   constitution says "pure helpers added to `lib/` SHOULD ship with
   pytest coverage." The README explicitly names `lib/tunings.py` and
   `lib/song.py` as the *current* covered targets and `sloppak_convert.py`
   + `gp2rs.py` as natural follow-ups. The spec does not mention this
   roadmap; `tasks.md` does pick it up (T242, T243). **Severity: low** —
   the artifacts agree, the roadmap is just only in two places.

2. **Spec FR-039 vs. clarify.md vs. `CLAUDE.md` "Common Pitfalls" #4 on
   concurrent WebSocket connections.** Spec marks
   `[NEEDS CLARIFICATION]`; clarify.md says `[OPEN]`; `CLAUDE.md` says
   "the server supports many simultaneous WebSocket connections to the
   same song." All three positions are technically consistent but the
   spec's `[NEEDS CLARIFICATION]` is harsher than the implementation
   reality (it works in production at unspecified scale).
   **Severity: low** — wording, not behaviour.

3. **Plugin gitlinks vs. constitution.** The constitution says plugins
   "are typically separate git repos." `tasks.md` Phase 5 lists ~30
   plugins, all in-tree. There is no contradiction, but a future
   reader might wonder why some `plugins/<name>/` are submodules,
   some are `.git`-shadowed clones, and some appear to be plain
   directories. **Severity: low** — clarify.md addresses this; could be
   surfaced more clearly in `CLAUDE.md`.

4. **Constitution Principle VI ("`print()` is legacy") vs. plan ("phase 2
   of #155 ongoing") vs. tasks (T008, T245).** All three say the same
   thing; the inconsistency is only in tone — the constitution says
   "must not add new ones" while the plan says it's "in flight." This
   is the correct framing (the rule is in force; the cleanup is in
   flight) but a casual reader could misread the plan as relaxing the
   rule. **Severity: low** — consider a one-liner in `plan.md` clarifying
   that the rule is binding for new code today, regardless of the legacy
   migration's progress.

5. **`spec.md` US5 AS#2 mentions `matchesArrangement`** but does not
   explicitly require Auto-mode evaluation on every `song:ready`. The
   actual implementation (per `CLAUDE.md`) re-evaluates Auto on every
   `song:ready`, including switching from a 2D renderer to a WebGL
   renderer mid-session. The spec is silent on this re-evaluation
   timing. **Severity: medium** — could let a future contributor
   "optimize" Auto by caching the picked renderer at first match.

6. **`docs/sloppak-spec.md` and `docs/diagnostics-bundle-spec.md` are
   cited by both the spec and the plan but are not themselves
   spec-kit artifacts.** They predate this retrospective and are the
   real source of truth for the wire formats. **Severity: low** — the
   spec correctly defers to them; consider symlinking or excerpting
   their key contracts into `specs/001-slopsmith-platform/contracts/`
   for spec-kit completeness.

## Gaps

Areas where the code has shipping behaviour that the spec is silent
on, or where rules are ambiguous:

1. **Demo-mode guard** — `server.py:179` defines a `_demo_mode_guard`
   middleware and a `register_demo_janitor_hook` mechanism. This
   exists for hosted public demos (e.g. a slopsmith.example.com that
   resets state nightly). The constitution says "single-user, no
   auth" but the demo path is a *real* multi-tenant-adjacent scenario
   the code supports. The spec should either (a) call out demo mode
   as a supported but separate scenario or (b) move demo-mode logic
   out of core into a plugin if it violates Principle I.

2. **Plugins not enumerated in spec/tasks** — `plugins/multiplayer/`,
   `plugins/the_daily/`, `plugins/transpose_chords/`,
   `plugins/rocksmith_highway/` (which `MEMORY.md` notes is
   *abandoned*) are present in-tree but neither the README plugin
   table nor `spec.md` mention them. Some of these are work-in-progress
   or experimental; some may be deprecated.
   The plugin inventory should either be fully enumerated somewhere
   (probably `README.md`'s Available Plugins table) or have a clear
   policy for "experimental/incubating plugins not yet listed."

3. **Tour engine** — `static/tour-engine.js` + `static/tour-engine.css`
   ship a guided onboarding tour. Neither the spec nor the README
   mention it. If it is user-facing, it should be a story (e.g.
   "First-run onboarding"). If it is dev-only, it should be in `docs/`.

4. **Audio offset env vars / ranges** — `CLAUDE.md` mentions audio
   offset shortcuts (`[`/`]` ±10ms; Shift ±50ms) but the spec does
   not enumerate the persisted offset key or its valid range. Plugin
   authors interacting with playback timing have to read the source.

5. **Plugin manifest fields beyond the documented set** — the
   `plugin.json` spec in `CLAUDE.md` documents `id`, `name`,
   `version`, `private`, `type`, `nav`, `screen`, `script`, `routes`,
   `settings`, `diagnostics`. The actual loader in
   `plugins/__init__.py` may accept or ignore additional fields
   (tested? validated?). A canonical JSON Schema would close this gap
   (see Recommendations).

6. **Sloppak "directory form" vs. "zip form" hot-reload** — the
   spec mentions both forms exist but does not specify whether the
   server watches the directory form for changes during live editing.
   `CLAUDE.md` is also silent on this. A plugin author working on
   the editor plugin would benefit from knowing.

7. **WebSocket disconnect / reconnect semantics** — the spec
   describes the message order from `loading` to `ready` but does not
   specify what happens when a client disconnects mid-stream
   (e.g. browser tab thrash). The code uses
   `try/except WebSocketDisconnect` but the user-visible behaviour
   (does the highway resume? restart? recompute?) is not described.

8. **`config.yaml` schema** — Server-side settings live in
   `CONFIG_DIR/config.yaml` (per `_load_config` `server.py:1618`).
   The spec mentions `/api/settings` but does not enumerate the
   keys. `_validate_server_config_types` (`server.py:1763`) is the de
   facto schema; surfacing it as a documented schema would help.

9. **Plugin uninstall semantics** — Update Manager plugin
   uninstalls plugins. The spec is silent on what happens to
   `localStorage` keys, `meta.db` rows, and `settings.server_files`
   left behind by an uninstalled plugin.

## Recommendations

Top improvements, ordered by ROI:

1. **Resolve the `[NEEDS CLARIFICATION]` markers in `spec.md`** by
   landing the answers in `clarify.md` and removing the ambiguity:
   - Browser support matrix (FR-037 / clarify Q "What is the
     supported browser matrix?")
   - Library size scaling envelope (FR-038, SC-001)
   - Concurrent WebSocket ceiling (FR-039)
   This is the cheapest way to make the spec self-contained for an AI
   agent operating without `git blame` or maintainer access.

2. **Document `meta.db` schema and migration policy** (closes
   `tasks.md` T009 and clarify.md "How is `meta.db` schema
   versioned?"). The constitution mandates additive/idempotent
   migrations but does not point readers at where the migrations
   live. A short table in `CLAUDE.md` listing each historical column
   add (e.g. `stem_ids`, `tuning_name`, `tuning_sort_key` from
   slopsmith#22/#129) would suffice.

3. **Publish a JSON Schema for `plugin.json`** under
   `docs/plugin-schema.json` and reference it from `CLAUDE.md`.
   Today the validation rules are scattered across the loader, the
   `settings.server_files` allowlist, and the `diagnostics`
   sub-spec. A single schema makes plugin authoring self-service and
   gives the loader something to validate against (closes T161).

4. **Audit and document the in-tree plugin set** — for each
   `plugins/<name>/`, decide: bundled with core (document in
   README), separate repo (link in README plugin table), or
   experimental/abandoned (move to a `plugins-experimental/` tier or
   delete). The `rocksmith_highway` directory is explicitly marked
   abandoned in `MEMORY.md` but still ships.

5. **Either lift demo-mode into a constitutional exception or move
   it to a plugin.** Today it is a load-bearing middleware in core
   that contradicts Principle I if read literally. A short paragraph
   in the constitution acknowledging "demo deployments are a
   supported secondary scenario gated by `_demo_mode_guard`" would
   close the loop without code changes.

6. **Cross-link `docs/sloppak-spec.md` and
   `docs/diagnostics-bundle-spec.md` from the spec's "Key Entities"
   section** so they are reachable in one click from the spec-kit
   artifact tree. Optionally symlink them under
   `specs/001-slopsmith-platform/contracts/`.

7. **Define a "what counts as core vs. a plugin" decision rubric**
   in the constitution. Today the line is implicit ("if it's a
   feature, it's a plugin"). Putting an explicit rubric in
   Principle III (e.g. "anything that a non-musician user could
   live without is a plugin") would make future contributions
   self-routing.

---

## Severity-of-finding summary

| Severity | Count |
|---|---:|
| Drift items (high) | 0 |
| Drift items (medium) | 1 (Auto-mode re-evaluation timing) |
| Drift items (low) | 5 |
| Coverage gaps | 4 (demo-mode, undocumented plugins, tour engine, ad-hoc audio offset) |
| `[NEEDS CLARIFICATION]` to resolve | 3 (FR-037, FR-038/SC-001, FR-039) |

No high-severity issues found. The spec-kit artifacts and the
codebase are coherent; the recommendations above are quality-of-life
improvements rather than bug fixes.
