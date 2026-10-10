// Hi-hat pedal + kit load check (muted browser): sends MIDI (CC4 pedal moves, hi-hat notes) through the real
// plugin on the Plugins -> Drums screen and reports which sample file each one started, plus how long the
// sampled kit took to become playable / fully loaded.   KIT=drs
import { launch, BASE } from './common.mjs';
const KIT = process.env.KIT || 'drs';
const { browser, page, errors } = await launch();
await page.addInitScript(({ KIT }) => {
    localStorage.setItem('drums_kit_v1', KIT);
    localStorage.setItem('drums_hh_pedal_v1', 'auto');
    window.__started = [];
    const st = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
        try {
            const k = window.__drumsDebug && window.__drumsDebug.kit();
            if (k) { const f = Object.keys(k.buffers).find((n) => k.buffers[n] === this.buffer); if (f) window.__started.push(f); }
        } catch (_) { /* ignore */ }
        return st.apply(this, a);
    };
}, { KIT });
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const res = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = window.__drumsDebug;
    window.showScreen('plugin-drums');
    await sleep(300);
    D.midi([0x89, 38, 0]);            // note-off: no sound
    D.midi([0x99, 38, 12]);           // wakes the synth (soft)
    let k = null;
    for (let i = 0; i < 200 && !(k = D.kit()); i++) await sleep(50);
    if (!k) return { err: 'kit not loaded' };
    await k.complete;
    const step = async (label, msgs) => {
        window.__started = [];
        for (const m of msgs) { D.midi(m); await sleep(40); }
        await sleep(60);
        return [label, window.__started.slice()];
    };
    const out = [];
    out.push(await step('note 46, no CC4 yet', [[0x99, 46, 90]]));
    out.push(await step('CC4 127 (down), note 46', [[0xB9, 4, 127], [0x99, 46, 90]]));
    out.push(await step('CC4 80 (half), note 46', [[0xB9, 4, 80], [0x99, 46, 90]]));
    out.push(await step('CC4 0 (up), note 42', [[0xB9, 4, 0], [0x99, 42, 90]]));
    out.push(await step('quick close 0 -> 127 (chick)', [[0xB9, 4, 0], [0xB9, 4, 127]]));
    out.push(await step('note 24 (Alesis), pedal down', [[0x99, 24, 90]]));
    return { out, readyMs: k.readyMs, completeMs: k.completeMs, files: Object.keys(k.buffers).length };
});
try { await browser.close(); } catch (_) {}
if (res.err) { console.log(res); process.exit(1); }
console.log(`kit ${KIT}: playable after ${res.readyMs.toFixed(0)} ms, all ${res.files} files after ${res.completeMs.toFixed(0)} ms`);
for (const [l, f] of res.out) console.log(`  ${l.padEnd(32)} -> ${f.join(', ') || '(nothing)'}`);
console.log('errors', JSON.stringify(errors.filter((e) => !/audio-engine|404/.test(e)).slice(0, 5)));
