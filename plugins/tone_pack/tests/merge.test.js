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
    const old = { 'Auto · Crunch': { nativePreset: 'old', generatedBy: 'tone_pack', outputGain: 0.9, created: 5 } };
    const r2 = mergePack(pack, old, null, ['Auto · Crunch']);
    assert.equal(r2.presets['Auto · Crunch'].nativePreset, 'B');
    assert.equal(r2.presets['Auto · Crunch'].outputGain, 0.9);
    assert.deepEqual(r2.updated, ['Auto · Crunch']);
});

test('a target pointing at a removed pack preset is moved to the new one', () => {
    const r = mergePack(pack, {}, { targets: { clean: 'Auto · Old Clean' } }, ['Auto · Old Clean']);
    assert.equal(r.ta.targets.clean, 'Auto · Clean');
});
