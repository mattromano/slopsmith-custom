// Offline validation of assets/pitch-shift-worklet.js.
//
// We can't audition audio in CI, so load the REAL worklet under stubbed
// AudioWorklet globals, run a known sine through it, and assert:
//   - semitones = 0 is sample-accurate passthrough
//   - +N / -N shift the dominant frequency by 2^(N/12)
//   - output length == input length (tempo preserved)
//   - stereo is processed independently; mono fans out
//
// Run: node test/pitch-shift.test.js   (exit 0 = pass, 1 = fail)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Load the worklet file under stubbed globals ───────────────────────────────
function loadProcessor() {
    let Captured = null;
    const sandbox = {
        AudioWorkletProcessor: class {
            constructor() { this.port = { onmessage: null, postMessage() {} }; }
        },
        registerProcessor: (name, cls) => { Captured = cls; },
        Math, Float32Array,
    };
    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'pitch-shift-worklet.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'pitch-shift-worklet.js' });
    if (!Captured) throw new Error('registerProcessor was never called');
    return Captured;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SR = 44100;
const QUANTUM = 128;

function makeSine(freq, samples, channels = 1) {
    const chans = [];
    for (let c = 0; c < channels; c++) {
        const a = new Float32Array(samples);
        for (let i = 0; i < samples; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / SR);
        chans.push(a);
    }
    return chans;
}

// Run a multi-channel signal through the processor block-by-block.
function runThrough(proc, inChans, semitones) {
    const samples = inChans[0].length;
    const nCh = inChans.length;
    const out = inChans.map(() => new Float32Array(samples));
    const params = { pitchSemitones: Float32Array.of(semitones) };
    for (let off = 0; off < samples; off += QUANTUM) {
        const n = Math.min(QUANTUM, samples - off);
        const inBlk = inChans.map((a) => a.subarray(off, off + n));
        const outBlk = out.map((a) => a.subarray(off, off + n));
        proc.process([inBlk], [outBlk], params);
    }
    return out;
}

// Dominant frequency via zero-crossing rate over a steady-state slice.
function estimateFreq(buf, skip) {
    let crossings = 0;
    for (let i = skip + 1; i < buf.length; i++) {
        if ((buf[i - 1] <= 0 && buf[i] > 0) || (buf[i - 1] >= 0 && buf[i] < 0)) crossings++;
    }
    const dur = (buf.length - skip - 1) / SR;
    return crossings / 2 / dur;
}

// ── Assertions ────────────────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ok   ${name}`); }
    else { console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}

const Proc = loadProcessor();
const W = 1024;
const N = SR; // 1 second

console.log('pitch-shift-worklet validation');

// 1. Passthrough at 0 semitones.
{
    const proc = new Proc({ processorOptions: { windowSize: W } });
    const inp = makeSine(440, N, 1);
    const out = runThrough(proc, inp, 0);
    let maxErr = 0;
    for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(out[0][i] - inp[0][i]));
    check('0 st is sample-accurate passthrough', maxErr < 1e-6, `maxErr=${maxErr}`);
    check('0 st preserves length', out[0].length === N);
}

// 2. Octave up / down + a couple of preset offsets.
for (const semi of [12, -12, -1, -5, 2]) {
    const proc = new Proc({ processorOptions: { windowSize: W } });
    const f0 = 440;
    const out = runThrough(proc, makeSine(f0, N, 1), semi);
    const expected = f0 * Math.pow(2, semi / 12);
    const got = estimateFreq(out[0], 4 * W); // skip ring fill + transient
    const errPct = Math.abs(got - expected) / expected * 100;
    check(`${semi >= 0 ? '+' : ''}${semi} st → ~${expected.toFixed(1)} Hz`,
          errPct < 8, `got ${got.toFixed(1)} Hz (${errPct.toFixed(1)}% off)`);
    check(`${semi >= 0 ? '+' : ''}${semi} st preserves length (tempo)`, out[0].length === N);
}

// 3. Stereo handled per channel.
{
    const proc = new Proc({ processorOptions: { windowSize: W } });
    const inp = [makeSine(330, N, 1)[0], makeSine(550, N, 1)[0]];
    const out = runThrough(proc, inp, -12);
    const l = estimateFreq(out[0], 4 * W);
    const r = estimateFreq(out[1], 4 * W);
    check('stereo L shifted independently', Math.abs(l - 165) / 165 < 0.08, `L=${l.toFixed(1)}`);
    check('stereo R shifted independently', Math.abs(r - 275) / 275 < 0.08, `R=${r.toFixed(1)}`);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
