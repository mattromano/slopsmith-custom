# Note Failure Feedback

In Rocksmith's Riff Repeater, missed or failed notes are marked with **exclamation marks** (!) that appear on the note highway at the position where the missed note was. On chords, the exclamation mark appears directly above the chord "bars," which can make them hard to see on songs with dense six-string chords — a known complaint, since the markers can't be resized or recolored in-game.

A few related things worth knowing:

- The markers are persistent visual flags on the note track after the note passes, not a popup or audio cue.
- If you want stricter feedback, set the error tolerance in Riff Repeater to 0, so the level won't advance unless you hit everything cleanly.
- Rocksmith's note detection is deliberately forgiving, so occasionally a
  genuinely missed note won't get flagged, especially in fast passages. Score
  Attack mode is generally less lenient if you want tighter scoring.

Goal: reproduce and improve on that behavior. When a user loops over the same
5-note lick repeatedly, the highway should show note misses with diagnostic
detail — which note was missed and *how* it was missed (too late / too early /
too sharp / too flat / not played).

## Docs

- **[Technical Spec](docs/NOTE_FAILURE_SPEC.md)** — architecture, matching
  algorithm, rendering design, data structures, integration points
- **[Implementation Plan](docs/NOTE_FAILURE_PLAN.md)** — 7 phases from
  detection foundation through section grading and polish
- **Note Detection Plugin Plan** — see the
  [slopsmith-plugin-notedetect](https://github.com/topkoa/slopsmith-plugin-notedetect)
  repository (Phase 0 foundation)
