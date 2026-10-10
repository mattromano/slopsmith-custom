// Drum pad sound check (muted browser): taps everything the drums plugin sends to the speakers, plays pad hits
// through the real plugin (MIDI -> _handleDrumHit -> kit), and measures per kit / room setting:
//   onset   graph delay from the hit (AudioContext time) to the first audible sample (dry path latency)
//   corr    L/R correlation of the whole hit (1 = mono / "2D", lower = wider)
//   tail    energy 150-600 ms after the hit relative to the first 150 ms (room / decay)
//   KIT=sblive,crocell  ROOM=0,0.35
import { launch, stats, BASE } from './common.mjs';
const KITS = (process.env.KIT || 'sblive,crocell').split(',');
const ROOMS = (process.env.ROOM || '0,0.35').split(',').map(Number);
const NOTES = [36, 38, 42, 48, 45, 43, 49, 51];

for (const kit of KITS) for (const room of ROOMS) {
    const { browser, page } = await launch();
    await page.addInitScript(({ kit, room }) => {
        localStorage.setItem('drums_kit_v1', kit);
        localStorage.setItem('drums_room_v1', String(room));
        localStorage.setItem('drums_synth_vol', '0.7');
        // Tap: anything connected to a context's destination is also recorded.
        const taps = new WeakMap();
        window.__tapCtxs = [];
        const origConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (dst, ...rest) {
            const r = origConnect.call(this, dst, ...rest);
            if (dst instanceof AudioDestinationNode) {
                const ctx = dst.context;
                let tap = taps.get(ctx);
                if (!tap) {
                    const sp = ctx.createScriptProcessor(1024, 2, 2);
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
    }, { kit, room });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.playSong('sloppak/1979.sloppak', 2));
    await page.waitForTimeout(8000);
    const res = await page.evaluate(async (NOTES) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__drumsDebug.midi([0x99, 38, 1]);           // wakes the synth (very soft)
        await sleep(2500);                                 // kit samples load
        const out = [];
        for (const note of NOTES) {
            const dctx = window.__drumsDebug.audioCtx();
            const tap = window.__tapCtxs.find((t) => t.ctx === dctx);
            if (!tap) return { err: 'no tap' };
            tap.frames = []; tap.rec = true;
            await sleep(150);
            const th = tap.ctx.currentTime;
            window.__drumsDebug.midi([0x99, note, 110]);
            await sleep(900);
            tap.rec = false;
            const sr = tap.ctx.sampleRate;
            const L = [], R = [], T = [];
            for (const f of tap.frames) for (let i = 0; i < f.l.length; i++) { L.push(f.l[i]); R.push(f.r[i]); T.push(f.t + i / sr); }
            let i0 = T.findIndex((t, i) => t >= th && Math.max(Math.abs(L[i]), Math.abs(R[i])) > 1e-3);
            if (i0 < 0) { out.push({ note, silent: true }); continue; }
            const seg = (a, b) => [L.slice(i0 + Math.floor(a * sr), i0 + Math.floor(b * sr)), R.slice(i0 + Math.floor(a * sr), i0 + Math.floor(b * sr))];
            const en = ([l, r]) => l.reduce((s, v) => s + v * v, 0) + r.reduce((s, v) => s + v * v, 0);
            const [l, r] = seg(0, 0.7);
            let sl = 0, sr2 = 0, slr = 0;
            for (let i = 0; i < l.length; i++) { sl += l[i] * l[i]; sr2 += r[i] * r[i]; slr += l[i] * r[i]; }
            out.push({ note, onsetMs: (T[i0] - th) * 1000, corr: slr / Math.sqrt(sl * sr2), balDb: 10 * Math.log10(sr2 / sl),
                tailDb: 10 * Math.log10(en(seg(0.15, 0.6)) / en(seg(0, 0.15))) });
        }
        return out;
    }, NOTES);
    try { await browser.close(); } catch (_) {}
    const dbg = res.dbg; if (res.err) { console.log(kit, room, res.err); continue; }
    const ok = res.filter((x) => !x.silent);
    console.log(`kit ${kit.padEnd(8)} room ${room.toFixed(2)}  onset ms ${JSON.stringify(stats(ok.map((x) => x.onsetMs)))}`);
    console.log('   per note  ' + ok.map((x) => `${x.note}: corr ${x.corr.toFixed(2)} bal ${x.balDb.toFixed(1)}dB tail ${x.tailDb.toFixed(1)}dB`).join(' | '));
    if (res.some((x) => x.silent)) console.log('   silent notes', res.filter((x) => x.silent).map((x) => x.note));
}
