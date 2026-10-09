'use strict';
// Coverage for the arrangement picker helpers in screen.js: option list
// built from the queued song's real arrangements (e.g. Drums), fallback,
// sticky picks, escaping, and name → highway-index resolution.
// Run: node --test tests/arrangements.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = { addEventListener: () => {} };
    global.document = { addEventListener: () => {}, getElementById: () => null };
    global.localStorage = { getItem: () => null, setItem: () => {} };
    global.sessionStorage = { getItem: () => null, setItem: () => {} };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

const values = choices => choices.map(c => c.value);
const selected = choices => choices.filter(c => c.selected).map(c => c.value);

test('options come from the song and follow app order (Lead, Combo, Rhythm, Bass, then others)', () => {
    const m = freshPlugin();
    const choices = m._arrangementChoices(['Drums', 'Bass', 'Keys', 'Rhythm', 'Combo', 'Lead'], 'Lead');
    assert.deepEqual(values(choices), ['Lead', 'Combo', 'Rhythm', 'Bass', 'Drums', 'Keys']);
    assert.deepEqual(selected(choices), ['Lead']);
});

test('accepts library/song_info objects and drops duplicates and blanks', () => {
    const m = freshPlugin();
    const arrs = [{ index: 0, name: 'Lead' }, { index: 1, name: 'Drums' }, { name: '' }, 'Lead', null, 7];
    assert.deepEqual(m._arrangementNames(arrs), ['Lead', 'Drums']);
});

test('Drums is selectable when the song has it', () => {
    const m = freshPlugin();
    const choices = m._arrangementChoices(['Lead', 'Bass', 'Drums'], 'Drums');
    assert.deepEqual(selected(choices), ['Drums']);
    assert.equal(choices.length, 3);
});

test('falls back to Lead/Rhythm/Bass when the song arrangements are unknown', () => {
    const m = freshPlugin();
    assert.deepEqual(values(m._arrangementChoices([], 'Rhythm')), ['Lead', 'Rhythm', 'Bass']);
    assert.deepEqual(values(m._arrangementChoices(undefined, 'Lead')), ['Lead', 'Rhythm', 'Bass']);
    assert.deepEqual(m.DEFAULT_ARRANGEMENTS, ['Lead', 'Rhythm', 'Bass']);
});

test('a pick the song lacks is kept (sticky) and flagged', () => {
    const m = freshPlugin();
    const choices = m._arrangementChoices(['Lead', 'Bass'], 'Drums');
    assert.deepEqual(values(choices), ['Lead', 'Bass', 'Drums']);
    assert.deepEqual(selected(choices), ['Drums']);
    assert.equal(choices[2].label, 'Drums (not in this song)');
    // Unknown song: still kept, but no "not in this song" claim.
    const unknown = m._arrangementChoices([], 'Drums');
    assert.equal(unknown[unknown.length - 1].label, 'Drums');
});

test('option HTML escapes names', () => {
    const m = freshPlugin();
    const html = m._arrangementOptionsHtml(m._arrangementChoices(['Lead', '"><img src=x onerror=alert(1)>'], 'Lead'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&quot;&gt;&lt;img'));
    assert.ok(html.includes('<option value="Lead" selected>Lead</option>'));
});

test('names that look like Object.prototype keys do not break ordering', () => {
    const m = freshPlugin();
    assert.deepEqual(m._arrangementNames(['constructor', 'Bass', '__proto__', 'Lead']),
        ['Lead', 'Bass', 'constructor', '__proto__']);
});

test('_resolveArrangementIndex maps a name to the highway index', () => {
    const m = freshPlugin();
    // Queue items carry library names in library (= highway) order.
    assert.equal(m._resolveArrangementIndex(['Lead', 'Bass', 'Drums'], 'Drums'), 2);
    assert.equal(m._resolveArrangementIndex(['Lead', 'Bass', 'Drums'], 'Lead'), 0);
    // Objects: their own `index` wins over array position.
    assert.equal(m._resolveArrangementIndex(
        [{ index: 3, name: 'Drums' }, { index: 0, name: 'Lead' }], 'Drums'), 3);
    // Missing → undefined so the server picks (default arrangement / most notes).
    assert.equal(m._resolveArrangementIndex(['Lead', 'Bass'], 'Drums'), undefined);
    assert.equal(m._resolveArrangementIndex([], 'Lead'), undefined);
    assert.equal(m._resolveArrangementIndex(null, 'Lead'), undefined);
    // Exact match only — "Drums" must not match "Drums 2".
    assert.equal(m._resolveArrangementIndex(['Drums 2', 'Drums'], 'Drums'), 1);
});

test('_arrangementFixIndex corrects a load that landed on the wrong part', () => {
    const m = freshPlugin();
    const si = {
        arrangement: 'Lead', arrangement_index: 0,
        arrangements: [{ index: 0, name: 'Lead' }, { index: 1, name: 'Drums' }],
    };
    assert.equal(m._arrangementFixIndex(si, 'Drums'), 1);
    assert.equal(m._arrangementFixIndex(si, 'Lead'), undefined);        // already right
    assert.equal(m._arrangementFixIndex(si, 'Bass'), undefined);        // song lacks it
    assert.equal(m._arrangementFixIndex({}, 'Drums'), undefined);       // song_info not in yet
    assert.equal(m._arrangementFixIndex(null, 'Drums'), undefined);
});

test('_arrangementSourceItem follows the current song, else the next queued one', () => {
    const m = freshPlugin();
    const a = { filename: 'a.sloppak' };
    const b = { filename: 'b.sloppak' };
    assert.equal(m._arrangementSourceItem({ queue: [a, b], now_playing: 1 }), b);
    assert.equal(m._arrangementSourceItem({ queue: [a, b], now_playing: -1 }), a);
    assert.equal(m._arrangementSourceItem({ queue: [], now_playing: -1 }), null);
    assert.equal(m._arrangementSourceItem({ queue: [a], now_playing: 5 }), null);
    assert.equal(m._arrangementSourceItem(null), null);
});

test('screen.js still loads as a browser script with only window/document stubs', () => {
    const m = freshPlugin();
    assert.equal(typeof global.window.mpSetArrangement, 'function');
    assert.equal(typeof m._arrangementChoices, 'function');
});

test('search results list songs with Drums first, then more parts, else library order', () => {
    const m = freshPlugin();
    const song = (filename, ...arrs) => ({ filename, arrangements: arrs.map(name => ({ name })) });
    const sorted = m._sortSearchResults([
        song('a_p.psarc', 'Lead', 'Rhythm', 'Bass'),
        song('b_p.psarc', 'Lead', 'Bass'),
        song('a.sloppak', 'Lead', 'Rhythm', 'Bass', 'Drums'),
        song('c_p.psarc', 'Lead', 'Rhythm', 'Bass', 'Bass'),
    ]);
    assert.deepEqual(sorted.map(s => s.filename), ['a.sloppak', 'a_p.psarc', 'c_p.psarc', 'b_p.psarc']);
    assert.equal(m._searchResultParts(['Lead', 'Rhythm', 'Bass', 'Bass', 'Drums']), 'Lead, Rhythm, Bass, Drums');
});
