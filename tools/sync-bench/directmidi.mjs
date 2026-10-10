// Direct MIDI bridge check (drums native_midi.py): needs the test server started with DRUMS_MIDI_TEST=1 (fake
// input id 999, POST /api/plugins/drums/native-midi/inject). Opens the drum view, lets the plugin auto-connect
// the direct input, injects hits on the server and checks each hit's timestamp lands between the page's
// request and response (the server stamps it in between), then that the drum engine judged them.
import { launch, stats, BASE } from './common.mjs';
const { browser, page, errors } = await launch();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const list = await page.evaluate(() => fetch('/api/plugins/drums/native-midi').then((r) => r.json()));
console.log('native inputs', JSON.stringify(list));
await page.evaluate(() => window.playSong('sloppak/1979.sloppak', 2));
await page.waitForTimeout(9000);
const res = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const status = () => [...document.querySelectorAll('.drums-midi-status')].map((e) => e.textContent).join(' | ');
    const taps = [];
    window.__drumsHitTap = (h) => taps.push(h);
    // The drum hit path only judges while playing; play (muted) for the test.
    const a = document.getElementById('audio');
    a.currentTime = 30; await a.play(); await sleep(1500);
    const out = [];
    for (let i = 0; i < 40; i++) {
        await sleep(80 + Math.random() * 60);
        const before = performance.now();
        await fetch('/api/plugins/drums/native-midi/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 999, data: [0x99, 38, 100] }) });
        const after = performance.now();
        await sleep(30);
        const h = taps[taps.length - 1];
        out.push(h ? { ok: h.ts >= before - 1 && h.ts <= after + 1, posMs: h.ts - before, rtt: after - before, deliveredMs: h.now - h.ts } : { ok: false, missing: true });
    }
    a.pause();
    return { out, taps: taps.length, diag: window.__drumsDebug.diag(), status: status() };
});
const ok = res.out.filter((x) => x.ok).length;
console.log(`hits delivered ${res.taps}/40, timestamp inside the request window: ${ok}/40`);
console.log('timestamp - request start ms', JSON.stringify(stats(res.out.map((x) => x.posMs))), 'request rtt ms', JSON.stringify(stats(res.out.map((x) => x.rtt))));
console.log('delivery delay after the stamped time ms', JSON.stringify(stats(res.out.map((x) => x.deliveredMs))));
console.log('diag', JSON.stringify(res.diag));
console.log('errors', JSON.stringify(errors.filter((e) => !/Desktop audio API|404/.test(e)).slice(0, 5)));
try { await browser.close(); } catch (_) {}
