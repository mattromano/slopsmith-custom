# sync-bench: measured clock / hit-timing checks

Headed Edge launched by Playwright with `--mute-audio` (nothing reaches the speakers, so songs can really
play), off-screen, against a Slopsmith server that uses a **scratch copy** of the AppData plugins
(`sync-test` in `Desktop/repos/.claude/launch.json`, port 8003). Song: `sloppak/1979.sloppak`.

    npm i playwright-core@1.48.2     # once, in a scratch dir; copy these .mjs files there
    bash deploy.sh <scratch>/plugins drums highway_tweaks
    node frames.mjs                  # single player: per-frame clock step error (judder)
    node hits.mjs                    # single player: synthetic MIDI hits with known strike times
    AV=30 node split.mjs             # split view (Drums + Lead): per-panel offset/judder + drum hit error

What they measure:
- **judder**: per frame, (render-time step − wall step) in ms. 0 = gems move perfectly evenly.
- **render − audio offset** per panel: should equal the A/V offset exactly.
- **hit-time error**: song time the drums plugin assigns to a pad hit, minus audio clock + A/V at the
  moment of the strike (the MIDI message is delivered 0–25 ms late on purpose, like a busy main thread).

Results, 2026-10-10 (A/V +30 for split):

| | before (drums 5.10.1 / tweaks 1.17.0) | after (5.11.0 / 1.18.0) |
|---|---|---|
| single-player drum highway judder | sd 3.67 ms, p95 13.2 ms | sd 0.09, p95 0.16 |
| single-player drum hit error | 0.0 ± 0.07 ms | 0.0 ± 0.07 |
| split: drum panel render offset (want +30) | −8.0 ms, sd 3.8 | +30.03, sd 0.05 |
| split: guitar 3D panel offset (want +30) | 0.1 ms, sd 4.8 | +30.03, sd 0.05 |
| split: guitar 3D panel judder | sd 3.75 ms | sd 0.09 |
| split: drum hit error | −29.6 ms, sd 4.3 (−41..−26) | 0.0 ± 0.07 |

## Multiplayer (mp.mjs)

Two separate muted browsers (host + guest) in one room, both on this PC (process clock skew measured 0.0-0.1 ms).
`SECS=40 node mp.mjs`, `TL=1` prints a timeline, `PERTURB=80` knocks the guest 80 ms off at 12 s.

| | before (multiplayer 1.0.0) | after (1.1.0) |
|---|---|---|
| guest - host, steady state | -10.2 ms, never corrected (50 ms dead band) | -6 to -9 ms, sd 0.07 ms |
| small drift correction | +-0.2 % rate nudges: each toggles the stems pitch worklet (adds/drops its delay) | none: 3 heartbeats > 30 ms -> one seek with a learned lead |
| knocked 80 ms off | (rate nudges, ~25 s) | back to -3 ms in ~1 s |

Measured along the way (seekprobe.mjs / rateprobe.mjs): a stems play or seek freezes the clock 120-160 ms
before audio restarts; playbackRate changes take effect at once (1.003 -> clock 1.0024).
