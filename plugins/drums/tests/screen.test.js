'use strict';
// Coverage for pure helpers in screen.js: MIDI mapping, lane presets,
// drum-tab hit conversion, custom-mapping validation, arrangement matching.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = { addEventListener: () => {} };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

test('noteToMidi maps string/fret to a MIDI number (24 semitones per string)', () => {
    const mod = freshPlugin();
    assert.equal(mod.noteToMidi(0, 0), 0);
    assert.equal(mod.noteToMidi(1, 12), 36);
});

test('_rgbStr formats rgb()/rgba() from 0..1 channel floats', () => {
    const mod = freshPlugin();
    assert.equal(mod._rgbStr(1, 0, 0), 'rgb(255,0,0)');
    assert.equal(mod._rgbStr(1, 0, 0, 0.5), 'rgba(255,0,0,0.5)');
});

test('_validateCustomMapping keeps only in-range MIDI keys with known lane ids', () => {
    const mod = freshPlugin();
    const clean = mod._validateCustomMapping({ '38': 'snare', '200': 'kick', '40': 'nope-lane' });
    assert.deepEqual({ ...clean }, { 38: 'snare' }); // clean has a null prototype
});

test('_validateCustomMapping rejects non-objects, arrays, and prototype-poisoning keys', () => {
    const mod = freshPlugin();
    assert.equal(mod._validateCustomMapping(null), null);
    assert.equal(mod._validateCustomMapping('nope'), null);
    assert.equal(mod._validateCustomMapping([1, 2]), null);
    // Empty after filtering -> null, not {}.
    assert.equal(mod._validateCustomMapping({ '__proto__': 'kick' }), null);
    assert.equal(mod._validateCustomMapping({}), null);
});

test('_drumTabHitsToNotes converts known piece-ids to {t,s,f} and sorts by time', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([
        { p: 'snare', t: 1.0, v: 120 },
        { p: 'kick', t: 0.5, v: 80 },
    ]);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].t, 0.5);
    assert.equal(notes[0]._piece, 'kick');
    assert.equal(notes[0].ac, false); // v=80 < 100
    assert.equal(notes[1].ac, true);  // v=120 >= 100
});

test('_drumTabHitsToNotes drops unknown piece-ids and non-finite/negative timestamps', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([
        { p: 'cowbell', t: 1.0 },       // unknown piece
        { p: 'snare', t: -1 },           // negative time
        { p: 'snare', t: NaN },          // non-finite
        { p: 'snare', t: 2.0 },          // kept
    ]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].t, 2.0);
});

test('_drumTabHitsToNotes emits a leading grace note for flams', () => {
    const mod = freshPlugin();
    const notes = mod._drumTabHitsToNotes([{ p: 'snare', t: 1.0, v: 100, f: true }]);
    assert.equal(notes.length, 2);
    const [grace, main] = notes;
    assert.equal(grace._noScore, true);
    assert.ok(grace.t < main.t);
    assert.equal(main.t, 1.0);
});

test('_drumTabHitsToNotes ignores a non-array payload', () => {
    const mod = freshPlugin();
    assert.deepEqual(mod._drumTabHitsToNotes(null), []);
    assert.deepEqual(mod._drumTabHitsToNotes('nope'), []);
});

test('lane preset switch rebuilds DRUM_LANES and the default map', () => {
    const mod = freshPlugin();
    mod._applyLanePreset('rb4');
    assert.deepEqual(mod.DRUM_LANES.map(l => l.id), ['hihat', 'snare', 'tom1', 'tom3', 'crash', 'ride', 'kick']);
    // In rb4, mid-tom notes 45/47 fold into tom1 (no separate tom2 lane).
    assert.equal(mod._midiToLaneIdx(45), mod.DRUM_LANES.findIndex(l => l.id === 'tom1'));

    mod._applyLanePreset('phase_shift_8');
    assert.deepEqual(mod.DRUM_LANES.map(l => l.id),
        ['hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick']);
});

test('_applyLanePreset falls back to phase_shift_8 for an unknown preset name', () => {
    const mod = freshPlugin();
    mod._applyLanePreset('not-a-real-preset');
    assert.deepEqual(mod.DRUM_LANES.map(l => l.id),
        ['hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick']);
});

test('_midiToLaneIdx/_songNoteToLaneIdx resolve unmapped notes to -1', () => {
    const mod = freshPlugin();
    assert.equal(mod._midiToLaneIdx(999), -1);
    assert.equal(mod._songNoteToLaneIdx(999), -1);
});

test('_midiResolveSaved matches by stored key first, falls back to legacy bare id', () => {
    const mod = freshPlugin();
    const sources = [{ id: 'dev1', key: 'webmidi:dev1' }];
    assert.equal(mod._midiResolveSaved('webmidi:dev1', sources), 'webmidi:dev1');
    assert.equal(mod._midiResolveSaved('dev1', sources), 'webmidi:dev1');
    assert.equal(mod._midiResolveSaved('nope', sources), null);
});

test('matchesArrangement trusts has_drum_tab regardless of arrangement name', () => {
    const mod = freshPlugin();
    assert.equal(mod.matchesArrangement({ has_drum_tab: true, arrangement: 'Lead' }), true);
});

test('matchesArrangement matches drum-pattern arrangement names', () => {
    const mod = freshPlugin();
    assert.equal(mod.matchesArrangement({ arrangement: 'Drums' }), true);
    assert.equal(mod.matchesArrangement({ arrangement: 'Lead Guitar' }), false);
});

test('matchesArrangement rejects falsy songInfo', () => {
    const mod = freshPlugin();
    assert.equal(mod.matchesArrangement(null), false);
});

test('PIECE_DEFAULT_MIDI covers the canonical piece set used by _drumTabHitsToNotes', () => {
    const mod = freshPlugin();
    assert.equal(mod.PIECE_DEFAULT_MIDI.kick, 36);
    assert.equal(mod.PIECE_DEFAULT_MIDI.snare, 38);
});

test('difficulty preference: drums_difficulty_v1, default Expert, junk ignored, same ids as highway3d.js', () => {
    const H = require(path.join(__dirname, '..', 'highway3d.js'));
    let mod = freshPlugin();
    assert.deepEqual(mod.DIFFICULTY_IDS, Array.from(H.DIFFICULTIES));
    assert.equal(mod.STORE_KEYS.difficulty, 'drums_difficulty_v1');
    assert.equal(mod._difficultyPref(), 'expert');
    const store = { drums_difficulty_v1: 'hard' };
    const load = () => {
        global.window = {};
        global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
        global.document = { addEventListener: () => {}, querySelectorAll: () => [] };
        const file = path.join(__dirname, '..', 'screen.js');
        delete require.cache[require.resolve(file)];
        return require(file);
    };
    mod = load();
    assert.equal(mod._difficultyPref(), 'hard');
    store.drums_difficulty_v1 = 'insane';
    assert.equal(load()._difficultyPref(), 'expert');
    mod = load();
    mod._setDifficulty('expert_plus');
    assert.equal(store.drums_difficulty_v1, 'expert_plus');
    mod._setDifficulty('<script>');
    assert.equal(store.drums_difficulty_v1, 'expert', 'invalid ids are not persisted');
});

test('_isDrumsArrangement: only when the loaded arrangement itself is drums', () => {
    const m = freshPlugin();
    assert.equal(m._isDrumsArrangement({ arrangement: 'Drums' }), true);
    assert.equal(m._isDrumsArrangement({ arrangement_index: 3, arrangements: [{ index: 3, name: 'Drums' }] }), true);
    // a guitar arrangement on a song that also carries a drum tab is not a takeover case
    assert.equal(m._isDrumsArrangement({ arrangement: 'Lead', has_drum_tab: true }), false);
    assert.equal(m._isDrumsArrangement({}), false);
    assert.equal(m._isDrumsArrangement(null), false);
});

test('_preferredKitSource: Clone Hero device name, then a drum module, then the first input', () => {
    const m = freshPlugin();
    const ins = [{ name: 'Arturia KeyStep', key: 'a' }, { name: 'Alesis Drum Module', key: 'b' }, { name: 'CH 2', key: 'c' }];
    assert.equal(m._preferredKitSource(ins, 'CH 2').key, 'c');
    assert.equal(m._preferredKitSource(ins, 'Alesis Drum Module 0').key, 'b', 'CH appends an index to the device name');
    assert.equal(m._preferredKitSource(ins, '').key, 'b', 'no Clone Hero name: anything drum-like');
    assert.equal(m._preferredKitSource([{ name: 'Keys', key: 'k' }], 'Nope').key, 'k');
});

// Node 24 has a read-only global navigator: swap it via its descriptor.
function fakeNavigator(value) {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
    return () => {
        if (orig) Object.defineProperty(globalThis, 'navigator', orig);
        else delete globalThis.navigator;
    };
}

test('Web MIDI fallback: used when the core has no midi-input domain; delivers raw bytes', async () => {
    const m = freshPlugin();
    m._resetWebMidiShim();
    let opened = 0;
    const kit = { id: 'k1', name: 'Alesis Drum Module', type: 'input', state: 'connected',
        open: async () => { opened++; }, close: () => {}, onmidimessage: null };
    const restore = fakeNavigator({ requestMIDIAccess: async () => ({ inputs: new Map([['k1', kit]]), onstatechange: null }) });
    try {
        const mi = m._webMidiShim();
        assert.ok(mi && mi.version === 1 && mi.shim);
        assert.deepEqual(mi.listSources(), [], 'nothing before discover');
        assert.equal((await mi.discover()).outcome, 'handled');
        const src = mi.listSources();
        assert.deepEqual(src, [{ sourceId: 'k1', label: 'Alesis Drum Module', logicalSourceKey: 'web-midi::k1' }]);
        const res = await mi.open({ requester: 'drums', logicalSourceKey: 'web-midi::k1' });
        const got = [];
        res.handle.addListener((d) => got.push(Array.from(d)));
        kit.onmidimessage({ data: new Uint8Array([0x99, 38, 100]) });   // snare, ch 10
        assert.deepEqual(got, [[0x99, 38, 100]]);
        assert.equal(opened, 1);
        assert.equal((await mi.open({ logicalSourceKey: 'web-midi::nope' })).handle, null);
    } finally {
        restore();
        m._resetWebMidiShim();
    }
});

test('Web MIDI fallback: a busy device (Windows MIDI is exclusive) rejects open', async () => {
    const m = freshPlugin();
    m._resetWebMidiShim();
    const busy = Object.assign(new Error('Port in use'), { name: 'InvalidAccessError' });
    const kit = { id: 'k1', name: 'Kit', type: 'input', state: 'connected', open: async () => { throw busy; }, close: () => {} };
    const restore = fakeNavigator({ requestMIDIAccess: async () => ({ inputs: new Map([['k1', kit]]) }) });
    try {
        const mi = m._webMidiShim();
        await mi.discover();
        await assert.rejects(mi.open({ logicalSourceKey: 'web-midi::k1' }), { name: 'InvalidAccessError' });
    } finally {
        restore();
        m._resetWebMidiShim();
    }
});

test('_midiAutoChoice: the drum kit beats an auto-picked device; a hand pick or explicit None is kept', () => {
    const m = freshPlugin();
    const store = {};
    global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    const ins = [{ name: 'Loupedeck Live', key: 'web-midi::loupe' }, { name: 'Alesis Drum Module', key: 'web-midi::kit' }];
    // auto-picked Loupedeck saved earlier -> the kit
    assert.equal(m._midiAutoChoice('web-midi::loupe', ins), 'web-midi::kit');
    // never picked -> the kit
    assert.equal(m._midiAutoChoice(null, ins), 'web-midi::kit');
    // explicit None stays off
    assert.equal(m._midiAutoChoice('', ins), null);
    // picked by hand in the dropdown -> kept
    store.drums_midi_manual = '1';
    assert.equal(m._midiAutoChoice('web-midi::loupe', ins), 'web-midi::loupe');
    delete store.drums_midi_manual;
    // no kit connected: keep the saved device; never picked -> first input
    const noKit = [{ name: 'Loupedeck Live', key: 'web-midi::loupe' }, { name: 'Arturia KeyStep', key: 'web-midi::keys' }];
    assert.equal(m._midiAutoChoice('web-midi::keys', noKit), 'web-midi::keys');
    assert.equal(m._midiAutoChoice(null, noKit), 'web-midi::loupe');
    // saved device unplugged and no kit -> wait for it (null)
    assert.equal(m._midiAutoChoice('web-midi::gone', noKit), null);
});

test('_kitSource: exact Clone Hero name, drum-looking names, no loose substring matches', () => {
    const m = freshPlugin();
    // "CH 2" must not loosely match unrelated names containing "ch"
    const ins = [{ name: 'Launch Control XL', key: 'a' }, { name: 'Loupedeck Live', key: 'b' }];
    assert.equal(m._kitSource(ins, 'CH 2'), null);
    assert.equal(m._kitSource([...ins, { name: 'CH 2', key: 'c' }], 'CH 2').key, 'c');
    assert.equal(m._kitSource([...ins, { name: 'Roland TD-17', key: 'd' }], '').key, 'd');
    assert.equal(m._kitSource([...ins, { name: 'Yamaha DTX-PRO', key: 'e' }], '').key, 'e');
});

test('assists: _autoAt follows the difficulty ceiling; _saveCfg validates the new settings', () => {
    const mod = freshPlugin();
    const cfg = mod._cfg();
    assert.equal(cfg.autoKick, 'off');
    assert.equal(cfg.timing, 'normal');
    assert.equal(cfg.kit, 'crocell');
    mod._saveCfg('autoKick', 'medium');
    mod._saveCfg('autoCymbals', 'all');
    assert.deepEqual(mod._autoAt('easy'), { kick: true, cymbals: true });
    assert.deepEqual(mod._autoAt('hard'), { kick: false, cymbals: true });
    mod._saveCfg('autoKick', 'nonsense');
    mod._saveCfg('timing', 'turbo');
    mod._saveCfg('kit', '../etc');
    mod._saveCfg('synthVolume', 7);
    assert.equal(cfg.autoKick, 'off');
    assert.equal(cfg.timing, 'normal');
    assert.equal(cfg.kit, 'crocell');
    assert.equal(cfg.synthVolume, 1);
    assert.equal(mod._timingParams(), null);
    mod._saveCfg('timing', 'relaxed');
    assert.equal(mod._timingParams().hitWindow.maxWindow, 0.26);
});

test('assists: _laneIsAuto maps 2D lanes (kick; hi-hat/crash/ride)', () => {
    const mod = freshPlugin();
    const idx = (id) => mod.DRUM_LANES.findIndex(l => l.id === id);
    const a = { kick: true, cymbals: false };
    assert.equal(mod._laneIsAuto(idx('kick'), a), true);
    assert.equal(mod._laneIsAuto(idx('hihat'), a), false);
    assert.equal(mod._laneIsAuto(idx('ride'), { cymbals: true }), true);
    assert.equal(mod._laneIsAuto(idx('snare'), { kick: true, cymbals: true }), false);
});

test('kits: every kit resolves to bundled sound files', () => {
    const mod = freshPlugin();
    const fs = require('node:fs');
    assert.equal(mod.DEFAULT_KIT, 'crocell');
    assert.ok(mod.KIT_IDS.includes(mod.DEFAULT_KIT));
    assert.deepEqual([...mod.KIT_IDS].sort(), Object.keys(mod.DRUM_KITS).sort());
    for (const id of mod.KIT_IDS) {
        if (mod._kitIsSampled(id)) {
            const dir = mod.DRUM_KITS[id].dir;
            assert.ok(mod.KIT_DIR_RE.test(dir), dir);
            assert.equal(mod._kitBaseUrl(dir), '/api/plugins/drums/sounds/kits/' + dir + '/');
            const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sounds', 'kits', dir, 'kit.json'), 'utf8'));
            const m = mod._validateKitManifest(raw);
            assert.ok(m, id);
            for (const n of mod.DRUM_MIDI_NOTES) assert.ok(m.notes[n], id + ' note ' + n);
            for (const f of m.files) assert.ok(fs.existsSync(path.join(__dirname, '..', 'sounds', 'kits', dir, f)), f);
            assert.deepEqual(m.chokes[42], [46]);
            continue;
        }
        const sf = mod._kitSf(id);
        assert.equal(mod._drumWafVar(38, sf), '_drum_38_0_' + sf);
        const file = mod._drumWafUrl(38, sf).replace('/api/plugins/drums/sounds/', '');
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'sounds', file)), file);
    }
    assert.equal(mod._kitSf('nope'), mod._kitSf('jclive'));
    assert.equal(mod._kitSf('crocell'), mod._kitSf('jclive'), 'sampled kits fall back to the JCLive GM set');
});

test('kits: a saved WebAudioFont kit choice stays valid', () => {
    global.window = {};
    global.localStorage = { getItem: (k) => (k === 'drums_kit_v1' ? 'fluid' : null), setItem: () => {} };
    global.document = { addEventListener: () => {} };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    assert.equal(mod._cfg().kit, 'fluid');
    mod._saveCfg('kit', 'virtuosity');
    assert.equal(mod._cfg().kit, 'virtuosity');
});

test('sample kits: _validateKitManifest normalises and rejects bad input', () => {
    const mod = freshPlugin();
    const v = mod._validateKitManifest;
    assert.equal(v(null), null);
    assert.equal(v({}), null);
    assert.equal(v({ notes: [] }), null);
    assert.equal(v({ notes: { 38: { layers: [] } } }), null);
    assert.equal(v({ notes: { 38: { layers: [{ lo: 1, hi: 127, files: ['../routes.py'] }] } } }), null);
    const m = v({
        gain: 9,
        notes: {
            38: { layers: [
                { lo: 80, hi: 127, files: ['snare_v2_a.ogg', 'snare_v2_b.ogg'] },
                { lo: 60, hi: 1, files: ['snare_v1_a.ogg', 'Bad Name.ogg', '/abs.ogg', 'x.wav', 7] },
                { lo: 1, hi: 127, files: [] },
            ] },
            200: { layers: [{ files: ['a.ogg'] }] },
            abc: { layers: [{ files: ['a.ogg'] }] },
            42: { layers: [{ files: ['hh.ogg'] }], gain: -2 },
        },
        chokes: { 42: [46, 'x', 300], 44: 'nope', 1000: [46] },
    });
    assert.deepEqual(Object.keys(m.notes).sort(), ['38', '42']);
    assert.deepEqual(m.notes[38].layers.map((l) => [l.lo, l.hi, l.files]), [
        [1, 60, ['snare_v1_a.ogg']],
        [80, 127, ['snare_v2_a.ogg', 'snare_v2_b.ogg']],
    ]);
    assert.deepEqual(m.notes[42].layers[0], { lo: 1, hi: 127, files: ['hh.ogg'], gain: 1 });
    assert.equal(m.notes[42].gain, 0);
    assert.equal(m.gain, 4);
    assert.deepEqual(m.chokes, { 42: [46] });
    assert.deepEqual(m.files.sort(), ['hh.ogg', 'snare_v1_a.ogg', 'snare_v2_a.ogg', 'snare_v2_b.ogg']);
});

test('sample kits: _pickKitLayer picks the layer by velocity, nearest when in a gap', () => {
    const mod = freshPlugin();
    const L = [{ lo: 1, hi: 40, id: 'pp' }, { lo: 41, hi: 90, id: 'mf' }, { lo: 100, hi: 127, id: 'ff' }];
    const pick = (vel) => mod._pickKitLayer(L, vel).id;
    assert.equal(pick(1), 'pp');
    assert.equal(pick(40), 'pp');
    assert.equal(pick(41), 'mf');
    assert.equal(pick(90), 'mf');
    assert.equal(pick(93), 'mf');
    assert.equal(pick(98), 'ff');
    assert.equal(pick(127), 'ff');
    assert.equal(pick(500), 'ff');
    assert.equal(pick(0), 'pp');
    assert.equal(pick('x'), 'pp');
    assert.equal(mod._pickKitLayer([], 100), null);
    assert.equal(mod._pickKitLayer(null, 100), null);
});

test('sample kits: _kitHitGain rises gently across a layer', () => {
    const mod = freshPlugin();
    const l = { lo: 41, hi: 81, gain: 1 };
    assert.equal(mod._kitHitGain(l, 41), 0.6);
    assert.equal(mod._kitHitGain(l, 81), 1);
    assert.ok(Math.abs(mod._kitHitGain(l, 61) - 0.8) < 1e-9);
    assert.equal(mod._kitHitGain({ lo: 5, hi: 5 }, 5), 1);
    assert.equal(mod._kitHitGain({ lo: 1, hi: 127, gain: 0.5 }, 127), 0.5);
    assert.equal(mod._kitHitGain(null, 100), 0);
});

test('_drumTabFor: a Drums arrangement with notes wins over the sloppak drum tab', () => {
    const mod = freshPlugin();
    const dt = { hits: [{ t: 1, p: 'kick' }] };
    const drums = { arrangement: 'Drums' };
    assert.equal(mod._drumTabFor({ drumTab: dt, songInfo: drums, notes: [{ t: 1, s: 1, f: 12 }] }), null);
    assert.equal(mod._drumTabFor({ drumTab: dt, songInfo: drums, notes: [] }), dt, 'empty chart: fall back to the tab');
    assert.equal(mod._drumTabFor({ drumTab: dt, songInfo: { arrangement: 'Lead' }, notes: [{ t: 1, s: 0, f: 3 }] }), dt);
    assert.equal(mod._drumTabFor({ songInfo: drums, notes: [] }), null);
    assert.equal(mod._drumTabFor({ drumTab: { hits: 'x' } }), null);
});
