# Highway look — handoff for the next session (2026-10-09, Windows PC)

Two tasks from Matt:

1. **Drums should look as close to Rock Band as possible.** He likes the symbol icons, but the drum gems
   look better as the **rectangles** Rock Band uses. "Do whatever else to make it look more Rock Band."
2. **Guitar: make it obvious whether you hit a note or not**, especially in runs of chords. Something like
   Rock Band's guitar highway, where a hit is unmistakable and a miss is too.

Read `DRUMS-HANDOFF.md` first for how Matt's setup runs. The short version: the app he plays is the
installed Slopsmith desktop 0.2.9. Our plugins are **user plugins** in `%APPDATA%\slopsmith-desktop\plugins\<id>`,
deployed by copying from this repo. Ctrl+R reloads JS; a `routes.py` change needs an app restart.
Commit and push straight to `main` in this repo; never push the `Desktop\slopsmith` fork (its origin is upstream).

---

## 1. Drums → Rock Band look

**Where:** `plugins/drums/highway3d.js`, `createView()` (the Three.js scene, about line 900 on). The 3D view is
the default (View = Auto with WebGL2). The 2D lane view (`screen.js` `_draw`) is secondary.

What's there now:
- **Pads / toms / snare:** round "puck" gems: `padGeo` (a `LatheGeometry` of `puckProfile`), plus `padCapGeo`
  (a cap disc) and `padRimGeo` (a torus rim), about lines 1120–1131. Ghost / accent notes scale them (×0.74 / ×1.16).
- **Cymbals:** a raised dome (`domeGeo`, a half sphere), a bell, `cymRing`, and a shadow on the track, from line 1133.
- **Kick:** a full-width bar (`meshes.kick`, plus a white `stripe` for 2x kick).
- **Instancing and colour:** the render loop places every gem kind as an `InstancedMesh` (`place(mesh, idx, x, y, z, sx, sy, sz, color)`,
  "Gems." block in `render()`, about line 1530). Colours come from `LANE_COLORS` / `COLORS` (top of the file).
  The auto-kick / auto-cymbal dimming (`g.auto`) and miss colour (`missedGem`) are applied there too.
- **Strikeline:** `targets[]` (a torus ring plus a disc per lane), the kick line and glow, lane tints, and hit
  flashes (`spawnFlash`), plus sparks.
- **HUD:** a 2D canvas overlay (`drawHud`): score, multiplier, streak, stars, star-power meter, difficulty badge.

Rock Band reference points (match these, but use **no Rock Band / Harmonix / YARG artwork, fonts or logos**;
`NOTICE.md` promises original look-alike art only):
- **Drum gems are rounded rectangles** spanning most of the lane width, with a lighter top face and a dark
  bevel / edge. Replace the puck lathe with a rounded box: an `ExtrudeGeometry` of a rounded-rect `Shape`
  with a bevel, or a `RoundedBoxGeometry`-style geometry built by hand. Keep it instanced.
- **Cymbals (pro drums)** are a different shape from pads in Rock Band, a flatter, wider gem on the same
  lane. Matt likes the symbol icons, so **ask whether he means the cymbal shape or the symbols on the gems**
  before you remove anything. A safe default: rectangles for pads, a distinct flat cymbal gem, and keep
  a symbol on each.
- **Kick:** a thin full-width orange bar (already close). Rock Band draws it flatter and lower than the pads.
- **Strikeline:** a row of rectangular "pad" targets in lane colours at the bottom, not rings. On a hit,
  the target flashes and the gem disappears into a burst. Missed gems keep scrolling past and go dark.
- **Track:** a dark highway with thin lane dividers, beat lines (thick on the measure), and side rails that
  light up for star power. A blue track tint and lane-coloured gems turn white/blue during star power.
- **HUD:** multiplier and streak at the bottom left of the track, a star-power bar, and a vertical "rock
  meter" (we have no fail mode, so optional). Score and stars at the bottom right.
- **Fills:** the activation fill region (`fills[]`), already present. Rock Band shows it as a highlighted
  section ending in a green gem / chord.

Tests and checking:
- Unit tests: `node --test plugins/drums/tests/highway3d.test.js` (geometry changes mostly won't need new
  tests; the session / gems logic is covered).
- **Visual check:** `python plugins/drums/tools/dev_server.py 8766`, then open
  `http://127.0.0.1:8766/plugins/drums/tools/app.html?view=auto&paused=1` in the browser pane. Drive frames with
  `window.__harness.setTime(t); window.__harness.frame()`, because requestAnimationFrame stops while the pane
  is in the background, then take a screenshot. `tools/screenshot.mjs` / `app-check.mjs` need Playwright, which
  isn't installed on this PC.
- Bump `plugin.json` version and `ASSET_VERSION` in `screen.js` (cache-buster for `highway3d.js`) when shipping.

## 2. Guitar → obvious hit / miss feedback

**Who draws what:**
- Matt plays guitar on the **3D Highway** (`highway_3d`, bundled with the app:
  `C:\Program Files\Slopsmith\current\resources\slopsmith\plugins\highway_3d\screen.js`, about 12k lines).
  It is `"bundled": true`, so **a user plugin with the same id can't replace it**.
- Hit / miss verdicts come from the bundled **Note Detection** plugin (`plugins/notedetect/screen.js`). It
  registers a note-state provider (`highway.setNoteStateProvider`). Each note gets `{state, alpha}` with
  state `'active'` (sustain ringing on pitch), `'hit'` or `'miss'`. Chords are judged per note, plus a
  chord verdict with a leniency setting (`_ndFinalizeChordVerdict`). Settings cover timing / pitch tolerance and the
  method (YIN default). Its stats panel already counts "Chord — partial".
- The core 2D highway (`static/highway.js`) uses the same provider (`_noteState`); a miss is a faint red wash.

What the 3D Highway shows today (`highway_3d/screen.js`):
- From about line 2311: 'hit'/'active' gives a string-tinted outline glow + a bright body + a glowing sustain + a
  small sparkle. 'miss' gives a red outline + a suppressed body. A sustain verdict latch keeps the colour
  during the sustain.
- From about line 9090: chord frames get a rim colour. Teal by default, green once **all** notes hit, red on
  any miss. **That's why chord runs are hard to read:** until every verdict arrives the rim stays teal (the
  default colour), and the hit / miss differences are outline colours on gems that are already bright and moving.

**How to change it:** `plugins/highway_tweaks/screen.js` (our user plugin; the leading `_` in its name makes it
load first) already **intercepts the `<script>` tag for highway_3d, rewrites parts of its source, and loads the
patched copy from a blob URL**. That's how the colorblind G/B string colours work, and every rewrite is
skipped safely when a pattern stops matching. Use the same mechanism for the hit / miss visuals. Alternatives:
draw on the overlay via `highway.addDrawHook` / the draw-hook canvas, reading `bundle.getNoteState`. Or write a
separate visualization plugin, which would be far more work.

Ideas, Rock Band style (confirm the direction with Matt, then iterate on screenshots):
- **Hit:** the gem is "eaten" at the now line. It vanishes with a bright burst / flame in the string colour,
  the string or fret target flashes, and a short pop. Sustains keep a bright, flickering trail while
  'active'. Chord hit: one big burst across the chord box, not per-note outlines.
- **Miss:** the gem goes **dark grey / desaturated** and keeps scrolling past the now line, so it's obvious it
  wasn't taken. A red flash at the now line on that string. The streak counter resets visibly.
- **Partial chord:** a distinct state (amber), not the teal default, as soon as the verdict window closes.
  The default "not judged yet" look must differ from both hit and miss.
- **Streak / multiplier HUD** like Rock Band (notedetect already computes the score / streak; check its
  events in the README "Events" section) so a broken streak is noticed.
- Keep the colorblind palette in mind (Matt uses the G/B colour patch): hit vs miss must not rely on red vs green
  alone. Use brightness + shape (vanish vs grey-out) as well.

Checking:
- The browser pane blocks the microphone, so real detection can't run there. notedetect has a **headless
  harness** (`plugins/notedetect/tools/harness.js`, README "Headless harness") and the provider can be faked:
  register your own `highway.setNoteStateProvider((note, t) => ({state: 'hit'|'miss', alpha: 1}))` from the
  console to see each state.
- Test server: `.claude/launch.json` in `C:\Users\mattr\Desktop\repos` → **`installed-app-test`** (the installed
  app's own core on port 8002, Matt's AppData plugins, scratch config). Start it with `preview_start`. If
  frames don't advance in the background pane, use a song paused at a chord-heavy spot. Load a song with
  `playSong('sloppak/<file>.sloppak', <arrangement index>)`. Library file names are relative to the DLC folder.

---

## Other things that changed today (context)

- **drums 5.5.x:** Plugins → Drums settings page, auto kick / cymbals (now with their own sound), hit timing,
  sampled kits (Crocell default), "In Too Deep" drum-tab fix. 31 songs upgraded to hand-charted levels;
  38 album songs got GP drums. Details in `DRUMS-HANDOFF.md`.
- **tone_pack 1.3** (`plugins/tone_pack`): Tone Automation presets.
  - Category targets: Crunch / Dist → Main Lead, Lead → Metal Tone, Clean → Auto Clean (Twin).
  - Metal-artist songs → Metal Tone for crunch / distortion.
  - Tones are classified per song from their gear.
  - Main Lead loads again after a song.
  - Offline chain renderer in `plugins/tone_pack/tools/`.
  - Matt dislikes most of the generated amp tones; his own presets are what he plays.
