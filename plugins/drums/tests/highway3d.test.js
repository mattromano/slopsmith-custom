'use strict';
// Unit tests for the pure parts of highway3d.js (chart -> render model, gem classification, drums-meta
// parsing, input mapping, timing and HUD helpers) and the engine session. No DOM / WebGL needed.
// Run: node --test plugins/drums/tests/highway3d.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const H = require(path.join(__dirname, '..', 'highway3d.js'));
const E = require(path.join(__dirname, '..', 'engine.js'));

const w = (t, midi, extra) => Object.assign({ t, s: Math.floor(midi / 24), f: midi % 24 }, extra || {});

// ── chart -> render model ──────────────────────────────────────────────────

test('collectWireNotes flattens chords with the chord time and drops visual-only notes', () => {
    const notes = [w(1, 38), w(0.5, 36), Object.assign(w(0.97, 38), { _noScore: true }), null];
    const chords = [{ t: 2, notes: [{ s: 1, f: 12 }, { s: 1, f: 18 }] }, { t: 3 }, null];
    const out = H.collectWireNotes(notes, chords);
    assert.equal(out.length, 4);
    assert.deepEqual(out.slice(2).map(n => [n.t, n.s * 24 + n.f]), [[2, 36], [2, 42]]);
    assert.deepEqual(H.collectWireNotes(null, undefined), []);
    // the chord's own note objects are not mutated
    assert.equal(chords[0].notes[0].t, undefined);
});

test('classifyNote: pads, cymbals, kick and 2x kick, with dynamics and lane colours', () => {
    assert.deepEqual(H.classifyNote({ pad: 0 }), { kind: 'kick', lane: -1, cymbal: false, kick2x: false, accent: false, ghost: false, color: H.COLORS.kick });
    assert.equal(H.classifyNote({ pad: 0, kick2x: true }).kind, 'kick2x');
    assert.equal(H.classifyNote({ pad: 0, kick2x: true }).color, H.COLORS.kick2x);
    const red = H.classifyNote({ pad: 1, dyn: 'accent' });
    assert.deepEqual([red.kind, red.lane, red.accent, red.color], ['pad', 0, true, H.LANE_COLORS.red]);
    assert.equal(H.classifyNote({ pad: 1, cymbal: true }).kind, 'pad', 'there is no red cymbal');
    const hat = H.classifyNote({ pad: 2, cymbal: true, dyn: 'ghost' });
    assert.deepEqual([hat.kind, hat.lane, hat.ghost, hat.color], ['cymbal', 1, true, H.LANE_COLORS.yellow]);
    assert.equal(H.classifyNote({ pad: 3 }).color, H.LANE_COLORS.blue);
    assert.equal(H.classifyNote({ pad: 4, cymbal: true }).lane, 3);
    assert.equal(H.classifyNote({ pad: 7 }), null);
    assert.equal(H.classifyNote(null), null);
});

test('buildGems maps General MIDI wire notes to gems keyed by engine note id', () => {
    const wire = [w(1, 42), w(1, 36), w(1.5, 48), w(2, 51), w(2, 45), w(2.5, 49, { ac: true }), w(2.5, 41),
        w(3, 35), w(3.25, 38, { mt: true })];
    const decoded = E.decodeNotes(wire);
    const gems = H.buildGems(decoded);
    const desc = gems.map(g => `${g.t}:${g.kind}:${g.lane}`);
    assert.deepEqual(desc, ['1:cymbal:1', '1:kick:-1', '1.5:pad:1', '2:cymbal:2', '2:pad:2', '2.5:cymbal:3', '2.5:pad:3',
        '3:kick2x:-1', '3.25:pad:0']);
    assert.ok(gems.find(g => g.t === 2.5 && g.cymbal).accent);
    assert.ok(gems[gems.length - 1].ghost);
    for (const g of gems) assert.equal(decoded.notes[g.id].t, g.t, 'gem id is the decoded/engine note id');
    // the engine knows every gem id
    const eng = E.create(decoded);
    for (const g of gems) assert.equal(eng.noteState(g.id), null);
});

test('visibleRange returns the half-open index range of gems in [t0, t1)', () => {
    const gems = [0, 1, 1, 2, 3, 5].map(t => ({ t }));
    assert.deepEqual(H.visibleRange(gems, 1, 3), [1, 4]);
    assert.deepEqual(H.visibleRange(gems, -5, 0), [0, 0]);
    assert.deepEqual(H.visibleRange(gems, 4, 10), [5, 6]);
    assert.deepEqual(H.visibleRange([], 0, 1), [0, 0]);
});

test('normalizeBeats keeps finite times, marks downbeats (measure >= 0) and sorts', () => {
    const out = H.normalizeBeats([{ time: 1, measure: -1 }, { time: 0.5, measure: 1 }, { t: 1.5 }, 2, { time: 'x' }, null]);
    assert.deepEqual(out, [{ t: 0.5, measure: true }, { t: 1, measure: false }, { t: 1.5, measure: false }, { t: 2, measure: false }]);
    assert.deepEqual(H.normalizeBeats(undefined), []);
});

// ── drums metadata (star power / fills) ───────────────────────────────────

test('parseDrumsMeta reads the arrangement JSON drums block into engine option shape', () => {
    const arr = { name: 'Drums', notes: [], drums: { version: 1, pro: true, kick2x: true,
        star_power: [[10, 14], [2, 4.5]], fills: [[20, 22]] } };
    const m = H.parseDrumsMeta(arr);
    assert.deepEqual(m, { version: 1, pro: true, kick2x: true,
        starPower: [{ start: 2, end: 4.5 }, { start: 10, end: 14 }], activation: [{ start: 20, end: 22 }],
        levels: null, levelsGenerated: [] });
    // the block itself is accepted too
    assert.deepEqual(H.parseDrumsMeta(arr.drums), m);
});

test('parseDrumsMeta drops malformed ranges and tolerates missing fields', () => {
    const m = H.parseDrumsMeta({ drums: { pro: false, star_power: [[5, 1], ['a', 2], [1], { start: 3, end: 4 }, 7], fills: 'nope' } });
    assert.equal(m.pro, false);
    assert.equal(m.kick2x, false);
    assert.equal(m.version, 1);
    assert.deepEqual(m.starPower, [{ start: 3, end: 4 }]);
    assert.deepEqual(m.activation, []);
    assert.equal(H.parseDrumsMeta({ name: 'Drums', notes: [] }), null);
    assert.equal(H.parseDrumsMeta(null), null);
    assert.equal(H.parseDrumsMeta([1, 2]), null);
    assert.equal(H.parseDrumsMeta({ error: 'not found' }), null);
});

test('drumsMetaUrl builds the sloppak file URL for arrangements/drums.json', () => {
    assert.equal(H.drumsMetaUrl({ format: 'sloppak', filename: 'My Song.sloppak' }),
        '/api/sloppak/My%20Song.sloppak/file/arrangements/drums.json');
    // song_info has no filename today: fall back to window.slopsmith.currentSong
    assert.equal(H.drumsMetaUrl({ format: 'sloppak' }, { filename: 'Band/Song.sloppak' }),
        '/api/sloppak/Band%2FSong.sloppak/file/arrangements/drums.json');
    assert.equal(H.drumsMetaUrl({}, { filename: 'a.sloppak' }), '/api/sloppak/a.sloppak/file/arrangements/drums.json');
    assert.equal(H.drumsMetaUrl({ format: 'psarc', filename: 'x_p.psarc' }), null);
    assert.equal(H.drumsMetaUrl({ format: 'loose' }, { filename: 'dir' }), null);
    assert.equal(H.drumsMetaUrl({}, { filename: 'x_p.psarc' }), null, 'unknown format needs a .sloppak name');
    assert.equal(H.drumsMetaUrl({ format: 'sloppak' }, {}), null);
    assert.equal(H.drumsMetaUrl(null, null), null);
});

// ── difficulty levels ─────────────────────────────────────────────────────

const LEVELS_BLOCK = {
    version: 1, pro: true, kick2x: true, star_power: [[1, 2]], fills: [],
    levels: {
        easy: [[2, 36, 0], [1, 38, 0], [1, 36, 0]],
        medium: [[1, 36, 0], [1, 42, 0], [1.5, 38, 1], [2, 42, 2]],
        hard: [[1, 36], ['x', 38, 0], [1.25, 200, 0], [1.5, -1, 0], 'nope', [1.75, 38.5, 0], [2, 38, 9]],
        expert: [[0, 36, 0]],          // not a lower level: ignored
    },
    levels_generated: ['easy', 'medium', 'expert', 'bogus'],
};

test('parseDrumsMeta reads the levels block: sorted, malformed entries dropped, generated list filtered', () => {
    const m = H.parseDrumsMeta({ drums: LEVELS_BLOCK });
    assert.deepEqual(Object.keys(m.levels).sort(), ['easy', 'hard', 'medium']);
    // stable sort by time keeps chord order
    assert.deepEqual(m.levels.easy, [[1, 38, 0], [1, 36, 0], [2, 36, 0]]);
    assert.deepEqual(m.levels.medium[2], [1.5, 38, 1]);
    // missing flag -> 0, out-of-range / non-integer GM numbers and bad times dropped, unknown flag -> 0
    assert.deepEqual(m.levels.hard, [[1, 36, 0], [2, 38, 0]]);
    assert.deepEqual(m.levelsGenerated, ['easy', 'medium']);
    // a block with only levels is accepted; non-object levels -> null
    assert.ok(H.parseDrumsMeta({ levels: { easy: [[1, 36, 0]] } }).levels.easy);
    assert.equal(H.parseDrumsMeta({ drums: { star_power: [], levels: [1, 2] } }).levels, null);
    assert.equal(H.parseDrumsMeta({ drums: { star_power: [], levels: { easy: 'x' } } }).levels, null);
    assert.equal(H.parseLevels(null), null);
});

test('levelToWireNotes converts [t, gm, flag] into wire notes (midi = s*24 + f) with accent / ghost', () => {
    const out = H.levelToWireNotes([[1, 38, 1], [1, 36, 0], [1.5, 42, 2], [2, 35, 0], 'bad', [NaN, 38, 0]]);
    assert.deepEqual(out, [
        { t: 1, s: 1, f: 14, ac: true },
        { t: 1, s: 1, f: 12 },
        { t: 1.5, s: 1, f: 18, mt: true },
        { t: 2, s: 1, f: 11 },
    ]);
    assert.deepEqual(out.map(n => n.s * 24 + n.f), [38, 36, 42, 35]);
    assert.deepEqual(H.levelToWireNotes(null), []);
    // the engine decodes them like bundle notes: one chord at t=1 (red + kick), accent kept
    const dec = E.decodeNotes(out);
    assert.equal(dec.chords[0].notes.length, 2);
    assert.equal(dec.notes.find(n => n.pad === 1).dyn, 'accent');
});

test('hasKick2x / stripKick2x: 2x kick (GM 35) in notes and chords; same arrays when there is none', () => {
    const notes = [w(1, 36), w(1.5, 35), w(2, 38)];
    const chords = [{ t: 3, notes: [{ s: 1, f: 11 }, { s: 1, f: 14 }] }, { t: 4, notes: [{ s: 1, f: 11 }] }, { t: 5, notes: [{ s: 1, f: 12 }] }];
    assert.equal(H.hasKick2x(notes, null), true);
    assert.equal(H.hasKick2x([w(1, 36)], chords), true);
    assert.equal(H.hasKick2x([{ t: 1, midi: 35 }], null), true);
    assert.equal(H.hasKick2x([w(1, 36)], [chords[2]]), false);
    const s = H.stripKick2x(notes, chords);
    assert.deepEqual(s.notes.map(n => n.s * 24 + n.f), [36, 38]);
    assert.equal(s.chords.length, 2, 'a chord of only 2x kicks disappears');
    assert.deepEqual(s.chords[0].notes.map(n => n.s * 24 + n.f), [38]);
    assert.equal(s.chords[1], chords[2], 'untouched chords are kept as they are');
    assert.equal(chords[0].notes.length, 2, 'input not mutated');
    const plain = [w(1, 36)], plainChords = [chords[2]];
    const same = H.stripKick2x(plain, plainChords);
    assert.ok(same.notes === plain && same.chords === plainChords);
});

test('difficultyOptions: Expert always, Expert+ with 2x kick, lower levels from the drums block', () => {
    const byId = (opts) => Object.fromEntries(opts.map(o => [o.id, o]));
    // old sloppak: no drums block / no levels
    let o = byId(H.difficultyOptions({ meta: null, has2x: false }));
    assert.deepEqual(H.DIFFICULTIES.filter(id => o[id].available), ['expert']);
    assert.match(o.easy.reason, /only has Expert/);
    assert.match(o.expert_plus.reason, /2x kick/);
    o = byId(H.difficultyOptions({ meta: H.parseDrumsMeta({ drums: { star_power: [] } }), has2x: true }));
    assert.deepEqual(H.DIFFICULTIES.filter(id => o[id].available), ['expert', 'expert_plus']);
    // the meta's kick2x flag also enables Expert+
    o = byId(H.difficultyOptions({ meta: H.parseDrumsMeta({ drums: { kick2x: true, star_power: [] } }) }));
    assert.equal(o.expert_plus.available, true);
    // still fetching
    assert.match(byId(H.difficultyOptions({ metaPending: true })).hard.reason, /Loading/);
    // levels present: available, generated marker
    const meta = H.parseDrumsMeta({ drums: Object.assign({}, LEVELS_BLOCK, { levels: { easy: [[1, 36, 0]], medium: [] } }) });
    o = byId(H.difficultyOptions({ meta, has2x: true }));
    assert.deepEqual([o.easy.available, o.easy.generated, o.easy.label, o.easy.name], [true, true, 'EASY', 'Easy']);
    assert.deepEqual([o.medium.available, o.hard.available], [false, false]);
    assert.match(o.medium.reason, /Medium chart is empty/);
    assert.match(o.hard.reason, /no Hard part/);
    assert.equal(o.expert.generated, false);
    // drum_tab charts: Expert only
    o = byId(H.difficultyOptions({ meta, drumTab: true }));
    assert.equal(o.easy.available, false);
    assert.match(o.easy.reason, /Drum tabs/);
    assert.equal(o.expert_plus.available, false);
});

test('resolveDifficulty falls back to Expert for unavailable levels without changing the request', () => {
    const opts = H.difficultyOptions({ meta: null, has2x: false });
    assert.deepEqual(H.resolveDifficulty('expert', opts), { id: 'expert', requested: 'expert', fallback: false, reason: '' });
    const r = H.resolveDifficulty('hard', opts);
    assert.deepEqual([r.id, r.requested, r.fallback], ['expert', 'hard', true]);
    assert.match(r.reason, /only has Expert/);
    assert.equal(H.resolveDifficulty('expert_plus', opts).id, 'expert');
    assert.equal(H.resolveDifficulty('expert_plus', H.difficultyOptions({ has2x: true })).id, 'expert_plus');
    // junk / missing preference -> Expert, no fallback flagged
    assert.deepEqual(H.resolveDifficulty('insane', opts), { id: 'expert', requested: 'expert', fallback: false, reason: '' });
    assert.equal(H.resolveDifficulty(undefined, null).id, 'expert');
    assert.equal(H.normalizeDifficulty('easy'), 'easy');
    assert.equal(H.normalizeDifficulty({}), 'expert');
});

test('nextDifficulty steps through the available levels and wraps', () => {
    const all = H.difficultyOptions({ meta: H.parseDrumsMeta({ drums: LEVELS_BLOCK }), has2x: true });
    assert.equal(H.nextDifficulty('easy', all, 1), 'medium');
    assert.equal(H.nextDifficulty('expert_plus', all, 1), 'easy');
    assert.equal(H.nextDifficulty('easy', all, -1), 'expert_plus');
    const few = H.difficultyOptions({ meta: null, has2x: false });
    assert.equal(H.nextDifficulty('expert', few, 1), 'expert');
    const two = H.difficultyOptions({ meta: null, has2x: true });
    assert.equal(H.nextDifficulty('expert', two, 1), 'expert_plus');
    assert.equal(H.nextDifficulty('expert_plus', two, 1), 'expert');
    assert.equal(H.nextDifficulty('expert', two, -1), 'expert_plus');
});

test('difficultyLabel / difficultyBadge: HUD text, AUTO marker for generated levels, fallback tooltip', () => {
    assert.equal(H.difficultyLabel('hard'), 'HARD');
    assert.equal(H.difficultyLabel('expert_plus'), 'EXPERT+');
    assert.equal(H.difficultyLabel('easy', true), 'EASY · AUTO');
    const meta = H.parseDrumsMeta({ drums: LEVELS_BLOCK });
    const opts = H.difficultyOptions({ meta, has2x: true });
    let b = H.difficultyBadge(H.resolveDifficulty('medium', opts), opts);
    assert.deepEqual([b.id, b.text, b.sub, b.fallback, b.color], ['medium', 'MEDIUM', 'AUTO', false, H.DIFFICULTY_COLORS.medium]);
    assert.match(b.title, /auto-generated/);
    b = H.difficultyBadge(H.resolveDifficulty('hard', opts), opts);
    assert.deepEqual([b.text, b.sub], ['HARD', null]);
    const none = H.difficultyOptions({ meta: null });
    b = H.difficultyBadge(H.resolveDifficulty('hard', none), none);
    assert.deepEqual([b.id, b.text, b.fallback], ['expert', 'EXPERT', true]);
    assert.match(b.title, /Hard is not available for this song/);
    assert.equal(H.difficultyBadge(null, null).text, 'EXPERT');
});

test('difficultyChart: Expert+ as is, Expert without 2x kick, lower levels from the block', () => {
    const notes = [w(1, 36), w(1, 42), w(1.25, 35), w(1.5, 38)];
    const chords = [];
    const meta = H.parseDrumsMeta({ drums: LEVELS_BLOCK });
    const xp = H.difficultyChart('expert_plus', notes, chords, meta);
    assert.ok(xp.notes === notes && xp.chords === chords && xp.id === 'expert_plus');
    const ex = H.difficultyChart('expert', notes, chords, meta);
    assert.deepEqual(ex.notes.map(n => n.s * 24 + n.f), [36, 42, 38]);
    const plain = [w(1, 36)];
    assert.equal(H.difficultyChart('expert', plain, null, null).notes, plain, 'no 2x kick: the same array');
    const md = H.difficultyChart('medium', notes, chords, meta);
    assert.equal(md.id, 'medium');
    assert.deepEqual(md.notes.map(n => [n.t, n.s * 24 + n.f, !!n.ac, !!n.mt]),
        [[1, 36, false, false], [1, 42, false, false], [1.5, 38, true, false], [2, 42, false, true]]);
    assert.deepEqual(md.chords, []);
    // a level the chart lacks plays Expert
    const fb = H.difficultyChart('hard', notes, chords, null);
    assert.equal(fb.id, 'expert');
    assert.deepEqual(fb.notes.map(n => n.s * 24 + n.f), [36, 42, 38]);
});

test('isDifficultyKey: D harder, Shift+D easier; never a drum key', () => {
    assert.deepEqual(H.isDifficultyKey({ code: 'KeyD', key: 'd' }), { dir: 1 });
    assert.deepEqual(H.isDifficultyKey({ code: 'KeyD', key: 'D', shiftKey: true }), { dir: -1 });
    assert.deepEqual(H.isDifficultyKey({ key: 'd' }), { dir: 1 });
    assert.equal(H.isDifficultyKey({ code: 'KeyD', key: 'd', ctrlKey: true }), null);
    assert.equal(H.isDifficultyKey({ code: 'KeyF', key: 'f' }), null);
    assert.equal(H.isDifficultyKey(null), null);
    assert.equal(H.keyToPad({ code: 'KeyD', key: 'd' }), null, 'D is not a drum key');
    for (const code of ['KeyB', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyI', 'KeyO', 'Enter', 'Space', 'ShiftLeft']) {
        assert.equal(H.isDifficultyKey({ code, key: code }), null, code);
    }
});

test('session: a level chart plays like any chart; switching level mid-song scores from the current time', () => {
    const meta = H.parseDrumsMeta({ drums: { star_power: [], fills: [], levels: {
        easy: [[1, 36, 0], [2, 38, 0], [3, 36, 0], [4, 38, 0]],
        hard: [[1, 36, 0], [1, 42, 0], [2, 38, 0], [2, 42, 0], [3, 36, 0], [3, 42, 0], [4, 38, 0], [4, 42, 0]],
    } } });
    const s = H.createSession(E, { now: () => 0 });
    s.load({ notes: H.difficultyChart('easy', [], [], meta).notes, chords: [], beats: [] });
    s.setMeta(meta);
    s.update(0);
    for (const g of s.gems.filter(g => g.t < 2.5)) { s.update(g.t); s.hit(g.t, g.pad, { cymbal: g.cymbal }); }
    s.update(2.5);
    assert.equal(s.getState().notesHit, 2);
    // switch to Hard at t=2.5 (what screen.js does: load the other chart, keep the meta)
    s.load({ notes: H.difficultyChart('hard', [], [], meta).notes, chords: [], beats: [] });
    s.setMeta(meta);
    s.update(2.5);
    const st = s.getState();
    assert.equal(st.totalNotes, 4, 'only the Hard notes from 2.5 s on');
    assert.equal(st.notesMissed, 0);
    for (const g of s.gems.filter(g => g.t > 2.5)) { s.update(g.t); s.hit(g.t, g.pad, { cymbal: g.cymbal }); }
    s.update(5);
    assert.deepEqual([s.getState().notesHit, s.getState().notesMissed, s.getState().overhits], [4, 0, 0]);
});

// ── input mapping ─────────────────────────────────────────────────────────

test('keyToPad: keyboard fallback layout (physical keys)', () => {
    const k = (code, extra) => H.keyToPad(Object.assign({ code, key: '' }, extra || {}));
    assert.equal(k('Space'), null, 'Space stays play/pause');
    assert.deepEqual(k('KeyB'), { pad: 0, cymbal: false });
    assert.deepEqual(k('KeyF'), { pad: 1, cymbal: false });
    assert.deepEqual(k('KeyJ'), { pad: 2, cymbal: false });
    assert.deepEqual(k('KeyK'), { pad: 3, cymbal: false });
    assert.deepEqual(k('KeyL'), { pad: 4, cymbal: false });
    assert.deepEqual(k('KeyJ', { shiftKey: true }), { pad: 2, cymbal: true });
    assert.deepEqual(k('KeyL', { shiftKey: true }), { pad: 4, cymbal: true });
    assert.deepEqual(k('KeyU'), { pad: 2, cymbal: true });
    assert.deepEqual(k('KeyI'), { pad: 3, cymbal: true });
    assert.deepEqual(k('KeyO'), { pad: 4, cymbal: true });
    assert.deepEqual(k('KeyF', { shiftKey: true }), { pad: 1, cymbal: false }, 'red has no cymbal');
    assert.deepEqual(k('KeyB', { shiftKey: true }), { pad: 0, cymbal: false });
    assert.deepEqual(k('Enter'), { action: 'activate' });
    assert.deepEqual(k('NumpadEnter'), { action: 'activate' });
});

test('keyToPad: falls back to e.key, ignores modifiers and unmapped keys', () => {
    assert.deepEqual(H.keyToPad({ key: 'K' }), { pad: 3, cymbal: false });
    assert.deepEqual(H.keyToPad({ key: 'b' }), { pad: 0, cymbal: false });
    assert.equal(H.keyToPad({ key: ' ' }), null);
    assert.deepEqual(H.keyToPad({ key: 'Enter' }), { action: 'activate' });
    assert.equal(H.keyToPad({ code: 'KeyF', ctrlKey: true }), null);
    assert.equal(H.keyToPad({ code: 'KeyJ', metaKey: true }), null);
    assert.equal(H.keyToPad({ code: 'KeyJ', altKey: true }), null);
    assert.equal(H.keyToPad({ code: 'KeyQ', key: 'q' }), null);
    assert.equal(H.keyToPad({ code: 'ArrowLeft', key: 'ArrowLeft' }), null);
    assert.equal(H.keyToPad(null), null);
});

test('midiToPad: Learn/custom mapping wins, otherwise General MIDI', () => {
    const gm = E.padFromMidi;
    assert.deepEqual(H.midiToPad(38, null, gm), { pad: 1, cymbal: false });
    assert.deepEqual(H.midiToPad(42, null, gm), { pad: 2, cymbal: true });
    assert.deepEqual(H.midiToPad(48, null, gm), { pad: 2, cymbal: false });
    assert.deepEqual(H.midiToPad(51, null, gm), { pad: 3, cymbal: true });
    assert.deepEqual(H.midiToPad(49, null, gm), { pad: 4, cymbal: true });
    assert.deepEqual(H.midiToPad(35, null, gm), { pad: 0, cymbal: false });
    assert.equal(H.midiToPad(44, null, gm), null, 'hi-hat pedal is not a hit');
    assert.equal(H.midiToPad(60, null, gm), null);
    const custom = { 60: 'snare', 61: 'crash', 62: 'tom2', 63: 'hihat', 64: 'ride', 65: 'kick', 66: 'tom1', 67: 'tom3',
        38: 'kick', 68: 'not-a-lane' };
    assert.deepEqual(H.midiToPad(60, custom, gm), { pad: 1, cymbal: false });
    assert.deepEqual(H.midiToPad(61, custom, gm), { pad: 4, cymbal: true });
    assert.deepEqual(H.midiToPad(62, custom, gm), { pad: 3, cymbal: false });
    assert.deepEqual(H.midiToPad(63, custom, gm), { pad: 2, cymbal: true });
    assert.deepEqual(H.midiToPad(64, custom, gm), { pad: 3, cymbal: true });
    assert.deepEqual(H.midiToPad(65, custom, gm), { pad: 0, cymbal: false });
    assert.deepEqual(H.midiToPad(66, custom, gm), { pad: 2, cymbal: false });
    assert.deepEqual(H.midiToPad(67, custom, gm), { pad: 4, cymbal: false });
    assert.deepEqual(H.midiToPad(38, custom, gm), { pad: 0, cymbal: false }, 'a remapped GM note follows the custom map');
    assert.equal(H.midiToPad(68, custom, gm), null, 'unknown lane id falls back to GM (68 is unmapped)');
    assert.deepEqual(H.midiToPad(42, custom, gm), { pad: 2, cymbal: true }, 'notes missing from the custom map use GM');
    assert.equal(H.midiToPad(200, null, gm), null);
    assert.equal(H.midiToPad(-1, null, gm), null);
    // a null-prototype map (screen.js _validateCustomMapping output) works too
    const np = Object.assign(Object.create(null), { 70: 'snare' });
    assert.deepEqual(H.midiToPad(70, np, gm), { pad: 1, cymbal: false });
});

test('synthMidiForPad picks a GM sound for keyboard hits', () => {
    assert.equal(H.synthMidiForPad(0, false), 36);
    assert.equal(H.synthMidiForPad(1, false), 38);
    assert.equal(H.synthMidiForPad(2, true), 42);
    assert.equal(H.synthMidiForPad(2, false), 48);
    assert.equal(H.synthMidiForPad(3, true), 51);
    assert.equal(H.synthMidiForPad(3, false), 45);
    assert.equal(H.synthMidiForPad(4, true), 49);
    assert.equal(H.synthMidiForPad(4, false), 41);
    assert.equal(H.synthMidiForPad(9, false), null);
    // every pad maps back to itself through GM
    for (const [pad, cym] of [[0, false], [1, false], [2, true], [2, false], [3, true], [3, false], [4, true], [4, false]]) {
        assert.deepEqual(E.padFromMidi(H.synthMidiForPad(pad, cym)), { pad, cymbal: cym });
    }
});

test('isTypingTarget: text inputs, textareas, selects and contenteditable', () => {
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'input' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'number' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(H.isTypingTarget({ tagName: 'INPUT', type: 'range' }), false);
    assert.equal(H.isTypingTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'SELECT' }), true);
    assert.equal(H.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(H.isTypingTarget({ tagName: 'CANVAS' }), false);
    assert.equal(H.isTypingTarget(null), false);
});

// ── timing ────────────────────────────────────────────────────────────────

test('estimateTime extrapolates between frames only while playing', () => {
    const playing = { time: 10, wall: 1000, prevTime: 9.984, prevWall: 984 };
    assert.ok(Math.abs(H.estimateTime(playing, 1010) - 10.01) < 1e-9);
    assert.ok(Math.abs(H.estimateTime(playing, 1500) - 10.06) < 1e-9, 'capped at 60 ms ahead');
    assert.equal(H.estimateTime(playing, 990), 10, 'never before the frame time');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: 10, prevWall: 984 }, 1010), 10, 'paused');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: 30, prevWall: 984 }, 1010), 10, 'seek back');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: 9, prevWall: 500 }, 1010), 10, 'stalled frames');
    assert.equal(H.estimateTime({ time: 10, wall: 1000, prevTime: NaN, prevWall: NaN }, 1010), 10);
    assert.ok(Number.isNaN(H.estimateTime({ time: NaN }, 0)));
    // half-speed playback extrapolates at half speed
    const slow = { time: 10, wall: 1000, prevTime: 9.992, prevWall: 984 };
    assert.ok(Math.abs(H.estimateTime(slow, 1020) - 10.01) < 1e-9);
});

test('isSeek flags backward jumps and large forward jumps', () => {
    assert.equal(H.isSeek(10, 10.016), false);
    assert.equal(H.isSeek(10, 11), false);
    assert.equal(H.isSeek(10, 12), true);
    assert.equal(H.isSeek(10, 9.9), false);
    assert.equal(H.isSeek(10, 9.5), true);
    assert.equal(H.isSeek(NaN, 3), false);
    assert.equal(H.isSeek(null, 3), false);
});

// ── HUD ───────────────────────────────────────────────────────────────────

test('formatScore / formatAccuracy', () => {
    assert.equal(H.formatScore(0), '0');
    assert.equal(H.formatScore(999), '999');
    assert.equal(H.formatScore(1000), '1,000');
    assert.equal(H.formatScore(1234567.9), '1,234,567');
    assert.equal(H.formatScore(-5), '0');
    assert.equal(H.formatScore(undefined), '0');
    assert.equal(H.formatAccuracy(1), '100.0%');
    assert.equal(H.formatAccuracy(0.9567), '95.7%');
    assert.equal(H.formatAccuracy(2), '100.0%');
    assert.equal(H.formatAccuracy(NaN), '--');
});

test('multiplierColor: x1..x4 and star power', () => {
    const set = new Set([1, 2, 3, 4].map(m => H.multiplierColor(m, false)));
    assert.equal(set.size, 4);
    assert.equal(H.multiplierColor(8, true), H.multiplierColor(2, true));
    assert.equal(H.multiplierColor(6, false), H.multiplierColor(8, true));
});

test('starProgress: stars earned and progress to the next threshold', () => {
    const th = [100, 200, 400, 800, 1600, 2400];
    assert.deepEqual(H.starProgress({ score: 0, starThresholds: th }), { count: 0, frac: 0, gold: false });
    assert.deepEqual(H.starProgress({ score: 50, starThresholds: th }), { count: 0, frac: 0.5, gold: false });
    assert.deepEqual(H.starProgress({ score: 300, starThresholds: th }), { count: 2, frac: 0.5, gold: false });
    assert.deepEqual(H.starProgress({ score: 2400, starThresholds: th }), { count: 6, frac: 1, gold: true });
    assert.deepEqual(H.starProgress(null), { count: 0, frac: 1, gold: false });
});

test('hudModel turns DrumsEngine.getState() into HUD values', () => {
    const eng = E.create(E.decodeNotes([w(1, 38), w(2, 38)]));
    const m0 = H.hudModel(eng.getState());
    assert.equal(m0.score, '0');
    assert.equal(m0.multiplierText, 'x1');
    assert.equal(m0.streakText, '0');
    assert.equal(m0.accuracy, '100.0%');
    assert.equal(m0.hitsText, '0 / 2');
    assert.equal(m0.spActive, false);
    const st = { score: 12345, combo: 37, multiplier: 8, maxMultiplier: 4, accuracy: 0.5, notesHit: 37, totalNotes: 74,
        starThresholds: [1, 2, 3, 4, 5, 99999], starPower: { amount: 0.625, active: true, canActivate: false } };
    const m = H.hudModel(st);
    assert.equal(m.score, '12,345');
    assert.equal(m.multiplierText, 'x8');
    assert.equal(m.multiplierProgress, 1, 'base x4 is maxed');
    assert.equal(m.multiplierColor, H.multiplierColor(8, true));
    assert.equal(m.spAmount, 0.625);
    assert.equal(m.spActive, true);
    assert.equal(m.stars, 5);
    assert.equal(m.accuracy, '50.0%');
    assert.equal(H.hudModel({ combo: 13, multiplier: 2, maxMultiplier: 4 }).multiplierProgress, 0.3);
    assert.equal(H.hudModel(null).score, '0');
});

// ── session ───────────────────────────────────────────────────────────────

function chart() {
    // 4/4 at 120 BPM: beats every 0.5 s. Snare + kick on every beat from t=1 to t=12.5.
    const notes = [];
    const beats = [];
    for (let i = 0; i < 40; i++) beats.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 + 1 : -1 });
    for (let t = 1; t <= 12.5; t += 0.5) notes.push(w(t, 38), w(t, 36));
    return { notes, chords: [], beats };
}

function playPerfect(s, from, to) {
    for (const g of s.gems) {
        if (g.t < from || g.t > to) continue;
        s.update(g.t);
        s.hit(g.t + 0.005, g.pad, { cymbal: g.cymbal });
    }
    s.update(to);
}

test('session: load builds the engine and render model; perfect play scores and queues hit events', () => {
    let wall = 0;
    const s = H.createSession(E, { now: () => wall });
    s.load(chart());
    assert.equal(s.gems.length, 48);
    assert.equal(s.getState().totalNotes, 48);
    assert.equal(s.beats.length, 40);
    playPerfect(s, 0, 5.2);
    const st = s.getState();
    assert.equal(st.notesHit, 18);
    assert.equal(st.combo, 18);
    assert.equal(st.multiplier, 2);
    const ev = s.drainEvents();
    assert.equal(ev.filter(e => e.type === 'hit').length, 18);
    assert.equal(ev.filter(e => e.type === 'press').length, 18);
    assert.equal(s.drainEvents().length, 0, 'drain empties the queue');
    assert.ok(ev.every(e => e.wall === 0));
});

test('session: misses and overhits queue events for the view', () => {
    const s = H.createSession(E);
    s.load(chart());
    s.update(1); s.hit(1, 1); s.hit(1, 0);   // hit both notes at t=1
    s.update(1.4); s.hit(1.4, 3);            // blue overhit
    s.update(2);                             // t=1.5 notes missed
    const types = s.drainEvents().map(e => e.type + (e.pad != null ? ':' + e.pad : ''));
    assert.ok(types.includes('overhit:3'));
    assert.ok(types.includes('miss:1') && types.includes('miss:0'));
    assert.ok(types.includes('combo-break'));
});

test('session: a backward seek rebuilds the engine from the new position', () => {
    const s = H.createSession(E);
    s.load(chart());
    playPerfect(s, 0, 6);
    const before = s.builds;
    assert.ok(s.getState().score > 0);
    s.update(3);                             // seek back
    assert.equal(s.builds, before + 1);
    const st = s.getState();
    assert.equal(st.score, 0);
    assert.equal(st.totalNotes, 40, 'notes before the seek point are left out');
    playPerfect(s, 3, 4);
    assert.equal(s.getState().notesHit, 6);
    s.update(4.016);
    assert.equal(s.builds, before + 1, 'normal playback does not rebuild');
    s.update(9);                             // big forward jump
    assert.equal(s.builds, before + 2);
    assert.equal(s.getState().notesMissed, 0, 'skipped notes are not counted as misses');
});

test('session: a chart loaded mid-song scores from the first frame, not from the song start', () => {
    const s = H.createSession(E);
    s.load(chart());
    s.update(6.2);
    const st = s.getState();
    assert.equal(st.notesMissed, 0);
    assert.equal(st.totalNotes, 26);
    const s2 = H.createSession(E);
    s2.load(chart());
    s2.update(0);                            // normal start: nothing rebuilt
    assert.equal(s2.builds, 1);
    assert.equal(s2.getState().totalNotes, 48);
});

test('session: setMeta applies star power phrases and drum fills (activation by the fill-end note)', () => {
    const s = H.createSession(E);
    s.load(chart());
    // phrases: two 2-beat phrases -> half a bar; fill ending at t=8 activates star power
    s.setMeta(H.parseDrumsMeta({ drums: { version: 1, pro: true, star_power: [[1, 2], [3, 4]], fills: [[7, 8]] } }));
    assert.ok(s.engine.isStarPowerNote(s.gems[0].id));
    playPerfect(s, 0, 7.9);
    let st = s.getState();
    assert.equal(st.starPower.phrasesHit, 2);
    assert.equal(st.starPower.canActivate, true);
    assert.equal(s.activate(7.9), false, 'fills disable manual activation');
    const ev1 = s.drainEvents();
    assert.ok(ev1.some(e => e.type === 'hit' && e.sp));
    assert.ok(ev1.some(e => e.type === 'sp-phrase'));
    assert.ok(ev1.some(e => e.type === 'sp-ready'));
    playPerfect(s, 7.95, 8.2);
    st = s.getState();
    assert.equal(st.starPower.active, true);
    assert.ok(s.drainEvents().some(e => e.type === 'sp-activate'));
    assert.equal(st.multiplier, 8, 'x4 doubled by star power');
});

test('session: without drums meta there is no star power and manual activation is allowed', () => {
    const s = H.createSession(E);
    s.load(chart());
    s.setMeta(null);
    assert.equal(s.getState().starPower.phrasesTotal, 0);
    assert.equal(s.engine.manualActivation, true);
    assert.equal(s.activate(1), false, 'empty bar');
});

test('session: setMeta mid-song rebuilds from the current time; hits during a seek are ignored', () => {
    const s = H.createSession(E);
    s.load(chart());
    playPerfect(s, 0, 4.2);
    const b = s.builds;
    s.setMeta(H.parseDrumsMeta({ drums: { star_power: [[6, 7]], fills: [] } }));
    assert.equal(s.builds, b + 1);
    assert.equal(s.getState().totalNotes, 34);
    assert.equal(s.getState().starPower.phrasesTotal, 1);
    assert.deepEqual(s.hit(1, 1), { type: 'ignored', reason: 'seek' });
    assert.deepEqual(H.createSession(E).hit(1, 1), { type: 'ignored', reason: 'no-chart' });
});

// ── screen.js view selection ──────────────────────────────────────────────

test('screen.js _resolveView: 3D when WebGL2 is available unless 2D is chosen', () => {
    global.window = {};
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.document = { addEventListener: () => {} };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    assert.equal(mod._resolveView('auto', true), '3d');
    assert.equal(mod._resolveView('auto', false), '2d');
    assert.equal(mod._resolveView('3d', true), '3d');
    assert.equal(mod._resolveView('3d', false), '2d');
    assert.equal(mod._resolveView('2d', true), '2d');
    assert.deepEqual([...mod._VALID_VIEWS].sort(), ['2d', '3d', 'auto']);
    assert.equal(typeof window.slopsmithViz_drums, 'function');
    assert.equal(window.slopsmithViz_drums.contextType, undefined, 'no static webgl2: Auto must not skip it without WebGL2');
    assert.equal(window.slopsmithViz_drums3d.contextType, 'webgl2');
    assert.equal(typeof window.slopsmithViz_drums.matchesArrangement, 'function');
});
