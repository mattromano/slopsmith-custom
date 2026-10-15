# Handoff: got-feedBack PR reviews + porting our custom fixes

Written 2026-10-14. State of Matt's 29 open PRs across the `got-feedBack` org, what the reviews asked for,
and which fixes made since in **slopsmith-custom** (Matt's everyday app) belong in those PRs or in new ones.

Refresh the comment data any time with:

```bash
gh search prs --owner got-feedBack --author mattromano --state open --json repository,number,title,url
gh api repos/got-feedBack/<repo>/pulls/<n>/comments      # inline review comments
gh api repos/got-feedBack/<repo>/issues/<n>/comments     # conversation (bot summaries, human tests)
gh api repos/got-feedBack/<repo>/pulls/<n>/reviews       # review summaries
```

> **Update 2026-10-14 (later): PRs consolidated.** Sections 1-2 and the PR table below describe the old set.
> Open now (15): feedBack#1083, #1085, #1087, #1089, #1091, #1099, #1101, #1105; drums#25 (scoring, replaces #20),
> drums#26 (3D highway, stacked on #25, replaces #22); notedetect#84 (replaces #72/#74/#76/#78/#80/#82);
> nam-tone#17, #19; multiplayer#22; feedpak-spec#68. #1091/#1105/spec#68 are the drum-metadata chain drums#25 uses.
> Closed: drums#20/#22/#23/#24, notedetect#72-#82, feedBack#1092/#1094/#1096, desktop#132, multiplayer#24/#25/#27.
> Review fixes done: nam-tone#17 (d1c4400), feedBack#1083 (94c37d8), feedBack#1087 CHANGELOG (5b060c0).
> New worktrees: wt-drums-scoring, wt-drums-rbhighway, wt-nd-scoring. Multiplayer work is deliberately not carried.

## 1. Where the reviews stand

Only two reviewers have commented: **CodeRabbit** (automated) on most PRs and **odntht** (a person, who tested
#1087 and #1089 end to end). No maintainer approvals or change requests yet.

**CodeRabbit didn't review 19 of the 29 PRs.** It hit its free-tier rate limit ("Review limit reached"), skipped
two drums PRs as too big (>100 files), and skips drafts by default. Once the limit resets, comment
`@coderabbitai review` on each PR to trigger it (drafts too).

| Status | PRs |
|---|---|
| Has actionable CodeRabbit findings | drums#20, nam-tone#17, notedetect#72, feedBack#1083 (nitpick) |
| Reviewed, nothing actionable | feedBack#1085, multiplayer#22, desktop#132 |
| Human-tested, LGTM | feedBack#1087, feedBack#1089 |
| Draft, never reviewed | feedBack#1091, feedBack#1105, feedpak-spec#68 |
| Too many files (>100), skipped | drums#23, drums#24 |
| Rate-limited, never reviewed | feedBack#1092, #1094, #1096, #1099, #1101; drums#22; multiplayer#24, #25, #27; nam-tone#19; notedetect#74, #76, #78, #80, #82 |

## 2. Review findings to work through (checklist)

Local worktrees already exist for every PR under `C:\Users\mattr\Desktop\repos\feedback-upstream\wt-*`
(table in section 5). Fix there, push to the same branch, and the PR updates.

### feedBack-plugin-drums#20 — YARG scoring engine (`wt-drums-engine`, 6 findings)
- [ ] **Major: positive input offset does nothing.** `_syncSession` advances the engine on raw
      `bundle.currentTime` while hits use `_inputTime()` (time minus `inputOffsetMs`), so a late-registered hit
      finds its note already missed. Fix: `_session.update(t - (_cfg.inputOffsetMs || 0) / 1000)`
      (screen.js ~1379-1384). Note our custom drums plugin set the input offset to +30 ms
      (commit e607f19), so this bug matters in practice.
- [ ] MIDI velocity passed raw (1-127); the engine's `normVelocity` only divides values > 1, so velocity 1
      reads as full strength. Pass `velocity / 127` at screen.js ~1866.
- [ ] Star power can't be activated on charts with star-power phrases but no fills: the engine switches to
      manual activation, but no input calls `_session.activate`. Wire a pad/key to it, or generate fills
      (screen.js ~1386-1398).
- [ ] A retry after a script-load failure can't succeed: the failed `<script>` stays in the DOM, so
      `_loadScript` resolves at once. Remove failed, unregistered script elements before clearing
      `_scoringPromise` (screen.js ~626-628).
- [ ] Docs: README 84-85 / CHANGELOG 16-17 should say legacy charts with GM 35 double-kick notes can still
      offer Expert+.
- [ ] Docs: NOTICE.md 20 / README 145-146: LGPL-3.0 section 2(b) also allows conveying a modified copy under
      the GPL; don't say "must stay under LGPL-3.0".

### feedBack-plugin-nam-tone#17 — keep model/IR when editing a preset (`wt-nam-editpreset`, 1 finding)
- [ ] **Major (CodeRabbit flags the PR as not mergeable until fixed):** focusing either preset dropdown calls
      `namPopulatePresetDropdowns()`, which rebuilds the options and drops the "(missing)" option the PR adds,
      so saving can still write an empty filename, the same data loss the PR fixes. After rebuilding each
      select, call `_namEnsureOption(sel, cur)` and restore `sel.value = cur` (screen.js ~1696). Add a test
      that focuses the dropdown and then saves.

### feedBack-plugin-notedetect#72 — score against the effective tuning (`wt-nd-retune`, 2 findings)
- [ ] **Major: tuning resync is skipped on the desktop fallback path.** Move `_ndResyncIfTuningChanged()`
      above the chart-verifier / `matchNotes(null)` branch in the detection tick (screen.js ~4222), so a
      mid-song retune is picked up on addons without the verifier API.
- [ ] **Major: rounding fractional offsets for the engine can push notes out of tolerance.**
      `_ndEngineOffsets()` rounds cents to semitones; add the worst-case rounding error to
      `pitchCheckCents` when calling `setChart` (screen.js ~641), and leave the scoreChord window alone.
      This is the same problem our highway_tweaks patch documents ("remainder <= 50c sits inside the pitch
      tolerance"), which only holds at the default 50c tolerance. Our Live Retune "Match song" offsets
      (+25 to +50c on Oasis records) hit exactly this case.

### feedBack#1083 — GP import articulations (`wt-gp-artic`, nitpick)
- [ ] Optional: the hammer-origin lookup rescans `_seq` per origin (lib/gp2rs.py ~1052), quadratic on huge
      tracks. Build a per-string successor lookup when sorting and reuse it for hammers and slides.

### feedBack#1087 — load arrangements in library order (`wt-arr-order`, tested LGTM)
- [ ] Add the CHANGELOG line odntht suggested: `song_stats` is keyed by arrangement *index*, so on packs whose
      manifest wasn't in library order, older stats rows may show under a different arrangement once.
- [ ] Follow-up (separate PR/issue, #1027 territory): a `type: drums` chip opens the default part, because its
      index is past the highway's arrangement list. Route drums chips through `drum_parts` / `?drum_part=`.

### feedBack#1089 — don't default to a drum part (`wt-default-arr`, tested LGTM)
- [ ] Nothing to fix. odntht's side note (`?arrangement=0` opens Drums while the list shows Lead first) is the
      #1086 mismatch that #1087 fixes; mention #1087 in the PR if helpful.

## 3. Fixes from our custom Slopsmith to carry upstream

slopsmith-custom runs on the *installed* Slopsmith 0.2.9 app, so many fixes there are user-plugin patches
(mostly `plugins/highway_tweaks/screen.js`, which string-patches bundled plugins at load). Upstream they become
real code changes in the plugin repo. Port by hand into the PR's worktree; don't copy files.

### feedBack-plugin-drums (PRs #20, #22, #23, #24)
The PRs carry drums **4.1-4.4**; `slopsmith-custom/plugins/drums` is **5.18.3**, 17 commits further on
(2026-10-09/10). Worth porting, in rough order of value:
- 5.14.0 `e8ded00`: direct MIDI input (WinMM) when Web MIDI can't see the kit
- 5.14.1 `e116d5e`: the drum view refuses non-drum arrangements instead of inventing drums from guitar notes
- 5.15.0 `7e646d1` / 5.15.1 `be6987f`: one drum highway; auto kick / cymbals timed from the audio clock, never
  doubled
- 5.16.0 `8823b9a` / 5.17.0 `6a69062`: balanced dynamic drum sounds, DRS multi-mic kit, MIDI monitor, hi-hat
  pedal (CC4) articulation, faster sampled-kit loading (belongs with #23 sampled kits)
- 5.18.x `b6ef142`, `c30e659`: rebuilt Crocell kit, less generated room on kits with room mics
- `2a9c795`, `879e817`, `d65ac91`: split-screen Drum Highway stuck on Lead; "This song has no drums" message;
  Drums chart filter vs drum-audio stem filter
- Sync work in highway_tweaks / Sync Lab (`06d4168`, `f258d2e`, `adf48a9`, `e607f19`): frame-exact drum clock,
  drum hits no longer clamped to the frame, measured +30 ms input offset. Pairs with the #20 input-offset bug.

Decide first whether to fold these into the open stack (#20 → #22 → #23 → #24, already 109-110 files, which is
why CodeRabbit skips two of them) or ship them as follow-up PRs once the stack merges. Smaller follow-ups are
easier to review.

### feedBack-plugin-multiplayer (PRs #22, #24, #25, #27)
- `278276a` Multiplayer 1.1.0 (custom) vs 1.0.0 in #27: guests line up with the host using clock stamps and
  output latency, with no pitch-worklet rate nudges. A new PR on top of #27 (it needs the LAN work).

### feedBack-plugin-notedetect (PRs #72, #74, #76, #78, #80, #82)
Our highway_tweaks `note_detect` patcher is the field-tested version of several of these PRs. Check that each
PR covers everything the patch does:
- **Capo (#74):** the patch rewrites the expected pitch, the engine notes **and** chords' fret 0, zeroes the
  engine capo, and fixes the display fallback (5 edits, all-or-nothing). Confirm #74 covers the engine path and
  the display fallback, not only the browser expected pitch.
- **Fast chord runs (#76):** patches `chord-closest-time`, `chord-early-edge`, `chord-no-early-lock`.
- **Effective tuning (#72):** patches `fractional-expected`, `engine-semitones`, `resync-on-shift` (chart
  signature includes the offset, so a change re-pushes the chart). The resync-on-shift idea is what the #72
  CodeRabbit finding asks for.
- **Richer events (#78):** our `verdict-hook` / `timing-hook` diagnostics read the engine's per-string verdicts;
  useful to confirm #78's payload has what stats plugins need.
- **New issue/PR candidate, hit flash for late verdicts** (fixed locally 2026-10-14, highway_tweaks 1.22.0,
  `b64a7d9`): with the engine verifier a sustained note's / chord's verdict lands after its sustain ends, but
  highway_3d culls the gem 0.75 s after the note *starts* (and latches a chord frame at 0.55 s), so ~10% of
  hits count with no flash. The upstream fix belongs in highway_3d (measure the verdict windows from the
  sustain end, or flash on `notedetect:hit`), with an optional notedetect tweak to send the verdict arrival
  time. File it against the highway_3d plugin repo.

### feedBack (core)
- **#1094 table view:** the local bug we fixed today (compact table ignoring the tuning filter) was in the old
  play_counts plugin. The upstream PR passes the full library query (`queryParams`) to `/api/library/table`, so
  it shouldn't have it. Verify by hand: tick a tuning filter while in table view and confirm it reloads.
- **New PR candidate, cent offsets lost in conversion:** psarc→sloppak conversion drops the PSARC manifest's
  `CentOffset` (writes `centOffset: 0.0` into the arrangement JSON). Seven Oasis songs prove it (e.g. Don't Look
  Back in Anger is +45c in the PSARC, 0 in the sloppak). Upstream already reads `centOffset` everywhere
  downstream (song.py, ws_highway `song_info`, the tuner), so fixing the converter is enough. Found while
  building our `song_cents` plugin (`d562555`).
- **Possible feature PR:** measuring a recording's tuning offset from its stems (FFT peaks folded onto 12-TET,
  ~±5c against PSARC values, `plugins/song_cents/assets/estimate.js`) for songs whose charts carry no offset.

### feedBack-desktop (PR #132)
- **#132 backing-track pitch transpose:** Matt removed the song pitch-shift feature from his own app
  (2026-10-14) in favour of Live Retune. Decide whether #132 still makes sense upstream. It's reviewed with
  nothing actionable, so it can stay as is or be closed.
- **New PR candidate, live guitar pitch shift (Live Retune):** branch `feat/live-pitch-shift` on
  `mattromano/feedBack-desktop` (`db94151`), built on the **0.2.9 snapshot** (`bd60318`), not upstream `main`.
  Upstream needs a rebase onto current `main` (SourceChain has moved on). It also needs real IPC methods
  instead of riding on `setTonePolish({pitch})`, a hack that only existed so the installed 0.2.9 bridge needed
  no change. Has a ctest (`tests/live_pitch`) and an offline renderer.
- **New issue candidate, chain-op crash:** rapid native chain operations (clearChain / loadPreset / loadNAMModel /
  loadIR / loadVST / removeProcessor / moveProcessor) crash the `slopsmith_audio.node` worker thread. Our
  workaround serializes them in JS (`tools/patch_chain_lock.py`, `49b88b5`/`fef43a0`). Upstream wants an
  engine-side fix; at least file the repro. The pedal experiment hit the same crash with back-to-back
  `loadVST` / `removeProcessor` calls.
- Not for upstream as-is: `feat/open-source-pedals` (in-process loading of selected VST3s). Experimental and
  parked; Matt hasn't decided whether to keep it.

### feedBack-plugin-nam-tone (PRs #17, #19)
- Nothing to port: `slopsmith-custom/plugins/nam_tone` is an older copy (1.1.0) than the PRs (1.2.1 / 1.3.0).
- Related: our Guitar Volume plugin needed `setGain('chain', …)` calls routed through one hook in audio_engine,
  nam_tone and nam_rig_builder (`tools/patch_callers.py`). A small upstream API (a master "player level" that
  presets multiply into) would make that patch unnecessary. Optional feature request.

## 4. Suggested order

1. Quick review fixes: nam-tone#17 (blocks merge), notedetect#72 (2 majors), drums#20 (input offset +
   velocity first, then the rest).
2. CHANGELOG line on feedBack#1087.
3. Re-trigger CodeRabbit (`@coderabbitai review`) on the 19 unreviewed PRs, a few per hour (rate limit),
   then work through the new findings.
4. New small PRs: psarc→sloppak CentOffset; highway_3d late-verdict flash; multiplayer clock-stamp sync.
5. Drums 5.x port plan (fold into the stack or follow-ups).
6. Bigger: Live Retune for desktop (rebase onto upstream main, proper IPC); chain-op crash issue.

## 5. Where everything is

Clones and worktrees: `C:\Users\mattr\Desktop\repos\feedback-upstream\` (origin = `mattromano/<repo>`;
upstream = `got-feedBack/<repo>` where set).

| PR | Worktree | Branch |
|---|---|---|
| feedBack#1083 | wt-gp-artic | fix/1082-gp-import-articulations |
| feedBack#1085 | wt-gp-anchors | fix/1084-gp-import-anchors |
| feedBack#1087 | wt-arr-order | fix/1086-feedpak-arrangement-order |
| feedBack#1089 | wt-default-arr | fix/1088-default-arrangement-not-drums |
| feedBack#1091 | wt-drum-chart-import | feature/1090-drum-chart-import |
| feedBack#1092 | wt-plays-sort | feature/49-plays-sort-and-badges |
| feedBack#1094 | (no worktree; branch in `feedBack` clone) | feature/1093-library-table-view |
| feedBack#1096 | wt-queue | feature/1095-queue-album-artist |
| feedBack#1099 | wt-ci-hidden | fix/1098-capability-inspector-hidden-render |
| feedBack#1101 | wt-solo-sections | feature/1100-solo-sections |
| feedBack#1105 | wt-drum-ws-meta | feature/1104-stream-drum-gameplay-metadata |
| feedBack-desktop#132 | wt-desk-pitch | feature/131-backing-pitch-shift |
| drums#20 | wt-drums-engine | feature/19-yarg-scoring-engine |
| drums#22 | wt-drums-3d | feature/21-rock-band-3d-view |
| drums#23 | wt-drums-kits | feature/3-sampled-kits |
| drums#24 | wt-drums-page | feature/1-drums-settings-page |
| multiplayer#22 | wt-mp-apos | fix/21-add-button-apostrophe |
| multiplayer#24 | wt-mp-arr | feature/23-real-arrangement-picker |
| multiplayer#25 | wt-mp-join | feature/6-join-links |
| multiplayer#27 | wt-mp-lan | feature/26-lan-players |
| nam-tone#17 | wt-nam-editpreset | fix/16-edit-preset-keeps-model |
| nam-tone#19 | wt-nam-picker | feature/18-player-preset-picker |
| notedetect#72 | wt-nd-retune | feature/24-follow-retune-offset |
| notedetect#74 | wt-nd-capo | fix/73-capo-expected-pitch |
| notedetect#76 | wt-nd-chordruns | fix/75-fast-chord-runs |
| notedetect#78 | wt-nd-judgment | feature/77-richer-judgment-events |
| notedetect#80 | wt-nd-techflags | fix/79-technique-flags-misread |
| notedetect#82 | wt-nd-sections | fix/81-sections-on-engine-path |
| feedpak-spec#68 | wt-spec-drums-meta | feature/67-drums-gameplay-metadata |

Custom-side references: `FORK-HANDOFF.md` (our feedBack fork plan), `SYNC-HANDOFF.md` (sync work),
`plugins/highway_tweaks/screen.js` (all the bundled-plugin patches), and
`%APPDATA%\slopsmith-desktop\plugins\highway_tweaks\jank_log.jsonl` (per-song judgment logs with engine verdicts).
