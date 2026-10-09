# slopsmith-custom

My customized [Slopsmith](https://github.com/byrongamatos/slopsmith) setup, plus the **song builder**: a
workflow that turns Guitar Pro tabs plus my own album MP3s into graded, stem-split Slopsmith charts
(`.sloppak`), with a Claude Code skill that drives it.

| Folder | What it is |
|---|---|
| `slopsmith/` | Slopsmith (AGPL-3.0, upstream history kept via git subtree) + my changes: GP→RS converter fixes in `lib/gp2rs.py` and the song-builder scripts in `scripts/` |
| `plugins/note_detect/` | note_detect plugin, `feat/retune-offset` branch (follows the Auto-Tuner retune offset) |
| `plugins/nam_tone/` | NAM amp plugin with a live preset picker in the player |
| `plugins/autotune/` | My Auto-Tuner plugin (snapshot; full history stays in the local repo) |
| `slopsmith-desktop/` | Desktop app changes (backing-track pitch shift) as patches on upstream; see its README |
| `song-builder/` | The skill, setup scripts, feedBack Studio setup, album recipes (YAML) and working notes |
| `.claude/skills/` | The same skill, auto-loaded when Claude Code runs inside this repo |

## Song builder at a glance

```bash
# one-time setup (host packages, MIR venv with Basic Pitch + beat refiner, skill, album YAMLs)
powershell -ExecutionPolicy Bypass -File song-builder/setup.ps1 -Slopsmith C:/Users/mattr/Desktop/slopsmith
```

```bash
# then, from the slopsmith folder, using the MIR venv:
_build/.mirvenv/Scripts/python.exe scripts/song_builder.py plan  _build/albums/ALBUM.yaml
_build/.mirvenv/Scripts/python.exe scripts/song_builder.py build _build/albums/ALBUM.yaml
_build/.mirvenv/Scripts/python.exe scripts/song_builder.py tune  _build/albums/ALBUM.yaml
_build/.mirvenv/Scripts/python.exe scripts/song_builder.py build _build/albums/ALBUM.yaml --notation-only
```

- **plan:** picks Lead, Rhythm and Bass from the tab. Extra guitar parts fill empty bars, and vocal/synth/drum tracks are skipped.
- **build:** syncs the tab to the recording (beat_this, beat-level DTW or constant tempo) and splits 6 Demucs stems.
- **tune:** settles close sync-method calls by checking the charts against the stems.
- **check:** grades every part with Basic Pitch ("lift" = how much better than luck the chart matches its own stems).
- **`--notation-only`:** rebuilds just the charts in about 1-2 s a song, reusing the stems and the stored sync map.
- **Drifting sections:** fix them by dragging bar markers in feedBack Studio (`song-builder/feedback-studio/`), then
  `scripts/rebuild_song.py EDITED.feedpak`.

The full workflow and the lessons learned are in `song-builder/skill/SKILL.md` and `song-builder/notes/HANDOFF.md`.

## Keeping this repo current

Work in the live checkouts on the Desktop, commit there, then run `sync_from_local.ps1` here and push.

## What's deliberately not in here

Guitar Pro tabs (Songsterr/UG downloads), album audio, cover art, built `.sloppak` files, the `_build/`
workspace and `.env`. Third-party plugins that I haven't changed are installed from their own repos.

## License

Slopsmith and its plugins keep their upstream licenses (Slopsmith is AGPL-3.0, see `slopsmith/LICENSE`).
Modified versions here are distributed under those same terms.
