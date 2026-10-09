# Drums (Rock Band–style) — overnight progress log

Branch: `drums-rockband`. Work tree: `~/drums-work/slopsmith-custom`.
Python env for tests: `~/drums-work/.venv` (uv; slopsmith requirements + numpy/scipy/librosa/soundfile).

## Status

| # | Milestone | State |
|---|-----------|-------|
| 0 | Import feedBack drums (871eb0e) + multiplayer (c9267ae) plugins into `plugins/` | done |
| 1 | `ch_to_sloppak.py` chart converter | in progress |
| 2 | Multiplayer arrangement dropdown | in progress |
| 3 | Drum-chart joiner | pending |
| 4 | JS drum engine (YARG port) | in progress |
| 5 | 3D Rock Band–style renderer | pending |
| 6 | Exporter (stretch) | pending |

## Decisions

- Baselines before any change: core `pytest` 838 passed; drums plugin `node --test tests/screen.test.js` 16 passed.
- Plugins copied without their `.git` (plain directories, like the other plugins in this repo). Upstream commits
  recorded above so they can be re-synced later.

## Open issues

## Test by hand (needs real hardware / real songs)
