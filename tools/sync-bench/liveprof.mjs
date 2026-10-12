// Profile Matt's REAL Slopsmith app while he plays (needs it started with
//   Slopsmith.exe --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1 --inspect=127.0.0.1:9230).
// Waits until the song clock moves, then records SECS seconds of: renderer CPU profile, frame intervals,
// long tasks, and a main-process (Node) CPU profile. Read-only: only a rAF counter is injected.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { stats } from './common.mjs';
const SECS = +(process.env.SECS || 20), OUT = process.env.OUT || 'liveprof';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9229');
const page = browser.contexts()[0].pages().find((p) => /18000/.test(p.url()));
if (!page) { console.log('no Slopsmith page'); process.exit(1); }
console.log('waiting for playback...');
for (let i = 0; ; i++) {
    const s = await page.evaluate(() => { const a = document.getElementById('audio'); return a ? [a.paused, a.currentTime] : [true, 0]; });
    await new Promise((r) => setTimeout(r, 1000));
    const s2 = await page.evaluate(() => { const a = document.getElementById('audio'); return a ? [a.paused, a.currentTime] : [true, 0]; });
    if (!s2[0] && s2[1] > s[1] + 0.5 && s2[1] > 15) break;
    if (i > 900) { console.log('no playback within 15 min'); process.exit(1); }
}
console.log('playing; capturing ' + SECS + ' s');

// main process (Node) profiler over raw CDP websocket
const list = await (await fetch('http://127.0.0.1:9230/json/list')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let mid = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const mcall = (method, params = {}) => new Promise((r) => { const id = ++mid; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await mcall('Profiler.enable'); await mcall('Profiler.setSamplingInterval', { interval: 500 }); await mcall('Profiler.start');

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
await page.evaluate(() => {
    window.__lp = { fi: [], lt: [] }; let last = 0;
    const f = (t) => { if (last) window.__lp.fi.push(t - last); last = t; if (window.__lp) requestAnimationFrame(f); };
    requestAnimationFrame(f);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lp.lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask' }); } catch (_) { /* no longtask */ }
});
await cdp.send('Profiler.start');
const t0 = Date.now();
await new Promise((r) => setTimeout(r, SECS * 1000));
const { profile } = await cdp.send('Profiler.stop');
const mprof = (await mcall('Profiler.stop')).profile;
const wall = Date.now() - t0;
const info = await page.evaluate(() => {
    const r = { fi: window.__lp.fi, lt: window.__lp.lt, dom: document.getElementsByTagName('*').length,
        viz: (document.getElementById('viz-picker') || {}).value, w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
        canvases: [...document.querySelectorAll('canvas')].filter((c) => c.offsetParent).map((c) => c.width + 'x' + c.height),
        split: !!(window.slopsmithSplitscreen && window.slopsmithSplitscreen.isActive && window.slopsmithSplitscreen.isActive()) };
    window.__lp = null; return r;
});
ws.close();
await browser.close();   // disconnects only; the app keeps running
fs.writeFileSync(OUT + '_renderer.cpuprofile', JSON.stringify(profile));
fs.writeFileSync(OUT + '_main.cpuprofile', JSON.stringify(mprof));

function report(label, prof) {
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (let i = 0; i < prof.samples.length; i++) self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + (prof.timeDeltas[i] || 0) / 1000);
    const fn = new Map(), file = new Map();
    for (const [id, ms] of self) {
        const cf = byId.get(id).callFrame;
        const name = cf.functionName || '(anon)';
        const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') || name;
        file.set(url, (file.get(url) || 0) + ms);
        if (!['(idle)', '(program)', '(garbage collector)'].includes(name)) { const k = name + '  ' + url + ':' + (cf.lineNumber + 1); fn.set(k, (fn.get(k) || 0) + ms); }
    }
    console.log(`\n== ${label}: busy ${((wall - (file.get('(idle)') || 0)) / wall * 100).toFixed(0)}%`);
    for (const [k, v] of [...file].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${(v / wall * 100).toFixed(1).padStart(5)}%  ${k}`);
    console.log('  -- functions (self)');
    for (const [k, v] of [...fn].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`  ${(v / wall * 100).toFixed(1).padStart(5)}%  ${k}`);
}
console.log(`viz ${info.viz} split ${info.split} window ${info.w}x${info.h} dpr ${info.dpr} canvases ${info.canvases.join(' ')} DOM ${info.dom}`);
console.log(`frames ${JSON.stringify(stats(info.fi))} over 20 ms: ${info.fi.filter((x) => x > 20).length}/${info.fi.length}`);
console.log(`long tasks: ${info.lt.length}, total ${info.lt.reduce((s, x) => s + x[1], 0)} ms, worst ${Math.max(0, ...info.lt.map((x) => x[1]))} ms`);
report('renderer', profile);
report('main process', mprof);
