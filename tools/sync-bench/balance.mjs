// Kit balance (muted browser): hits every piece through the real plugin and measures its PERCEIVED loudness:
// K-weighted (BS.1770) momentary loudness, the loudest 400 ms window in the first 1.5 s (so a crash that keeps
// blooming is caught), Room 0. Compares with the target drum mix below and prints the gain (dB) each piece
// needs. OUT=balance.json writes {kit: {note: {lufs, db}}} for the tables in screen.js / kit.json.
//   KIT=sblive,crocell  VEL=100  NOTES=36,38,...
import { launch, BASE } from './common.mjs';
import fs from 'node:fs';
const KITS = (process.env.KIT || 'crocell,virtuosity,jclive,fluid,sblive,chaos').split(',');
const VEL = +(process.env.VEL || 100);
// Target mix (dB relative to kick / snare). Same table as screen.js KIT_MIX_TARGET_DB.
export const TARGET = {
    35: 0, 36: 0, 38: 0, 40: 0, 37: -9,
    41: -2, 43: -2, 45: -2, 47: -2, 48: -2, 50: -2,
    42: -7, 44: -10, 46: -4,
    49: -4, 57: -4, 52: -5, 55: -6,
    51: -7, 59: -7, 53: -5,
};
const NOTES = (process.env.NOTES || Object.keys(TARGET).join(',')).split(',').map(Number);
const out = process.env.OUT && fs.existsSync(process.env.OUT) ? JSON.parse(fs.readFileSync(process.env.OUT, 'utf8')) : {};

for (const kit of KITS) {
    const { browser, page } = await launch();
    await page.addInitScript(({ kit }) => {
        localStorage.setItem('drums_kit_v1', kit);
        localStorage.setItem('drums_room_v1', '0');
        localStorage.setItem('drums_synth_vol', '0.7');
        localStorage.setItem('drums_vel_curve_v1', 'linear');
        const taps = new WeakMap();
        window.__tapCtxs = [];
        const origConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (dst, ...rest) {
            const r = origConnect.call(this, dst, ...rest);
            if (dst instanceof AudioDestinationNode) {
                const ctx = dst.context;
                let tap = taps.get(ctx);
                if (!tap) {
                    const sp = ctx.createScriptProcessor(2048, 2, 2);
                    tap = { ctx, sp, frames: [], rec: false };
                    sp.onaudioprocess = (e) => {
                        if (!tap.rec) return;
                        tap.frames.push({ t: e.playbackTime, l: Float32Array.from(e.inputBuffer.getChannelData(0)), r: Float32Array.from(e.inputBuffer.getChannelData(1)) });
                    };
                    const z = ctx.createGain(); z.gain.value = 0;
                    origConnect.call(sp, z); origConnect.call(z, ctx.destination);
                    taps.set(ctx, tap);
                    window.__tapCtxs.push(tap);
                }
                origConnect.call(this, tap.sp);
            }
            return r;
        };
    }, { kit });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const res = await page.evaluate(async ({ NOTES, VEL }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        if (typeof window.showScreen === 'function') window.showScreen('plugin-drums');   // routes pad hits
        await sleep(500);
        window.__drumsDebug.midi([0x99, 38, 12]);   // wakes the synth
        await sleep(4000);
        const dctx = window.__drumsDebug.audioCtx();
        const tap = window.__tapCtxs.find((t) => t.ctx === dctx);
        if (!tap) return { err: 'no tap' };
        const sr = dctx.sampleRate;
        // BS.1770 K-weighting at any sample rate (pyloudnorm's formulas).
        const biq = (b, a) => { let x1 = 0, x2 = 0, y1 = 0, y2 = 0; return (x) => { const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; };
        const kw = () => {
            let G = 3.99984385397, Q = 0.7071752369554193, fc = 1681.9744509555319;
            let A = 10 ** (G / 40), w0 = 2 * Math.PI * fc / sr, al = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
            let a0 = (A + 1) - (A - 1) * c + 2 * Math.sqrt(A) * al;
            const s1 = biq([A * ((A + 1) + (A - 1) * c + 2 * Math.sqrt(A) * al) / a0, -2 * A * ((A - 1) + (A + 1) * c) / a0, A * ((A + 1) + (A - 1) * c - 2 * Math.sqrt(A) * al) / a0],
                [1, 2 * ((A - 1) - (A + 1) * c) / a0, ((A + 1) - (A - 1) * c - 2 * Math.sqrt(A) * al) / a0]);
            Q = 0.5003270373253953; fc = 38.13547087613982; w0 = 2 * Math.PI * fc / sr; al = Math.sin(w0) / (2 * Q); c = Math.cos(w0); a0 = 1 + al;
            const s2 = biq([(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], [1, -2 * c / a0, (1 - al) / a0]);
            return (x) => s2(s1(x));
        };
        const out = [];
        for (const note of NOTES) {
            tap.frames = []; tap.rec = true;
            await sleep(120);
            const th = dctx.currentTime;
            window.__drumsDebug.midi([0x99, note, VEL]);
            await sleep(1700);
            tap.rec = false;
            const L = [], R = [];
            for (const f of tap.frames) for (let i = 0; i < f.l.length; i++) { if (f.t + i / sr >= th) { L.push(f.l[i]); R.push(f.r[i]); } }
            const kl = kw(), kr = kw();
            const n = Math.min(L.length, Math.floor(1.5 * sr));
            const e = new Float64Array(n + 1);
            for (let i = 0; i < n; i++) { const a = kl(L[i]), b = kr(R[i]); e[i + 1] = e[i] + a * a + b * b; }
            const w = Math.floor(0.4 * sr), step = Math.floor(0.01 * sr);
            let best = 0, bestAt = 0;
            for (let i = 0; i + w <= n; i += step) { const m = (e[i + w] - e[i]) / w; if (m > best) { best = m; bestAt = i; } }
            out.push({ note, lufs: best > 0 ? -0.691 + 10 * Math.log10(best) : -Infinity, at: bestAt / sr });
        }
        return out;
    }, { NOTES, VEL });
    try { await browser.close(); } catch (_) {}
    if (res.err) { console.log(kit, res.err); continue; }
    const by = Object.fromEntries(res.map((x) => [x.note, x]));
    const ref = (by[36].lufs + by[38].lufs) / 2;
    out[kit] = {};
    console.log(`kit ${kit}: kick ${by[36].lufs.toFixed(1)} snare ${by[38].lufs.toFixed(1)} LUFS (momentary max)`);
    for (const x of res) {
        if (!Number.isFinite(x.lufs)) { console.log(`   ${x.note}: silent`); continue; }
        const rel = x.lufs - ref, db = TARGET[x.note] - rel;
        out[kit][x.note] = { lufs: +x.lufs.toFixed(2), rel: +rel.toFixed(2), db: +db.toFixed(1), at: +x.at.toFixed(2) };
        if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
        console.log(`   ${String(x.note).padStart(2)}: ${rel >= 0 ? '+' : ''}${rel.toFixed(1)} dB vs kick/snare (target ${TARGET[x.note]}) -> ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB   loudest at ${x.at.toFixed(2)} s`);
    }
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 1));
