// Drum Highway visualization plugin — lane-based scrolling drum
// renderer (Rock Band-style) with MIDI drum pad input, WebAudioFont
// drum kit sounds, and accuracy scoring.
//
// Milestone 5: each renderer instance is either the 2D lane view below
// or the 3D drum track (highway3d.js + engine.js, lazily loaded via
// routes.py), picked from the View setting when the instance is
// created (Auto = 3D with WebGL2). Both share the MIDI routing, synth,
// focus handling and settings panel in this file; see README "3D view".
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption. Wave C lifts that: rendering, scoring,
// held-pad state, settings UI, and listeners are now all
// per-instance (closured inside createFactory). Main-player usage
// keeps its single-instance fast path via the
// window.slopsmithSplitscreen helper surface — its absence OR
// isActive()===false means "we're the only instance, always
// focused."
//
// Under splitscreen (N panels, N simultaneous drum instances):
//   - each panel hosts its own overlay canvas, scoring, settings
//     panel + gear docked inside the panel's bar
//   - MIDI input is a browser singleton; the currently-focused
//     panel (clicked most recently) is the sole recipient of
//     drum-pad note-on events
//   - focus-change clears held-pad / lane-flash state on the
//     outgoing panel
//   - _cfg.learnLane stays module-scope (per-user-intent — clicking
//     Learn in any panel assigns the next pad-hit-from-the-focused
//     device; the lane-row UI updates everywhere via class selector)
//
// song:ready event subscription is gone: each draw() edge-detects
// bundle.isReady false→true per-instance, which is correct for N
// panels without the cross-instance fan-out of the global bus.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

// Word-boundary match so unrelated arrangement names don't trigger
// Auto-drums via a substring hit — e.g. "Drumstick" (hypothetical)
// must NOT match "drums". The \b anchors still catch standard
// an arrangement labels cleanly: "Drums", "Drum Kit",
// "Percussion", "Electronic Drums", etc.
const DRUMS_PATTERNS = /\b(?:drums|percussion|drum\s*kit)\b/i;
// Smaller window = more vertical pixels per second = more space between
// consecutive hits. 2.0 leaves enough lookahead for fast metal (16ths at
// 170 BPM ≈ 11.3 hits/s gives 22+ visible notes ahead) while spreading
// each hit ~50% further apart than the old 3.0 default.
const VISIBLE_SECONDS = 2.0;
const NOW_LINE_Y_FRAC = 0.85;
const LANE_PAD = 1;
const KICK_LANE_EXTRA = 20;
const HIT_TOLERANCE = 0.05;        // seconds (drums need tighter timing than piano)

// ── Persisted settings ───────────────────────────────────────────────

const STORE_KEYS = {
    midiInputId:    'drums_midi_input',
    synthVolume:    'drums_synth_vol',
    midiChannel:    'drums_midi_ch',
    hitDetection:   'drums_hit_detect',
    showLaneLabels: 'drums_lane_labels',
    customMapping:  'drums_custom_map',
    // Lane preset — chooses which DRUM_LANES table the renderer uses.
    // 'phase_shift_8' (default) matches the legacy 8-lane HH/Sn/T1/T2/T3/
    // Cr/Ri/Ki layout. 'rb4' is a denser 7-lane Rock-Band-style preset.
    // Persisted via _saveCfg below.
    lanePreset:     'drums_lane_preset_v1',
    // 3D view (milestone 5). view: 'auto' (3D when WebGL2 is available,
    // else 2D) | '3d' | '2d'. keyboard: keyboard drumming in the 3D view.
    // inputOffsetMs: subtracted from the song time of every 3D-view hit
    // (positive = your hits register earlier; for audio/MIDI latency).
    view:           'drums_view_v1',
    keyboard:       'drums_kbd',
    inputOffsetMs:  'drums_input_offset_ms',
    // Drum difficulty (both views): easy | medium | hard | expert |
    // expert_plus. Per browser, so each player keeps their own; songs
    // without that level play Expert without overwriting the choice.
    difficulty:     'drums_difficulty_v1',
    // Pro cymbals (3D view): true = pro drums (cymbal and tom of a colour
    // are separate lanes); false = non-pro, no cymbal gems and either pad
    // of a colour hits. Per browser, like difficulty.
    proCymbals:     'drums_pro_cymbals_v1',
    // '1' when the MIDI input was picked by hand in the dropdown. Auto picks
    // (first start, hotplug) never set it, so a later start can still move
    // an auto-picked non-kit device (e.g. a Loupedeck) to the drum kit.
    midiManual:     'drums_midi_manual',
    // Accessibility (both views): auto kick / auto cymbals are played for
    // you up to a difficulty ('off' | 'easy' | 'medium' | 'hard' | 'all').
    autoKick:       'drums_auto_kick_v1',
    autoCymbals:    'drums_auto_cymbals_v1',
    // 3D view hit window preset (TIMING_PRESETS).
    timing:         'drums_timing_v1',
    // Drum synth sound set (DRUM_KITS).
    kit:            'drums_kit_v1',
    // Volume of the notes the auto kick / auto cymbals play for you (0..1),
    // separate from the pad volume so pads can be silent (kit module makes
    // the sound) while the auto notes still fill in for a muted drum stem.
    autoVolume:     'drums_auto_volume_v1',
};

// Valid preset ids — kept here so _saveCfg can validate before persisting
// (drums_lane_preset_v1 is user-controlled, like every other storage key
// in this plugin).
const _VALID_LANE_PRESETS = new Set(['phase_shift_8', 'rb4']);
const _VALID_VIEWS = new Set(['auto', '3d', '2d']);
// Same ids as DrumsHighway3D.DIFFICULTIES (highway3d.js loads lazily).
const DIFFICULTY_IDS = ['easy', 'medium', 'hard', 'expert', 'expert_plus'];
const DIFFICULTY_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', expert_plus: 'Expert+' };
const _VALID_DIFFICULTIES = new Set(DIFFICULTY_IDS);
// Same ids as DrumsHighway3D.AUTO_LEVELS.
const AUTO_LEVEL_IDS = ['off', 'easy', 'medium', 'hard', 'all'];
const AUTO_LEVEL_NAMES = { off: 'Off', easy: 'Easy only', medium: 'Easy – Medium', hard: 'Easy – Hard', all: 'Every difficulty' };
const _VALID_AUTO_LEVELS = new Set(AUTO_LEVEL_IDS);

// Hit window presets for the 3D view's engine (engine.js params.hitWindow).
// Normal = YARG's default 140 ms window (±70 ms).
const TIMING_PRESETS = {
    relaxed:   { name: 'Relaxed (±130 ms)', params: { hitWindow: { maxWindow: 0.26, minWindow: 0.26, isDynamic: false } } },
    forgiving: { name: 'Forgiving (±100 ms)', params: { hitWindow: { maxWindow: 0.20, minWindow: 0.20, isDynamic: false } } },
    normal:    { name: 'Normal (±70 ms)', params: null },
    precision: { name: 'Precision (tightens on fast notes)', params: { hitWindow: {
        maxWindow: 0.13, minWindow: 0.05, isDynamic: true, dynamicScale: 1, dynamicSlope: 0.60615, dynamicGamma: 2 } } },
};
const TIMING_IDS = ['relaxed', 'forgiving', 'normal', 'precision'];

// Drum synth sound sets. type 'samples': a real multi-sampled kit with
// velocity layers in sounds/kits/<dir>/ (kit.json + .ogg, built by
// tools/build_sample_kit.py). The others are WebAudioFont General MIDI kits
// in sounds/ (one sample per note). See sounds/README.md. Only the chosen
// kit is loaded.
const DRUM_KITS = {
    crocell:    { name: 'Crocell (rock)', type: 'samples', dir: 'crocell', note: 'real sampled rock kit, velocity layers (default)' },
    virtuosity: { name: 'Virtuosity (jazz)', type: 'samples', dir: 'virtuosity', note: 'real sampled jazz kit, velocity layers' },
    jclive: { name: 'JCLive', sf: 'JCLive_sf2_file', note: 'tight, dry GM rock kit' },
    fluid:  { name: 'FluidR3 GM', sf: 'FluidR3_GM_sf2_file', note: 'full acoustic GM kit with room' },
    sblive: { name: 'Sound Blaster Live!', sf: 'SBLive_sf2', note: 'punchy, bright GM kit' },
    chaos:  { name: 'Chaos', sf: 'Chaos_sf2_file', note: 'lighter, softer GM kit' },
};
const KIT_IDS = ['crocell', 'virtuosity', 'jclive', 'fluid', 'sblive', 'chaos'];
const DEFAULT_KIT = 'crocell';
// Safe localStorage reader — getItem can throw SecurityError in
// sandboxed iframes, under Safari on file://, or when storage is
// disabled for the origin. An unguarded throw during the _cfg
// initialiser would abort the IIFE and the plugin would never
// register its setRenderer factory. Return null on failure so the
// `|| default` fallthrough below still produces a usable value.
function _readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

// Numeric cfg normaliser — parseFloat/parseInt return NaN on junk
// like "foo" or "", which would propagate into AudioParam.gain.value
// (breaks playback) or MIDI channel filtering (misroutes events).
// Clamp to [min, max] when provided and fall back to the default on
// any non-finite result.
function _readNum(key, fallback, min, max) {
    const raw = _readStore(key);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

// Lane ids declared here so the customMapping validator below can
// shape-check persisted user mappings. The full DRUM_LANES table
// appears further down (with colors, symbols, MIDI-note lists); the
// ids are duplicated here once because _cfg initialises before the
// DRUM_LANES block runs.
const _VALID_LANE_IDS = new Set([
    'hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick',
]);

// Validate a customMapping object loaded from localStorage. Storage
// is user-controlled (manual edits, another plugin, synced profiles),
// so parsing the raw JSON is NOT enough — we need to reject
// non-object / array inputs, strip __proto__ / constructor /
// prototype keys to block prototype-pollution, and drop any
// (key, value) pair that isn't (MIDI note 0-127, known lane id).
// Returns a clean null-prototype object, or null if nothing survives.
function _validateCustomMapping(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clean = Object.create(null);
    let hasEntries = false;
    for (const key of Object.keys(raw)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const midi = parseInt(key, 10);
        if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
        const val = raw[key];
        if (typeof val !== 'string' || !_VALID_LANE_IDS.has(val)) continue;
        clean[midi] = val;
        hasEntries = true;
    }
    return hasEntries ? clean : null;
}

const _cfg = {
    midiInputId:    _readStore(STORE_KEYS.midiInputId) || '',
    synthVolume:    _readNum(STORE_KEYS.synthVolume, 0.7, 0, 1),
    autoVolume:     _readNum(STORE_KEYS.autoVolume, 0.8, 0, 1),
    // -1 = all, 0..15 are the 16 MIDI channels (9 = "ch10" Drums)
    midiChannel:    Math.round(_readNum(STORE_KEYS.midiChannel, -1, -1, 15)),
    hitDetection:   _readStore(STORE_KEYS.hitDetection) === 'true',
    showLaneLabels: _readStore(STORE_KEYS.showLaneLabels) !== 'false',
    customMapping:  (function () {
        try {
            const raw = JSON.parse(_readStore(STORE_KEYS.customMapping) || 'null');
            return _validateCustomMapping(raw);
        } catch (_) { return null; }
    })(),
    lanePreset:     (function () {
        const raw = _readStore(STORE_KEYS.lanePreset);
        return _VALID_LANE_PRESETS.has(raw) ? raw : 'phase_shift_8';
    })(),
    view:           (function () {
        const raw = _readStore(STORE_KEYS.view);
        return _VALID_VIEWS.has(raw) ? raw : 'auto';
    })(),
    keyboard:       _readStore(STORE_KEYS.keyboard) !== 'false',
    inputOffsetMs:  Math.round(_readNum(STORE_KEYS.inputOffsetMs, 0, -250, 250)),
    difficulty:     (function () {
        const raw = _readStore(STORE_KEYS.difficulty);
        return _VALID_DIFFICULTIES.has(raw) ? raw : 'expert';
    })(),
    proCymbals:     _readStore(STORE_KEYS.proCymbals) !== 'false',
    autoKick:       (function () {
        const raw = _readStore(STORE_KEYS.autoKick);
        return _VALID_AUTO_LEVELS.has(raw) ? raw : 'off';
    })(),
    autoCymbals:    (function () {
        const raw = _readStore(STORE_KEYS.autoCymbals);
        return _VALID_AUTO_LEVELS.has(raw) ? raw : 'off';
    })(),
    timing:         (function () {
        const raw = _readStore(STORE_KEYS.timing);
        return Object.prototype.hasOwnProperty.call(TIMING_PRESETS, raw) ? raw : 'normal';
    })(),
    kit:            (function () {
        const raw = _readStore(STORE_KEYS.kit);
        return Object.prototype.hasOwnProperty.call(DRUM_KITS, raw) ? raw : DEFAULT_KIT;
    })(),
    // Transient: which lane is in learn mode. Module-scope across
    // panels — the Learn-mode UX is "click Learn in any panel, then
    // hit a pad on the focused MIDI device." The next focused-panel
    // drum-hit consumes the sentinel and remaps. Per-panel learnLane
    // would imply N independent in-flight remap operations, which is
    // surprising when there's only one user + one MIDI kit.
    learnLane:      null,
};

function _saveCfg(key, val) {
    // Apply the same shape validation the _cfg initialiser uses so
    // anything we write to localStorage is also trustworthy on next
    // load. Belt-and-suspenders — Learn-mode builds its map from
    // Object.assign({}, _getActiveDrumMap()) + a fresh midi+laneId
    // pair, so input is already well-formed, but routing through
    // the validator means any future caller can't accidentally
    // persist garbage.
    if (key === 'customMapping' && val !== null) {
        val = _validateCustomMapping(val);
    }
    if (key === 'lanePreset' && !_VALID_LANE_PRESETS.has(val)) {
        val = 'phase_shift_8';
    }
    if (key === 'view' && !_VALID_VIEWS.has(val)) {
        val = 'auto';
    }
    if (key === 'difficulty' && !_VALID_DIFFICULTIES.has(val)) {
        val = 'expert';
    }
    if ((key === 'autoKick' || key === 'autoCymbals') && !_VALID_AUTO_LEVELS.has(val)) {
        val = 'off';
    }
    if (key === 'timing' && !Object.prototype.hasOwnProperty.call(TIMING_PRESETS, val)) {
        val = 'normal';
    }
    if (key === 'kit' && !Object.prototype.hasOwnProperty.call(DRUM_KITS, val)) {
        val = DEFAULT_KIT;
    }
    if (key === 'autoVolume') {
        const n = Number(val);
        val = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.8;
    }
    if (key === 'synthVolume') {
        const n = Number(val);
        val = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7;
    }
    if (key === 'inputOffsetMs') {
        const n = Math.round(Number(val));
        val = Number.isFinite(n) ? Math.max(-250, Math.min(250, n)) : 0;
    }
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    const serialised = typeof val === 'object' && val !== null
        ? JSON.stringify(val) : String(val);
    try { localStorage.setItem(storeKey, serialised); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons (browser-unique resources)
// ═══════════════════════════════════════════════════════════════════════

// ── MIDI input ────────────────────────────────────────────────────────
// MIDI is sourced from the core `midi-input` capability domain
// (window.slopsmith.midiInput) rather than a private requestMIDIAccess() — one
// device-access boundary shared with piano/keys/onboarding.
let _midiReady = false;      // discover() has run
let _midiHandle = null;      // live domain session handle (addListener/removeListener)
let _midiListener = null;    // the addListener callback wrapping _midiOnMessage
let _midiStateSub = false;   // subscribed to midi-input:sources-changed
let _midiInput = null;       // selected source descriptor { id, name, key }
let _midiConnectSeq = 0;     // generation guard for async _midiConnect races
// Gates the live listener wiring. init() flips true via _midiResumeHandler
// and destroy() flips false via _midiPauseHandler. Because _midiConnect is
// async, an open() begun in init() can resolve AFTER destroy() has run — the
// resulting addListener would otherwise re-wire scoring/synth on a
// no-longer-visible renderer. Every callsite that would attach the listener
// consults this flag first.
let _midiActive = false;
// Wave C: routes incoming MIDI events to the currently-focused drum
// instance (null when no instance is active). Instances claim this
// on focus-change and release it on defocus / destroy.
let _activeInstance = null;
// Registry of live factory instances so module-level helpers (device-
// list refresh, shutdown-when-last-destroys) can iterate.
const _instances = new Set();
// Monotonic id for per-instance DOM tagging (useful for debugging).
let _nextInstanceId = 0;

// Save the drum difficulty (per browser) and apply it to every live
// instance: each one resolves it against its own chart (falling back to
// Expert for that song when the level is missing) and, mid-song, rebuilds
// its chart from the current position on its next frame.
function _setDifficulty(id) {
    _saveCfg('difficulty', id);
    try {
        document.querySelectorAll('.drums-difficulty-select').forEach((sel) => { sel.value = _cfg.difficulty; });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { inst._difficultyChanged(); } catch (e) { console.warn('[Drums] difficulty update failed:', e); }
    }
}

// Save "Pro cymbals" (per browser) and apply it to every live instance;
// mid-song, scoring restarts from the current position.
function _setProCymbals(on) {
    _saveCfg('proCymbals', !!on);
    try {
        document.querySelectorAll('.drums-chk-pro').forEach((chk) => { chk.checked = _cfg.proCymbals; });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { inst._proCymbalsChanged(); } catch (e) { console.warn('[Drums] pro cymbals update failed:', e); }
    }
}

// Save an assist setting (auto kick / auto cymbals / timing) and apply it
// to every live instance (mid-song, scoring restarts from the current
// position, like a difficulty change).
function _setAssist(key, val) {
    _saveCfg(key, val);
    const cls = { autoKick: '.drums-auto-kick', autoCymbals: '.drums-auto-cym', timing: '.drums-timing-select' }[key];
    try {
        if (cls) document.querySelectorAll(cls).forEach((sel) => { sel.value = _cfg[key]; });
    } catch (_) { /* no DOM */ }
    for (const inst of _instances) {
        try { if (inst._assistsChanged) inst._assistsChanged(); } catch (e) { console.warn('[Drums] assist update failed:', e); }
    }
}

// <option> lists for the settings selects (values are fixed ids; names are ours).
function _optList(ids, names, current) {
    return ids.map(id => `<option value="${id}"${id === current ? ' selected' : ''}>${names[id]}</option>`).join('');
}
function _autoOptions(current) { return _optList(AUTO_LEVEL_IDS, AUTO_LEVEL_NAMES, current); }
function _timingOptions(current) {
    const names = {};
    for (const id of TIMING_IDS) names[id] = TIMING_PRESETS[id].name;
    return _optList(TIMING_IDS, names, current);
}
function _kitOptions(current) {
    const names = {};
    for (const id of KIT_IDS) names[id] = DRUM_KITS[id].name;
    return _optList(KIT_IDS, names, current);
}

const _SEL_CSS = 'background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:3px 6px;font-size:11px;color:#ccc;outline:none;';

// Auto lanes for a difficulty: each setting is a ceiling ('easy' = on at
// Easy only, 'hard' = Easy..Hard, 'all' = always). Mirrors
// DrumsHighway3D.autoFor (kept here so the 2D view needs no helpers).
function _autoAt(diffId) {
    const rank = (id) => DIFFICULTY_IDS.indexOf(id);
    const on = (lvl) => lvl === 'all' || (lvl !== 'off' && rank(diffId) >= 0 && rank(diffId) <= rank(lvl));
    return { kick: on(_cfg.autoKick), cymbals: on(_cfg.autoCymbals) };
}

// 2D lane ids played for the player by the auto settings.
function _laneIsAuto(laneIdx, auto) {
    const lane = DRUM_LANES[laneIdx];
    if (!lane || !auto) return false;
    if (lane.id === 'kick') return !!auto.kick;
    return !!auto.cymbals && (lane.id === 'hihat' || lane.id === 'crash' || lane.id === 'ride');
}

function _timingParams() {
    const p = TIMING_PRESETS[_cfg.timing];
    return p && p.params ? JSON.parse(JSON.stringify(p.params)) : null;
}

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthGain = null;
let _autoGain = null;        // bus for auto-played notes (its own volume)
let _synthLoading = false;
let _playerScriptLoaded = false;
const _drumPresets = {};           // midiNote -> preset

// ═══════════════════════════════════════════════════════════════════════
// MIDI / Drum Mapping
// ═══════════════════════════════════════════════════════════════════════

function noteToMidi(string, fret) { return string * 24 + fret; }

// ── Piece-id ↔ MIDI (mirrors lib/drums.py::PIECES) ──────────────────
//
// Default GM MIDI for each canonical piece-id. The mapped value is the
// "preferred" MIDI we synthesize when a drum_tab.json hit names this
// piece-id — it then flows through the legacy {string, fret}
// MIDI-encoding pipeline unchanged (`midi = string * 24 + fret`).
// Hi-hat openness is preserved as distinct piece-ids (hh_closed=42,
// hh_open=46, hh_pedal=44) so the renderer's open-vs-closed visual
// dispatch keeps working from the synthesised note's MIDI alone.
const PIECE_DEFAULT_MIDI = {
    kick:         36,
    snare:        38,
    snare_xstick: 37,
    tom_hi:       50,
    tom_mid:      47,
    tom_low:      43,
    tom_floor:    41,
    hh_closed:    42,
    hh_open:      46,
    hh_pedal:     44,
    crash_l:      49,
    crash_r:      57,
    splash:       55,
    china:        52,
    ride:         51,
    ride_bell:    53,
};

// Convert a drum_tab.hits[] payload into the legacy {t, s, f, ac, mt}
// note objects the renderer already understands. Velocity ≥ 100 →
// accent (renders larger + brighter glow). Ghost notes carry `mt: true`
// (intent for dimming/shrinking — not yet consumed by the renderer). Flams
// emit a small leading grace note 30 ms ahead so the user sees the
// characteristic two-tap shape. Unknown piece-ids are dropped — better
// silent than a mis-rendered piece on an outdated client.
function _drumTabHitsToNotes(hits) {
    if (!Array.isArray(hits)) return [];
    const out = [];
    for (const h of hits) {
        const piece = h && h.p;
        // Use hasOwnProperty guard to prevent prototype-poisoning: if h.p is
        // '__proto__', 'constructor', etc., the plain-object lookup would
        // return an inherited value instead of undefined.
        if (!Object.prototype.hasOwnProperty.call(PIECE_DEFAULT_MIDI, piece)) continue;
        const midi = PIECE_DEFAULT_MIDI[piece];
        const v = (typeof h.v === 'number') ? h.v : 100;
        const t = +h.t;
        // Skip hits with missing or non-finite timestamps — rendering at t=0
        // by default would score bogus notes at the song start.
        if (!Number.isFinite(t) || t < 0) continue;
        const note = {
            t,
            s: (midi / 24) | 0,
            f: midi % 24,
            ac: v >= 100,
            mt: !!h.g,        // ghost — carries intent for renderer (dim/small); TODO: wire up
            _piece: piece,    // carried for future rendering/debug use
            _vel: v,
        };
        if (h.f) {
            // Leading flam grace note 30 ms ahead. mt:true and _vel carry
            // intent for a future smaller/dimmer rendering pass; currently
            // the note renders at normal size. _noScore:true is the only
            // active field — it excludes the grace from miss-counting and
            // from consuming the hit window (the player strikes the main hit).
            out.push({
                t: Math.max(0, t - 0.030),
                s: note.s, f: note.f,
                ac: false,
                mt: true,
                _piece: piece,
                _vel: Math.max(20, ((v * 0.5) | 0)),
                _noScore: true,
            });
        }
        out.push(note);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
}

function _noteKey(time, midi) {
    return time.toFixed(3) + '|' + midi;
}

// Lane preset table — the user picks via the settings panel (PR6). The
// `phase_shift_8` default matches v3's legacy 8-lane HH/Sn/T1/T2/T3/Cr/
// Ri/Ki layout so existing setups are untouched. `rb4` collapses to a
// 7-lane Rock-Band-style layout that several community members asked for
// (single tom-pair lane, merged cymbals, no x-stick / pedal-hat split).
const LANE_PRESETS = {
    phase_shift_8: [
        { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0], symbol: 'x'      },
        { id: 'snare',  label: 'Sn', midiNotes: [38, 40, 37], color: [1.0, 0.9, 0.2], symbol: 'circle' },
        { id: 'tom1',   label: 'T1', midiNotes: [48, 50],     color: [0.3, 1.0, 0.3], symbol: 'circle' },
        { id: 'tom2',   label: 'T2', midiNotes: [45, 47],     color: [1.0, 0.6, 0.1], symbol: 'circle' },
        { id: 'tom3',   label: 'T3', midiNotes: [41, 43, 58], color: [0.7, 0.4, 1.0], symbol: 'circle' },
        { id: 'crash',  label: 'Cr', midiNotes: [49, 57, 55, 52], color: [0.2, 0.9, 0.9], symbol: 'diamond' },
        { id: 'ride',   label: 'Ri', midiNotes: [51, 59, 53], color: [0.9, 0.9, 0.9], symbol: 'diamond' },
        { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3], symbol: 'bar'    },
    ],
    rb4: [
        { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0], symbol: 'x'      },
        { id: 'snare',  label: 'Sn', midiNotes: [38, 40, 37], color: [1.0, 0.9, 0.2], symbol: 'circle' },
        { id: 'tom1',   label: 'T',  midiNotes: [48, 50, 45, 47], color: [0.3, 1.0, 0.3], symbol: 'circle' },
        { id: 'tom3',   label: 'FT', midiNotes: [41, 43, 58], color: [0.7, 0.4, 1.0], symbol: 'circle' },
        { id: 'crash',  label: 'Cr', midiNotes: [49, 57, 55, 52], color: [0.2, 0.9, 0.9], symbol: 'diamond' },
        { id: 'ride',   label: 'Ri', midiNotes: [51, 59, 53], color: [0.9, 0.9, 0.9], symbol: 'diamond' },
        { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3], symbol: 'bar'    },
    ],
};

// Live lane table — mutated in place by _applyLanePreset so existing
// references (closures, _computeLaneLayout, _midiToLane builders) keep
// pointing at the same array object after a preset swap.
const DRUM_LANES = [];
const _midiToLane = {};

function _applyLanePreset(presetName) {
    const preset = LANE_PRESETS[presetName] || LANE_PRESETS.phase_shift_8;
    DRUM_LANES.length = 0;
    for (const lane of preset) DRUM_LANES.push(lane);
    for (const k of Object.keys(_midiToLane)) delete _midiToLane[k];
    DRUM_LANES.forEach((lane, idx) => {
        lane.midiNotes.forEach(n => { _midiToLane[n] = idx; });
    });
}
_applyLanePreset(_cfg.lanePreset);

// ── E-kit mapping from Clone Hero ────────────────────────────────────
// GET /api/plugins/drums/kit-mapping reads the kit mapping from Clone
// Hero's active MIDI profile on the computer running Slopsmith (so a LAN
// guest gets the same map). It is the default MIDI map whenever no Learn
// map is saved: Learn edits start from it and Reset Map returns to it.
// Its per-note velocity thresholds drop crosstalk/ghost triggers below
// them, as Clone Hero does.
let _kitMap = null;          // {midi: laneId} or null (no Clone Hero profile)
let _kitMinVel = {};         // {midi: velocity}
let _kitInfo = null;         // {device, source} for the settings panel
function _baseMapping() {
    return _cfg.customMapping || _kitMap;
}
let _kitMappingPromise = null;
function _loadKitMapping() {
    if (typeof fetch !== 'function') return;
    _kitMappingPromise = fetch('/api/plugins/drums/kit-mapping').then(r => (r.ok ? r.json() : null)).then((d) => {
        const map = d && d.mapping ? _validateCustomMapping(d.mapping) : null;
        _kitMap = map;
        _kitMinVel = {};
        if (map && d.min_velocity && typeof d.min_velocity === 'object') {
            for (const [k, v] of Object.entries(d.min_velocity)) {
                const n = parseInt(k, 10), vel = Number(v);
                if (Number.isFinite(n) && Number.isFinite(vel) && vel > 0) _kitMinVel[n] = vel;
            }
        }
        _kitInfo = map ? { device: d.device || '', source: d.source || '' } : null;
        try { _refreshAllMappingTables(); } catch (_) { /* no panel yet */ }
    }).catch(() => { /* no endpoint (older plugin server) */ });
}
_loadKitMapping();

function _getActiveDrumMap() {
    // For the settings mapping table and Learn-mode, return the custom map
    // when set, otherwise derive the default map from _midiToLane (which is
    // rebuilt by _applyLanePreset and is always preset-aware). This ensures
    // that in rb4 mode MIDI notes 45/47 show as mapping to 'tom1' (their
    // actual destination) rather than being omitted by a static map that
    // lists them as 'tom2' — a lane that doesn't exist in rb4.
    //
    // When a customMapping is present, filter out any lane IDs that are not
    // in the active preset so the mapping table and Learn-mode UI show the
    // same effective mapping that _midiToLaneIdx() produces (i.e. entries
    // that fall back to the preset-aware default are shown as unassigned
    // rather than pointing at a lane that doesn't exist).
    const base = _baseMapping();
    if (base) {
        const activeLaneIds = new Set(DRUM_LANES.map(l => l.id));
        const filtered = {};
        for (const [midi, laneId] of Object.entries(base)) {
            if (activeLaneIds.has(laneId)) filtered[midi] = laneId;
        }
        return filtered;
    }
    const result = {};
    for (const [midi, laneIdx] of Object.entries(_midiToLane)) {
        const lane = DRUM_LANES[laneIdx];
        if (lane) result[midi] = lane.id;
    }
    return result;
}

function _midiToLaneIdx(midiNote) {
    // When the user has a custom mapping, honour it (maps MIDI → lane id string).
    // When using the default, delegate to _midiToLane which is rebuilt by
    // _applyLanePreset() and already returns the correct index for the active
    // preset — avoiding stale lane-id references (e.g. 'tom2' in rb4 which
    // has no tom2 lane, causing findIndex to return -1 for mid-tom live hits).
    const custom = _baseMapping();
    if (custom) {
        const laneId = custom[midiNote];
        if (laneId) {
            const idx = DRUM_LANES.findIndex(l => l.id === laneId);
            // If the custom-mapped lane is absent in the active preset (e.g. user
            // mapped a note to 'tom2' then switched to rb4 which has no tom2), fall
            // through to the preset-aware default rather than silently returning -1.
            if (idx >= 0) return idx;
        }
    }
    return _midiToLane[midiNote] !== undefined ? _midiToLane[midiNote] : -1;
}

function _songNoteToLaneIdx(midi) {
    return _midiToLane[midi] !== undefined ? _midiToLane[midi] : -1;
}

// ═══════════════════════════════════════════════════════════════════════
// Color helper
// ═══════════════════════════════════════════════════════════════════════

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// ═══════════════════════════════════════════════════════════════════════
// Script loader
// ═══════════════════════════════════════════════════════════════════════

function _loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// 3D view: lazy-loaded modules (three.js, engine.js, highway3d.js)
// ═══════════════════════════════════════════════════════════════════════
//
// plugin.json can only name one script, so the 3D view's extra files are
// served by this plugin's routes.py (GET /api/plugins/drums/static/<name>,
// whitelisted) and loaded on first use. three.js is core's vendored ES
// module, the same file the bundled 3D guitar highway imports.

const PLUGIN_ID = 'drums';
const ASSET_VERSION = '5.7.0';   // cache-buster for the lazily loaded files
const THREE_URL = '/static/vendor/three/three.module.min.js';
const PLUGIN_STATIC = '/api/plugins/' + PLUGIN_ID + '/static/';

// highway3d.js alone: its pure helpers (drums.json URL / parsing,
// difficulty levels) are also used by the 2D view. One shared promise,
// so the 2D and 3D loaders never race on the same <script> tag.
let _helpersPromise = null;
function _loadHelpers() {
    if (window.DrumsHighway3D) return Promise.resolve(window.DrumsHighway3D);
    if (_helpersPromise) return _helpersPromise;
    _helpersPromise = _loadScript(PLUGIN_STATIC + 'highway3d.js?v=' + ASSET_VERSION).then(() => {
        if (!window.DrumsHighway3D) throw new Error('highway3d.js did not register');
        return window.DrumsHighway3D;
    }).catch((e) => {
        _helpersPromise = null;
        throw e;
    });
    return _helpersPromise;
}

let _libsPromise = null;
function _load3DLibs() {
    if (_libsPromise) return _libsPromise;
    const want = (name, global) => (window[global]
        ? Promise.resolve()
        : _loadScript(PLUGIN_STATIC + name + '?v=' + ASSET_VERSION));
    _libsPromise = Promise.all([
        import(THREE_URL),
        want('engine.js', 'DrumsEngine'),
        _loadHelpers(),
    ]).then(([THREE]) => {
        if (!window.DrumsEngine || !window.DrumsHighway3D) throw new Error('drums 3D modules did not register');
        return { THREE, E: window.DrumsEngine, H: window.DrumsHighway3D };
    }).catch((e) => {
        _libsPromise = null;   // allow a retry on the next init
        throw e;
    });
    return _libsPromise;
}

let _webgl2Probe = null;
function _canWebGL2() {
    if (_webgl2Probe !== null) return _webgl2Probe;
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        _webgl2Probe = !!gl;
        const ext = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
        if (ext && ext.loseContext) ext.loseContext();
    } catch (_) { _webgl2Probe = false; }
    return _webgl2Probe;
}

// Which view a new renderer instance uses: the setting, with '3d' and
// 'auto' falling back to 2D when WebGL2 is unavailable.
function _resolveView(view, canWebGL2) {
    if (view === '2d') return '2d';
    return canWebGL2 ? '3d' : '2d';
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont drum kit synthesizer (module-level — one audio context per tab)
// ═══════════════════════════════════════════════════════════════════════

// Bundled in sounds/ and served by routes.py (works offline, nothing from
// third-party sites). Same files as surikov.github.io/webaudiofont(data).
const WAF_BASE = '/api/plugins/drums/sounds/';
const WAF_PLAYER_URL = '/api/plugins/drums/sounds/WebAudioFontPlayer.js';
function _kitSf(kitId) {
    const k = DRUM_KITS[kitId];
    return (k && k.sf) || DRUM_KITS.jclive.sf;
}
function _kitIsSampled(kitId) { const k = DRUM_KITS[kitId]; return !!(k && k.type === 'samples'); }

// MIDI notes that the synth preloads samples for. Includes
// all notes that appear in any LANE_PRESETS midiNotes array so that
// hits on cross-stick (37), china/splash cymbals (52/55), ride bell (53),
// and alternate tom3 (58) produce audio rather than scoring silently.
const DRUM_MIDI_NOTES = [35, 36, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 57, 58, 59];

function _drumWafVar(note, sf)  { return '_drum_' + note + '_0_' + sf; }
function _drumWafUrl(note, sf)  { return WAF_BASE + '128' + note + '_0_' + sf + '.js'; }

// ── Sampled kits (sounds/kits/<dir>/kit.json + audio files) ──────────
// kit.json: { "format": 1, "notes": { "<midi>": { "layers": [ { "lo": 1, "hi": 50,
// "files": ["snare_v1_a.ogg", ...] }, ... ], "gain"?: 1 } }, "chokes"?: { "<midi>": [<midi>, ...] },
// "gain"?: 1 }. Layers cover velocity ranges (1..127); files are round-robins.
// chokes: hitting the key note cuts the listed notes (closed hi-hat -> open hi-hat).
// File and folder names match routes.py _KIT_FILE (served from sounds/kits/ only).
const KIT_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.(?:ogg|webm|mp3)$/;
const KIT_DIR_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function _kitBaseUrl(dir) { return WAF_BASE + 'kits/' + dir + '/'; }

// Check + normalise a kit.json. Returns { notes: {midi: {layers, gain}}, chokes, gain, files }
// or null if it is unusable. Bad layers / file names are dropped, layers sorted by velocity.
function _validateKitManifest(m) {
    if (!m || typeof m !== 'object' || !m.notes || typeof m.notes !== 'object') return null;
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));
    const clampGain = (v) => Math.max(0, Math.min(4, num(v, 1)));
    const out = { notes: {}, chokes: {}, gain: clampGain(m.gain), files: [] };
    const files = new Set();
    for (const key of Object.keys(m.notes)) {
        const midi = Number(key);
        if (!Number.isInteger(midi) || midi < 0 || midi > 127) continue;
        const n = m.notes[key];
        if (!n || !Array.isArray(n.layers)) continue;
        const layers = [];
        for (const l of n.layers) {
            if (!l || !Array.isArray(l.files)) continue;
            const fl = l.files.filter((f) => typeof f === 'string' && KIT_FILE_RE.test(f));
            if (!fl.length) continue;
            let lo = clampVel(num(l.lo, 1)), hi = clampVel(num(l.hi, 127));
            if (hi < lo) { const t = lo; lo = hi; hi = t; }
            layers.push({ lo, hi, files: fl, gain: clampGain(l.gain) });
            fl.forEach((f) => files.add(f));
        }
        if (!layers.length) continue;
        layers.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
        out.notes[midi] = { layers, gain: clampGain(n.gain) };
    }
    if (!Object.keys(out.notes).length) return null;
    if (m.chokes && typeof m.chokes === 'object') {
        for (const key of Object.keys(m.chokes)) {
            const midi = Number(key);
            const raw = Array.isArray(m.chokes[key]) ? m.chokes[key] : [];
            const list = raw.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 127);
            if (Number.isInteger(midi) && midi >= 0 && midi <= 127 && list.length) out.chokes[midi] = list;
        }
    }
    out.files = Array.from(files);
    return out;
}

// The layer for a velocity: the one whose range holds it, else the nearest range.
function _pickKitLayer(layers, velocity) {
    if (!layers || !layers.length) return null;
    const v = Math.max(1, Math.min(127, Math.round(Number(velocity) || 0)));
    let best = null, bestD = Infinity;
    for (const l of layers) {
        if (v >= l.lo && v <= l.hi) return l;
        const d = v < l.lo ? l.lo - v : v - l.hi;
        if (d < bestD) { bestD = d; best = l; }
    }
    return best;
}

// Gain for a hit inside its layer: the layer's samples already carry the
// loudness of that dynamic, so only a gentle slope across the layer's range
// (0.6 at its bottom .. 1 at its top) smooths the step between layers.
function _kitHitGain(layer, velocity) {
    if (!layer) return 0;
    const v = Math.max(1, Math.min(127, Number(velocity) || 0));
    const span = layer.hi - layer.lo;
    const t = span > 0 ? Math.max(0, Math.min(1, (v - layer.lo) / span)) : 1;
    return (0.6 + 0.4 * t) * (layer.gain == null ? 1 : layer.gain);
}

const _sampleKits = {};       // kitId -> { manifest, buffers: {file: AudioBuffer}, promise }
let _sampleKit = null;        // the loaded sampled kit in use (null = WebAudioFont kit)
const _kitRR = {};            // midi -> round-robin counter
const _kitVoices = {};        // midi -> [{ src, gain }] still sounding (for chokes)

// Fetch + decode one sampled kit (once; later calls share the promise).
function _loadSampleKit(kitId) {
    if (_sampleKits[kitId]) return _sampleKits[kitId].promise;
    const dir = (DRUM_KITS[kitId] && DRUM_KITS[kitId].dir) || '';
    if (!KIT_DIR_RE.test(dir)) return Promise.reject(new Error('bad kit folder'));
    const base = _kitBaseUrl(dir);
    const entry = { manifest: null, buffers: {}, promise: null };
    entry.promise = (async () => {
        const res = await fetch(base + 'kit.json?v=' + ASSET_VERSION);
        if (!res.ok) throw new Error('kit.json HTTP ' + res.status);
        const manifest = _validateKitManifest(await res.json());
        if (!manifest) throw new Error('kit.json is not a valid kit');
        entry.manifest = manifest;
        let failed = 0;
        await Promise.all(manifest.files.map(async (f) => {
            try {
                const r = await fetch(base + f + '?v=' + ASSET_VERSION);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                entry.buffers[f] = await _audioCtx.decodeAudioData(await r.arrayBuffer());
            } catch (e) {
                failed++;
                console.warn('[Drums] Kit sample ' + dir + '/' + f + ' failed:', e);
            }
        }));
        if (failed === manifest.files.length) throw new Error('no samples decoded');
        return entry;
    })().catch((e) => { delete _sampleKits[kitId]; throw e; });
    _sampleKits[kitId] = entry;
    return entry.promise;
}

// Decoded kits take ~100 MB each: keep only the one in use (voices still
// playing keep their own buffers until they end).
function _dropSampleKitsExcept(kitId) {
    for (const id of Object.keys(_sampleKits)) {
        if (id !== kitId && _sampleKits[id].manifest) delete _sampleKits[id];
    }
}

function _sampleKitHit(kit, midiNote, velocity, when, dest) {
    const n = kit.manifest.notes[midiNote];
    if (!n) return;
    const layer = _pickKitLayer(n.layers, velocity);
    if (!layer) return;
    const t = Math.max(when || 0, _audioCtx.currentTime);
    // Chokes: e.g. a closed hi-hat cuts the open hi-hat still ringing.
    const choked = kit.manifest.chokes[midiNote];
    if (choked) {
        for (const c of choked) {
            for (const v of (_kitVoices[c] || [])) {
                if (v.t0 > t) continue;   // scheduled after this hit (Play test)
                try {
                    v.gain.gain.cancelScheduledValues(t);
                    v.gain.gain.setTargetAtTime(0, t, 0.012);
                    v.src.stop(t + 0.1);
                } catch (_) { /* already stopped */ }
            }
        }
    }
    // Round-robin over the layer's files that decoded.
    const rr = (_kitRR[midiNote] = ((_kitRR[midiNote] || 0) + 1) % 1024);
    let buf = null;
    for (let i = 0; i < layer.files.length && !buf; i++) buf = kit.buffers[layer.files[(rr + i) % layer.files.length]] || null;
    if (!buf) return;
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    const g = _audioCtx.createGain();
    g.gain.value = _kitHitGain(layer, velocity) * n.gain * kit.manifest.gain;
    src.connect(g);
    g.connect(dest || _synthGain);
    src.start(t);
    const list = (_kitVoices[midiNote] = (_kitVoices[midiNote] || []));
    const voice = { src, gain: g, t0: t };
    list.push(voice);
    if (list.length > 12) list.shift();
    src.onended = () => {
        const l = _kitVoices[midiNote];
        const i = l ? l.indexOf(voice) : -1;
        if (i >= 0) l.splice(i, 1);
        try { g.disconnect(); } catch (_) { /* gone */ }
    };
}

async function _synthInit() {
    if (_audioCtx) return;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        _audioCtx = new AC({ latencyHint: 'interactive' });
        _synthGain = _audioCtx.createGain();
        _synthGain.gain.value = _cfg.synthVolume;
        _autoGain = _audioCtx.createGain();
        _autoGain.gain.value = _cfg.autoVolume;
        _autoGain.connect(_audioCtx.destination);
        _synthGain.connect(_audioCtx.destination);
        await _synthLoadDrumKit();
    } catch (e) {
        console.warn('[Drums] Synth init failed:', e);
    }
}

// The WebAudioFont player, loaded only when a GM kit is used.
async function _ensureWafPlayer() {
    if (_synthPlayer) return true;
    if (!_playerScriptLoaded) {
        await _loadScript(WAF_PLAYER_URL);
        _playerScriptLoaded = true;
    }
    if (typeof WebAudioFontPlayer === 'undefined') return false;
    _synthPlayer = new WebAudioFontPlayer();
    return true;
}

let _kitLoadSeq = 0;
async function _synthLoadDrumKit() {
    if (!_audioCtx) return;
    _synthLoading = true;
    const seq = ++_kitLoadSeq;
    const kitId = _cfg.kit;
    try {
        if (_kitIsSampled(kitId)) {
            try {
                const kit = await _loadSampleKit(kitId);
                if (seq === _kitLoadSeq) {
                    _sampleKit = kit;
                    _dropSampleKitsExcept(kitId);
                }
                return;
            } catch (e) {
                // Missing / broken kit folder: fall back to the GM kit so pads still sound.
                console.warn('[Drums] Sampled kit ' + kitId + ' failed, using JCLive:', e);
                if (seq !== _kitLoadSeq) return;
            }
        }
        if (!(await _ensureWafPlayer())) return;
        await _loadWafKit(_kitSf(kitId), seq);
        if (seq === _kitLoadSeq) {
            _sampleKit = null;
            _dropSampleKitsExcept(null);
        }
    } catch (e) {
        console.warn('[Drums] Kit load failed:', e);
    } finally {
        if (seq === _kitLoadSeq) _synthLoading = false;
    }
}

async function _loadWafKit(sf, seq) {
    const loaded = {};
    await Promise.all(DRUM_MIDI_NOTES.map(async (note) => {
        const varName = _drumWafVar(note, sf);
        try {
            if (!window[varName]) {
                await _loadScript(_drumWafUrl(note, sf));
            }
            const preset = window[varName];
            if (preset) {
                if (!preset.__drumsAdjusted) {
                    _synthPlayer.adjustPreset(_audioCtx, preset);
                    preset.__drumsAdjusted = true;
                }
                loaded[note] = preset;
            }
        } catch (e) {
            console.warn('[Drums] Failed to load drum note ' + note + ':', e);
        }
    }));
    // A newer kit pick supersedes this load: keep its sounds.
    if (seq === _kitLoadSeq) Object.assign(_drumPresets, loaded);
}

function _synthEnsureCtx() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
}

// One drum sound at `when` (AudioContext time; 0 = now) on the current kit.
// dest: the output bus (default: the pad bus _synthGain; _autoGain for auto notes).
function _synthPlayNote(midiNote, velocity, when, dest) {
    if (!_audioCtx || !_synthGain) return;
    dest = dest || _synthGain;
    if (_sampleKit) {
        _sampleKitHit(_sampleKit, midiNote, velocity, when, dest);
        return;
    }
    const preset = _drumPresets[midiNote];
    if (!preset || !_synthPlayer) return;
    _synthPlayer.queueWaveTable(_audioCtx, dest, preset, when || 0, midiNote, when ? 0.6 : 0.5,
        (velocity / 127) * (dest === _synthGain ? _cfg.synthVolume : 1));
}

function _setAutoVolume(vol) {
    _saveCfg('autoVolume', vol);
    if (_autoGain) _autoGain.gain.value = _cfg.autoVolume;
    try {
        document.querySelectorAll('.drums-autovol-slider').forEach((el) => { el.value = String(Math.round(_cfg.autoVolume * 100)); });
    } catch (_) { /* no DOM */ }
}

// GM notes the auto settings play for the player (engine.js MIDI_MAP: kick
// pads and the yellow/blue/green cymbals; the hat pedal is never scored).
const _AUTO_KICK_MIDI = new Set([35, 36]);
const _AUTO_CYM_MIDI = new Set([42, 46, 49, 51, 52, 53, 55, 57, 59]);

function _isAutoMidi(midi, auto) {
    return !!auto && ((auto.kick && _AUTO_KICK_MIDI.has(midi)) || (auto.cymbals && _AUTO_CYM_MIDI.has(midi)));
}

// Velocity for an auto note: drum-tab velocity, else accent / ghost / normal.
function _autoVelocity(n) {
    if (Number.isFinite(n._vel)) return n._vel;
    return n.ac ? 118 : (n.mt ? 55 : 100);
}

// Auto notes with from < t <= to in a sorted wire list ({t, s, f}) and its
// chords, as [{t, midi, vel}]. Pure (tested).
function _autoNotesBetween(notes, chords, from, to, auto) {
    const out = [];
    if (!auto || (!auto.kick && !auto.cymbals) || !(to > from)) return out;
    const scan = (list, each) => {
        if (!Array.isArray(list)) return;
        let lo = 0, hi = list.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (!(list[m] && list[m].t > from)) lo = m + 1; else hi = m; }
        for (let i = lo; i < list.length && list[i] && list[i].t <= to; i++) each(list[i]);
    };
    scan(notes, (n) => {
        if (n._noScore) return;
        const midi = (n.s | 0) * 24 + (n.f | 0);
        if (_isAutoMidi(midi, auto)) out.push({ t: n.t, midi, vel: _autoVelocity(n) });
    });
    scan(chords, (c) => {
        for (const cn of (c.notes || [])) {
            const midi = (cn.s | 0) * 24 + (cn.f | 0);
            if (_isAutoMidi(midi, auto)) out.push({ t: c.t, midi, vel: _autoVelocity(cn) });
        }
    });
    return out;
}

function _synthDrumHit(midiNote, velocity) {
    if (!_audioCtx || !_synthGain) return;
    _synthEnsureCtx();
    _synthPlayNote(midiNote, velocity, 0);
}

function _synthSetVolume(vol) {
    _saveCfg('synthVolume', vol);
    if (_synthGain) _synthGain.gain.value = _cfg.synthVolume;
    try {
        document.querySelectorAll('.drums-vol-slider').forEach((el) => { el.value = String(Math.round(_cfg.synthVolume * 100)); });
    } catch (_) { /* no DOM */ }
}

// Switch the synth's sound set. Loads only the picked kit (lazily, once).
async function _synthSetKit(kitId) {
    _saveCfg('kit', kitId);
    try { document.querySelectorAll('.drums-kit-select').forEach((sel) => { sel.value = _cfg.kit; }); } catch (_) { /* no DOM */ }
    if (_audioCtx) await _synthLoadDrumKit();
}

// Short groove on the current kit (settings "Play test" button).
async function _synthPlayTest() {
    await _synthInit();
    if (!_audioCtx) return;
    _synthEnsureCtx();
    for (let i = 0; i < 100 && _synthLoading; i++) await new Promise((r) => setTimeout(r, 100));
    // [eighth, GM note, velocity] at 110 BPM, then a tom fill into a crash.
    const pat = [
        [0, 36, 110], [0, 42, 90], [1, 42, 70], [2, 38, 110], [2, 42, 90], [3, 42, 70],
        [4, 36, 110], [4, 42, 90], [5, 36, 90], [5, 42, 70], [6, 38, 115], [6, 42, 90], [7, 46, 80],
        [8, 50, 100], [8.5, 48, 100], [9, 45, 105], [9.5, 43, 110], [10, 36, 120], [10, 49, 115],
    ];
    const step = 60 / 110 / 2;
    const t0 = _audioCtx.currentTime + 0.08;
    for (const [b, note, vel] of pat) _synthPlayNote(note, vel, t0 + b * step);
}

// ═══════════════════════════════════════════════════════════════════════
// Web MIDI input (module-level — one MIDI access per tab)
// ═══════════════════════════════════════════════════════════════════════

// The core midi-input domain, if present (it ships with core).
function _mi() {
    const m = window.slopsmith && window.slopsmith.midiInput;
    if (m && m.version === 1) return m;
    // Cores without the midi-input domain (Slopsmith desktop 0.2.x) get a
    // minimal Web MIDI provider with the same surface, so the kit still works.
    return _webMidiShim();
}

// ── Web MIDI fallback provider ───────────────────────────────────────
// Implements the subset of the core midi-input domain this plugin uses:
// discover / listSources / select / open (-> handle.addListener /
// removeListener, raw MIDI bytes) / close, plus 'midi-input:sources-changed'
// on plug/unplug. One MIDIAccess for the page; inputs are opened on demand.
let _shim = null;
function _webMidiShim() {
    if (_shim) return _shim;
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') return null;
    let access = null;
    const listeners = new Map();   // logicalSourceKey -> Set<fn(data)>
    const keyOf = (id) => 'web-midi::' + id;
    const inputFor = (key) => {
        if (!access) return null;
        for (const inp of access.inputs.values()) if (keyOf(inp.id) === key) return inp;
        return null;
    };
    const sourcesChanged = () => {
        try {
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') window.slopsmith.emit('midi-input:sources-changed', {});
            else _midiReconcileSources();
        } catch (_) { /* ignore */ }
    };
    _shim = {
        version: 1,
        shim: true,
        async discover() {
            if (!access) {
                access = await navigator.requestMIDIAccess({ sysex: false });
                access.onstatechange = (e) => { if (e && e.port && e.port.type === 'input') sourcesChanged(); };
            }
            return { outcome: 'handled' };
        },
        listSources() {
            if (!access) return [];
            return Array.from(access.inputs.values())
                .filter(inp => inp.state !== 'disconnected')
                .map(inp => ({ sourceId: inp.id, label: inp.name || inp.manufacturer || inp.id, logicalSourceKey: keyOf(inp.id) }));
        },
        async select() { /* selection lives in the plugin */ },
        async open({ logicalSourceKey }) {
            const inp = inputFor(logicalSourceKey);
            if (!inp) return { handle: null };
            // Throws if another program holds the port (Windows MIDI is exclusive).
            await inp.open();
            let set = listeners.get(logicalSourceKey);
            if (!set) {
                set = new Set();
                listeners.set(logicalSourceKey, set);
                inp.onmidimessage = (e) => { for (const fn of set) { try { fn(e.data); } catch (err) { console.warn('[Drums] MIDI listener failed:', err); } } };
            }
            return {
                handle: {
                    addListener(fn) { set.add(fn); },
                    removeListener(fn) { set.delete(fn); },
                },
            };
        },
        close({ logicalSourceKey }) {
            const set = listeners.get(logicalSourceKey);
            const inp = inputFor(logicalSourceKey);
            if (set && set.size) return;     // still in use by another listener
            listeners.delete(logicalSourceKey);
            if (inp) { inp.onmidimessage = null; try { inp.close(); } catch (_) { /* ignore */ } }
        },
    };
    return _shim;
}

// MIDI status for the settings panel: device, hits received, last error.
const _midiDiag = { hits: 0, last: '', error: '' };
function _midiStatusText() {
    if (!_mi()) return 'MIDI not available in this browser (use Chrome, Edge or Brave; Safari has no Web MIDI).';
    if (_midiDiag.error) return 'MIDI problem: ' + _midiDiag.error;
    if (!_midiInput) return 'No MIDI input selected.';
    return 'Listening to ' + (_midiInput.name || 'MIDI input') + ' · ' + _midiDiag.hits + ' hits received'
        + (_midiDiag.last ? ' · last: ' + _midiDiag.last : '');
}
let _midiStatusTimer = null;
function _refreshMidiStatus() {
    if (_midiStatusTimer) return;
    _midiStatusTimer = setTimeout(() => {
        _midiStatusTimer = null;
        try { document.querySelectorAll('.drums-midi-status').forEach((el) => { el.textContent = _midiStatusText(); }); } catch (_) { /* no DOM */ }
    }, 150);
}

// Domain sources shaped like the old MIDIInput list: { id, name, key }.
// sourceId == the old MIDIInput.id, so stored `midiInputId` stays compatible.
function _midiSources() {
    const mi = _mi();
    if (!mi) return [];
    return mi.listSources().map(s => ({ id: s.sourceId, name: s.label, key: s.logicalSourceKey }));
}

// In-flight guard around discover(): Wave C calls _midiInit() once per init();
// N concurrent splitscreen instances would otherwise issue N discover() calls
// (each a requestMIDIAccess via the provider) before the first resolves.
let _midiInitPromise = null;

async function _midiInit() {
    const mi = _mi();
    if (!mi) return;
    // Already discovered: re-run auto-connect so a re-mount after a full release
    // (or a settings re-open) reconnects from the saved pick instead of no-opping.
    // Already discovered: only (re)connect when there's no live session. A
    // repeated _midiInit (settings panel open, extra splitscreen instance) must
    // NOT re-enter _midiConnect on an active handle — that tears down the live
    // session and releases held pads for no reason. After a full release the
    // handle is null, so reconnect happens then.
    if (_midiReady) { if (!_midiHandle) _midiAutoConnect(); return; }
    if (_midiInitPromise) return _midiInitPromise;
    _midiInitPromise = (async () => {
        try {
            const r = await mi.discover();  // permission boundary (requestMIDIAccess)
            // Only latch ready on a successful discovery — a denied/unavailable
            // outcome must NOT latch, or reopening the panel never retries.
            if (!r || r.outcome !== 'handled') return;
            _midiReady = true;
            _midiDiag.error = '';
            // Refresh device lists on plug/unplug (replaces MIDIAccess.onstatechange).
            if (!_midiStateSub && window.slopsmith && typeof window.slopsmith.on === 'function') {
                _midiStateSub = true;
                window.slopsmith.on('midi-input:sources-changed', () => _midiReconcileSources());
            }
            _midiAutoConnect();
            // Populate whatever settings panels are open.
            _midiUpdateAllDeviceLists();
        } catch (e) {
            console.warn('[Drums] MIDI access denied:', e);
            _midiDiag.error = 'MIDI access was denied (' + ((e && (e.message || e.name)) || 'unknown') + ')';
            _refreshMidiStatus();
        } finally {
            // On success future calls short-circuit on `_midiReady`; on
            // rejection, releasing the slot lets a later init() retry.
            _midiInitPromise = null;
        }
    })();
    return _midiInitPromise;
}

// Plug/unplug reconciliation (midi-input:sources-changed). The domain closes +
// deletes a session when its device is unplugged, so refreshing the dropdown
// isn't enough: if OUR selected device vanished, drop the now-stale
// handle/selection (keeping _midiActive) and re-auto-connect — that reattaches
// the saved device when it's replugged, or falls back to another input. Then
// refresh the dropdowns. If the selected device is unaffected, just refresh.
function _midiReconcileSources() {
    if (_midiInput && !_midiSources().some(s => s.key === _midiInput.key)) {
        if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
        _midiHandle = null;
        _midiListener = null;
        _midiInput = null;
        // No note-off can arrive for pads that were down at unplug — clear any
        // sounding/lit state so a lane isn't stuck until the next hit.
        for (const inst of _instances) {
            if (inst && typeof inst._releaseAllSounding === 'function') inst._releaseAllSounding();
        }
    }
    // Reconnect ONLY to the saved device when it's (re)present. Don't fall back to
    // another input here: _midiConnect persists its id, so a fallback during a
    // transient unplug would overwrite the user's saved kit (the original returns
    // on replug and reconnects then). A deliberate device switch goes through the UI.
    if (!_midiInput) {
        const sources = _midiSources();
        const raw = _readStore(STORE_KEYS.midiInputId);
        if (raw === '') {
            // explicit None — stay disconnected.
        } else {
            const key = _midiAutoChoice(raw, sources);
            if (key) _midiConnect(key);                              // saved device (or the kit) present → connect
            // else: a saved pick exists but is absent → preserve (reconnect on replug)
        }
    }
    _midiUpdateAllDeviceLists();
}

// Resolve a persisted selection to a current source's logicalSourceKey. Handles
// both the new logicalSourceKey storage AND legacy bare web-midi sourceId saves
// (pre-domain), returning the canonical key, or null when the device is absent.
function _midiResolveSaved(saved, sources) {
    if (!saved) return null;
    let m = sources.find(s => s.key === saved);    // new: stored logicalSourceKey
    if (!m) m = sources.find(s => s.id === saved);  // legacy: bare web-midi sourceId
    return m ? m.key : null;
}

async function _midiAutoConnect() {
    // Wait (briefly) for Clone Hero's device name so the kit can be recognised.
    if (_kitMappingPromise) { try { await Promise.race([_kitMappingPromise, new Promise(r => setTimeout(r, 1500))]); } catch (_) { /* ignore */ } }
    const inputs = _midiSources();
    if (!inputs.length) return;
    const key = _midiAutoChoice(_readStore(STORE_KEYS.midiInputId), inputs);
    if (key) _midiConnect(key);
}

// Which input to open without asking. Explicit "None" ('') stays off and a
// device picked by hand is kept. Otherwise the drum kit wins: an auto-picked
// device that isn't the kit is replaced by the kit when the kit is present.
// A saved device that is absent (unplugged) is kept for its return unless
// the kit is here. Returns a logicalSourceKey or null.
function _midiAutoChoice(raw, inputs) {
    if (raw === '' || !inputs.length) return null;
    const saved = _midiResolveSaved(raw, inputs);
    const manual = _readStore(STORE_KEYS.midiManual) === '1';
    if (saved && manual) return saved;
    const kit = _kitSource(inputs);
    if (kit) return kit.key;
    if (saved) return saved;
    return raw == null ? inputs[0].key : null;      // never picked: something rather than nothing
}

// No saved pick: the kit Clone Hero is set up for (its MIDI profile is
// named after the device, sometimes with a " 0"-style index), then
// anything that looks like a drum module, then the first input.
function _preferredKitSource(inputs, kitDevice) {
    return _kitSource(inputs, kitDevice) || inputs[0];
}

// The drum kit among the inputs, or null: the device Clone Hero's profile is
// named after (exact match, ignoring case and Clone Hero's " 0" index suffix),
// then a name that looks like a drum module.
const _DRUM_NAME = /\bdrums?\b|alesis|\btd-?\d|e-?kit|roland td|yamaha dtx|\bdtx\b/i;
function _kitSource(inputs, kitDevice) {
    const norm = (x) => String(x || '').toLowerCase().replace(/\s+\d+$/, '').trim();
    const want = norm(kitDevice !== undefined ? kitDevice : (_kitInfo && _kitInfo.device));
    if (want) {
        const m = inputs.find(s => norm(s.name) === want);
        if (m) return m;
    }
    return inputs.find(s => _DRUM_NAME.test(s.name || '')) || null;
}

async function _midiConnect(key) {
    const myGen = ++_midiConnectSeq;
    const mi = _mi();
    // Tear down any existing live session.
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    if (mi && _midiInput) { try { mi.close({ requester: 'drums', logicalSourceKey: _midiInput.key }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;

    // Release anything currently sounding / held on the OLD device
    // before we swap. Drum notes are short (queueWaveTable duration
    // 0.5s) so hung tones are less likely than for piano, but
    // _heldPads drives on-screen lane pressed state and would
    // otherwise keep the prior hit animating after a device swap.
    // Iterate ALL live instances — _activeInstance can be null
    // (no panel focused yet) or stale (focus swapped between
    // device events). Iterating _instances guarantees no panel
    // shows "stuck" pressed lanes when it later becomes focused.
    for (const inst of _instances) {
        if (inst && typeof inst._releaseAllSounding === 'function') {
            inst._releaseAllSounding();
        }
    }
    // Learn-mode is a module-scope sentinel, so clear once and
    // refresh every panel's Learn UI to keep buttons in sync.
    _cfg.learnLane = null;
    _updateLearnUI();

    // Persist regardless of match. Empty key is the explicit "None" option and
    // must be saved so _midiAutoConnect respects the opt-out on next init instead
    // of auto-picking inputs[0] again. We store the globally-unique
    // logicalSourceKey (not the provider-local sourceId).
    _saveCfg('midiInputId', key || '');

    if (!key || !mi) {
        _midiUpdateAllDeviceLists();
        return;
    }
    const src = _midiSources().find(s => s.key === key);
    if (!src) { _midiUpdateAllDeviceLists(); return; }
    _midiInput = { id: src.id, name: src.name, key: src.key };   // selection descriptor for the UI
    // No live renderer to consume OR release a session — don't hold one open
    // (settings-only init, or the last instance was torn down during async
    // discovery). The pick is saved; a later renderer mount re-runs auto-connect
    // and opens for real, and its destroy() releases it.
    if (_instances.size === 0) { _midiUpdateAllDeviceLists(); return; }
    try {
        await mi.select(src.key);
        const res = await mi.open({ requester: 'drums', logicalSourceKey: src.key });
        // A newer _midiConnect (rapid device switch / None) superseded us while
        // we awaited — discard this open so we don't install a stale handle.
        if (myGen !== _midiConnectSeq) {
            if (!_midiInput || _midiInput.key !== src.key) { try { mi.close({ requester: 'drums', logicalSourceKey: src.key }); } catch (_) { /* best-effort */ } }
            return;
        }
        if (res && res.handle) {
            _midiDiag.error = '';
            _midiHandle = res.handle;
            // The domain handle delivers raw MIDI data; adapt to the old
            // MIDIMessageEvent shape so _midiOnMessage stays unchanged.
            _midiListener = (data) => _midiOnMessage({ data });
            // Wire the listener only when at least one renderer is active. A
            // late open() from an async _midiInit that resolved post-destroy
            // would otherwise re-enable scoring/synth in the background.
            if (_midiActive) _midiHandle.addListener(_midiListener);
        } else {
            // Open yielded no live handle (device vanished post-discovery, or the
            // provider reported denied/unavailable). Clear the selection so the UI
            // doesn't show a phantom connected device and miss-counting stays off.
            _midiInput = null;
        }
    } catch (e) {
        console.warn('[Drums] MIDI open failed:', e);
        if (myGen === _midiConnectSeq) {
            _midiDiag.error = (e && e.name === 'InvalidAccessError')
                ? 'the kit is in use by another program (close Clone Hero or other apps using it, then pick it again)'
                : ((e && (e.message || e.name)) || 'unknown error');
        }
        // Only clear if we're still the current connect — a stale older open's
        // rejection (rapid switch / autoconnect racing a manual pick) must not
        // wipe a newer connect's already-installed _midiInput/_midiHandle (which
        // would also leak the live handle, since closes are gated on _midiInput).
        if (myGen === _midiConnectSeq) _midiInput = null;
    }
    _midiUpdateAllDeviceLists();
}

function _midiPauseHandler() {
    // Called from destroy() when the LAST instance goes away —
    // detach the message handler so the connected kit stops firing
    // hits into a plugin no longer visible. Flipping _midiActive
    // BEFORE the detach also prevents a late-resolving _midiConnect
    // (from an in-flight _midiInit started in the most recent init())
    // from re-wiring the handler on an already-destroyed renderer.
    // Keep _midiInput so a future init() can reattach without the
    // user re-picking.
    _midiActive = false;
    if (_midiHandle && _midiListener) { try { _midiHandle.removeListener(_midiListener); } catch (_) { /* best-effort */ } }
    // Clear pending Learn-mode sentinel — leaving it set would
    // consume the first drum hit on the NEXT renderer lifetime
    // (user clicks Learn, closes the last drums panel before
    // tapping a pad, reopens drums later, hits a pad → silent
    // remap with no UI explaining why). _updateLearnUI() refreshes
    // any reopened settings panel; if no panel is open right now
    // the call is a cheap no-op.
    _cfg.learnLane = null;
    _updateLearnUI();
}

// Called when the LAST live instance is torn down. Builds on _midiPauseHandler
// (listener detach + Learn-sentinel clear) by also fully releasing the shared
// midi-input domain session, so the e-kit/provider session isn't held open after
// the visualization is gone and the core domain can close the device once other
// consumers release it too. Reset readiness so a later re-mount re-discovers and
// auto-connects from the saved pick.
function _midiReleaseSession() {
    _midiConnectSeq += 1;   // invalidate any in-flight _midiConnect open
    _midiPauseHandler();
    const mi = _mi();
    if (mi && _midiInput) { try { mi.close({ requester: 'drums', logicalSourceKey: _midiInput.key || ('web-midi::' + _midiInput.id) }); } catch (_) { /* best-effort */ } }
    _midiHandle = null;
    _midiListener = null;
    _midiInput = null;
    // Intentionally leave _midiReady latched and _midiInitPromise alone: _midiInit
    // re-runs _midiAutoConnect on a ready re-mount (no re-discover needed), and
    // clearing the in-flight promise here would let a quick remount during a
    // pending discover() start a SECOND requestMIDIAccess, defeating the guard.
    // The in-flight init clears its own promise in its finally.
}

function _midiResumeHandler() {
    // Idempotent: a second instance init (splitscreen / re-init) calls this while
    // already active. The domain handle's addListener is Set-backed, but don't
    // rely on the provider de-duping — re-adding could double-deliver each MIDI
    // event to the focused instance, doubling note-ons/hits.
    if (_midiActive) return;
    // Called from init() — flip the gate first so an in-flight
    // _midiConnect that lands shortly after this returns wires the
    // handler too. If _midiInput is already populated from a prior
    // lifetime, restore the handler immediately.
    _midiActive = true;
    if (_midiHandle && _midiListener) { try { _midiHandle.addListener(_midiListener); } catch (_) { /* best-effort */ } }
}

function _midiOnMessage(e) {
    // Only the focused instance receives MIDI. Module-level
    // _activeInstance is the routing slot; it points at null when
    // no instance is focused (splitscreen toggled off mid-session
    // between teardowns, or no instance initialised yet).
    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;
    const cmd = status & 0xF0;
    if (cmd === 0x90 && velocity > 0) {
        // Counted before routing so the settings status shows whether the
        // kit reaches Slopsmith at all, and why a hit was dropped.
        _midiDiag.hits++;
        _midiDiag.last = 'note ' + note + ' vel ' + velocity + ' ch ' + (ch + 1)
            + (!_activeInstance ? ' (no drum view focused)'
                : (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) ? ' (ignored: Ch filter is ' + (_cfg.midiChannel + 1) + ')' : '');
        _refreshMidiStatus();
    }
    if (!_activeInstance) return;
    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    if (cmd === 0x90 && velocity > 0) {
        _activeInstance._handleDrumHit(note, velocity);
    }
    // Drums don't need note-off handling (one-shot hits)
}

function _midiUpdateAllDeviceLists() {
    const inputs = _midiSources();
    _refreshMidiStatus();

    // Every instance's settings panel (if open) has a
    // `.drums-midi-select` node. Iterate all of them so a
    // device plug/unplug reflects everywhere simultaneously.
    const selects = document.querySelectorAll('.drums-midi-select');
    for (const sel of selects) {
        // Build <option> elements via the DOM API rather than
        // concatenating an HTML string. MIDI device names come from
        // attached hardware and can contain characters that would
        // otherwise inject markup ("<" in a vendor string or a
        // maliciously-named device) directly into the settings panel.
        // .value / .textContent escape both fields safely.
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        sel.appendChild(noneOpt);
        for (const inp of inputs) {
            const opt = document.createElement('option');
            opt.value = inp.key;
            // inp.name can be null / empty across browsers and devices
            // (Firefox historically, some class-compliant kits); fall
            // back through manufacturer → id so the dropdown never
            // literally says "null".
            opt.textContent = inp.name || inp.manufacturer || inp.id || 'Unknown device';
            if (_midiInput && _midiInput.key === inp.key) opt.selected = true;
            sel.appendChild(opt);
        }
    }
}

// Refresh every Learn button across every open settings panel so the
// "..." pending indicator and the active-lane highlight reflect the
// shared _cfg.learnLane sentinel.
function _updateLearnUI() {
    const learnBtns = document.querySelectorAll('.drums-learn-btn');
    learnBtns.forEach(btn => {
        const idx = parseInt(btn.dataset.lane);
        btn.textContent = _cfg.learnLane === idx ? '...' : 'Learn';
        btn.style.color = _cfg.learnLane === idx ? '#ff0' : '#aaa';
    });
}

// Build the mapping table rows from the active drum map. Module-scope
// because customMapping is module-shared state — every open settings
// panel (across N splitscreen drum instances) should render the same
// rows. References only module-scope identifiers (DRUM_LANES, _cfg,
// _getActiveDrumMap, _rgbStr).
function _buildMappingRows() {
    return DRUM_LANES.map((lane, idx) => {
        const map = _getActiveDrumMap();
        const assigned = Object.entries(map).filter(([_, v]) => v === lane.id).map(([k]) => k).join(', ');
        return `<tr>
            <td style="color:${_rgbStr(lane.color[0], lane.color[1], lane.color[2])};font-weight:bold;padding:2px 6px;">${lane.label}</td>
            <td style="color:#888;padding:2px 6px;font-size:10px;">${assigned || 'none'}</td>
            <td style="padding:2px 4px;"><button class="drums-learn-btn" data-lane="${idx}"
                style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:1px 6px;
                font-size:10px;color:${_cfg.learnLane === idx ? '#ff0' : '#aaa'};cursor:pointer;">${_cfg.learnLane === idx ? '...' : 'Learn'}</button></td>
        </tr>`;
    }).join('');
}

// Re-bind Learn-button onclicks within a freshly-rebuilt mapping
// table. Module-scope because the handler only mutates _cfg.learnLane
// (module-shared) and calls _updateLearnUI (also module-scope) —
// no per-instance closure needed.
function _wireLearnButtons(scope) {
    scope.querySelectorAll('.drums-learn-btn').forEach(btn => {
        btn.onclick = function () {
            const idx = parseInt(this.dataset.lane);
            _cfg.learnLane = _cfg.learnLane === idx ? null : idx;
            _updateLearnUI();
        };
    });
}

// Rebuild EVERY open mapping table after a customMapping change
// (Learn-mode assignment, Reset Map button). Iterating the DOM
// rather than _instances means we rebuild only the tables that
// actually exist in the document — instances whose settings panel
// was never opened simply don't have a `.drums-map-table` node yet,
// and they pick up the current state when the panel opens later.
// Where the MIDI map in use comes from, for the settings panel.
// (Lanes are by colour in the 3D view: Ri = blue cymbal, Cr = green cymbal.)
function _mapSourceText() {
    if (_cfg.customMapping) return 'your Learn map';
    if (_kitMap) return 'Clone Hero profile "' + ((_kitInfo && _kitInfo.device) || 'kit') + '" (Ri = blue cymbal, Cr = green cymbal)';
    return 'General MIDI defaults';
}

// Learn mode: when a lane is waiting for a pad, assign this MIDI note to it
// and return true (the hit is consumed). _cfg.learnLane is module-scope so
// the assignment + UI refresh apply uniformly across every open panel.
function _learnConsume(midiNote) {
    if (_cfg.learnLane === null || !DRUM_LANES[_cfg.learnLane]) return false;
    // Use the full customMapping (not the filtered active-only view) so
    // that inactive preset lane assignments (e.g. tom2 in rb4 mode) are
    // preserved — only the new assignment is added/overwritten.
    const map = Object.assign({}, _cfg.customMapping || _kitMap || _getActiveDrumMap());
    map[midiNote] = DRUM_LANES[_cfg.learnLane].id;
    _saveCfg('customMapping', map);
    _cfg.learnLane = null;
    _updateLearnUI();
    // Rebuild the "assigned" column on EVERY open settings table —
    // customMapping is module-shared.
    _refreshAllMappingTables();
    return true;
}

function _refreshAllMappingTables() {
    document.querySelectorAll('.drums-map-source').forEach((el) => { el.textContent = '— ' + _mapSourceText(); });
    const tables = document.querySelectorAll('.drums-map-table');
    if (!tables.length) return;
    const html = _buildMappingRows();
    tables.forEach(tbl => {
        tbl.innerHTML = html;
        _wireLearnButtons(tbl);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrappers
// ═══════════════════════════════════════════════════════════════════════
//
// Centralise the "am I in splitscreen?" / "which panel are my chrome
// anchors?" queries so instance code can read the runtime environment
// cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
// means "main-player, always focused" from the plugin's POV.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    // Validate the FULL surface this plugin consumes, not just
    // isActive(). If a future splitscreen build ships partial
    // helpers (or an older bundled splitscreen lacks one of the
    // newer methods), report "not active" so the wrappers fall
    // back to the main-player single-instance fast path rather
    // than reaching a half-broken splitscreen state where focus
    // never lands on any instance and MIDI routing dies.
    return typeof ss.isCanvasFocused === 'function'
        && typeof ss.panelChromeFor === 'function'
        && typeof ss.settingsAnchorFor === 'function'
        && typeof ss.onFocusChange === 'function'
        && typeof ss.offFocusChange === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.panelChromeFor === 'function')
        ? ss.panelChromeFor(highwayCanvas) : null;
}

function _ssSettingsAnchor(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.settingsAnchorFor === 'function')
        ? ss.settingsAnchorFor(highwayCanvas) : null;
}

function _ssIsCanvasFocused(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return true;  // main-player fast path
    return !!(ss && typeof ss.isCanvasFocused === 'function' &&
              ss.isCanvasFocused(highwayCanvas));
}

// ═══════════════════════════════════════════════════════════════════════
// Round rect helper (stateless)
// ═══════════════════════════════════════════════════════════════════════

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ═══════════════════════════════════════════════════════════════════════
// Lane geometry (vertical — lanes are columns, notes scroll top → bottom)
// ═══════════════════════════════════════════════════════════════════════

function _computeLaneLayout(W /* , H */) {
    const numLanes = DRUM_LANES.length;
    const padL = 10;
    const padR = 10;
    const availW = W - padL - padR;

    const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');
    const regularW = (availW - KICK_LANE_EXTRA) / numLanes;
    const kickW = regularW + KICK_LANE_EXTRA;

    const lanes = [];
    let x = padL;
    for (let i = 0; i < numLanes; i++) {
        const w = i === kickIdx ? kickW : regularW;
        lanes.push({
            idx: i,
            lane: DRUM_LANES[i],
            x: x,
            w: w,
            centerX: x + w / 2,
        });
        x += w + LANE_PAD;
    }
    return lanes;
}

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory(forceView) {
    const _instanceId = ++_nextInstanceId;

    // '2d' = the lane renderer below (unchanged), '3d' = the WebGL drum
    // track from highway3d.js driven by engine.js. Fixed for this
    // instance's lifetime because highway.js reads contextType before
    // init(); a settings change installs a fresh instance instead.
    const _view = (forceView === '2d' || forceView === '3d')
        ? (forceView === '3d' && !_canWebGL2() ? '2d' : forceView)
        : _resolveView(_cfg.view, _canWebGL2());

    // Lifecycle
    let _isReady = false;

    // Rendering state — _drumCanvas / _drumCtx point at the highway's own
    // canvas (passed to init by highway.js). We render directly onto it
    // instead of overlaying a separate canvas, matching the 3D Highway
    // plugin's pattern. The player-controls strip stays at the bottom
    // naturally because highway.js sizes the canvas to exclude it.
    let _drumCanvas = null;
    let _drumCtx = null;
    let _highwayCanvas = null;

    // Settings UI
    let _settingsPanel = null;
    let _settingsGear = null;
    let _settingsVisible = false;

    // Held / flash state — per-instance so each panel only shows the
    // pads ITS focused user is hitting.
    const _heldPads = new Map();          // midi note -> {velocity, wall}
    const _wrongFlashes = [];             // [{lane, wall}]
    const _laneFlashes = [];              // [{laneIdx, wall, color}]

    // Scoring
    let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
    const _hitNoteKeys = new Set();
    const _missedNoteKeys = new Set();

    // Latest bundle snapshot — cached each frame so MIDI handler
    // (async wrt draw) can score against the filter-aware chart
    // the user sees.
    let _latestNotes = null, _latestChords = null, _latestTime = 0;

    // Cached drum_tab → legacy-shape notes from the last frame. Memoised
    // on the drum_tab object identity so the conversion (kit walk + sort)
    // runs once per chart load, not per frame. Cleared on chart reset.
    let _drumTabCacheKey = null;
    let _drumTabCacheNotes = null;

    // Wave C: replace the module-level `song:ready` subscription
    // with a bundle.isReady edge-detect per-instance. The global
    // event fires N times under splitscreen (once per panel's
    // highway); edge-detecting locally scopes the reset correctly.
    let _lastBundleIsReady = false;

    // Wave C focus state
    let _isFocused = false;
    // Tracks whether we successfully subscribed to splitscreen
    // focus-change events. Necessary because subscribe is gated on
    // _ssActive() (full helper surface + isActive()===true) but
    // destroy() must still unsubscribe what was actually attached
    // — we can't re-derive "did we subscribe?" from a fresh
    // _ssActive() check at destroy time, since isActive() might
    // have flipped false (splitscreen toggled off) between init
    // and destroy. Without this flag a defensive offFocusChange
    // call against a subscription that never happened would be a
    // no-op for EventTarget but obscures intent; a missed
    // unsubscribe of one we DID register would leak the listener
    // closure across the destroy.
    let _focusSubscribed = false;

    // ── 3D view state (only used when _view === '3d') ──
    let _libs = null;               // { THREE, E: DrumsEngine, H: DrumsHighway3D }
    let _view3d = null;             // DrumsHighway3D.createView(...)
    let _session = null;            // DrumsHighway3D.createSession(...)
    let _hudCanvas = null;          // 2D overlay (HUD + core draw hooks)
    let _initToken = 0;             // supersedes in-flight async inits
    let _chartRefs = null;          // [notes, chords, beats] identities of the loaded chart
    let _metaUrl;                   // drums.json URL fetched for the loaded song (undefined = none yet)
    let _metaCache = null;          // parsed drums block for _metaUrl
    let _metaSeq = 0;
    let _renderScale = 1;
    let _lastHwW = 0, _lastHwH = 0;
    let _hwVisible = true;
    const _clock = { time: NaN, wall: NaN, prevTime: NaN, prevWall: NaN };
    let _onVisibility = null, _onCanvasReplaced = null, _onKeyDown = null;

    // ── Difficulty (both views) ──
    // The wire notes are the Expert chart; Easy/Medium/Hard come from the
    // drums.json `levels` block (see highway3d.js "difficulty levels").
    let _h = null;                  // DrumsHighway3D (pure helpers), loaded in both views
    let _metaState = 'none';        // drums.json for the loaded song: 'pending' | 'loaded' | 'none'
    let _diffOptions = null;        // _h.difficultyOptions(...) for the loaded chart
    let _diff = null;               // _h.resolveDifficulty(...) in use: {id, requested, fallback, reason}
    let _badge = null;              // _h.difficultyBadge(...) drawn in the HUD
    let _diffUiKey = '';            // last difficulty state written to the DOM
    let _lvlMemo = null;            // {notes, chords, id, src, chart}: chart for the difficulty
    let _has2xMemo = null;          // {notes, chords, val}
    let _scoreFromT = -Infinity;    // 2D view: no miss marks before a mid-song difficulty switch
    let _badgeBtn = null;           // clickable button over the HUD badge
    let _badgeRectKey = '';
    let _diffMenu = null;           // difficulty pop-up menu
    let _onDiffKey = null, _onMenuOutside = null;
    let _auto = { kick: false, cymbals: false };   // auto lanes for the difficulty in use
    // Auto-note sounds: song time up to which they're scheduled, and the last
    // frame's (song time, wall ms) for the playback-rate estimate.
    let _autoSchedTo = NaN, _autoPrevT = NaN, _autoPrevWall = NaN;

    // Play the auto notes (kick / cymbals) so a muted drum stem doesn't leave
    // holes. Scheduled ~60 ms ahead on the audio clock for tight timing; a
    // pause, seek or song change resets the schedule (nothing is replayed).
    const AUTO_LOOKAHEAD = 0.06;
    function _scheduleAutoSounds(notes, chords, t) {
        const wall = performance.now();
        const prevT = _autoPrevT, prevWall = _autoPrevWall;
        _autoPrevT = t; _autoPrevWall = wall;
        if ((!_auto.kick && !_auto.cymbals) || !_audioCtx || !_autoGain || _cfg.autoVolume <= 0) {
            _autoSchedTo = NaN;
            return;
        }
        const dt = t - prevT, dw = (wall - prevWall) / 1000;
        if (!Number.isFinite(dt) || dt <= 0 || dt > 0.5 || !(dw > 0)) {
            // first frame, paused, seek or jump back: start from here
            _autoSchedTo = t;
            return;
        }
        const rate = Math.max(0.25, Math.min(2, dt / dw));
        if (!Number.isFinite(_autoSchedTo) || _autoSchedTo < t - 0.1 || _autoSchedTo > t + 1) _autoSchedTo = t;
        const to = t + AUTO_LOOKAHEAD * rate;
        const due = _autoNotesBetween(notes, chords, _autoSchedTo, to, _auto);
        _autoSchedTo = to;
        if (!due.length) return;
        _synthEnsureCtx();
        const now = _audioCtx.currentTime;
        for (const n of due) _synthPlayNote(n.midi, n.vel, now + Math.max(0, (n.t - t) / rate), _autoGain);
    }

    function _now() { return performance.now(); }

    // Song time for an input arriving now (between frames), minus the
    // user's input offset.
    function _inputTime() {
        const H = _libs && _libs.H;
        const t = H ? H.estimateTime(_clock, _now()) : _clock.time;
        return t - (_cfg.inputOffsetMs || 0) / 1000;
    }

    function _positionHud() {
        if (!_hudCanvas || !_highwayCanvas) return;
        _hudCanvas.style.left = _highwayCanvas.offsetLeft + 'px';
        _hudCanvas.style.top = _highwayCanvas.offsetTop + 'px';
    }

    function _resize3D() {
        if (!_view3d || !_highwayCanvas) return;
        const rect = _highwayCanvas.getBoundingClientRect();
        const w = rect.width || _highwayCanvas.clientWidth;
        const h = rect.height || _highwayCanvas.clientHeight;
        if (!w || !h) return;
        const base = Math.min(window.devicePixelRatio || 1, _ssActive() ? 1.25 : 2);
        _view3d.resize(w, h, base * (_renderScale || 1));
        _positionHud();
        _lastHwW = _highwayCanvas.width;
        _lastHwH = _highwayCanvas.height;
    }

    // 3D init: claim the webgl2 context, mount the HUD overlay, wire
    // visibility + keyboard (synchronously), then load the modules and
    // build the scene. Returns the readyPromise, or null on failure.
    function _begin3D(canvas) {
        let gl = null;
        try { gl = canvas.getContext('webgl2', { antialias: true, alpha: false }); } catch (_) { gl = null; }
        if (!gl) return null;
        _hudCanvas = document.createElement('canvas');
        _hudCanvas.className = 'drums3d-hud';
        _hudCanvas.dataset.drumsInstance = String(_instanceId);
        _hudCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2;';
        if (canvas.parentNode) canvas.parentNode.insertBefore(_hudCanvas, canvas.nextSibling);
        _hwVisible = canvas.offsetParent !== null;
        _hudCanvas.style.display = _hwVisible ? '' : 'none';

        // Keyboard drumming (capture phase, so drum keys don't reach other
        // shortcuts while this view is focused and Keys is on). Space is
        // deliberately not a drum key: it stays play/pause.
        _onKeyDown = (e) => {
            if (_instanceDestroyed || !_isReady || !_isFocused || !_hwVisible || !_cfg.keyboard) return;
            if (!_libs || !_session) return;
            const H = _libs.H;
            if (H.isTypingTarget(e.target) || H.isTypingTarget(document.activeElement)) return;
            const m = H.keyToPad(e);
            if (!m) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            if (m.action === 'activate') { _session.activate(_inputTime()); return; }
            _synthDrumHit(H.synthMidiForPad(m.pad, m.cymbal), 100);
            _session.hit(_inputTime(), m.pad, { cymbal: m.cymbal });
        };
        window.addEventListener('keydown', _onKeyDown, true);

        const token = ++_initToken;
        return _load3DLibs().then((libs) => {
            if (token !== _initToken || _instanceDestroyed) throw new Error('superseded');
            _libs = libs;
            _h = libs.H;
            _view3d = libs.H.createView(libs.THREE, canvas, { hudCanvas: _hudCanvas, context: gl });
            _auto = _autoAt(_diff ? _diff.id : _cfg.difficulty);
            _session = libs.H.createSession(libs.E, { proDrums: _cfg.proCymbals, auto: _auto, params: _timingParams() });
            _chartRefs = null;
            _resetMeta();
            _resize3D();
            if (!_lastHwW) {
                // Panel not laid out yet (splitscreen sizes after init).
                (function retry() {
                    if (token !== _initToken || _instanceDestroyed || !_view3d) return;
                    _resize3D();
                    if (!_lastHwW) requestAnimationFrame(retry);
                })();
            }
        });
    }

    // Shared bus wiring (both views). The HUD canvas and the difficulty
    // badge are sibling DOM, so hide them with the highway canvas
    // (splitscreen display:none's #highway). Filter by canvas: every
    // highway instance emits on the shared bus.
    function _wireBus() {
        const bus = window.slopsmith;
        if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') return;
        _onVisibility = (e) => {
            if (!e || !e.detail || e.detail.canvas !== _highwayCanvas) return;
            _hwVisible = e.detail.visible !== false;
            if (_hudCanvas) _hudCanvas.style.display = _hwVisible ? '' : 'none';
            if (!_hwVisible) { _placeBadge(null); _toggleDiffMenu(false); }
        };
        _onCanvasReplaced = (e) => {
            if (!e || !e.detail || e.detail.oldCanvas !== _highwayCanvas) return;
            _highwayCanvas = e.detail.newCanvas;
        };
        try { bus.on('highway:visibility', _onVisibility); } catch (_) { _onVisibility = null; }
        try { bus.on('highway:canvas-replaced', _onCanvasReplaced); } catch (_) { _onCanvasReplaced = null; }
    }

    function _unwireBus() {
        const bus = window.slopsmith;
        if (bus && typeof bus.off === 'function') {
            if (_onVisibility) { try { bus.off('highway:visibility', _onVisibility); } catch (_) { /* ignore */ } }
            if (_onCanvasReplaced) { try { bus.off('highway:canvas-replaced', _onCanvasReplaced); } catch (_) { /* ignore */ } }
        }
        _onVisibility = null;
        _onCanvasReplaced = null;
    }

    function _resetMeta() {
        _metaUrl = undefined;
        _metaCache = null;
        _metaState = 'none';
        _metaSeq++;
    }

    function _teardown3D() {
        _initToken++;
        if (_onKeyDown) { window.removeEventListener('keydown', _onKeyDown, true); _onKeyDown = null; }
        if (_view3d) { try { _view3d.dispose(); } catch (e) { console.warn('[Drums] 3D dispose failed:', e); } }
        _view3d = null;
        _session = null;
        _libs = null;
        if (_hudCanvas) { _hudCanvas.remove(); _hudCanvas = null; }
        _chartRefs = null;
        _resetMeta();
        _lastHwW = _lastHwH = 0;
        _clock.time = _clock.wall = _clock.prevTime = _clock.prevWall = NaN;
    }

    // Star power / fill phrases and the lower difficulty levels live in
    // the arrangement JSON's `drums` block, not in the wire stream. Fetch
    // arrangements/drums.json from the sloppak (core route) once per song
    // (both views; called on every ready frame, cheap while the URL is
    // unchanged); no file / not a sloppak / not a Drums arrangement -> no
    // star power phrases and Expert only.
    function _syncMeta(bundle) {
        const H = _h;
        if (!H) return;
        const si = bundle.songInfo || {};
        let arrName = si.arrangement || '';
        if (!arrName && Array.isArray(si.arrangements)) {
            const a = si.arrangements.find(x => x && x.index === si.arrangement_index);
            if (a) arrName = a.name || '';
        }
        const url = (DRUMS_PATTERNS.test(arrName) && !_drumTabFor(bundle))
            ? H.drumsMetaUrl(si, window.slopsmith && window.slopsmith.currentSong) : null;
        if (url === _metaUrl) return;
        _metaUrl = url;
        _metaCache = null;
        const seq = ++_metaSeq;
        if (!url || typeof fetch !== 'function') { _metaState = 'none'; return; }
        _metaState = 'pending';
        fetch(url).then(r => (r.ok ? r.json() : null)).then((json) => {
            if (seq !== _metaSeq || _instanceDestroyed) return;
            const meta = H.parseDrumsMeta(json);
            _metaCache = meta;
            _metaState = meta ? 'loaded' : 'none';
            if (meta && _session) _session.setMeta(meta);
        }).catch(() => {
            // no drums.json: play without star power, Expert only
            if (seq === _metaSeq) _metaState = 'none';
        });
    }

    // ── Difficulty ──

    // Chart for the selected difficulty, memoised on the source arrays so
    // identities stay stable across frames (the 3D view reloads its
    // session only when they change). Before the helpers load (2D view,
    // first frames) the arrangement's notes are used as they are.
    function _applyDifficulty(bundle, notes, chords) {
        const H = _h;
        if (!H) return { notes, chords };
        const chordKey = (Array.isArray(chords) && chords.length) ? chords : null;
        if (!_has2xMemo || _has2xMemo.notes !== notes || _has2xMemo.chords !== chordKey) {
            _has2xMemo = { notes, chords: chordKey, val: H.hasKick2x(notes, chordKey) };
        }
        _diffOptions = H.difficultyOptions({
            meta: _metaCache, metaPending: _metaState === 'pending',
            has2x: _has2xMemo.val, drumTab: !!_drumTabFor(bundle),
        });
        _diff = H.resolveDifficulty(_cfg.difficulty, _diffOptions);
        const id = _diff.id;
        const src = _metaCache && _metaCache.levels ? (_metaCache.levels[id] || null) : null;
        const m = _lvlMemo;
        if (!m || m.notes !== notes || m.chords !== chordKey || m.id !== id || m.src !== src) {
            const switched = !!(m && m.notes === notes && m.chords === chordKey && m.id !== id);
            const chart = H.difficultyChart(id, notes, chordKey || chords, _metaCache);
            _lvlMemo = { notes, chords: chordKey, id, src, chart };
            if (switched) {
                // Same song, other difficulty: the 3D view reloads its
                // session (scores from the current time, like a seek); the
                // 2D counter restarts from here.
                _resetScoring();
                _scoreFromT = +bundle.currentTime || 0;
            }
        }
        _refreshDifficultyUI();
        _syncAuto();
        return _lvlMemo.chart;
    }

    // Auto kick / cymbals follow the difficulty being played.
    function _syncAuto() {
        const a = _autoAt(_diff ? _diff.id : _cfg.difficulty);
        if (a.kick !== _auto.kick || a.cymbals !== _auto.cymbals) {
            _auto = a;
            if (_view !== '3d') { _resetScoring(); _scoreFromT = _latestTime || 0; }
        }
        if (_session) _session.setAuto(_auto);
    }

    function _assistsChanged() {
        _syncAuto();
        if (_session) _session.setParams(_timingParams());
    }

    function _proCymbalsChanged() {
        if (_session) _session.setProDrums(_cfg.proCymbals);
    }

    function _difficultyChanged() {
        if (_h && _diffOptions) _diff = _h.resolveDifficulty(_cfg.difficulty, _diffOptions);
        _refreshDifficultyUI(true);
    }

    function _optionsHtml() {
        const H = _h;
        const opts = _diffOptions || (H ? H.difficultyOptions({}) : null);
        const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        return DIFFICULTY_IDS.map((id) => {
            const o = opts ? opts.find(x => x.id === id) : null;
            const off = !!(o && !o.available);
            const text = DIFFICULTY_NAMES[id] + (o && o.generated ? ' (auto)' : '') + (off ? ' – n/a' : '');
            return `<option value="${id}"${id === _cfg.difficulty ? ' selected' : ''}${off ? ' disabled' : ''}`
                + `${off && o.reason ? ` title="${esc(o.reason)}"` : ''}>${esc(text)}</option>`;
        }).join('');
    }

    function _difficultyNote() {
        if (!_diff) return '';
        if (_diff.fallback) {
            return 'Playing Expert: ' + (_diff.reason || (DIFFICULTY_NAMES[_diff.requested] + ' is not available'));
        }
        const o = _diffOptions ? _diffOptions.find(x => x.id === _diff.id) : null;
        return o && o.generated ? DIFFICULTY_NAMES[_diff.id] + ' is auto-generated from Expert' : '';
    }

    // Push the difficulty state into the DOM (badge tooltip, settings
    // panel, open menu) when it changed.
    function _refreshDifficultyUI(force) {
        const H = _h;
        if (!H || !_diff || !_diffOptions) return;
        const key = _cfg.difficulty + '|' + _diff.id + '|' + _diff.fallback + '|'
            + _diffOptions.map(o => (o.available ? 1 : 0) + (o.generated ? 'g' : '') + o.reason).join(',');
        if (!force && key === _diffUiKey) return;
        _diffUiKey = key;
        _badge = H.difficultyBadge(_diff, _diffOptions);
        if (_badgeBtn) {
            _badgeBtn.title = _badge.title + '. Click, or press D / Shift+D, to change.';
            _badgeBtn.setAttribute('aria-label', 'Drum difficulty: ' + _badge.text
                + (_badge.sub ? ' ' + _badge.sub : '') + '. Change difficulty');
            _badgeBtn.dataset.difficulty = _badge.id;
            _badgeBtn.dataset.fallback = _badge.fallback ? '1' : '0';
        }
        if (_settingsPanel) {
            const sel = _settingsPanel.querySelector('.drums-difficulty-select');
            if (sel) { sel.innerHTML = _optionsHtml(); sel.value = _cfg.difficulty; }
            const note = _settingsPanel.querySelector('.drums-difficulty-note');
            if (note) note.textContent = _difficultyNote();
        }
        if (_diffMenu && _diffMenu.style.display !== 'none') _renderDiffMenu();
    }

    // Clickable (transparent) button over the HUD difficulty badge.
    function _ensureBadge() {
        if (_badgeBtn || !_highwayCanvas || !_highwayCanvas.parentNode) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'drums-diff-badge';
        b.dataset.drumsInstance = String(_instanceId);
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-label', 'Change drum difficulty');
        b.style.cssText = 'position:absolute;z-index:3;display:none;margin:0;padding:0;border:0;'
            + 'background:transparent;cursor:pointer;border-radius:999px;';
        b.onclick = (e) => {
            e.stopPropagation();
            b.blur();   // keep Space = play/pause rather than "click the badge again"
            _toggleDiffMenu();
        };
        const after = _hudCanvas || _highwayCanvas;
        after.parentNode.insertBefore(b, after.nextSibling);
        _badgeBtn = b;
        _diffUiKey = '';
        _refreshDifficultyUI();
    }

    // rect: the badge in canvas css px (from the HUD / 2D draw), or null to hide.
    function _placeBadge(rect) {
        if (!_badgeBtn) return;
        if (!rect || !_hwVisible || !_highwayCanvas) {
            if (_badgeRectKey !== '') { _badgeBtn.style.display = 'none'; _badgeRectKey = ''; }
            return;
        }
        const x = Math.round(_highwayCanvas.offsetLeft + rect.x);
        const y = Math.round(_highwayCanvas.offsetTop + rect.y);
        const w = Math.round(rect.w), h = Math.round(rect.h);
        const key = x + '|' + y + '|' + w + '|' + h;
        if (key === _badgeRectKey) return;
        _badgeRectKey = key;
        const st = _badgeBtn.style;
        st.left = x + 'px'; st.top = y + 'px'; st.width = w + 'px'; st.height = h + 'px';
        st.display = '';
    }

    function _renderDiffMenu() {
        const menu = _diffMenu;
        if (!menu) return;
        menu.textContent = '';
        const head = document.createElement('div');
        head.textContent = 'Difficulty';
        head.style.cssText = 'font:700 10px system-ui,sans-serif;color:#7a84a6;padding:2px 8px 4px;'
            + 'letter-spacing:0.08em;text-transform:uppercase;';
        menu.appendChild(head);
        const colors = (_h && _h.DIFFICULTY_COLORS) || {};
        for (const o of (_diffOptions || [])) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'drums-diff-option';
            item.dataset.diff = o.id;
            item.setAttribute('role', 'menuitemradio');
            const current = !!(_diff && _diff.id === o.id);
            item.setAttribute('aria-checked', current ? 'true' : 'false');
            item.disabled = !o.available;
            if (!o.available) item.title = o.reason;
            item.style.cssText = 'display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:4px 8px;'
                + 'font:700 12px system-ui,sans-serif;background:' + (current ? 'rgba(255,255,255,0.09)' : 'transparent') + ';'
                + 'color:' + (o.available ? (colors[o.id] || '#ddd') : '#5a6078') + ';'
                + 'cursor:' + (o.available ? 'pointer' : 'not-allowed') + ';';
            const label = document.createElement('span');
            label.textContent = (current ? '▸ ' : ' ') + o.name;
            item.appendChild(label);
            const tag = (text) => {
                const g = document.createElement('span');
                g.textContent = ' ' + text;
                g.style.cssText = 'font:800 9px system-ui,sans-serif;color:#9aa4c4;';
                item.appendChild(g);
            };
            if (o.generated) tag('AUTO');
            if (_diff && _diff.fallback && _diff.requested === o.id) tag('(saved)');
            if (!o.available && o.reason) {
                const r = document.createElement('div');
                r.textContent = o.reason;
                r.style.cssText = 'font:400 10px system-ui,sans-serif;color:#5a6078;padding-left:1.3em;white-space:normal;';
                item.appendChild(r);
            }
            item.onclick = (e) => {
                e.stopPropagation();
                item.blur();
                _toggleDiffMenu(false);
                _setDifficulty(o.id);
            };
            menu.appendChild(item);
        }
    }

    function _toggleDiffMenu(open) {
        const isOpen = !!(_diffMenu && _diffMenu.style.display !== 'none');
        if (open === undefined) open = !isOpen;
        if (!open) {
            if (_diffMenu) _diffMenu.style.display = 'none';
            if (_onMenuOutside) { document.removeEventListener('pointerdown', _onMenuOutside, true); _onMenuOutside = null; }
            return;
        }
        if (!_badgeBtn || !_badgeBtn.parentNode) return;
        if (!_diffMenu) {
            const m = document.createElement('div');
            m.className = 'drums-diff-menu';
            m.dataset.drumsInstance = String(_instanceId);
            m.setAttribute('role', 'menu');
            m.style.cssText = 'position:absolute;z-index:26;display:none;min-width:150px;max-width:260px;padding:4px;'
                + 'background:rgba(8,10,24,0.96);border:1px solid #2a3150;border-radius:8px;'
                + 'box-shadow:0 6px 20px rgba(0,0,0,0.5);';
            _badgeBtn.parentNode.insertBefore(m, _badgeBtn.nextSibling);
            _diffMenu = m;
        }
        _renderDiffMenu();
        const bx = _badgeBtn.offsetLeft, by = _badgeBtn.offsetTop, bh = _badgeBtn.offsetHeight;
        _diffMenu.style.left = bx + 'px';
        _diffMenu.style.top = (by + bh + 4) + 'px';
        _diffMenu.style.display = '';
        // Open upward when it would run off the bottom of the highway.
        if (_highwayCanvas) {
            const mh = _diffMenu.offsetHeight;
            const bottom = _highwayCanvas.offsetTop + _highwayCanvas.offsetHeight;
            if (by + bh + 4 + mh > bottom && by - mh - 4 >= _highwayCanvas.offsetTop) {
                _diffMenu.style.top = (by - mh - 4) + 'px';
            }
        }
        if (!_onMenuOutside) {
            _onMenuOutside = (e) => {
                if (_diffMenu && _diffMenu.contains(e.target)) return;
                if (_badgeBtn && _badgeBtn.contains(e.target)) return;
                _toggleDiffMenu(false);
            };
            document.addEventListener('pointerdown', _onMenuOutside, true);
        }
    }

    function _removeDifficultyUI() {
        _toggleDiffMenu(false);
        if (_diffMenu) { _diffMenu.remove(); _diffMenu = null; }
        if (_badgeBtn) { _badgeBtn.remove(); _badgeBtn = null; }
        _badgeRectKey = '';
        if (_onDiffKey) { window.removeEventListener('keydown', _onDiffKey, true); _onDiffKey = null; }
    }

    // D = harder, Shift+D = easier (focused, visible panel only; not while typing).
    function _wireDifficultyKey() {
        if (_onDiffKey) return;
        _onDiffKey = (e) => {
            if (_instanceDestroyed || !_isReady || !_isFocused || !_hwVisible || !_h) return;
            const H = _h;
            if (H.isTypingTarget(e.target) || H.isTypingTarget(document.activeElement)) return;
            const k = H.isDifficultyKey(e);
            if (!k) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            _setDifficulty(H.nextDifficulty(_diff ? _diff.id : _cfg.difficulty, _diffOptions, k.dir));
        };
        window.addEventListener('keydown', _onDiffKey, true);
    }

    // 2D view: the badge is drawn on the lane canvas, top-left.
    function _drawDifficulty2D(ctx) {
        const b = _badge;
        if (!b) { _placeBadge(null); return; }
        const x = 10, y = 6, h = 20, padX = 8, gap = 5;
        ctx.save();
        ctx.font = 'italic bold 11px sans-serif';
        const tw = ctx.measureText(b.text).width;
        ctx.font = 'bold 8px sans-serif';
        const sw = b.sub ? ctx.measureText(b.sub).width + gap : 0;
        const w = tw + sw + padX * 2;
        ctx.fillStyle = 'rgba(8,8,20,0.8)';
        _roundRect(ctx, x, y, w, h, h / 2);
        ctx.fill();
        ctx.globalAlpha = b.fallback ? 0.55 : 1;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = 'italic bold 11px sans-serif';
        ctx.fillStyle = b.color;
        ctx.fillText(b.text, x + padX, y + h / 2 + 0.5);
        if (b.sub) {
            ctx.font = 'bold 8px sans-serif';
            ctx.fillStyle = '#9aa4c4';
            ctx.fillText(b.sub, x + padX + tw + gap, y + h / 2 + 0.5);
        }
        ctx.restore();
        _placeBadge({ x, y, w, h });
    }

    function _draw3D(bundle, notes, chords, isReady) {
        if (!_view3d || !_session) return;   // modules still loading
        const nextScale = bundle.renderScale || 1;
        if (nextScale !== _renderScale) { _renderScale = nextScale; _resize3D(); }
        else if (_highwayCanvas && (_highwayCanvas.width !== _lastHwW || _highwayCanvas.height !== _lastHwH)) _resize3D();
        const t = +bundle.currentTime || 0;
        const wall = _now();
        if (!isReady) {
            _view3d.render({ time: t, session: null, wallNow: wall, message: 'Loading drums...' });
            _placeBadge(null);
            return;
        }
        // Reload when the chart arrays change identity (new song /
        // arrangement / difficulty: draw() hands in the selected level's
        // chart). Empty chord lists are compared as "none": the drum_tab
        // path builds a fresh [] every frame. A reload mid-song scores
        // from the current time (session.update), like a seek.
        const chordKey = (Array.isArray(chords) && chords.length) ? chords : null;
        if (!_chartRefs || _chartRefs[0] !== notes || _chartRefs[1] !== chordKey || _chartRefs[2] !== bundle.beats) {
            _chartRefs = [notes, chordKey, bundle.beats];
            _session.load({ notes, chords, beats: bundle.beats });
            _session.setMeta(_metaCache);   // this song's drums block (null until fetched)
            _clock.time = _clock.wall = _clock.prevTime = _clock.prevWall = NaN;
        }
        _clock.prevTime = _clock.time;
        _clock.prevWall = _clock.wall;
        _clock.time = t;
        _clock.wall = wall;
        _session.update(t);
        const meta = _session.meta;
        const hint = meta && meta.activation.length
            ? 'Hit the marked note at the end of the fill to activate'
            : (_cfg.keyboard ? 'Press Enter to activate star power' : null);
        _view3d.render({ time: t, session: _session, wallNow: wall, hint, difficulty: _badge });
        _placeBadge(_view3d.difficultyRect);
        const hctx = _view3d.hudContext;
        if (hctx && window.highway && typeof window.highway.fireDrawHooks === 'function') {
            const sz = _view3d.size;
            try { window.highway.fireDrawHooks(hctx, sz.w, sz.h); } catch (_) { /* hooks are best-effort */ }
        }
    }

    // ── Listener refs (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _applyCanvasDims();
    const _onFocusChange = () => _updateFocusState();

    // ── Focus management ──
    //
    // _instanceDestroyed is a belt-and-suspenders gate: even if the
    // splitscreen helper ever ships without an unsubscribe (or a
    // future version renames offFocusChange), the focus-change
    // handler will no-op against a destroyed instance rather than
    // mutating torn-down state. Defensive because the helper's
    // unsubscribe pathway is the only thing standing between a
    // lingering listener and a stale closure.
    let _instanceDestroyed = false;

    function _updateFocusState() {
        if (_instanceDestroyed) return;
        // _highwayCanvas is nulled by _teardown; a focus-change
        // callback fired between destroy() and the handler
        // detaching would otherwise call isCanvasFocused(null).
        if (!_highwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_highwayCanvas);
        if (shouldFocus && !_isFocused) {
            _isFocused = true;
            _activeInstance = instance;
        } else if (!shouldFocus && _isFocused) {
            _isFocused = false;
            // Outgoing panel: stop showing pressed lanes / flashes
            // that originated from MIDI hits the panel was the
            // recipient of while focused.
            _releaseAllSounding();
            if (_activeInstance === instance) _activeInstance = null;
        }
    }

    // Per-instance cleanup: clear visual hit state. Module-level
    // `_cfg.learnLane` is NOT touched here — it's a shared sentinel,
    // and it gets cleared by _midiConnect on device swap (which
    // already iterates every live instance to call this).
    function _releaseAllSounding() {
        _heldPads.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    // ── MIDI event handler (called by _midiOnMessage via _activeInstance) ──

    function _handleDrumHit(midiNote, velocity) {
        if (midiNote < 0 || midiNote > 127) return;

        // Learn mode: assign this MIDI note to the pending lane.
        if (_learnConsume(midiNote)) return;

        // Clone Hero kit thresholds (only while its map is the one in use).
        if (!_cfg.customMapping && _kitMinVel[midiNote] && velocity < _kitMinVel[midiNote]) return;

        _heldPads.set(midiNote, { velocity, wall: performance.now() });
        _synthDrumHit(midiNote, velocity);
        _synthEnsureCtx();

        const laneIdx = _midiToLaneIdx(midiNote);
        if (laneIdx >= 0) {
            const lane = DRUM_LANES[laneIdx];
            _laneFlashes.push({
                laneIdx,
                wall: performance.now(),
                color: _rgbStr(lane.color[0], lane.color[1], lane.color[2], 0.6),
            });
        }

        if (_view === '3d') {
            // 3D view: the engine scores. Learn/custom mapping wins, else GM.
            if (_session && _libs) {
                const m = _libs.H.midiToPad(midiNote, _baseMapping(), _libs.E.padFromMidi);
                if (m) _session.hit(_inputTime(), m.pad, { cymbal: m.cymbal, velocity });
            }
            return;
        }

        if (_cfg.hitDetection) {
            _checkHit(midiNote);
        }
    }

    // ── Hit detection / accuracy scoring (against cached filter-aware arrays) ──

    function _checkHit(playedMidi) {
        const t = _latestTime;
        const notes = _latestNotes;
        const chords = _latestChords;

        // No chart cached yet (song-change reconnect window, or the
        // very first frame after init before draw has caught up). Skip
        // scoring entirely — counting a hit as a miss here would inflate
        // the miss counter every time the user noodles on the pad during
        // a song switch, with no matching notes to score against.
        const notesEmpty = !notes || notes.length === 0;
        const chordsEmpty = !chords || chords.length === 0;
        if (notesEmpty && chordsEmpty) return;

        const playedLane = _midiToLaneIdx(playedMidi);
        if (playedLane < 0) return;
        if (_laneIsAuto(playedLane, _auto)) return;   // played for you: no hit, no miss

        let foundHit = false;

        if (notes) {
            for (const n of notes) {
                if (n.t > t + HIT_TOLERANCE + 0.5) break;
                if (n.t < t - HIT_TOLERANCE - 0.5) continue;
                // Skip visual-only flam ghost notes — they must not consume the hit
                // window and prevent the main strike from registering.
                if (n._noScore) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const songLane = _songNoteToLaneIdx(songMidi);
                const key = _noteKey(n.t, songMidi);
                if (songLane === playedLane && Math.abs(n.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                    _hitNoteKeys.add(key);
                    foundHit = true;
                    break;
                }
            }
        }

        if (!foundHit && chords) {
            for (const c of chords) {
                if (c.t > t + HIT_TOLERANCE + 0.5) break;
                if (c.t < t - HIT_TOLERANCE - 0.5) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const songLane = _songNoteToLaneIdx(songMidi);
                    const key = _noteKey(c.t, songMidi);
                    if (songLane === playedLane && Math.abs(c.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                        _hitNoteKeys.add(key);
                        foundHit = true;
                        break;
                    }
                }
                if (foundHit) break;
            }
        }

        if (foundHit) {
            _hits++;
            _streak++;
            if (_streak > _bestStreak) _bestStreak = _streak;
        } else {
            _misses++;
            _streak = 0;
            _wrongFlashes.push({ lane: playedLane, wall: performance.now() });
        }
    }

    function _updateMissedNotes(t, notes, chords) {
        if (!_cfg.hitDetection) return;
        const cutoff = t - HIT_TOLERANCE - 0.05;

        if (notes) {
            for (const n of notes) {
                if (n.t > cutoff) break;
                if (n.t < cutoff - 2 || n.t < _scoreFromT) continue;
                // Skip visual-only notes (e.g. flam leading ghost glyph) — the
                // user is expected to hit the main note, not the grace ornament.
                if (n._noScore) continue;
                const songMidi = noteToMidi(n.s, n.f);
                if (_laneIsAuto(_songNoteToLaneIdx(songMidi), _auto)) continue;
                const key = _noteKey(n.t, songMidi);
                if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && n.t < cutoff) {
                    _missedNoteKeys.add(key);
                }
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > cutoff) break;
                if (c.t < cutoff - 2 || c.t < _scoreFromT) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    if (_laneIsAuto(_songNoteToLaneIdx(songMidi), _auto)) continue;
                    const key = _noteKey(c.t, songMidi);
                    if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && c.t < cutoff) {
                        _missedNoteKeys.add(key);
                    }
                }
            }
        }

        const now = performance.now();
        while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
            _wrongFlashes.shift();
        }
        while (_laneFlashes.length && now - _laneFlashes[0].wall > 300) {
            _laneFlashes.shift();
        }
        for (const [midi, info] of _heldPads) {
            if (now - info.wall > 200) _heldPads.delete(midi);
        }
    }

    function _resetScoring() {
        _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
        _hitNoteKeys.clear();
        _missedNoteKeys.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    function _resetForNewChart() {
        _resetScoring();
        _heldPads.clear();
        _scoreFromT = -Infinity;
        // Drop the drum_tab → notes memo so a song-change replay
        // doesn't keep showing the previous chart's drum hits while
        // the new bundle is still loading.
        _drumTabCacheKey = null;
        _drumTabCacheNotes = null;
        // Wave C: no _primeLatestSnapshot — we don't consult the
        // bare `window.highway` global anymore (it's the main-
        // player's highway, not ours under splitscreen). First
        // MIDI hits before the first draw() just don't score.
    }

    // ── Settings panel + gear button (per-instance) ──

    function _injectSettingsGear() {
        if (_settingsGear) return;
        const anchor = _ssSettingsAnchor(_highwayCanvas) ||
                       document.getElementById('player-controls');
        if (!anchor) return;

        const gear = document.createElement('button');
        gear.className = 'btn-drums-settings px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        gear.dataset.drumsInstance = String(_instanceId);
        gear.type = 'button';
        gear.title = 'Drum settings (MIDI, sounds, scoring)';
        // Accessible name for screen readers — title alone is announced
        // inconsistently, and the glyph itself would otherwise surface
        // as "black gear" or similar ambiguous text.
        gear.setAttribute('aria-label', 'Drum settings');
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = '⚙';
        gear.appendChild(glyph);
        gear.onclick = _toggleSettings;

        if (_ssActive()) {
            // Splitscreen: append to the panel bar.
            anchor.appendChild(gear);
        } else {
            // Main-player: insert before the close button. Scope the
            // selector to direct children — `button:last-child` alone
            // matches any descendant button that's its own parent's
            // last child, and #player-controls contains nested wrappers
            // (e.g. #mixer-anchor > #btn-mixer) whose lone button
            // qualifies and appears earlier in document order than the
            // real close button. insertBefore on a node that isn't a
            // direct child of `anchor` throws NotFoundError DOMException.
            const closeBtn = anchor.querySelector(':scope > button:last-of-type');
            if (closeBtn && closeBtn.parentNode === anchor) anchor.insertBefore(gear, closeBtn);
            else anchor.appendChild(gear);
        }
        _settingsGear = gear;
    }

    function _removeSettingsGear() {
        if (_settingsGear) {
            _settingsGear.remove();
            _settingsGear = null;
        }
    }

    function _toggleSettings() {
        _settingsVisible = !_settingsVisible;
        if (!_settingsPanel && _settingsVisible) _createSettingsPanel();
        if (_settingsPanel) _settingsPanel.style.display = _settingsVisible ? '' : 'none';
        if (_settingsVisible) {
            _midiInit();
            _synthInit();
            _midiUpdateAllDeviceLists();
        }
    }

    function _createSettingsPanel() {
        if (_settingsPanel) return;
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return;

        const panel = document.createElement('div');
        panel.className = 'drums-settings-panel';
        panel.dataset.drumsInstance = String(_instanceId);
        panel.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:25;' +
            'background:rgba(8,8,20,0.94);border-bottom:1px solid #222;padding:6px 12px;' +
            'font-family:system-ui,sans-serif;display:none;max-height:50%;overflow-y:auto;';

        const channelOpts = '<option value="-1"' + (_cfg.midiChannel === -1 ? ' selected' : '') + '>All</option>' +
            '<option value="9"' + (_cfg.midiChannel === 9 ? ' selected' : '') + '>10 (Drums)</option>' +
            Array.from({length: 16}, (_, i) =>
                i === 9 ? '' : `<option value="${i}"${_cfg.midiChannel === i ? ' selected' : ''}>${i + 1}</option>`
            ).join('');

        // All form controls use classes (not ids) so N panels don't
        // collide on getElementById lookups. Handlers bind via
        // panel.querySelector scoped to this specific panel.
        panel.innerHTML = `
            <div class="drums-midi-status" style="font-size:10px;color:#8ab;margin-bottom:4px;">${_midiStatusText()}</div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">MIDI</span>
                    <select class="drums-midi-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;max-width:180px;">
                        <option value="">None</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Vol</span>
                    <input type="range" class="drums-vol-slider" min="0" max="100"
                        value="${Math.round(_cfg.synthVolume * 100)}"
                        style="width:70px;accent-color:#ef4444;height:14px;">
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Ch</span>
                    <select class="drums-channel-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:72px;">
                        ${channelOpts}
                    </select>
                </div>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;">
                    Lanes
                    <select class="drums-lane-preset" aria-label="Lane preset"
                        style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:110px;">
                        <option value="phase_shift_8"${_cfg.lanePreset === 'phase_shift_8' ? ' selected' : ''}>Phase Shift 8</option>
                        <option value="rb4"${_cfg.lanePreset === 'rb4' ? ' selected' : ''}>Rock Band</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="drums-chk-labels" ${_cfg.showLaneLabels ? 'checked' : ''}
                        style="accent-color:#ef4444;"> Labels
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="drums-chk-hits" ${_cfg.hitDetection ? 'checked' : ''}
                        style="accent-color:#22cc66;"> Hits
                </label>
                <button class="drums-reset-map" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                    padding:2px 8px;font-size:10px;color:#aaa;cursor:pointer;">Reset Map</button>
            </div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="3D drum track (needs WebGL2) or the 2D lane view. Auto picks 3D when WebGL2 is available.">
                    View
                    <select class="drums-view-select" aria-label="Drum view"
                        style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:82px;">
                        <option value="auto"${_cfg.view === 'auto' ? ' selected' : ''}>Auto</option>
                        <option value="3d"${_cfg.view === '3d' ? ' selected' : ''}>3D</option>
                        <option value="2d"${_cfg.view === '2d' ? ' selected' : ''}>2D</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;"
                    title="3D view: play with the keyboard. B kick, F red, J/K/L yellow/blue/green, Shift or U/I/O for cymbals, Enter = star power.">
                    <input type="checkbox" class="drums-chk-keys" ${_cfg.keyboard ? 'checked' : ''}
                        style="accent-color:#3b82f6;"> Keys
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="3D view: input offset in ms, subtracted from each hit's time (raise it if your hits register late).">
                    Offset
                    <input type="number" class="drums-offset-input" min="-250" max="250" step="5"
                        value="${_cfg.inputOffsetMs}"
                        style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:2px 4px;font-size:11px;color:#ccc;outline:none;width:58px;"> ms
                </label>
                <span class="drums-view-note" style="font-size:10px;color:#666;">${_view === '3d' ? '3D view active' : '2D view active'}</span>
            </div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Drum difficulty, saved in this browser. Expert+ adds the 2x kick notes. Easy/Medium/Hard need a chart that has them; otherwise the song plays Expert. While playing: click the difficulty badge, or press D (harder) / Shift+D (easier).">
                    Difficulty
                    <select class="drums-difficulty-select" aria-label="Drum difficulty"
                        style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:128px;">
                        ${_optionsHtml()}
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;"
                    title="3D view. On: pro drums, cymbals and toms of the same colour are separate (cymbal gems, cymbal pads). Off: no cymbals, every yellow/blue/green note is a plain pad and either the cymbal or the tom of that colour hits it.">
                    <input type="checkbox" class="drums-chk-pro" ${_cfg.proCymbals ? 'checked' : ''}
                        style="accent-color:#eab308;"> Pro cymbals
                </label>
                <span class="drums-difficulty-note" style="font-size:10px;color:#a8946a;">${_difficultyNote()}</span>
            </div>
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Kick notes are played for you (no score, no misses) at the difficulties picked here.">
                    Auto kick
                    <select class="drums-auto-kick" aria-label="Auto kick" style="${_SEL_CSS}width:118px;">${_autoOptions(_cfg.autoKick)}</select>
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Cymbal notes (hi-hat, ride, crash) are played for you at the difficulties picked here.">
                    Auto cymbals
                    <select class="drums-auto-cym" aria-label="Auto cymbals" style="${_SEL_CSS}width:118px;">${_autoOptions(_cfg.autoCymbals)}</select>
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Volume of the kick / cymbal notes the game plays for you (so a muted drum stem has no holes).">
                    Auto vol
                    <input type="range" class="drums-autovol-slider" min="0" max="100"
                        value="${Math.round(_cfg.autoVolume * 100)}" style="width:70px;accent-color:#ef4444;height:14px;">
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="3D view: how early or late a hit can be and still count.">
                    Timing
                    <select class="drums-timing-select" aria-label="Hit timing window" style="${_SEL_CSS}width:150px;">${_timingOptions(_cfg.timing)}</select>
                </label>
                <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#666;"
                    title="Drum sounds played when you hit a pad. More options under Plugins → Drums.">
                    Kit
                    <select class="drums-kit-select" aria-label="Drum kit sound" style="${_SEL_CSS}width:130px;">${_kitOptions(_cfg.kit)}</select>
                </label>
            </div>
            <details style="margin-top:2px;">
                <summary style="font-size:10px;color:#666;cursor:pointer;">MIDI Mapping <span class="drums-map-source" style="color:#888;">— ${_mapSourceText()}</span></summary>
                <table class="drums-map-table" style="font-size:11px;margin-top:4px;">${_buildMappingRows()}</table>
            </details>`;

        if (panelChrome) {
            panelChrome.appendChild(panel);
        } else {
            const controls = document.getElementById('player-controls');
            if (controls && controls.parentNode === mount) mount.insertBefore(panel, controls);
            else mount.appendChild(panel);
        }
        _settingsPanel = panel;

        panel.querySelector('.drums-midi-select').onchange = function () {
            _saveCfg('midiManual', this.value ? '1' : '');
            _midiConnect(this.value);
            _synthInit();
        };
        panel.querySelector('.drums-vol-slider').oninput = function () {
            _synthSetVolume(parseInt(this.value) / 100);
        };
        panel.querySelector('.drums-channel-select').onchange = function () {
            _saveCfg('midiChannel', parseInt(this.value));
        };
        panel.querySelector('.drums-lane-preset').onchange = function () {
            _saveCfg('lanePreset', this.value);
            // Rebuild DRUM_LANES + _midiToLane in place (mutated arrays,
            // not reassigned) so existing geometry closures keep their
            // references. _refreshAllMappingTables() re-renders every open
            // panel's lane rows so Learn-mode data-lane indexes stay correct
            // after the preset change; also sync all preset selectors so a
            // second open panel reflects the new choice.
            _applyLanePreset(_cfg.lanePreset);
            // Clear the Learn-mode lane sentinel: the lane count may have
            // changed, so a stale _cfg.learnLane could index beyond DRUM_LANES
            // bounds in _handleDrumHit() or remap into the wrong lane.
            _cfg.learnLane = null;
            document.querySelectorAll('.drums-lane-preset').forEach(sel => {
                sel.value = _cfg.lanePreset;
            });
            _refreshAllMappingTables();
        };
        panel.querySelector('.drums-chk-labels').onchange = function () {
            _saveCfg('showLaneLabels', this.checked);
        };
        panel.querySelector('.drums-chk-hits').onchange = function () {
            _saveCfg('hitDetection', this.checked);
            if (this.checked) _resetScoring();
        };
        panel.querySelector('.drums-reset-map').onclick = function () {
            _saveCfg('customMapping', null);
            // Rebuild the mapping table inline so the `<details>`
            // open state and panel scroll position survive the
            // reset. customMapping is module-shared, so refresh
            // EVERY open settings panel's table — not just this
            // one — to keep splitscreen UIs consistent.
            _refreshAllMappingTables();
            _midiUpdateAllDeviceLists();
        };
        panel.querySelector('.drums-view-select').onchange = function () {
            _saveCfg('view', this.value);
            document.querySelectorAll('.drums-view-select').forEach(sel => { sel.value = _cfg.view; });
            // Main player: swap in a renderer for the new view right away
            // (contextType is fixed per instance). Splitscreen panels pick
            // it up the next time their renderer is created.
            const want = _resolveView(_cfg.view, _canWebGL2());
            const hw = window.highway;
            if (want !== _view && !_ssActive() && _highwayCanvas && _highwayCanvas.id === 'highway'
                && hw && typeof hw.setRenderer === 'function') {
                setTimeout(() => {
                    if (_instances.has(instance)) hw.setRenderer(createFactory());
                }, 0);
            }
        };
        panel.querySelector('.drums-chk-keys').onchange = function () {
            _saveCfg('keyboard', this.checked);
            document.querySelectorAll('.drums-chk-keys').forEach(el => { el.checked = _cfg.keyboard; });
        };
        panel.querySelector('.drums-chk-pro').onchange = function () {
            _setProCymbals(this.checked);
        };
        panel.querySelector('.drums-difficulty-select').onchange = function () {
            _setDifficulty(this.value);
        };
        panel.querySelector('.drums-offset-input').onchange = function () {
            _saveCfg('inputOffsetMs', this.value);
            this.value = String(_cfg.inputOffsetMs);
        };
        panel.querySelector('.drums-auto-kick').onchange = function () { _setAssist('autoKick', this.value); };
        panel.querySelector('.drums-auto-cym').onchange = function () { _setAssist('autoCymbals', this.value); };
        panel.querySelector('.drums-timing-select').onchange = function () { _setAssist('timing', this.value); };
        panel.querySelector('.drums-kit-select').onchange = function () { _synthSetKit(this.value); };
        panel.querySelector('.drums-autovol-slider').oninput = function () { _setAutoVolume(parseInt(this.value, 10) / 100); };

        _wireLearnButtons(panel);
    }

    function _removeSettingsPanel() {
        if (_settingsPanel) {
            _settingsPanel.remove();
            _settingsPanel = null;
        }
        _settingsVisible = false;
    }

    // ── Canvas sizing ──
    //
    // Highway.js owns the canvas element and its CSS dimensions. It already
    // sizes the canvas to the highway area (viewport minus player-controls
    // height — see static/highway.js `resize()`), so we just need to scale
    // the backing store to DPR so 2D drawing stays crisp at HiDPI. Highway
    // calls our `resize(w, h)` callback after its own resize, which we use
    // to re-apply this — see the renderer contract below.

    function _applyCanvasDims() {
        if (_view === '3d') { _resize3D(); return; }
        if (!_drumCanvas || !_drumCtx) return;
        const rect = _drumCanvas.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        _drumCanvas.width = Math.round(w * dpr);
        _drumCanvas.height = Math.round(h * dpr);
        _drumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Drawing ──

    function _draw(notes, chords, t, beats) {
        if (!_drumCanvas || !_drumCtx) return;

        // Update the MIDI-scoring snapshots FIRST — before the
        // no-chart-yet early return below. During a song change where
        // bundle.currentTime advances but notes/chords are still empty
        // (WS reconnect window), a drum hit between frames would
        // otherwise score against the PREVIOUS song's cached chart and
        // its stale t.
        _latestNotes = notes;
        _latestChords = chords;
        _latestTime = t;

        const W = _drumCanvas.width / (window.devicePixelRatio || 1);
        const H = _drumCanvas.height / (window.devicePixelRatio || 1);
        const ctx = _drumCtx;

        // Empty-but-loaded chart (e.g. arrangement filtered to nothing
        // by the difficulty slider, or a long rest). bundle.isReady is
        // already verified upstream in draw(); blank the overlay so
        // a previous chart's notes don't sit frozen on screen, but
        // the Wave B "treat empty as no chart and bail" early-return
        // is GONE — empty arrays during ready playback are still a
        // valid render path (paint backgrounds + lane labels even
        // without scrolling notes) so the kit lanes stay visible.
        _updateMissedNotes(t, notes, chords);

        const nowLineY = H * NOW_LINE_Y_FRAC;
        const topY = 0;
        const laneLayout = _computeLaneLayout(W, H);
        const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');

        // ── Background ──────────────────────────────────────────────────
        ctx.fillStyle = '#040408';
        ctx.fillRect(0, 0, W, H);

        // ── Lane backgrounds (vertical columns) ─────────────────────────
        for (let i = 0; i < laneLayout.length; i++) {
            const ll = laneLayout[i];
            const [r, g, b] = ll.lane.color;

            ctx.fillStyle = _rgbStr(r * 0.06, g * 0.06, b * 0.06, 0.5);
            ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);

            ctx.strokeStyle = _rgbStr(r * 0.15, g * 0.15, b * 0.15, 0.3);
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(ll.x + ll.w, topY);
            ctx.lineTo(ll.x + ll.w, nowLineY + 20);
            ctx.stroke();

            for (const flash of _laneFlashes) {
                if (flash.laneIdx === i) {
                    const age = (performance.now() - flash.wall) / 300;
                    if (age < 1) {
                        ctx.fillStyle = _rgbStr(r, g, b, 0.25 * (1 - age));
                        ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);
                    }
                }
            }
        }

        // ── Kick lane separator ─────────────────────────────────────────
        if (kickIdx >= 0) {
            const kickLL = laneLayout[kickIdx];
            ctx.strokeStyle = 'rgba(255,80,80,0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(kickLL.x - 2, topY);
            ctx.lineTo(kickLL.x - 2, nowLineY + 20);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // ── Beat / measure lines ────────────────────────────────────────
        if (beats) {
            for (const b of beats) {
                const dt = b.time - t;
                if (dt < -0.1 || dt > VISIBLE_SECONDS) continue;
                const y = _timeToY(dt, nowLineY, topY);
                ctx.strokeStyle = b.measure > 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
                ctx.lineWidth = b.measure > 0 ? 1 : 0.5;
                ctx.beginPath();
                ctx.moveTo(laneLayout[0].x, y);
                ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, y);
                ctx.stroke();
            }
        }

        // ── Now line ────────────────────────────────────────────────────
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(laneLayout[0].x, nowLineY);
        ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, nowLineY);
        ctx.stroke();

        _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY, W, H);

        if (_cfg.showLaneLabels) {
            _drawLaneLabels(ctx, laneLayout, nowLineY, H);
        }

        if (_cfg.hitDetection && (_hits + _misses) > 0) {
            _drawAccuracyHUD(ctx, W, H);
        }

        // MIDI indicator — show on the focused panel only; non-focused
        // panels don't receive input so the dot would be misleading.
        if (_midiInput && _isFocused) {
            ctx.fillStyle = '#22cc66';
            ctx.beginPath();
            ctx.arc(W - 20, 16, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#22cc6688';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('MIDI', W - 28, 16);
        }

        _drawDifficulty2D(ctx);
    }

    function _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY /* , W, H */) {
        const allNotes = [];

        if (notes) {
            for (const n of notes) {
                const dt = n.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                allNotes.push({ midi: noteToMidi(n.s, n.f), t: n.t, ac: n.ac });
            }
        }
        if (chords) {
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                for (const cn of (c.notes || [])) {
                    allNotes.push({ midi: noteToMidi(cn.s, cn.f), t: c.t, ac: cn.ac });
                }
            }
        }

        for (const n of allNotes) {
            const laneIdx = _songNoteToLaneIdx(n.midi);
            if (laneIdx < 0 || laneIdx >= laneLayout.length) continue;

            const ll = laneLayout[laneIdx];
            const lane = ll.lane;
            const dt = n.t - t;
            const y = _timeToY(dt, nowLineY, topY);

            if (y < -20 || y > nowLineY + 30) continue;

            const isActive = Math.abs(dt) < 0.03;

            const nk = _noteKey(n.t, n.midi);
            let useHitColor = false, useMissColor = false;
            if (_cfg.hitDetection) {
                if (_hitNoteKeys.has(nk)) useHitColor = true;
                else if (_missedNoteKeys.has(nk)) useMissColor = true;
            }

            let [cr, cg, cb] = lane.color;
            if (useHitColor) { cr = 0; cg = 1; cb = 0.27; }
            else if (useMissColor) { cr = 0.33; cg = 0.33; cb = 0.4; }

            const velFactor = n.ac ? 1.3 : 1.0;
            const cx = ll.centerX;

            if (lane.id === 'kick') {
                // Thin bar so 16th-note double-bass at 88 ms spacing
                // (≈ 26 px apart at default zoom) renders as distinct
                // bars instead of one merged strip. Previously barH=10
                // plus a 4-6 px glow on each side merged adjacent
                // kicks into a continuous block.
                const barH = Math.max(3, 4 * velFactor);
                const firstLane = laneLayout[0];
                const lastLane = laneLayout[laneLayout.length - 1];
                const fullLeft = firstLane.x;
                const fullRight = lastLane.x + lastLane.w;

                // Dim full-width underbar (replaces old wide glow — avoids
                // visibility clutter at fast rolls), then bright bar at the
                // kick lane only.
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.18 : 0.4);
                ctx.fillRect(fullLeft, y - barH / 2, fullRight - fullLeft, barH);

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.fillRect(ll.x + 2, y - barH / 2, ll.w - 4, barH);

                if (isActive && !useMissColor) {
                    ctx.fillStyle = _rgbStr(cr, cg, cb, 0.12);
                    ctx.fillRect(fullLeft, nowLineY - 5, fullRight - fullLeft, 10);
                }
            } else if (lane.symbol === 'diamond') {
                const size = (ll.w * 0.25) * velFactor;

                if (!useMissColor) {
                    const glowAlpha = isActive ? 0.5 : 0.2;
                    for (let i = 1; i >= 0; i--) {
                        const spread = (i + 1) * 2;
                        const a = glowAlpha * (0.15 + (1 - i) * 0.15);
                        ctx.strokeStyle = _rgbStr(cr, cg, cb, a);
                        ctx.lineWidth = spread;
                        ctx.beginPath();
                        ctx.moveTo(cx, y - size - spread);
                        ctx.lineTo(cx + size + spread, y);
                        ctx.lineTo(cx, y + size + spread);
                        ctx.lineTo(cx - size - spread, y);
                        ctx.closePath();
                        ctx.stroke();
                    }
                }

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.moveTo(cx, y - size);
                ctx.lineTo(cx + size, y);
                ctx.lineTo(cx, y + size);
                ctx.lineTo(cx - size, y);
                ctx.closePath();
                ctx.fill();
            } else if (lane.id === 'hihat') {
                const size = (ll.w * 0.22) * velFactor;
                const isOpen = n.midi === 46;
                const isPedal = n.midi === 44;
                const s = isPedal ? size * 0.6 : size;

                if (!useMissColor) {
                    const glowAlpha = isActive ? 0.5 : 0.2;
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, glowAlpha * 0.3);
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.moveTo(cx - s, y - s);
                    ctx.lineTo(cx + s, y + s);
                    ctx.moveTo(cx + s, y - s);
                    ctx.lineTo(cx - s, y + s);
                    ctx.stroke();
                }

                if (isOpen) {
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    ctx.arc(cx, y, s, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.font = `bold ${Math.max(8, s * 0.7)}px sans-serif`;
                    ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 0.8);
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('o', cx, y);
                } else {
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                    ctx.lineWidth = isPedal ? 1.5 : 2.5;
                    ctx.beginPath();
                    ctx.moveTo(cx - s, y - s);
                    ctx.lineTo(cx + s, y + s);
                    ctx.moveTo(cx + s, y - s);
                    ctx.lineTo(cx - s, y + s);
                    ctx.stroke();
                }
            } else {
                // Smaller radius (0.18 of lane vs 0.25) so 16th-note tom
                // rolls / fast snares render as distinct circles instead
                // of merging into one blob. Drop the wide glow rings for
                // the same reason — they add 4-6 px of visual bleed that
                // erases the gaps between fast hits.
                const radius = (ll.w * 0.18) * velFactor;

                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.beginPath();
                ctx.arc(cx, y, radius, 0, Math.PI * 2);
                ctx.fill();

                // Hard outline so adjacent circles are still individually
                // readable even when they're touching at very dense rolls.
                if (!useMissColor) {
                    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.stroke();
                }

                if (!useMissColor && radius > 4) {
                    const grad = ctx.createRadialGradient(cx - radius * 0.3, y - radius * 0.3, 0, cx, y, radius);
                    grad.addColorStop(0, _rgbStr(Math.min(cr + 0.3, 1), Math.min(cg + 0.3, 1), Math.min(cb + 0.3, 1), 0.4));
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    function _drawLaneLabels(ctx, laneLayout, nowLineY, H) {
        const labelY = nowLineY + 8;
        const labelH = H - labelY;

        ctx.fillStyle = 'rgba(8,8,20,0.85)';
        ctx.fillRect(0, labelY, laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelH);

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, labelY);
        ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelY);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const ll of laneLayout) {
            const [r, g, b] = ll.lane.color;
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = _rgbStr(r, g, b, 0.9);
            ctx.fillText(ll.lane.label, ll.centerX, labelY + labelH / 2);
        }
    }

    function _drawAccuracyHUD(ctx, W /* , H */) {
        const total = _hits + _misses;
        if (total === 0) return;

        const pct = Math.round((_hits / total) * 100);
        const text = `Accuracy: ${pct}%   Streak: ${_streak}   Best: ${_bestStreak}   ${_hits}/${total}`;

        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(text).width;
        const hudW = tw + 24;
        const hudH = 24;
        const hudX = (W - hudW) / 2;
        const hudY = 6;

        ctx.fillStyle = 'rgba(8,8,20,0.75)';
        _roundRect(ctx, hudX, hudY, hudW, hudH, 6);
        ctx.fill();

        ctx.fillStyle = pct >= 80 ? '#22cc66' : pct >= 50 ? '#ffcc33' : '#ff6644';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, hudY + hudH / 2);
    }

    // ── Teardown ──

    function _teardown() {
        // We render directly onto the canvas highway.js gives us — don't
        // remove or hide it (the next renderer needs the same element).
        // Clear our paint so a quick re-init doesn't show stale drums.
        if (_drumCanvas && _drumCtx) {
            try {
                _drumCtx.save();
                _drumCtx.setTransform(1, 0, 0, 1, 0, 0);
                _drumCtx.clearRect(0, 0, _drumCanvas.width, _drumCanvas.height);
                _drumCtx.restore();
            } catch (_) {}
        }
        _drumCanvas = null;
        _drumCtx = null;
        _removeDifficultyUI();
        _unwireBus();
        _teardown3D();
        _highwayCanvas = null;
        _hwVisible = true;
        _diffOptions = null;
        _diff = null;
        _badge = null;
        _diffUiKey = '';
        _lvlMemo = null;
        _has2xMemo = null;

        _removeSettingsPanel();
        _removeSettingsGear();

        _releaseAllSounding();

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }

    // ── Factory return: setRenderer contract ──

    const instance = {
        // highway.js reads this before init() and swaps the <canvas>
        // element when it differs from the current context type.
        contextType: _view === '3d' ? 'webgl2' : '2d',
        view: _view,
        init(canvas /* , bundle */) {
            // Defensive teardown if a prior init wasn't paired with
            // destroy. Remove listeners, restore canvas, release
            // held state — mirrors destroy() exactly, INCLUDING
            // removing from _instances and pausing MIDI if we're
            // the last live instance. Without the _instances
            // cleanup, a re-init that subsequently fails early
            // (no mount / null ctx) would leave the instance
            // orphaned in the set, making _instances.size checks
            // inaccurate and preventing _midiPauseHandler from
            // ever running.
            if (_drumCanvas || _hudCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                if (_focusSubscribed) {
                    const ss = window.slopsmithSplitscreen;
                    if (ss && typeof ss.offFocusChange === 'function') {
                        ss.offFocusChange(_onFocusChange);
                    }
                    _focusSubscribed = false;
                }
                _instances.delete(instance);
                if (_activeInstance === instance) _activeInstance = null;
                _teardown();
                _isReady = false;
                _isFocused = false;
                if (_instances.size === 0) _midiReleaseSession();
            }

            // Clear the destroyed sentinel so an init() following a
            // destroy() on the same factory object (e.g. highway
            // re-using a renderer across songs) re-enables focus
            // updates. Set to true in destroy() above — without this
            // reset, _updateFocusState would permanently no-op.
            _instanceDestroyed = false;

            // Use the canvas highway.js gives us directly — same pattern
            // as the 3D Highway plugin. Highway's CSS sizing already
            // excludes the player-controls strip, so the controls stay
            // visible at the bottom without us touching the layout. No
            // overlay, no display:none on the highway canvas, no
            // visibility-override workaround.
            _highwayCanvas = canvas;
            if (_view === '3d') {
                // Async-ready contract (slopsmith#36 readyPromise): highway.js
                // reverts to its default renderer if this rejects.
                const ready = canvas ? _begin3D(canvas) : null;
                if (!ready) {
                    console.warn('[Drums] init: webgl2 context unavailable on highway canvas; aborting 3D view');
                    _teardown3D();
                    _highwayCanvas = null;
                    this.readyPromise = Promise.reject(new Error('webgl2 unavailable'));
                    this.readyPromise.catch(() => {});
                    return;
                }
                this.readyPromise = ready;
                ready.catch((e) => {
                    if (e && e.message === 'superseded') return;
                    console.error('[Drums] 3D view failed to start:', e);
                });
            } else {
            _drumCanvas = canvas;
            _drumCtx = canvas ? canvas.getContext('2d') : null;
            if (!_drumCanvas || !_drumCtx) {
                console.warn('[Drums] init: 2D context unavailable on highway canvas; aborting');
                _drumCanvas = null;
                _drumCtx = null;
                _highwayCanvas = null;
                return;
            }
            }

            _injectSettingsGear();
            _applyCanvasDims();
            window.addEventListener('resize', _onWinResize);
            _wireBus();
            _ensureBadge();
            _wireDifficultyKey();
            if (_view !== '3d') {
                // 2D view: highway3d.js for the drums.json / difficulty
                // helpers only (no three.js, no engine).
                _loadHelpers().then((H) => { if (!_instanceDestroyed && !_h) _h = H; })
                    .catch((e) => console.warn('[Drums] difficulty helpers unavailable:', e));
            }

            const ss = window.slopsmithSplitscreen;
            // Subscribe only when splitscreen is FULLY supported and
            // active (matches the rest of the plugin's helper gating
            // through _ssActive). A partial helper that exposes
            // on/offFocusChange but lacks isCanvasFocused / panelChrome
            // / settingsAnchor would otherwise let us subscribe while
            // _ssIsCanvasFocused falls back to "always focused"
            // (main-player path), so every instance would race to
            // claim _activeInstance on every focus event and break
            // MIDI routing under the partial helper.
            if (_ssActive()) {
                ss.onFocusChange(_onFocusChange);
                _focusSubscribed = true;
            }

            _resetForNewChart();

            _instances.add(instance);

            // Kick off MIDI + synth. One-time init — subsequent
            // instances no-op out because the module singletons are
            // already populated.
            _midiInit();
            _synthInit();

            _isReady = true;

            // Determine focus BEFORE resuming the MIDI handler so
            // _activeInstance is populated when onmidimessage gets
            // wired. Otherwise a MIDI message arriving in the
            // window between _midiResumeHandler and the first
            // focus-change event would route through _midiOnMessage
            // → null _activeInstance → silently dropped. Main-player
            // fast path takes effect synchronously here too.
            _updateFocusState();
            _midiResumeHandler();
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Wave C: bundle.isReady edge detect in place of the
            // global song:ready subscription. Each panel's highway
            // emits song:ready independently; subscribing at module
            // scope would fire N×. Edge-detecting per-instance
            // correctly scopes the reset.
            const isReady = !!bundle.isReady;
            if (isReady && !_lastBundleIsReady) {
                _resetForNewChart();
            }
            _lastBundleIsReady = isReady;

            // Refresh the MIDI-scoring snapshot from the LATEST bundle
            // even on unready frames. Otherwise a pad hit during the
            // loading / reconnect window scores against the PREVIOUS
            // chart's _latestNotes (which still hold last song's data
            // until _draw refreshes them). After bundle.isReady falls
            // false the new song's notes/chords typically arrive as
            // [] until the chart loads — that's exactly what we want
            // here: _checkHit's `notesEmpty && chordsEmpty` guard
            // bails so unready hits neither score nor mis-score, and
            // the scoring resumes naturally on the first ready frame.
            //
            // drum_tab takes precedence over the standard notes stream.
            // When the active sloppak ships a `drum_tab:` manifest key,
            // the server suppresses irrelevant chord/handshape streams
            // for the drum view and the plugin renders + scores against
            // the canonical drum_tab hits via _drumTabHitsToNotes.
            let drumNotes = null;
            let drumChords = null;
            const dt = _drumTabFor(bundle);
            if (dt) {
                if (_drumTabCacheKey !== dt) {
                    _drumTabCacheKey = dt;
                    _drumTabCacheNotes = _drumTabHitsToNotes(dt.hits);
                }
                drumNotes = _drumTabCacheNotes;
                drumChords = [];  // drum_tab carries no chord templates
            } else {
                // Legacy path: drums encoded as guitar notes
                // (`midi = string * 24 + fret`). The renderer's existing
                // _songNoteToLaneIdx already decodes them.
                drumNotes = bundle.notes;
                drumChords = bundle.chords;
            }
            if (isReady) {
                // Difficulty: Expert+ = the wire notes as they are, Expert
                // drops the 2x kick notes, Easy/Medium/Hard come from the
                // drums.json levels (both views render + score this chart).
                _syncMeta(bundle);
                const lv = _applyDifficulty(bundle, drumNotes, drumChords);
                drumNotes = lv.notes;
                drumChords = lv.chords;
            }
            _latestNotes = drumNotes;
            _latestChords = drumChords;
            _latestTime = bundle.currentTime;
            if (isReady) _scheduleAutoSounds(drumNotes, drumChords, +bundle.currentTime || 0);
            else _autoSchedTo = NaN;

            if (_view === '3d') {
                _draw3D(bundle, drumNotes, drumChords, isReady);
                return;
            }

            // Loading / reconnect window — chart isn't confirmed
            // yet. Paint the plugin's base background so the
            // previous chart's notes + HUD don't sit frozen on
            // screen. Once bundle.isReady flips true we hand off to
            // _draw which paints lanes + scrolling notes.
            if (!isReady) {
                if (_drumCanvas && _drumCtx) {
                    const W = _drumCanvas.width / (window.devicePixelRatio || 1);
                    const H = _drumCanvas.height / (window.devicePixelRatio || 1);
                    _drumCtx.fillStyle = '#040408';
                    _drumCtx.fillRect(0, 0, W, H);
                }
                return;
            }

            _draw(drumNotes, drumChords, bundle.currentTime, bundle.beats);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _applyCanvasDims();
        },
        destroy() {
            _isReady = false;
            // Set BEFORE attempting the (best-effort) unsubscribe so
            // the focus-change handler's _instanceDestroyed guard
            // catches any event that sneaks through a failed /
            // missing offFocusChange call.
            _instanceDestroyed = true;
            window.removeEventListener('resize', _onWinResize);
            if (_focusSubscribed) {
                const ss = window.slopsmithSplitscreen;
                if (ss && typeof ss.offFocusChange === 'function') {
                    ss.offFocusChange(_onFocusChange);
                }
                _focusSubscribed = false;
            }
            _instances.delete(instance);
            if (_activeInstance === instance) _activeInstance = null;
            _isFocused = false;
            // Pause the MIDI handler only if we're the last instance
            // standing. Otherwise other instances still need MIDI
            // events flowing into _midiOnMessage (which routes to the
            // currently-focused instance).
            if (_instances.size === 0) {
                _midiReleaseSession();
            }
            _teardown();
        },
        // Internal hooks used by module-level MIDI router + device-swap.
        _handleDrumHit,
        _releaseAllSounding,
        // 3D view: engine state snapshot (DrumsEngine.getState()) or null.
        // Read-only; used by the harness in tools/ and for debugging.
        _engineState() { return _session ? _session.getState() : null; },
        // Difficulty in use ({id, requested, fallback, reason, options}) and
        // the size of the chart being drawn/scored. Read-only, for tools/.
        _difficulty() { return _diff ? Object.assign({ options: _diffOptions }, _diff) : null; },
        _chartNoteCount() { return Array.isArray(_latestNotes) ? _latestNotes.length : 0; },
        // Called by the module-level _setDifficulty for every live instance.
        _difficultyChanged,
        _proCymbalsChanged,
        _assistsChanged,
        _autoLanes() { return Object.assign({}, _auto); },
    };

    return instance;
}

createFactory.matchesArrangement = function (songInfo) {
    if (!songInfo) return false;
    // First-class signal: sloppaks with a top-level `drum_tab:` manifest
    // key ship a `has_drum_tab` flag on song_info regardless of which
    // guitar arrangement the user picked. The drum tab lives off to the
    // side of the arrangements list, so name-pattern matching alone
    // would miss it (a sloppak with a `Lead` arrangement + a drum_tab
    // is still drummable).
    if (songInfo.has_drum_tab) return true;
    if (songInfo.arrangement && DRUMS_PATTERNS.test(songInfo.arrangement)) return true;
    if (Array.isArray(songInfo.arrangements)) {
        const idx = songInfo.arrangement_index;
        const arr = songInfo.arrangements.find(a => a.index === idx);
        if (arr && DRUMS_PATTERNS.test(arr.name)) return true;
    }
    return false;
};

// The picker and Auto mode find one factory per plugin id
// (window.slopsmithViz_<id>), so `drums` is the single entry for both
// views: each call builds a 3D or 2D renderer from the View setting
// (Auto = 3D when WebGL2 is available). No static `contextType` here on
// purpose: Auto skips factories that statically declare 'webgl2' on
// machines without WebGL2, and this one degrades to 2D by itself.
window.slopsmithViz_drums = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_drums = window.slopsmithViz_drums;
// Explicit per-view factories for hosts / tools that want one view
// regardless of the setting (not listed in the picker).
window.slopsmithViz_drums3d = function () { return createFactory('3d'); };
window.slopsmithViz_drums3d.contextType = 'webgl2';
window.slopsmithViz_drums3d.matchesArrangement = createFactory.matchesArrangement;
window.slopsmithViz_drums2d = function () { return createFactory('2d'); };
window.slopsmithViz_drums2d.matchesArrangement = createFactory.matchesArrangement;

// ── Library: filter by Drums ──────────────────────────────────────────
// The library Filters drawer builds its arrangement pills from core's
// _getArrangements() (Lead / Rhythm / Bass [/ Combo]); add Drums so songs
// can be required / excluded by a Drums arrangement. routes.py adds
// "Drums" to the server's filter whitelist. Drum badges on song cards get
// their own colour instead of the grey fallback.
function _addDrumsLibraryFilter() {
    if (typeof window === 'undefined') return;
    const orig = window._getArrangements;
    if (typeof orig === 'function' && !orig.__drums) {
        const wrapped = function () {
            const list = orig.apply(this, arguments);
            return Array.isArray(list) && !list.includes('Drums') ? list.concat('Drums') : list;
        };
        wrapped.__drums = true;
        window._getArrangements = wrapped;
        try { if (typeof window._renderLibFilterDrawer === 'function') window._renderLibFilterDrawer(); } catch (_) { /* drawer not built yet */ }
    }
    const badge = window._arrangementBadgeHtml;
    if (typeof badge === 'function' && !badge.__drums) {
        const wrappedBadge = function (arrangement, nm) {
            const html = badge.apply(this, arguments);
            const label = arrangement && ((nm === 'smart' && arrangement.smart_name) || arrangement.name) || '';
            return DRUMS_PATTERNS.test(label) ? html.replace('bg-dark-600 text-gray-400', 'bg-orange-900/40 text-orange-300') : html;
        };
        wrappedBadge.__drums = true;
        window._arrangementBadgeHtml = wrappedBadge;
    }
}
try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelectorAll) {
        _addDrumsLibraryFilter();
        // app.js may define these after this plugin's script runs.
        let tries = 0;
        const t = setInterval(() => { _addDrumsLibraryFilter(); if (++tries > 30 || (window._getArrangements && window._getArrangements.__drums)) clearInterval(t); }, 500);
    }
} catch (_) { /* non-browser */ }

// ── Retire the stock "3D Drum Highway" (drum_highway_3d) ──────────────
// The desktop app bundles an older drum view that this plugin replaces.
// It's marked bundled, so a user copy can't shadow it server-side, and in
// Auto mode it would claim Drums arrangements before this plugin (picker
// order). Here: its factory is blocked (whether its script loads before or
// after this one), its picker / splitscreen options are removed, and saved
// choices of it move to the Drum Highway.
const _RETIRED_VIZ = 'drum_highway_3d';

function _blockRetiredFactory() {
    for (const k of ['slopsmithViz_' + _RETIRED_VIZ, 'feedBackViz_' + _RETIRED_VIZ]) {
        try {
            const d = Object.getOwnPropertyDescriptor(window, k);
            if (d && d.get && d.get.__drumsRetired) continue;
            if (d && !d.configurable) { window[k] = undefined; continue; }
            const get = () => undefined;
            get.__drumsRetired = true;
            Object.defineProperty(window, k, { configurable: true, get, set() { /* retired */ } });
        } catch (_) { /* non-browser */ }
    }
}

function _migrateRetiredVizPrefs() {
    try {
        if (localStorage.getItem('vizSelection') === _RETIRED_VIZ) localStorage.setItem('vizSelection', 'drums');
        const raw = localStorage.getItem('splitscreenPanelPrefs');
        if (raw && raw.includes('__viz__:' + _RETIRED_VIZ + ':')) {
            localStorage.setItem('splitscreenPanelPrefs',
                raw.split('__viz__:' + _RETIRED_VIZ + ':').join('__viz__:drums:'));
        }
    } catch (_) { /* storage blocked */ }
}

function _removeRetiredVizOptions() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    const main = document.querySelector('#viz-picker option[value="' + _RETIRED_VIZ + '"]');
    if (main) {
        const sel = main.parentNode;
        const was = sel.value === _RETIRED_VIZ;
        main.remove();
        if (was) {
            sel.value = 'drums';
            if (typeof window.setViz === 'function') window.setViz('drums');
        }
    }
    const prefix = '__viz__:' + _RETIRED_VIZ + ':';
    document.querySelectorAll('select option[value^="' + prefix + '"]').forEach((o) => {
        const sel = o.parentNode;
        const was = sel.value === o.value;
        const repl = '__viz__:drums:' + o.value.slice(prefix.length);
        o.remove();
        if (was && Array.from(sel.options).some(x => x.value === repl)) {
            sel.value = repl;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelectorAll) {
        _blockRetiredFactory();
        _migrateRetiredVizPrefs();
        _removeRetiredVizOptions();
        // Pickers are (re)built after plugins load and when splitscreen panels open.
        setInterval(() => { _blockRetiredFactory(); _removeRetiredVizOptions(); }, 1000);
    }
} catch (_) { /* non-browser */ }

// ── Drums never render through a guitar view ─────────────────────────
// When the picker holds a guitar view (3D Highway / Classic 2D, e.g. the
// fresh-install default on a device that just joined a multiplayer room)
// and the loaded arrangement IS Drums, the Drum Highway takes over for
// this song only: the picker and the saved choice stay as they are, and
// the next non-drum song gets the picked view back. Stands down when the
// core already does this (this repo's core: _instrumentVizOverride).
const _GUITAR_VIZ = new Set(['default', 'highway_3d']);
let _drumsOverride = false;

function _isDrumsArrangement(si) {
    if (!si) return false;
    if (si.arrangement && DRUMS_PATTERNS.test(si.arrangement)) return true;
    if (Array.isArray(si.arrangements)) {
        const arr = si.arrangements.find(a => a && a.index === si.arrangement_index);
        if (arr && DRUMS_PATTERNS.test(arr.name || '')) return true;
    }
    return false;
}

function _drumsTakeover() {
    if (typeof window._instrumentVizOverride === 'function') return;   // core handles it
    const sel = document.getElementById('viz-picker');
    const hw = window.highway;
    if (!sel || !hw || typeof hw.setRenderer !== 'function') return;
    const picked = sel.value;
    if (!_GUITAR_VIZ.has(picked)) { _drumsOverride = false; return; }
    const si = typeof hw.getSongInfo === 'function' ? (hw.getSongInfo() || {}) : {};
    if (_isDrumsArrangement(si)) {
        if (_drumsOverride) return;
        let r = null;
        try { r = createFactory(); } catch (e) { console.error('[Drums] takeover failed', e); }
        if (!r || typeof r.draw !== 'function') return;
        _drumsOverride = true;
        hw.setRenderer(r);
    } else if (_drumsOverride) {
        _drumsOverride = false;
        if (typeof window.setViz === 'function') window.setViz(picked);   // the user's own view, unchanged
        else hw.setRenderer(null);
    }
}

try {
    if (window.slopsmith && typeof window.slopsmith.on === 'function') {
        window.slopsmith.on('song:ready', _drumsTakeover);
        // An explicit pick mid-song is the user's call: stop overriding.
        document.addEventListener('change', (e) => {
            if (e.target && e.target.id === 'viz-picker') _drumsOverride = false;
        }, true);
    }
} catch (e) { /* no host */ }

// ── Drums settings screen (Plugins → Drums) ──────────────────────────
// plugin.json's nav entry puts "Drums" in the core Plugins menu; core
// injects screen.html into #plugin-drums before this script runs. The
// controls share their classes with the in-player ⚙ panel, so the
// module-level setters keep both in sync. While the screen is showing it
// registers a pseudo-instance so the kit connects and the pad tester
// receives hits (MIDI only routes to live instances).

const _LANE_NAMES = { hihat: 'Hi-hat', snare: 'Snare', tom1: 'Tom 1', tom2: 'Tom 2', tom3: 'Floor tom',
    crash: 'Crash', ride: 'Ride', kick: 'Kick' };
let _page = null;          // #plugin-drums once wired
let _pageVisible = false;
let _padFlashTimers = {};

const _pageInst = {
    _handleDrumHit(midiNote, velocity) {
        if (midiNote < 0 || midiNote > 127) return;
        if (_learnConsume(midiNote)) { _pageLast('Learned: note ' + midiNote); return; }
        if (!_cfg.customMapping && _kitMinVel[midiNote] && velocity < _kitMinVel[midiNote]) {
            _pageLast('note ' + midiNote + ' vel ' + velocity + ' — below the kit profile\'s threshold (' + _kitMinVel[midiNote] + '), ignored');
            return;
        }
        _synthDrumHit(midiNote, velocity);
        _synthEnsureCtx();
        const idx = _midiToLaneIdx(midiNote);
        const lane = DRUM_LANES[idx];
        _pageLast('note ' + midiNote + ' · velocity ' + velocity + ' → ' + (lane ? (_LANE_NAMES[lane.id] || lane.label) : 'not mapped'));
        if (!lane || !_page) return;
        const chip = _page.querySelector('.dr-pad[data-lane="' + idx + '"]');
        if (!chip) return;
        chip.classList.add('dr-on');
        clearTimeout(_padFlashTimers[idx]);
        _padFlashTimers[idx] = setTimeout(() => chip.classList.remove('dr-on'), 140);
    },
    _releaseAllSounding() {},
    _difficultyChanged() {},
    _proCymbalsChanged() {},
    _assistsChanged() {},
};

function _pageLast(text) {
    const el = _page && _page.querySelector('[data-dr="last"]');
    if (el) el.textContent = text;
}

function _pageRenderPads() {
    const box = _page && _page.querySelector('[data-dr="pads"]');
    if (!box) return;
    box.textContent = '';
    DRUM_LANES.forEach((lane, idx) => {
        const chip = document.createElement('div');
        chip.className = 'dr-pad';
        chip.dataset.lane = String(idx);
        chip.style.setProperty('--c', _rgbStr(lane.color[0], lane.color[1], lane.color[2]));
        chip.textContent = _LANE_NAMES[lane.id] || lane.label;
        box.appendChild(chip);
    });
}

function _pageKitNote() {
    const el = _page && _page.querySelector('[data-dr="kitNote"]');
    const k = DRUM_KITS[_cfg.kit];
    if (el && k) el.textContent = 'Sound played when you hit a pad. ' + k.name + ': ' + k.note + '.';
}

function _pageAutoVolumeText() {
    const el = _page && _page.querySelector('[data-dr="autoVolumeText"]');
    if (el) el.textContent = Math.round(_cfg.autoVolume * 100) + '%';
}

function _pageVolumeText() {
    const el = _page && _page.querySelector('[data-dr="volumeText"]');
    if (el) el.textContent = Math.round(_cfg.synthVolume * 100) + '%';
}

// Put the saved values into every control (first show and after a reset).
function _pageFill() {
    const q = (k) => _page.querySelector('[data-dr="' + k + '"]');
    q('difficulty').innerHTML = _optList(DIFFICULTY_IDS, DIFFICULTY_NAMES, _cfg.difficulty);
    q('autoKick').innerHTML = _autoOptions(_cfg.autoKick);
    q('autoCymbals').innerHTML = _autoOptions(_cfg.autoCymbals);
    q('timing').innerHTML = _timingOptions(_cfg.timing);
    q('kit').innerHTML = _kitOptions(_cfg.kit);
    q('channel').innerHTML = '<option value="-1">All channels</option>'
        + Array.from({ length: 16 }, (_, i) => `<option value="${i}">${i + 1}${i === 9 ? ' (drums)' : ''}</option>`).join('');
    q('channel').value = String(_cfg.midiChannel);
    q('proCymbals').checked = _cfg.proCymbals;
    q('volume').value = String(Math.round(_cfg.synthVolume * 100));
    q('autoVolume').value = String(Math.round(_cfg.autoVolume * 100));
    q('view').value = _cfg.view;
    q('offset').value = String(_cfg.inputOffsetMs);
    q('keyboard').checked = _cfg.keyboard;
    q('lanes').value = _cfg.lanePreset;
    q('labels').checked = _cfg.showLaneLabels;
    q('hits').checked = _cfg.hitDetection;
    const v = q('version');
    if (v) v.textContent = 'Drum Highway ' + ((_page.dataset.pluginVersion) || '');
    _pageKitNote();
    _pageVolumeText();
    _pageAutoVolumeText();
    _pageRenderPads();
    _refreshAllMappingTables();
    _midiUpdateAllDeviceLists();
}

function _pageWire() {
    const q = (k) => _page.querySelector('[data-dr="' + k + '"]');
    q('back').onclick = () => { if (typeof window.showScreen === 'function') window.showScreen('home'); };
    q('difficulty').onchange = function () { _setDifficulty(this.value); };
    q('autoKick').onchange = function () { _setAssist('autoKick', this.value); };
    q('autoCymbals').onchange = function () { _setAssist('autoCymbals', this.value); };
    q('timing').onchange = function () { _setAssist('timing', this.value); };
    q('proCymbals').onchange = function () { _setProCymbals(this.checked); };
    q('kit').onchange = function () {
        const id = this.value;
        _saveCfg('kit', id);
        _pageKitNote();
        _synthInit().then(() => _synthSetKit(id)).then(_synthPlayTest);
    };
    q('test').onclick = () => { _synthPlayTest(); };
    q('volume').oninput = function () { _synthSetVolume(parseInt(this.value, 10) / 100); _pageVolumeText(); };
    q('autoVolume').oninput = function () { _synthInit(); _setAutoVolume(parseInt(this.value, 10) / 100); _pageAutoVolumeText(); };
    q('midi').onchange = function () {
        _saveCfg('midiManual', this.value ? '1' : '');
        _midiConnect(this.value);
        _synthInit();
    };
    q('channel').onchange = function () {
        _saveCfg('midiChannel', parseInt(this.value, 10));
        document.querySelectorAll('.drums-channel-select').forEach((sel) => { sel.value = String(_cfg.midiChannel); });
    };
    q('resetMap').onclick = () => {
        _saveCfg('customMapping', null);
        _cfg.learnLane = null;
        _refreshAllMappingTables();
    };
    q('view').onchange = function () {
        _saveCfg('view', this.value);
        document.querySelectorAll('.drums-view-select').forEach((sel) => { sel.value = _cfg.view; });
    };
    q('offset').onchange = function () {
        _saveCfg('inputOffsetMs', this.value);
        document.querySelectorAll('.drums-offset-input').forEach((el) => { el.value = String(_cfg.inputOffsetMs); });
    };
    q('keyboard').onchange = function () {
        _saveCfg('keyboard', this.checked);
        document.querySelectorAll('.drums-chk-keys').forEach((el) => { el.checked = _cfg.keyboard; });
    };
    q('lanes').onchange = function () {
        _saveCfg('lanePreset', this.value);
        _applyLanePreset(_cfg.lanePreset);
        _cfg.learnLane = null;
        document.querySelectorAll('.drums-lane-preset').forEach((sel) => { sel.value = _cfg.lanePreset; });
        _pageRenderPads();
        _refreshAllMappingTables();
    };
    q('labels').onchange = function () {
        _saveCfg('showLaneLabels', this.checked);
        document.querySelectorAll('.drums-chk-labels').forEach((el) => { el.checked = _cfg.showLaneLabels; });
    };
    q('hits').onchange = function () {
        _saveCfg('hitDetection', this.checked);
        document.querySelectorAll('.drums-chk-hits').forEach((el) => { el.checked = _cfg.hitDetection; });
    };
    q('resetAll').onclick = () => {
        if (!window.confirm('Reset the drum settings to their defaults? Your MIDI input and pad mapping are kept.')) return;
        _resetDrumSettings();
        _pageFill();
    };
}

// Defaults for everything except the MIDI device and the pad mapping.
function _resetDrumSettings() {
    _setDifficulty('expert');
    _setProCymbals(true);
    _setAssist('autoKick', 'off');
    _setAssist('autoCymbals', 'off');
    _setAssist('timing', 'normal');
    _synthSetKit(DEFAULT_KIT);
    _synthSetVolume(0.7);
    _setAutoVolume(0.8);
    _saveCfg('midiChannel', -1);
    _saveCfg('view', 'auto');
    _saveCfg('inputOffsetMs', 0);
    _saveCfg('keyboard', true);
    _saveCfg('lanePreset', 'phase_shift_8');
    _applyLanePreset(_cfg.lanePreset);
    _saveCfg('showLaneLabels', true);
    _saveCfg('hitDetection', false);
}

function _pageSetVisible(on) {
    if (on === _pageVisible) return;
    _pageVisible = on;
    if (on) {
        _pageFill();
        _instances.add(_pageInst);
        if (!_activeInstance) _activeInstance = _pageInst;
        _midiResumeHandler();
        _midiInit();
        _synthInit();
        _midiUpdateAllDeviceLists();
    } else {
        _instances.delete(_pageInst);
        if (_activeInstance === _pageInst) _activeInstance = null;
        _cfg.learnLane = null;
        if (_instances.size === 0) _midiReleaseSession();
    }
}

function _initDrumsScreen() {
    const el = document.getElementById('plugin-drums');
    if (!el || el.dataset.drumsWired === '1') return !!el;
    el.dataset.drumsWired = '1';
    _page = el;
    _pageWire();
    new MutationObserver(() => _pageSetVisible(el.classList.contains('active')))
        .observe(el, { attributes: true, attributeFilter: ['class'] });
    _pageSetVisible(el.classList.contains('active'));
    return true;
}

try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) {
        // The screen div exists before this script runs; retry briefly in case it doesn't.
        if (!_initDrumsScreen()) {
            let tries = 0;
            const t = setInterval(() => { if (_initDrumsScreen() || ++tries > 40) clearInterval(t); }, 250);
        }
    }
} catch (e) { console.warn('[Drums] settings screen failed to start:', e); }

// The drum tab to play, or null. A sloppak's drum_tab is for songs without a
// real drum chart: when the loaded arrangement IS a Drums arrangement with
// notes, that chart (and its Easy/Medium/Hard levels) wins over the tab.
function _drumTabFor(bundle) {
    const dt = bundle && bundle.drumTab;
    if (!dt || !Array.isArray(dt.hits)) return null;
    const hasChart = (Array.isArray(bundle.notes) && bundle.notes.length > 0)
        || (Array.isArray(bundle.chords) && bundle.chords.length > 0);
    if (hasChart && _isDrumsArrangement(bundle.songInfo)) return null;
    return dt;
}

// Node-only export hook for tests; browsers keep the window.*Viz_drums wiring.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        noteToMidi, _rgbStr, _validateCustomMapping, _drumTabHitsToNotes,
        _applyLanePreset, _getActiveDrumMap, _midiToLaneIdx, _songNoteToLaneIdx,
        _midiResolveSaved, DRUM_LANES, PIECE_DEFAULT_MIDI,
        _resolveView, _VALID_VIEWS,
        DIFFICULTY_IDS, STORE_KEYS,
        _difficultyPref: () => _cfg.difficulty,
        _setDifficulty,
        matchesArrangement: createFactory.matchesArrangement,
        _isDrumsArrangement, _preferredKitSource, _kitSource, _midiAutoChoice,
        _webMidiShim: () => _webMidiShim(), _resetWebMidiShim: () => { _shim = null; },
        _midiOnMessage, _midiDiag,
        AUTO_LEVEL_IDS, TIMING_PRESETS, TIMING_IDS, DRUM_KITS, KIT_IDS,
        _autoAt, _laneIsAuto, _timingParams, _autoNotesBetween, _isAutoMidi, _setAssist, _saveCfg, _cfg: () => _cfg,
        _drumWafVar, _drumWafUrl, _kitSf, _drumTabFor, DEFAULT_KIT, _kitIsSampled, _kitBaseUrl,
        _validateKitManifest, _pickKitLayer, _kitHitGain, KIT_FILE_RE, KIT_DIR_RE, DRUM_MIDI_NOTES,
    };
}

})();
