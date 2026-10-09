# Clarifications: Slopsmith Platform

> Questions a future contributor or AI agent might ask after reading the
> spec, with the best inferable answer from `CLAUDE.md`, `README.md`,
> `CHANGELOG.md`, and the source. `[OPEN]` means the answer is not derivable
> from the existing artifacts and needs a maintainer decision.

### Q: Why is there no auth / login? Is multi-user planned?

**A:** Slopsmith is intentionally a self-hosted, single-user app. The
constitution (Principle I) explicitly forbids introducing a user/account
model. The deployment story is "one container, one user, one DLC folder."
Users who need multi-user would run multiple containers behind their own
reverse proxy. There is no roadmap to change this.

### Q: Why vanilla JS — is a framework migration planned?

**A:** No. Constitution Principle II makes "no frontend framework, no JS
build pipeline" non-negotiable for core. Plugins MAY ship bundled assets
(some viz plugins do — e.g. tabview wraps alphaTab), but core
`static/app.js`, `static/highway.js`, `static/index.html`, and
`static/style.css` are source-served plain JS and must stay that way.
Tailwind via CDN is the only style framework allowed.

### Q: Where is the canonical list of WebSocket message shapes?

**A:** `CLAUDE.md` "WebSocket Protocol Reference" section is the
authoritative list. The shapes are produced by `server.py`'s `highway_ws`
handler (`server.py:2906`) and consumed by
`static/highway.js` (`createHighway` factory). Adding a new message type
requires updates to both ends + `CLAUDE.md` + a CHANGELOG note if it is
not strictly additive.

### Q: How do plugins survive a `git checkout` on the main repo?

**A:** They often don't, which is documented as a known pitfall in
`CLAUDE.md` "Common Pitfalls" #2. Plugins are typically separate git
repos cloned into `plugins/<name>/`. The recommended workaround is
`git update-index --assume-unchanged plugins/<name>` and avoiding
`git clean -fd` near `plugins/`. There is no in-tree submodule manifest;
the user is expected to manage their own plugin directory.

### Q: What happens when two plugins export the same `window.slopsmithViz_<id>`?

**A:** The plugin loader does not enforce uniqueness on the JS side —
the second-loaded plugin's factory wins because it overwrites the
property on `window`. Plugin authors must keep their `id` in
`plugin.json` unique within the user's installation. Backend route
collisions are prevented by the
`/api/plugins/<plugin_id>/...` namespace, which inherits the same
uniqueness assumption.

### Q: Is sloppak the future and PSARC the past?

**A:** Sloppak is the *preferred new* format for new features (per
`CLAUDE.md` "Song Formats" and Principle IV). PSARC support is a
permanent constitutional requirement — the whole product premise is
"point at a Rocksmith DLC folder and it works." Sloppak augments
PSARC with stems, hand-editable manifests, and an open spec
(`docs/sloppak-spec.md`); it does not replace it.

### Q: How is the F# `RsCli` SNG → XML converter integrated?

**A:** Bundled inside the Docker image via the `Dockerfile`. Invoked
as a subprocess from `lib/psarc.py` / song-loading paths when an SNG
binary is encountered (typically official disc DLC). The source is
[Rocksmith2014.NET](https://github.com/iminashi/Rocksmith2014.NET); we
ship a thin F# CLI wrapper. Updates to RsCli flow in via Dockerfile
revisions, not at runtime.

### Q: What is the supported browser matrix?

**A:** `[OPEN]`. `CLAUDE.md` flags Chromium-family for Web MIDI–
dependent plugins (drums, piano, midi_amp, MIDI capo) and assumes
WebGL2 for the 3D highway and other WebGL viz. There is no published
"minimum browser" matrix or compatibility table.

### Q: What is the upper bound on library size?

**A:** `[OPEN]`. README claims "handles 80,000+ songs" via server-side
pagination and SQLite, and CLAUDE.md notes 8-thread parallel scanning.
No published memory/CPU benchmarks; no documented hard ceiling.
Consider this an aspirational scaling target validated empirically by
power users, not a tested SLA.

### Q: What is the upper bound on concurrent WebSocket connections?

**A:** `[OPEN]`. `CLAUDE.md` "Common Pitfalls" #4 says "the server
supports many simultaneous WebSocket connections to the same song"
(splitscreen, lyrics pane, jumping tab pane each open their own) but
no documented ceiling. uvicorn defaults apply.

### Q: How are plugin requirements resolved — is there dependency
isolation between plugins?

**A:** Plugins ship a `requirements.txt`; the loader installs them
into the shared container Python environment on first load (per
`plugins/__init__.py`). There is **no per-plugin venv** — two plugins
that pin conflicting versions of the same dependency are mutually
incompatible and the loser will break at import. This is a known
trade-off favouring deployment simplicity over strict isolation. The
mitigation is the diagnostics bundle's plugin inventory, which makes
conflicting installs visible.

### Q: How is `meta.db` schema versioned?

**A:** `[OPEN]`. The constitution mandates "schema migrations MUST be
additive and idempotent" but the actual versioning mechanism inside
`MetadataDB` (`server.py:226`) is not documented. Worth a follow-up
note in `CLAUDE.md` listing the column-add policy and any historical
migrations applied at startup.

### Q: What is the relationship between this repo and `slopsmith-desktop`?

**A:** Slopsmith Desktop (`https://github.com/byrongamatos/slopsmith-desktop`)
is a downstream Electron wrapper that bundles the same web app plus a
JUCE-based audio engine, VST3/AU/LV2 hosting, NAM amp modeling, and
cabinet IRs. Releases of `slopsmith-desktop` fire a `repository_dispatch`
event (`desktop-released`) into this repo, which auto-bumps the `VERSION`
file via `.github/workflows/sync-version.yml` (the only sanctioned
exception to "never push directly to `main`").
