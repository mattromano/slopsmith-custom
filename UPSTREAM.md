# Upstreaming to got-feedBack

Tracks the issues and PRs that port this repo's custom work into the [got-feedBack](https://github.com/got-feedBack) org.

- **Forks:** `mattromano/<repo>`
- **Clones:** `C:\Users\mattr\Desktop\repos\feedback-upstream\`

## Wave 1: small fixes

| Item | Repo | Issue | PR | Status |
|---|---|---|---|---|
| GP import articulations (H/P, slides, ghosts) | feedBack | [#1082](https://github.com/got-feedBack/feedBack/issues/1082) | [#1083](https://github.com/got-feedBack/feedBack/pull/1083) | open |
| GP import anchors | feedBack | [#1084](https://github.com/got-feedBack/feedBack/issues/1084) | [#1085](https://github.com/got-feedBack/feedBack/pull/1085) | open |
| Feedpak unpack race | feedBack | — | — | already upstream (#534) |
| Feedpak arrangement order | feedBack | [#1086](https://github.com/got-feedBack/feedBack/issues/1086) | [#1087](https://github.com/got-feedBack/feedBack/pull/1087) | open |
| Default arrangement never Drums | feedBack | [#1088](https://github.com/got-feedBack/feedBack/issues/1088) | [#1089](https://github.com/got-feedBack/feedBack/pull/1089) | open |
| Instrument viz takeover | feedBack | — | — | dropped (conflicts with explicit-pick contract; see #298) |
| Note detect follows retune offset (chart-transform) | feedBack-plugin-notedetect | [#24](https://github.com/got-feedBack/feedBack-plugin-notedetect/issues/24) | [#72](https://github.com/got-feedBack/feedBack-plugin-notedetect/pull/72) | open |
| NAM: editing a preset keeps model/IR | feedBack-plugin-nam-tone | [#16](https://github.com/got-feedBack/feedBack-plugin-nam-tone/issues/16) | [#17](https://github.com/got-feedBack/feedBack-plugin-nam-tone/pull/17) | open |
| NAM: preset picker in the player | feedBack-plugin-nam-tone | [#18](https://github.com/got-feedBack/feedBack-plugin-nam-tone/issues/18) | [#19](https://github.com/got-feedBack/feedBack-plugin-nam-tone/pull/19) | open |

## Wave 2: drums

| Item | Repo | Issue | PR | Status |
|---|---|---|---|---|
| Drum gameplay metadata in drum_tab (FEP, 1.20.0) | feedpak-spec | [#67](https://github.com/got-feedBack/feedpak-spec/issues/67) | [#68](https://github.com/got-feedBack/feedpak-spec/pull/68) | draft (awaiting FEP discussion) |
| Drum chart import (CH/RB/YARG .mid/.chart/.sng ↔ feedpak) | feedBack | [#1090](https://github.com/got-feedBack/feedBack/issues/1090) | [#1091](https://github.com/got-feedBack/feedBack/pull/1091) | draft (needs spec #68) |
| Stream drum gameplay metadata on highway WS (stacked on #1091) | feedBack | [#1104](https://github.com/got-feedBack/feedBack/issues/1104) | [#1105](https://github.com/got-feedBack/feedBack/pull/1105) | draft |
| Drum align/join + scripts | feedBack | | | deferred (needs non-spec keys, numpy/scipy) |
| Chorus Encore fetch (optional) | feedBack | | | deferred (network-download policy) |
| YARG scoring engine, difficulties, star power | feedBack-plugin-drums | [#19](https://github.com/got-feedBack/feedBack-plugin-drums/issues/19) | [#20](https://github.com/got-feedBack/feedBack-plugin-drums/pull/20) | open |
| Rock Band 3D view (stacked on #20) | feedBack-plugin-drums | [#21](https://github.com/got-feedBack/feedBack-plugin-drums/issues/21) | [#22](https://github.com/got-feedBack/feedBack-plugin-drums/pull/22) | open |
| Sampled kits, no CDN (stacked on #22) | feedBack-plugin-drums | [#3](https://github.com/got-feedBack/feedBack-plugin-drums/issues/3) | [#23](https://github.com/got-feedBack/feedBack-plugin-drums/pull/23) | open |
| Settings page + end card (stacked on #23) | feedBack-plugin-drums | [#1](https://github.com/got-feedBack/feedBack-plugin-drums/issues/1) (partial) | [#24](https://github.com/got-feedBack/feedBack-plugin-drums/pull/24) | open |

## Wave 3: scoring and stats

| Item | Repo | Issue | PR | Status |
|---|---|---|---|---|
| Capo-aware expected pitch | feedBack-plugin-notedetect | [#73](https://github.com/got-feedBack/feedBack-plugin-notedetect/issues/73) | [#74](https://github.com/got-feedBack/feedBack-plugin-notedetect/pull/74) | open |
| Fast chord-run fixes | feedBack-plugin-notedetect | [#75](https://github.com/got-feedBack/feedBack-plugin-notedetect/issues/75) | [#76](https://github.com/got-feedBack/feedBack-plugin-notedetect/pull/76) | open |
| Richer hit/miss event payload | feedBack-plugin-notedetect | [#77](https://github.com/got-feedBack/feedBack-plugin-notedetect/issues/77) | [#78](https://github.com/got-feedBack/feedBack-plugin-notedetect/pull/78) | open |
| Technique flags misread (sl=-1 / bn), found while porting | feedBack-plugin-notedetect | [#79](https://github.com/got-feedBack/feedBack-plugin-notedetect/issues/79) | [#80](https://github.com/got-feedBack/feedBack-plugin-notedetect/pull/80) | open |
| Section stats empty on desktop engine path, found while porting | feedBack-plugin-notedetect | [#81](https://github.com/got-feedBack/feedBack-plugin-notedetect/issues/81) | [#82](https://github.com/got-feedBack/feedBack-plugin-notedetect/pull/82) | open |
| Scorecard plugin ([repo](https://github.com/mattromano/feedBack-plugin-scorecard)) + candidacy | feedBack | [#1103](https://github.com/got-feedBack/feedBack/issues/1103) | — | published, candidacy open (lists 8 API gaps) |
| Most Played sort + play/FC badges | feedBack | [#49](https://github.com/got-feedBack/feedBack/issues/49) | [#1092](https://github.com/got-feedBack/feedBack/pull/1092) | open |
| Table library view (stacked on #1092) | feedBack | [#1093](https://github.com/got-feedBack/feedBack/issues/1093) | [#1094](https://github.com/got-feedBack/feedBack/pull/1094) | open |
| Queue: + button, album/artist queue, tray, same-arrangement advance | feedBack | [#1095](https://github.com/got-feedBack/feedBack/issues/1095) | [#1096](https://github.com/got-feedBack/feedBack/pull/1096) | open |
| Solo sections detection (lib + script) | feedBack | [#1100](https://github.com/got-feedBack/feedBack/issues/1100) | [#1101](https://github.com/got-feedBack/feedBack/pull/1101) | open |
| capability_inspector renders only while visible | feedBack | [#1098](https://github.com/got-feedBack/feedBack/issues/1098) | [#1099](https://github.com/got-feedBack/feedBack/pull/1099) | open |
| sloppak_converter observer / colorblind G/B / stems full-mix | — | — | — | dropped (already upstream; per-string colours configurable in 0.3) |

## Wave 4: retune and multiplayer

| Item | Repo | Issue | PR | Status |
|---|---|---|---|---|
| Backing-track pitch shift (+ stretch latency fix) | feedBack-desktop | [#131](https://github.com/got-feedBack/feedBack-desktop/issues/131) | [#132](https://github.com/got-feedBack/feedBack-desktop/pull/132) | open |
| Auto-Tuner plugin ([repo](https://github.com/mattromano/feedBack-plugin-autotune)) + candidacy | feedBack | [#1102](https://github.com/got-feedBack/feedBack/issues/1102) | — | published, candidacy open |
| Search "+ Add" breaks on quotes/apostrophes | feedBack-plugin-multiplayer | [#21](https://github.com/got-feedBack/feedBack-plugin-multiplayer/issues/21) | [#22](https://github.com/got-feedBack/feedBack-plugin-multiplayer/pull/22) | open |
| Real arrangement picker + search (stacked on #22) | feedBack-plugin-multiplayer | [#23](https://github.com/got-feedBack/feedBack-plugin-multiplayer/issues/23) | [#24](https://github.com/got-feedBack/feedBack-plugin-multiplayer/pull/24) | open |
| Join links + How to join panel | feedBack-plugin-multiplayer | [#6](https://github.com/got-feedBack/feedBack-plugin-multiplayer/issues/6) (partial) | [#25](https://github.com/got-feedBack/feedBack-plugin-multiplayer/pull/25) | open |
| LAN players via desktop network switch (no relay; stacked on #25) | feedBack-plugin-multiplayer | [#26](https://github.com/got-feedBack/feedBack-plugin-multiplayer/issues/26), refs #10 | [#27](https://github.com/got-feedBack/feedBack-plugin-multiplayer/pull/27) | open |

## Wave 5: song builder

| Item | Repo | Issue | PR | Status |
|---|---|---|---|---|
| Song-builder tooling proposal (hybrid: small core PRs + separate tool repo) | feedBack | [#1097](https://github.com/got-feedBack/feedBack/issues/1097) | — | awaiting maintainers |

Out of scope: `tone_pack`.

Follow-ups not opened yet:
- Count-in extras (Auto mode, scrolling count-in, skip count-in on queue advance)
- profileimport revival (Steam profile plays/mastery). Legally sensitive; ask the maintainers first.
- Song builder should write `track:` into the manifest (upstream reads `track_number`)
- Accuracy pill CSS classes `bg-fb-mid/90` and `bg-fb-low/90` are missing from tailwind.min.css (upstream bug)
- NAM tone: saving a preset gives it a new id and can orphan its mappings (upstream bug)
