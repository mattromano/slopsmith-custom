'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRigPreset } = require('../screen.js');

const base = {
    nativePreset: JSON.stringify({ version: 1, chain: [
        { id: 1, type: 1, name: 'NAM: amp', path: 'C:/amp.nam', bypassed: false, state: 'S1' },
        { id: 2, type: 2, name: 'IR: cab', path: 'C:/cab.wav', bypassed: false, state: 'S2' },
    ] }),
    inputGain: 1, outputGain: 0.8, generatedBy: 'tone_pack', category: 'od',
};
const rig = {
    pre: [{ name: 'Range Booster', path: 'C:/rb/vst/Range Booster.vst3', params: { Boost: 0.6 } }],
    post: [{ name: 'Holy Spring', path: 'C:/rb/vst/Holy Spring.vst3', params: { Mix: 0.24 } }],
};

test('pedals wrap the amp + cab: pre first, post last, ids renumbered', () => {
    const { name, preset } = buildRigPreset(base, rig, 'Auto · Crunch');
    assert.equal(name, '\u266A Auto · Crunch: Range Booster + Holy Spring');
    const chain = JSON.parse(preset.nativePreset).chain;
    assert.deepEqual(chain.map(s => s.name), ['Range Booster', 'NAM: amp', 'IR: cab', 'Holy Spring']);
    assert.deepEqual(chain.map(s => s.id), [1, 2, 3, 4]);
    assert.equal(chain[1].state, 'S1', 'amp keeps its state');
    assert.equal(chain[0].type, 0);
});

test('knob values are recorded per chain position; base levels and tags carry over', () => {
    const { preset } = buildRigPreset(base, rig, 'Auto · Crunch');
    assert.deepEqual(preset.rsPedals.map(p => p.index), [0, 3]);
    assert.deepEqual(preset.rsPedals[1].params, { Mix: 0.24 });
    assert.equal(preset.outputGain, 0.8);
    assert.equal(preset.generatedBy, 'tone_pack:song');
    assert.equal(preset.rigBase, 'Auto · Crunch');
    assert.equal(preset.items.length, 4);
});

test('a base without a chain still yields just the pedals', () => {
    const { preset } = buildRigPreset({ nativePreset: 'not json' }, { pre: [], post: rig.post }, 'X');
    assert.deepEqual(JSON.parse(preset.nativePreset).chain.map(s => s.name), ['Holy Spring']);
});
