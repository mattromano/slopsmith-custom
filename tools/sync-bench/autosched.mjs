// Auto-note scheduling check (muted browser): plays a song with Auto kick (and optionally cymbals) on and logs
// every drum-context source start. For each one: the song time it lands on (song clock at the call + the
// scheduled lead) and the HEARD offset against the same moment in the stems (each context's getOutputTimestamp,
// so a difference in output latency between the two contexts shows up). Compared with the chart notes.
//   SONG=sloppak/1979.sloppak ARR=2 FROM=60 SECS=30 CHART=<path to arrangements/drums.json> CYM=0
import { launch, stats, BASE } from './common.mjs';
import fs from 'node:fs';
const SONG = process.env.SONG || 'sloppak/1979.sloppak', ARR = +(process.env.ARR || 2);
const FROM = +(process.env.FROM || 60), SECS = +(process.env.SECS || 30);
const CYM = process.env.CYM === '1';
const chart = JSON.parse(fs.readFileSync(process.env.CHART, 'utf8'));
const want = new Set(CYM ? [35, 36, 42, 46, 49, 51, 52, 53, 55, 57, 59] : [35, 36]);
const chartT = [...new Set(chart.notes.filter((n) => want.has(n.s * 24 + n.f)).map((n) => n.t))].sort((a, b) => a - b);

const { browser, page } = await launch();
await page.addInitScript(({ CYM }) => {
    localStorage.setItem('drums_difficulty_v1', 'expert');
    localStorage.setItem('drums_auto_kick_v1', 'all');
    localStorage.setItem('drums_auto_cymbals_v1', CYM ? 'all' : 'off');
    localStorage.setItem('drums_auto_volume_v1', '1');
    window.__starts = [];
    window.__logStarts = false;
    const st = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, ...rest) {
        try {
            const d = window.__drumsDebug && window.__drumsDebug.audioCtx();
            if (window.__logStarts && d && this.context === d) {
                const a = document.getElementById('audio');
                const s = window.__stemsCtx;
                window.__starts.push({ when: when || 0, dNow: d.currentTime, sNow: s ? s.currentTime : NaN, song: a.currentTime, wall: performance.now() });
            }
        } catch (_) { /* ignore */ }
        return st.call(this, when, ...rest);
    };
    // find the stems context: the one whose sources are started with the song
    const oc = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dst, ...rest) {
        try {
            const d = window.__drumsDebug && window.__drumsDebug.audioCtx();
            if (dst instanceof AudioDestinationNode && dst.context !== d && this instanceof GainNode) window.__stemsCands = (window.__stemsCands || new Set()).add(dst.context);
        } catch (_) { /* ignore */ }
        return oc.call(this, dst, ...rest);
    };
}, { CYM });
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.evaluate(({ SONG, ARR }) => window.playSong(SONG, ARR), { SONG, ARR });
await page.waitForTimeout(9000);
const res = await page.evaluate(async ({ FROM, SECS }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__drumsDebug.midi([0x99, 38, 1]);
    await sleep(3000);
    const d = window.__drumsDebug.audioCtx();
    const cands = [...(window.__stemsCands || [])].filter((c) => c !== d && c.state === 'running');
    window.__stemsCtx = cands.sort((x, y) => y.currentTime - x.currentTime)[0];
    const a = document.getElementById('audio');
    a.currentTime = FROM;
    await sleep(400);
    const ts = { d: [], s: [] };
    const tick = setInterval(() => {
        const o1 = d.getOutputTimestamp(), o2 = window.__stemsCtx.getOutputTimestamp();
        ts.d.push(o1.performanceTime - o1.contextTime * 1000); ts.s.push(o2.performanceTime - o2.contextTime * 1000);
    }, 50);
    window.__logStarts = true;
    if (a.paused) await a.play();
    await sleep(SECS * 1000);
    window.__logStarts = false;
    clearInterval(tick);
    a.pause();
    const med = (x) => x.slice().sort((p, q) => p - q)[x.length >> 1];
    return { starts: window.__starts, dOff: med(ts.d), sOff: med(ts.s), dLat: d.outputLatency, sLat: window.__stemsCtx.outputLatency, nC: cands.length,
        rate: window.__stemsCtx ? 1 : NaN };
}, { FROM, SECS });
try { await browser.close(); } catch (_) {}
console.log(`starts ${res.starts.length}  stems ctx candidates ${res.nC}  outputLatency drum ${(res.dLat * 1000).toFixed(1)} stems ${(res.sLat * 1000).toFixed(1)}`);
const near = (t) => { let lo = 0, hi = chartT.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (chartT[m] < t) lo = m; else hi = m; } return Math.abs(chartT[lo] - t) < Math.abs(chartT[hi] - t) ? chartT[lo] : chartT[hi]; };
const songErr = [], heardErr = [], lead = [], late = [];
for (const s of res.starts) {
    const tSong = s.song + (Math.max(s.when, s.dNow) - s.dNow);        // song time the note lands on (rate 1)
    const n = near(tSong);
    songErr.push((tSong - n) * 1000);
    // heard: drum when -> perf ms; stem note n -> stems ctx time -> perf ms
    const hd = res.dOff + Math.max(s.when, s.dNow) * 1000;
    const hs = res.sOff + (s.sNow + (n - s.song)) * 1000;
    heardErr.push(hd - hs);
    lead.push((s.when - s.dNow) * 1000);
    if (s.when < s.dNow) late.push((s.dNow - s.when) * 1000);
}
console.log('landed song time - chart note (ms):', JSON.stringify(stats(songErr)));
console.log('HEARD drum - stem for that note (ms):', JSON.stringify(stats(heardErr)));
console.log('schedule lead (ms):', JSON.stringify(stats(lead)), ' scheduled in the past:', late.length);
const inWin = chartT.filter((t) => t > FROM + 0.2 && t < FROM + SECS - 0.5).length;
console.log(`chart notes in window ~${inWin}, starts ${res.starts.length}`);
const counts = new Map(); for (const s of res.starts) { const n = near(s.song + Math.max(0, s.when - s.dNow)); counts.set(n, (counts.get(n) || 0) + 1); }
console.log('notes started more than once:', [...counts.values()].filter((c) => c > 1).length);
