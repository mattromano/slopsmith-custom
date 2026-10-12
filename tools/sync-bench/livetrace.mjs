// Timeline trace of Matt's real app (port 9229, see liveprof.mjs) for SECS seconds while playing: where the
// renderer main thread's non-JS time goes (style, layout, paint, canvas, GC...), and which elements cause
// style/layout work. Read-only.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SECS = +(process.env.SECS || 5);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9229');
const page = browser.contexts()[0].pages().find((p) => /18000/.test(p.url()));
const playing = await page.evaluate(() => { const a = document.getElementById('audio'); return a && !a.paused; });
console.log('playing:', playing);
const cdp = await page.context().newCDPSession(page);
const events = [];
cdp.on('Tracing.dataCollected', (d) => { for (const e of d.value) events.push(e); });
const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: [
    'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'v8', 'blink.user_timing',
    'disabled-by-default-devtools.timeline.frame', 'toplevel'] } });
await new Promise((r) => setTimeout(r, SECS * 1000));
await cdp.send('Tracing.end');
await done;
await browser.close();
fs.writeFileSync('livetrace.json', JSON.stringify({ traceEvents: events }));

// renderer main thread = the thread with the most RunTask time among threads that ran 'UpdateLayoutTree' or 'Paint'
const threadOf = new Map();
for (const e of events) if (['UpdateLayoutTree', 'Layout', 'Paint', 'FireAnimationFrame'].includes(e.name)) threadOf.set(e.pid + ':' + e.tid, (threadOf.get(e.pid + ':' + e.tid) || 0) + 1);
const main = [...threadOf].sort((a, b) => b[1] - a[1])[0][0];
// self time per event name on that thread (complete events 'X' with dur; nesting -> subtract children)
const evs = events.filter((e) => e.pid + ':' + e.tid === main && e.ph === 'X' && e.dur > 0).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const self = new Map(), stack = [];
for (const e of evs) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
    if (stack.length) { const p = stack[stack.length - 1]; self.set(p.name, (self.get(p.name) || 0) - e.dur); }
    self.set(e.name, (self.get(e.name) || 0) + e.dur);
    stack.push(e);
}
const total = SECS * 1e6;
console.log('renderer main thread, self time by activity:');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
// style recalcs: how many elements per recalc
const ult = evs.filter((e) => e.name === 'UpdateLayoutTree');
const els = ult.map((e) => (e.args && e.args.elementCount) || 0);
console.log(`UpdateLayoutTree: ${ult.length} times, ${(ult.reduce((s, e) => s + e.dur, 0) / 1000).toFixed(0)} ms, elements per recalc median ${els.sort((a, b) => a - b)[els.length >> 1]} max ${Math.max(0, ...els)}`);
const lay = evs.filter((e) => e.name === 'Layout');
console.log(`Layout: ${lay.length} times, ${(lay.reduce((s, e) => s + e.dur, 0) / 1000).toFixed(0)} ms`);
// who invalidated style (stack / reason) - top initiators
const inv = events.filter((e) => /StyleInvalidator|ScheduleStyleRecalculation|StyleRecalcInvalidationTracking|LayoutInvalidationTracking/.test(e.name));
const why = new Map();
for (const e of inv) { const d = e.args && e.args.data; const k = e.name + ' ' + ((d && (d.reason || d.nodeName || d.invalidationList && JSON.stringify(d.invalidationList).slice(0, 60))) || ''); why.set(k, (why.get(k) || 0) + 1); }
console.log('invalidations:');
for (const [k, v] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(v).padStart(5)}  ${k}`);
