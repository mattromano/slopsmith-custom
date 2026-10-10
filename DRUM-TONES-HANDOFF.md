# Drum tones handoff: make the kit sound real and dynamic (2026-10-10)

Read `DRUMS-HANDOFF.md` (setup, deploy, testing) and the top of `SYNC-HANDOFF.md` (what changed overnight) first.
Plugin: `plugins/drums` (5.15.0). Deploy = copy into `%APPDATA%\slopsmith-desktop\plugins\drums`
(`tools/sync-bench/deploy.sh`); bump `plugin.json` version every time (scripts are cached by `?v=`); restart the app
for `routes.py` changes. Commit and push straight to `main`.

## Status (2026-10-10, second session): Phases 0-2 done, Phase 3 partly

Shipped (drums 5.15.1 `be6987f`, 5.16.0 `8823b9a`, installed in AppData incl. the drs samples):
- **Auto kick fixed (5.15.1):** auto notes were scheduled off the frame clock: +28 ms late, +-16 ms wobble,
  ~7 % played twice. Now song time -> stems AudioContext -> drum AudioContext via getOutputTimestamp, one
  forward-only shared schedule, cancelled on pause / seek. `tools/sync-bench/autosched.mjs`: 0.1 +- 0.1 ms, no
  doubles. (`autokick.mjs` records both contexts to WAV.)
- **Phase 0:** MIDI monitor on Plugins -> Drums (Record / Save log -> `<config>/drums/midi_log.jsonl`).
  **Matt still has to record** (each pad soft -> hard, hi-hat pedal open/half/closed/chick, choke).
- **Phase 1:** balance by perceived loudness for all 7 kits (`tools/sync-bench/balance.mjs` +
  `plugins/drums/tools/apply_balance.py`): every piece within 1.5 dB of the target table (exceptions at the
  +12 dB cap: Chaos note 59 +1.7, DRS hi-hat pedal +2.4). Velocity law 20*1.75*log10(v/127) dB for all kits
  (snare 20->127 measured 28-29 dB); sampled layers levelled onto it (`tools/kit_loudness.py`) and blended
  +-7 velocity across boundaries; GM soft hits darker (low-pass bands); velocity curve setting; GM double
  pad volume fixed; GM sounds ring naturally (were cut at 0.5 s) + hi-hat choke; voice limits; note 24 ->
  lane sound (currently closed hi-hat; confirm with the monitor).
- **Phase 2:** new default kit **DRS** from DRSKit 2.1 multichannel (`tools/build_drumgizmo_kit.py`): own mix of
  13 mics, snare-bottom and kick-front polarity inverted (decided on their own drums), up to 8 layers x 3 hits,
  semi-open hi-hat on note 23. 6.3 MB ogg, ~130 MB decoded. Source zip in the session scratchpad (re-download
  `https://drumgizmo.org/kits/DRSKit/DRSKit2_1.zip`, 2.8 GB). Kit .ogg files are gitignored (all kits).

Third session (Matt away), shipped 5.17.0 `6a69062`, 5.18.0 `b6ef142`, 5.18.1:
- **Hi-hat pedal (CC4)** without waiting for the recording: modules that split 42 / 46 are trusted (a raw 42
  is always closed; half-closed pedal turns 46 into semi-open note 23); one-note modules get closed /
  semi-open / open from the pedal; closing the pedal chokes the open hat, chick (note 44) if the kit never
  sends 44; CC4 direction learnt from 42 vs 46 values (default high = closed). Setting on Plugins -> Drums.
  `tools/sync-bench/hihat.mjs` checks MIDI -> sample end to end.
- **Lazy decode:** first hit of every layer first; DRS playable ~125 ms, all ~330 ms (this PC, local).
- **Crocell rebuilt from the 15-mic multichannel kit** (5.6 GB zip; overheads are named from the audience,
  so they're panned swapped; snare close mics nudged left): up to 10 layers x 4, ~165 MB decoded.
- **Room per kit:** multi-mic kits (own room mics) get half the generated room; tails at Room 35 % now match
  the GM kits (snare -14 vs -13.6 dB).

Still open (needs Matt):
1. Record the MIDI monitor once: confirms note 24, whether CC4 is sent and its direction, chokes.
   If the module's CC4 runs high = open AND it sends one note for every hit, flip `_hh.closedHigh`.
2. Ears: balance targets (`balance.mjs` TARGET), velocity law 1.75 (Soft curve if too quiet), DRS / Crocell
   mixes (`MIX` in build_drumgizmo_kit.py), default kit (DRS).
3. Memory: DRS ~140 MB, Crocell ~165 MB decoded (one kit loaded at a time). If that's a problem, drop
   round-robins or decode layers on first use.

## GOAL (paste as the session goal)

> Make the drum sounds as close to a real, well-recorded kit as possible, and fully dynamic:
> 1. **Balance:** no piece jumps out (today the crash is far louder than the kit); every piece sits in a natural
>    drum mix at every velocity.
> 2. **Dynamics from the kit:** use the Alesis's MIDI velocity (and hi-hat pedal CC, choke if it sends it) so soft
>    hits sound soft *in tone*, not just quieter, with no audible steps between layers and no machine-gun repeats.
> 3. **Realism:** a new flagship kit built from multi-mic recordings (close + overheads + real room), real stereo
>    image, natural cymbal decay, hi-hat articulations.
> 4. **No added latency** (dry path stays IIR-only; nothing with look-ahead) and fast loading.
> Verify with measurements (loudness per piece/velocity, spectral change with velocity, onset delay, decode time),
> then Matt's ears. Never play song audio in tests (muted browser only, see `tools/sync-bench`).

## Where things stand (measured 2026-10-10)

`tools/sync-bench/loudness.mjs` taps the drum AudioContext in a muted Edge and hits pads through the real plugin
(`KIT=sblive,crocell ROOM=0 NOTES=... VELS=...`). RMS = first 400 ms; tail = energy 150–600 ms vs the first 150 ms.

**SB Live! (GM kit Matt uses), velocity 100, Room 0:**

| piece (GM note) | RMS 400 ms | peak | tail |
|---|---|---|---|
| kick 36 | −26.1 dB | −12.5 | (short) |
| snare 38 | **−33.6** | −15.8 | −24.0 |
| hi-hat closed 42 | **−45.0** | −18.2 | (short) |
| hi-hat open 46 | −36.6 | −16.3 | −4.4 |
| toms 48 / 45 / 43 | −30.4 / −28.7 / −28.2 | ≈ −15 | ≈ −5 |
| crash 49 / 57 | **−29.1 / −29.2** | −14.9 | **+3.9** (keeps blooming) |
| ride 51 / bell 53 | −42.9 / −37.5 | −17 | −6 / −7 |

So the snare is quieter than every tom and the kick, hats and ride are 9–11 dB under the snare, and the crash is
4.5 dB over the snare in the first 0.4 s and then *grows* (broadband, long, and the ear is most sensitive up there,
so it reads much louder than these RMS numbers). **Crocell** (sampled default) is better balanced but has the same
cymbal problem (crash tail +4..+8 dB, hats −43, ride −39).

**Velocity today:**
- GM kits (WebAudioFont, `_synthPlayNote`): one sample per note, gain = velocity/127 → snare 20→127 = 16 dB, timbre
  identical (tail constant). Also the pad volume is applied twice for GM kits (`_synthGain.gain` *and* the
  per-note gain).
- Sampled kits (`_pickKitLayer`, `_kitHitGain`): 4 velocity layers × 2 round-robins, gain 0.6–1.0 inside a layer;
  snare 20→127 = 19 dB with tone changes, but steps between layers and only 2 alternates (machine-gun on rolls).
- Kits are built by `tools/build_sample_kit.py`: each piece trimmed, **peak-normalised kit-wide** (PEAK_DBFS −3) plus
  a hand gain table. Peak normalisation is why cymbals end up loud: a crash has a low crest factor (lots of
  energy for its peak), drums the opposite.

**What the kit sends** (Clone Hero profiles `Documents\Clone Hero\MIDI Profiles\CH 2.yaml` / `Alesis Drum Module 0.yaml`):
snare 38, toms 48 / 45 / 43, kick 36, hi-hat **42, 46 and 24**, crash 49, ride 51; CH ignores velocity < 10.
Model unknown (USB 13B2:00BE; WinMM name "Alesis Drum Module"). Gaps found:
- **Note 24 has no sound** (`DRUM_MIDI_NOTES` and the kits stop at 35..59): hi-hat hits sent as 24 are silent.
- **CC messages are ignored** (`_midiOnMessage` only handles note-on). Alesis Nitro-and-up modules send the hi-hat
  pedal position as **CC4** and one hi-hat note for every strike ([Alesis support](https://support.alesis.com/en/support/solutions/articles/69000851410-alesis-drums-why-does-the-hi-hat-send-the-same-midi-note-open-closed-));
  some models send CC4 127 / 0 around the strikes. Cymbal choke on Alesis is usually *not* sent (no aftertouch)
  ([Toontrack forum](https://toontrack.com/?p=1908933)). Velocity curves are set in the module.

The drum bus (5.13): IIR low shelf + presence, per-piece pan for GM kits, convolution room (generated IR, Room 35 %).

## Research: sample sources

Licence rule from the earlier sessions: CC0 / CC BY ok (credit in `plugins/drums/NOTICE.md` + kit picker);
CC BY-SA possible only if the shipped samples stay CC BY-SA (was rejected before; ask Matt); no "free for use but
no redistribution" libraries.

| Library | Licence | What it is | Notes |
|---|---|---|---|
| **DrumGizmo DRSKit 2.1** | CC BY 4.0 | jazz→rock kit, 13 mono mics: amb L/R, kick back+front, hat, OH L/R, ride, snare top+bottom, 3 toms; Paiste 602 / Giant Beat cymbals | best all-rounder; [page](https://drumgizmo.org/wiki/doku.php?id=kits:drskit), zip `https://drumgizmo.org/kits/DRSKit/DRSKit2_1.zip` |
| **DrumGizmo CrocellKit 1.1** (multichannel) | CC BY 4.0 | metal/rock kit (current default is its *stereo mix*), 15 mics incl. amb L/R, OH L/C/R, hat, ride, snare top/bottom, 4 toms, kick in/out; 3 crashes, 2 chinas, 2 splashes | 5.5 GB; [page](https://drumgizmo.org/wiki/doku.php?id=kits:crocellkit) |
| DrumGizmo MuldjordKit | CC BY 4.0 | Tama Superstar metal/rock, 2 kicks, 3+1 toms, 2 crash, 2 ride, china | ~2.8 GB multitrack; [SFZ port](https://github.com/sfzinstruments/DrumGizmo.MuldjordKit) |
| DrumGizmo Aasimonster | CC BY 4.0 | death-metal kit, 16 mics | 2.3 GB; [page](https://drumgizmo.org/wiki/doku.php?id=kits:the_aasimonster) |
| Virtuosity Drums (in use) | CC0 | jazz kit, SFZ | already built |
| Karoryfer Unruly / Big Rusty Drums | listed "public domain" on KVR | junk/odd kits | check the bundled licence; Big Rusty rejected before |
| AVL Drumkits | CC BY-SA 3.0 | 5–10 velocity layers, SFZ | [bandshed](https://www.bandshed.net/avldrumkits/); SA |
| SM Drums | unclear ("royalty free") | 60s Ludwig, up to 127 layers × 8 RR, multi-mic | redistribution unclear → no |

DrumGizmo kits store every recorded hit per instrument with a `power` value (a full soft→hard sweep, dozens of
hits), all mic channels per hit, so velocity layers, round-robins and our own mic mix can all be built from them.
The earlier sources are not on disk any more: download into a scratch dir (multi-GB; check free space first).

## Plan

### Phase 0: know the kit (needs Matt, ~3 min)
- Add a **MIDI monitor** to Plugins → Drums: logs every raw message (notes *and* CC / aftertouch, with
  timestamps) and per-pad velocity min / median / max; "Save log" posts it to a drums route (e.g.
  `drums/midi_log.jsonl`). Works over Web MIDI and the direct (WinMM) input.
- Matt: each pad soft → hard ×8, hi-hat closed / half / open / pedal chick / foot splash, choke the crash.
- Result decides: velocity range per pad (Alesis rarely reaches 127 on soft-set pads), what 24 is, CC4 behaviour,
  whether choke exists.

### Phase 1: quick wins on the current kits (no new samples)
1. **Loudness-balance every piece** instead of peak-normalising: K-weighted short-term loudness (BS.1770,
   400 ms) of each piece at velocity ~100, matched to a target mix table, e.g. kick 0 dB, snare 0, toms −2, hat
   closed −6, hat open −4, ride −7, crash −5 (short-term), china −5. Measure the crash over 1–2 s too and
   shorten / darken cymbal tails if they still dominate. GM kits: per-note gain table in screen.js;
   sampled kits: rebuild with `build_sample_kit.py` doing the same (pure numpy K-weighting; no pyloudnorm).
2. Map **note 24** (and whatever Phase 0 finds) to a hi-hat sound; fix the double pad-volume for GM kits.
3. **Velocity curve** setting (linear / soft / hard + range auto-fit from Phase 0 data): velocity → dB with a
   chosen dynamic range (~30–36 dB snare pp→ff), applied before layer choice.
4. Re-measure with `loudness.mjs`; Matt A/B.

### Phase 2: a flagship kit from multi-mic sources (DRSKit first, CrocellKit multichannel second)
- Extend `build_sample_kit.py` with a DrumGizmo multichannel reader (instrument XML → hits with power, one
  file per channel).
- **Mix our own stereo per hit**: close mic(s) + overheads + ambience, panned to the drummer's view, with a
  fixed per-kit mix (gain, polarity / time alignment of close vs OH, gentle EQ). Option: ship two stereo stems
  per hit, *close+OH* and *room*, so the Room slider blends real room mics instead of the convolution IR.
- **8–12 velocity layers × 3–4 round-robins** per piece, picked by `power` quantiles; loudness-matched across
  layers so the curve is smooth; keep full natural cymbal decays (with a sensible max length + fade).
- Hi-hat articulations if the source has them (closed tight / closed / half / open / pedal / splash).
- Size budget: tens of MB per kit (Ogg q5); load lazily (mid layers first), decode in the background.

### Phase 3: playback engine realism
- **Velocity crossfade** between the two nearest layers (no audible steps), round-robin without immediate
  repeats, tiny per-hit variation (±0.5 dB, a few ms of start jitter is *not* ok; keep onsets exact).
- **Hi-hat from CC4**: pick closed / half / open by pedal position at strike time; pedal down after an open hat
  plays the chick and chokes; foot splash on fast pedal up/down.
- Cymbal choke if Phase 0 shows aftertouch/notes for it; choke groups per piece; voice limits per piece with
  short fades (no clicks), steal oldest.
- Bus: keep IIR-only dry path; optional glue via an AudioWorklet compressor with **zero look-ahead** (Chromium's
  DynamicsCompressor has a fixed ~6 ms look-ahead), or none.

### Phase 4: verify
- `loudness.mjs`: every piece within ±1.5 dB of the target table at vel 100; snare and crash dynamic range
  20→127 ≥ 28 dB; spectral centroid rises with velocity (soft = darker); tails per piece.
- `drumsound.mjs`: onset delay unchanged; L/R correlation of the full kit < 0.6.
- Kit load: decode time and memory (aim < 2 s to first playable hit).
- Matt plays: balance, dynamics, rolls (no machine-gun), hats with the pedal.

## Tools / where things are
- `plugins/drums/screen.js`: `DRUM_KITS`, `DRUM_MIDI_NOTES`, `_synthPlayNote`, `_sampleKitHit`, `_pickKitLayer`,
  `_kitHitGain`, `_buildDrumBus`, `_makeRoomIR`, `DRUM_PAN`, `_midiOnMessage` (MIDI in), `_handleDrumHit`.
- `plugins/drums/tools/build_sample_kit.py` (kit builder), `sounds/kits/<id>/kit.json` (layers, chokes),
  `sounds/README.md`, `NOTICE.md` (licences).
- `tools/sync-bench/`: `loudness.mjs` (per-piece / per-velocity loudness), `drumsound.mjs` (width, tail, onset),
  muted-browser rules in its README; server `sync-test` (:8003, scratch copy of plugins).
