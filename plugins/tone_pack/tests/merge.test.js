'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePack } = require('../screen.js');

const pack = {
    presets: {
        'Auto · Clean': { nativePreset: 'A', generatedBy: 'tone_pack', outputGain: 1 },
        'Auto · Crunch': { nativePreset: 'B', generatedBy: 'tone_pack', outputGain: 0.5 },
    },
    targets: { clean: 'Auto · Clean', od: 'Auto · Crunch' },
};

test('adds pack presets, fills empty targets, idle = the user\'s own preset', () => {
    const r = mergePack(pack, { 'Main Lead': { nativePreset: 'X' } }, null, []);
    assert.deepEqual(r.added.sort(), ['Auto · Clean', 'Auto · Crunch']);
    assert.equal(r.presets['Main Lead'].nativePreset, 'X');
    assert.deepEqual(r.ta.targets, { clean: 'Auto · Clean', od: 'Auto · Crunch', idle: 'Main Lead' });
});

test('never overrides user targets or user presets with the same name', () => {
    const r = mergePack(pack, { 'Auto · Clean': { nativePreset: 'mine' } }, { targets: { clean: 'Mine' } }, []);
    assert.equal(r.presets['Auto · Clean'].nativePreset, 'mine');
    assert.equal(r.ta.targets.clean, 'Mine');
});

test('a deleted pack preset stays deleted; a changed one refreshes but keeps level tweaks', () => {
    const r1 = mergePack(pack, {}, null, ['Auto · Clean']);
    assert.equal(r1.presets['Auto · Clean'], undefined);
    // older pack preset (no packLevels): takes the new pack levels
    const old = { 'Auto · Crunch': { nativePreset: 'old', generatedBy: 'tone_pack', outputGain: 0.9, created: 5 } };
    const r2 = mergePack(pack, old, null, ['Auto · Crunch']);
    assert.equal(r2.presets['Auto · Crunch'].nativePreset, 'B');
    assert.equal(r2.presets['Auto · Crunch'].outputGain, 0.5);
    // the user moved the level away from what the pack set: kept
    const tweaked = { 'Auto · Crunch': { nativePreset: 'old', generatedBy: 'tone_pack', outputGain: 1.4,
        packLevels: { outputGain: 1 } } };
    const r3 = mergePack(pack, tweaked, null, ['Auto · Crunch']);
    assert.equal(r3.presets['Auto · Crunch'].outputGain, 1.4);
    assert.deepEqual(r2.updated, ['Auto · Crunch']);
});

test('a target pointing at a removed pack preset is moved to the new one', () => {
    const r = mergePack(pack, {}, { targets: { clean: 'Auto · Old Clean' } }, ['Auto · Old Clean']);
    assert.equal(r.ta.targets.clean, 'Auto · Clean');
});

const { songOverrides } = require('../screen.js');
const targets = { clean: 'C', dist: 'D', od: 'O', bass: 'B', solo: 'S', idle: 'I' };
const byName = (n) => (/clean/i.test(n) ? 'clean' : /dist/i.test(n) ? 'dist' : null);

test('songOverrides: only names the keyword classifier misses, bass parts all Bass, $song key', () => {
    const ov = songOverrides({ 'Tone 1': 'dist', 'x_clean': 'od', 'Default': 'clean', '$song': 'od' },
        byName, targets, { songKey: 'sloppak/a.sloppak' });
    assert.deepEqual(ov, { 'Tone 1': 'D', 'Default': 'C', 'sloppak/a.sloppak': 'O' });
    const bass = songOverrides({ 'b_dist': 'bass', 'Tone 0': 'bass' }, byName, targets, { bass: true });
    assert.deepEqual(bass, { 'b_dist': 'B', 'Tone 0': 'B' });
    assert.deepEqual(songOverrides({ 'Tone 1': 'mod' }, byName, targets, {}), {}, 'no target for the category');
});

const { withTrim, homePresetName } = require('../screen.js');

test('trims fold into the pack output gain and refresh existing pack presets', () => {
    const p = { nativePreset: 'A', generatedBy: 'tone_pack', outputGain: 1, category: 'dist', packLevels: { outputGain: 1 } };
    const t = withTrim(p, { dist: 6 });
    assert.ok(Math.abs(t.outputGain - 1.9953) < 1e-3);
    assert.equal(t.packLevels.outputGain, t.outputGain);
    const pk = { presets: { 'Auto · Dist': p }, targets: {} };
    const r = mergePack(pk, { 'Auto · Dist': Object.assign({}, p) }, null, ['Auto · Dist'], { dist: 6 });
    assert.deepEqual(r.updated, ['Auto · Dist']);
    assert.ok(r.presets['Auto · Dist'].outputGain > 1.9);
});

test('homePresetName: Main Lead, else the Idle target', () => {
    assert.equal(homePresetName({ 'Main Lead': {}, X: {} }, {}), 'Main Lead');
    assert.equal(homePresetName({ X: {} }, { targets: { idle: 'X' } }), 'X');
    assert.equal(homePresetName({}, {}), null);
});
