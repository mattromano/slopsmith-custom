// Where does the renderer's time go while a song plays? (muted browser) CDP CPU profile of SECS seconds of
// playback + frame-interval stats + the busiest functions by self time, grouped by script.
//   BASE=http://127.0.0.1:8002 SONG=sloppak/x.sloppak ARR=0 SECS=10 VIEW=  (VIEW = viz picker value, optional)
import { launch, stats, BASE } from './common.mjs';
const SONG = process.env.SONG || 'sloppak/1979.sloppak', ARR = +(process.env.ARR || 0), SECS = +(process.env.SECS || 10);
const { browser, page, errors } = await launch();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const dom0 = await page.evaluate(() => document.getElementsByTagName('*').length);
await page.evaluate(({ SONG, ARR }) => window.playSong(SONG, ARR), { SONG, ARR });
await page.waitForTimeout(8000);
if (process.env.VIEW) await page.evaluate((v) => { const s = document.getElementById('viz-picker'); if (s) { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); } }, process.env.VIEW);
await page.evaluate(() => { const a = document.getElementById('audio'); if (a.paused) a.play(); });
await page.waitForTimeout(4000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await page.evaluate(() => { window.__fi = []; let last = 0; const f = (t) => { if (last) window.__fi.push(t - last); last = t; window.__fiRaf = requestAnimationFrame(f); }; requestAnimationFrame(f); });
await cdp.send('Profiler.start');
const t0 = Date.now();
await page.waitForTimeout(SECS * 1000);
const { profile } = await cdp.send('Profiler.stop');
const wall = Date.now() - t0;
const info = await page.evaluate(() => ({ fi: window.__fi, dom: document.getElementsByTagName('*').length, viz: (document.getElementById('viz-picker') || {}).value,
    t: document.getElementById('audio').currentTime, paused: document.getElementById('audio').paused }));
try { await browser.close(); } catch (_) {}

// self time per node
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + (dts[i] || 0) / 1000);
const total = [...self.values()].reduce((a, b) => a + b, 0);
const fn = new Map(), file = new Map();
for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame;
    const name = cf.functionName || '(anon)';
    const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') || name;
    if (['(idle)', '(program)'].includes(name)) { file.set(name, (file.get(name) || 0) + ms); continue; }
    const key = name + '  ' + url + ':' + (cf.lineNumber + 1);
    fn.set(key, (fn.get(key) || 0) + ms);
    file.set(url, (file.get(url) || 0) + ms);
}
const busy = total - (file.get('(idle)') || 0);
console.log(`song ${SONG} arr ${ARR} viz ${info.viz}  playing ${!info.paused} t=${info.t.toFixed(1)}  DOM ${dom0} -> ${info.dom} elements`);
console.log(`frames: ${JSON.stringify(stats(info.fi))}  over 20 ms: ${info.fi.filter((x) => x > 20).length}/${info.fi.length}`);
console.log(`main thread busy ${(busy / wall * 100).toFixed(0)}% of ${wall} ms (gc/program ${(((file.get('(garbage collector)') || 0) + (file.get('(program)') || 0)) / wall * 100).toFixed(0)}%)`);
console.log('by script:');
for (const [k, v] of [...file].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(v / wall * 100).toFixed(1).padStart(5)}%  ${k}`);
console.log('by function (self):');
for (const [k, v] of [...fn].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(v / wall * 100).toFixed(1).padStart(5)}%  ${k}`);
console.log('errors', JSON.stringify(errors.filter((e) => !/audio-engine|404/.test(e)).slice(0, 5)));
