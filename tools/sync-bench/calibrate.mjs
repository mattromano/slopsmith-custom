// End-to-end Sync Lab calibration with a simulated drummer (muted browser, real player, real drum engine).
// The drummer has input latency IN ms and the screen display latency LD ms, plus Gaussian human jitter:
//   listen part: strikes when a click becomes audible (+IN)
//   watch part:  strikes when a gem is seen on the line (+LD +IN)
// Expected from the Sync Lab math (A/V = av, R = Web Audio render-ahead):
//   eye = LD + IN,  ear = R + av + IN,  suggested A/V = LD - R,  suggested drums input offset = LD + IN.
//   MODE=drums | split-gd   AV=<start A/V ms>   IN=20 LD=25 JIT=8
import { launch, stats, BASE } from './common.mjs';
const MODE = process.env.MODE || 'drums';
const AV = +(process.env.AV || 24), IN = +(process.env.IN || 20), LD = +(process.env.LD || 25), JIT = +(process.env.JIT || 8);
const { browser, page, errors } = await launch();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.evaluate((av) => window.setAvOffsetMs(av, true), AV);
await page.evaluate((m) => window.__syncLab.start(m), MODE);
await page.waitForTimeout(9000);
const pre = await page.evaluate(() => ({ calib: !!window.__syncLab.run, plan: window.__syncLab.plan,
    split: !!(window.slopsmithSplitscreen && window.slopsmithSplitscreen.isActive()), route: !!window.__drumsDebug.routeTarget() }));
console.log('start', JSON.stringify({ calib: pre.calib, split: pre.split, route: pre.route }));
const simulate = () => page.evaluate(async ({ IN, LD, JIT }) => {
    const plan = window.__syncLab.plan;
    const a = document.getElementById('audio');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    a.currentTime = 0;
    await a.play();
    await sleep(1500);
    const notes = [];
    for (const [sec, [s, e]] of Object.entries(plan.sections)) for (let t = s; t < e - 1e-6; t += plan.beat) notes.push({ sec, t: Math.round(t * 1e4) / 1e4 });
    const out = { strikes: 0, aheadMs: [] };
    for (const n of notes) {
        // Target on the stems clock (render-ahead clock): audible at clock = n + R, seen at clock + av = n + LD.
        const R = window.__hwtRenderAheadMs / 1000, av = window.highway.getAvOffset() / 1000;
        out.aheadMs.push(window.__hwtRenderAheadMs);
        const target = (n.sec === 'listen' ? n.t + R + IN / 1000 : n.t - av + (LD + IN) / 1000) + gauss() * JIT / 1000;
        const waitMs = (target - a.currentTime) * 1000;
        if (waitMs < -100) continue;
        const strikeWall = performance.now() + waitMs;
        await sleep(Math.max(0, waitMs) + Math.random() * 8);   // delivered 0-8 ms late, stamped at the strike
        window.__drumsDebug.midi([0x99, 38, 100], strikeWall);
        out.strikes++;
        // Split view: a simulated guitarist in panel 1 (Note Detection judgments, input latency IN + 15 ms).
        const wrap = document.getElementById('splitscreen-wrap');
        if (wrap && wrap.children.length) {
            const lat = (JSON.parse(localStorage.getItem('slopsmith_notedetect') || '{}').latencyOffset ?? 0.08) * 1000;
            const gIn = IN + 15;
            const raw = (n.sec === 'listen' ? R * 1000 + av * 1000 + gIn : LD + gIn) + gauss() * JIT;
            window.dispatchEvent(new CustomEvent('hwt:judgment', { detail: {
                j: { noteTime: n.t, timingError: raw - lat, hit: true }, latencyMs: lat, container: wrap.children[0] } }));
        }
    }
    await sleep(1500);
    out.result = window.__syncLab.analyse();
    out.card = !!document.querySelector('div[style*="9600"]');
    a.pause();
    return out;
}, { IN, LD, JIT });
function report(res) {
    const R = stats(res.aheadMs);
    console.log('strikes', res.strikes, 'card shown', res.card, 'render-ahead R', JSON.stringify(R));
    const r = res.result;
    console.log('A/V', r.av, '-> suggested', r.avNew, '| expected LD - R =', Math.round(LD - R.p50));
    for (const row of r.rows) {
        const off = row.current || 0;
        console.log(row.label, 'n', row.n, 'ear', row.ear && row.ear.toFixed(1), '(exp', (R.p50 + r.av + IN).toFixed(1) + ')', 'eye', row.eye && row.eye.toFixed(1), '(exp', LD + IN + ')',
            '| play-section error with current offset', (row.both - off).toFixed(1), '| input ->', row.input, 'spread', row.spread && row.spread.toFixed(1));
    }
}
const res = await simulate();
report(res);
// Apply all (the card's button), then play it again: ear, eye and play should all centre on the new offsets.
await page.evaluate(() => { const b = document.querySelector('button[data-act=all]'); if (b) b.click(); });
console.log('--- after Apply all: A/V', await page.evaluate(() => window.highway.getAvOffset()), 'drums offset', await page.evaluate(() => window.__drumsGetConfig().inputOffsetMs));
await page.evaluate(() => { const b = document.querySelector('button[data-act=close]'); if (b) b.click(); });
report(await simulate());
console.log('errors', JSON.stringify(errors.filter((e) => !/Desktop audio API|404/.test(e)).slice(0, 5)));
try { await browser.close(); } catch (_) {}
