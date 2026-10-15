# Handoff: four fixes for our feedBack build (from the PC session, 2026-10-15)

Matt asked for these on the PC by mistake; do them on the Mac. Read `MAC-HANDOFF.md` and `feedback-fork/README.md`
first for how the build works. The build branch is `custom` on each `mattromano/*` fork; rebuild with
`gh workflow run build.yml -R mattromano/feedBack-desktop --ref custom`.

**Matt may be using the app while you work.** Don't restart or kill it. If you need a browser test, run core from
source separately (see the fork README), never play audio, and seek while paused. The findings below come from
reading the code on the PC, and the build has changed a lot, so **re-check each one against the current
`custom` code** before relying on it.

## 1. Hit/miss effects: keep the stock look on BOTH highways, in one drum view

Matt: the stock app had much better hit and miss effects. Gems carried on past the hit line, out the back of the
highway, and faded away. In our build they "just flash". That's true for **both the guitar 3D Highway and the
drums**. He wants the stock effects back, and for drums **one** view that has the stock effects plus our scoring
features ("best of both").

### Guitar (3D Highway): our highway_tweaks overrides the stock effects
- `plugins/highway_tweaks/screen.js` in the core fork (2.1.0, `custom`) string-patches `highway_3d` with
  "Rock Band-style verdicts": hits burst and vanish, misses go grey and drift, chord verdict frames. See the header
  comment around lines 30–40 and the `rbVerdicts(code)` patcher around 150–350. That replaces the stock
  note-state-provider rendering.
- Stock rendering is the feedBack#254 note-state provider: a bright outline and body, sparkle/sizzle, a shockwave on
  a fresh strike, and a red wash on a miss. See the "Note-state provider" section of core `CLAUDE.md` and
  `bundle.getNoteState`.
- **Quick check without a rebuild:** in the app's devtools console, set
  `localStorage.highwayTweaksNoRbVerdicts = '1'` and reload. That's the existing kill switch, and it should bring
  the stock look back. Confirm with Matt that this is the look he means.
- **Fix:** turn the Rock Band verdicts off in highway_tweaks (remove the patcher, or default it off). Keep the
  rest of highway_tweaks: its frame clock / stems clock work is sync-critical (see `SYNC-HANDOFF.md`).
- Also keep core commit 8aa5cd3 ("highway_3d verdict windows measured from the sustain end"), so late verdicts on
  sustained notes still show. Check it doesn't cut the stock fade-out short.

### Drums: port the stock 3D Drum Highway's effects into our drums plugin's view
- **Stock view:** core `plugins/drum_highway_3d/screen.js`, "3D Drum Highway". Its effects:
  - notes stay drawn `BEHIND = 0.4` s past the strike line, fading out (around line 277)
  - pooled hit-spark bursts (`sparks`), consecutive-hit escalation (`streakFx`) and score bursts (`_scoreBursts`)
    (around lines 1119–1122 and 1471)
  - pre-cloned hit/miss tint materials (around line 1489) and the green/red lane flash
- **Our view:** `mattromano/feedBack-plugin-drums@custom` (4.5.2), `assets/highway3d.js` (the Rock Band 3D view).
  Port the effects above into it. Keep everything ours: the YARG scoring, star power, difficulty levels, the
  timing meter and Apply, sampled kits, split-view routing, and the smoothed frame clock.
  - Both use three.js, but the scene code differs, so port the behaviour, don't paste the code.
  - The stock code is AGPL, our view is MIT. Write it fresh, or note the licence if code is copied.
- **Why Auto stopped choosing the stock view:** core custom commit e035ba8 makes `drum_highway_3d` step aside in
  Auto when the drums plugin is installed. Keep that, so ours is the only drum view Auto picks.
- Run the drums tests (`node tests/<x>.test.js` for engine, session, screen, highway3d and kits), and add a
  highway3d test for the past-the-line and fade window.

## 2. Show only the main highways in the visualization picker

Matt: "only have the main highways listed, I don't care about 2D and stuff like that."
- **Keep:** Auto, 3D Highway (guitar/bass), our Drums 3D view, and Keys Highway 3D. Ask Matt about keys if unsure.
- **Hide:**
  - the built-in 2D highway
  - our drums 2D view (`feedBackViz_drums2d`)
  - the stock 3D Drum Highway (once task 1 is done)
  - Piano, Tab, Jumping Tab, Staff View and SlopScale, as picker entries
- Find where core builds the main player's picker and splitscreen's per-panel picker (core `static/app.js` / the v3
  player code; search for `feedBackViz_` and the picker `<select>`). Add a `custom:` hide-list there. Hidden
  renderers must keep working if something selects them explicitly, e.g. a saved `localStorage.vizSelection` or
  Auto. Simplest is to hide them only from the menus.
- Check what Auto falls back to when nothing matches. Today that's the built-in 2D highway, and it should be
  3D Highway for guitar/bass.

## 3. Lead guitar by default (it keeps opening Bass)

- Probable cause: the server picks the start arrangement from the user's "default arrangement" setting, else the
  part with the **most notes**, and bass parts often have the most. See core #1089 (`fix/1088`, merged in custom):
  "don't default to a drum part on most-notes fallback". Find that fallback (ws_highway / server.py /
  `lib/song.py`; search `most notes` / `default_arrangement`).
- **Fix in custom:** when no default is set, start on library order (Lead > Combo > Rhythm > Bass) instead of
  most notes, i.e. Lead whenever the song has one. Also check whether Settings has a default-arrangement option,
  and set it to Lead if that's simpler.
- Don't break explicit picks: library chip `?arrangement=N`, playlists' pinned arrangements, multiplayer.

## 4. Multiplayer: Drums missing from the part picker when the queue is empty

- **Cause:** confirmed on the Mac's room. With nothing queued, the picker falls back to
  `DEFAULT_ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass']` in `mattromano/feedBack-plugin-multiplayer@custom`
  `screen.js` (around line 4637), so there's no Drums.
- Picking Drums does work once a drum song is queued. `?arrangement=3` on `afimiss.sloppak` loads "Drums"
  (checked against the Mac app).
- **Fix:** add `'Drums'` to `DEFAULT_ARRANGEMENTS`, update `tests/arrangements.test.js` lines 45–47, and add a test
  that `_arrangementChoices([], 'Drums')` offers and selects Drums.
- A branch `custom-drums-default` was created on the PC with nothing committed. Ignore it and start fresh.

## Finish
1. Commit each fix on the right fork's `custom`:
   - identity: `mattromano <42412983+mattromano@users.noreply.github.com>`, `-s`
   - trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
   - first tag the old `custom` as a backup, e.g. `custom-backup-2026-10-15b`
2. Bump the drums plugin version and `ASSET_VERSION`, so cached assets reload.
3. Run the Build workflow. Check it's green, and check the Mac zip has the new drums version, highway_tweaks
   version and core changes.
4. Tell Matt to install it the same way as before: quit the app, replace `/Applications/feedback.app`, run the
   `xattr` command.
5. Update `MAC-HANDOFF.md`.
