// Auto kick check (muted browser): plays a song with Auto kick on, records what the drums plugin's auto notes
// put out and what the song's drum stem puts out (all other stems muted), maps both to the moment they are
// HEARD (AudioContext.getOutputTimestamp, so each context's own output latency counts), and reports:
//   per auto kick: heard time - heard time of the matching chart note in the stem (want ~0, tiny spread)
//   doubles: two auto onsets for one chart kick; misses: chart kicks with no auto onset
// Writes autokick_auto.wav / autokick_stem.wav (mono, 30 s) next to this script for listening / analysis.
//   SONG=sloppak/1979.sloppak ARR=2 FROM=60 SECS=30 KIT=crocell
import { launch, stats, BASE } from './common.mjs';
import fs from 'node:fs';
const SONG = process.env.SONG || 'sloppak/1979.sloppak', ARR = +(process.env.ARR || 2);
const FROM = +(process.env.FROM || 60), SECS = +(process.env.SECS || 30);
const KIT = process.env.KIT || 'crocell';

const { browser, page, errors } = await launch();
await page.addInitScript(({ KIT }) => {
    localStorage.setItem('drums_kit_v1', KIT);
    localStorage.setItem('drums_difficulty_v1', 'expert');
    localStorage.setItem('drums_auto_kick_v1', 'all');
    localStorage.setItem('drums_auto_cymbals_v1', 'off');
    localStorage.setItem('drums_auto_volume_v1', '1');
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
                tap = { ctx, sp, frames: [], rec: false, ts: [] };
                sp.onaudioprocess = (e) => {
                    if (!tap.rec) return;
                    const l = e.inputBuffer.getChannelData(0), rr = e.inputBuffer.getChannelData(1);
                    const m = new Float32Array(l.length);
                    for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + rr[i]);
                    tap.frames.push({ t: e.playbackTime, m });
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
}, { KIT });
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.evaluate(({ SONG, ARR }) => window.playSong(SONG, ARR), { SONG, ARR });
await page.waitForTimeout(9000);
const res = await page.evaluate(async ({ FROM, SECS }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const id of ['guitar', 'bass', 'vocals', 'piano', 'other']) try { window.stems.setMuted(id, true); } catch (_) {}
    window.__drumsDebug.midi([0x99, 38, 1]);   // wake the drum synth
    await sleep(3000);
    const a = document.getElementById('audio');
    a.currentTime = FROM;
    await sleep(500);
    const dctx = window.__drumsDebug.audioCtx();
    const dtap = window.__tapCtxs.find((t) => t.ctx === dctx);
    if (!dtap) return { err: 'no drum tap', n: window.__tapCtxs.length };
    for (const t of window.__tapCtxs) { t.frames = []; t.ts = []; t.rec = true; }
    let stap = null;
    // heard-time map per context + song clock samples
    const clock = [];
    const tick = setInterval(() => {
        for (const t of window.__tapCtxs) { const o = t.ctx.getOutputTimestamp(); if (o && o.performanceTime) t.ts.push([o.contextTime, o.performanceTime]); }
        clock.push([performance.now(), a.currentTime]);
    }, 50);
    if (a.paused) await a.play();
    await sleep(SECS * 1000);
    clearInterval(tick);
    a.pause();
    for (const t of window.__tapCtxs) t.rec = false;
    // the stems context: the non-drum tap with the most signal
    const energy = (t) => t.frames.reduce((s, f) => { for (let i = 0; i < f.m.length; i += 8) s += f.m[i] * f.m[i]; return s; }, 0);
    for (const t of window.__tapCtxs) if (t !== dtap && t.frames.length && (!stap || energy(t) > energy(stap))) stap = t;
    if (!stap || !dtap.frames.length) return { err: 'no frames', taps: window.__tapCtxs.map((t) => [t.ctx.state, t.frames.length, energy(t)]) };
    const pack = (t) => {
        const sr = t.ctx.sampleRate;
        const n = t.frames.reduce((s, f) => s + f.m.length, 0);
        const m = new Float32Array(n); let o = 0;
        for (const f of t.frames) { m.set(f.m, o); o += f.m.length; }
        // ctx -> heard (performance.now ms): median offset of performanceTime - contextTime*1000
        const offs = t.ts.map(([c, p]) => p - c * 1000).sort((x, y) => x - y);
        return { sr, t0: t.frames[0].t, data: Array.from(m), heardOff: offs[offs.length >> 1], offSpread: offs[offs.length - 1] - offs[0],
            outLat: t.ctx.outputLatency, baseLat: t.ctx.baseLatency };
    };
    return { d: pack(dtap), s: pack(stap), clock };
}, { FROM, SECS });
try { await browser.close(); } catch (_) {}
if (res.err) { console.log(res); process.exit(1); }

// Onsets: half-wave rectified energy rise on a short envelope, low-passed for kick.
function onsets(x, sr, { lp = 150, thrDb = -40, minGap = 0.06 } = {}) {
    const a = Math.exp(-2 * Math.PI * lp / sr);
    let y = 0; const env = new Float32Array(x.length);
    let e = 0; const ae = Math.exp(-1 / (0.004 * sr));
    for (let i = 0; i < x.length; i++) { y = a * y + (1 - a) * x[i]; e = Math.max(Math.abs(y), e * ae); env[i] = e; }
    const out = []; const thr = 10 ** (thrDb / 20); const lag = Math.floor(0.01 * sr);
    let last = -1e9;
    for (let i = lag; i < x.length; i++) {
        if (env[i] > thr && env[i] > 2.0 * env[i - lag] && (i - last) / sr > minGap) {
            // refine: first sample reaching 30 % of the local max over the next 20 ms
            let pk = 0; for (let j = i; j < Math.min(x.length, i + 0.02 * sr); j++) pk = Math.max(pk, env[j]);
            let k = i - lag; while (k < i && env[k] < 0.3 * pk) k++;
            out.push({ i: k, amp: pk }); last = i;
        }
    }
    return out;
}
const heard = (r, i) => r.heardOff + (r.t0 + i / r.sr) * 1000;   // ms, performance.now timebase
const dOn = onsets(res.d.data, res.d.sr, { thrDb: -45 }).map((o) => ({ ...o, h: heard(res.d, o.i) }));
const sOn = onsets(res.s.data, res.s.sr, { thrDb: -35 }).map((o) => ({ ...o, h: heard(res.s, o.i) }));
console.log(`drum ctx: outputLatency ${(res.d.outLat * 1000).toFixed(1)} ms base ${(res.d.baseLat * 1000).toFixed(1)}  heard-map spread ${res.d.offSpread.toFixed(1)} ms`);
console.log(`stem ctx: outputLatency ${(res.s.outLat * 1000).toFixed(1)} ms base ${(res.s.baseLat * 1000).toFixed(1)}  heard-map spread ${res.s.offSpread.toFixed(1)} ms`);
console.log(`auto onsets ${dOn.length}, stem low-band onsets ${sOn.length}`);
// match each auto onset to the nearest stem kick onset
const diffs = [];
for (const o of dOn) {
    let best = null;
    for (const s of sOn) if (!best || Math.abs(s.h - o.h) < Math.abs(best.h - o.h)) best = s;
    if (best && Math.abs(best.h - o.h) < 60) diffs.push(o.h - best.h);
}
console.log('auto heard - stem kick heard (ms):', JSON.stringify(stats(diffs)));
const gaps = []; for (let i = 1; i < dOn.length; i++) gaps.push(dOn[i].h - dOn[i - 1].h);
console.log('auto onset gaps < 40 ms (doubles):', gaps.filter((g) => g < 40).length);
console.log('auto amp dB:', JSON.stringify(stats(dOn.map((o) => 20 * Math.log10(o.amp)))));
// WAVs
function wav(file, data, sr) {
    const n = Math.min(data.length, sr * 30);
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), 44 + i * 2);
    fs.writeFileSync(file, b);
}
wav('autokick_auto.wav', res.d.data, res.d.sr);
wav('autokick_stem.wav', res.s.data, res.s.sr);
fs.writeFileSync('autokick_onsets.json', JSON.stringify({ d: dOn.map((o) => [o.h, o.amp]), s: sOn.map((o) => [o.h, o.amp]), dT0: res.d.t0, sT0: res.s.t0, dOff: res.d.heardOff, sOff: res.s.heardOff, clock: res.clock }));
console.log('errors', JSON.stringify(errors.slice(0, 5)));
