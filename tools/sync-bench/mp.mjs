// Multiplayer sync check: two separate muted browsers (host + guest) in one room on the test server, playing
// the same song. Both run on this PC, so their clocks can be compared directly (performance.timeOrigin + now).
// Reports the guest-minus-host difference of the render clock and of the AUDIBLE clock (render - Web Audio
// render-ahead), over time.   SECS=40 SONG=sloppak/1979.sloppak
import { launch, stats, BASE } from './common.mjs';
const SECS = +(process.env.SECS || 40);
const SONG = process.env.SONG || 'sloppak/1979.sloppak';

const host = await launch();
const guest = await launch();
for (const p of [host.page, guest.page]) {
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
}
await host.page.waitForTimeout(2500);
const code = await host.page.evaluate(async () => {
    await showScreen('plugin-multiplayer');
    document.getElementById('mp-create-name').value = 'Host';
    await window.mpCreateRoom();
    await new Promise((r) => setTimeout(r, 1500));
    return sessionStorage.getItem('mp_room');
});
const hostId = await host.page.evaluate(() => sessionStorage.getItem('mp_player'));
console.log('room', code);
await host.page.evaluate(async ({ code, hostId, SONG }) => {
    await fetch(`/api/plugins/multiplayer/rooms/${code}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: SONG, title: 'test', artist: 'test', player_id: hostId, arrangements: [] }) });
    await new Promise((r) => setTimeout(r, 800));
    window.mpLoadSong(0);
}, { code, hostId, SONG });
await guest.page.evaluate(async (code) => {
    await showScreen('plugin-multiplayer');
    document.getElementById('mp-join-name').value = 'Guest';
    document.getElementById('mp-join-code').value = code;
    await window.mpJoinRoom();
}, code);
await host.page.waitForTimeout(12000);
await host.page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = 30; window.mpTogglePlay(); });
const sampler = (secs) => (async (secs) => {
    const out = [];
    const a = document.getElementById('audio');
    const end = performance.now() + secs * 1000;
    while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
        const sy = window.slopsmithMultiplayerDebug && window.slopsmithMultiplayerDebug.getSync ? window.slopsmithMultiplayerDebug.getSync() : {};
        out.push({ abs: performance.timeOrigin + performance.now(), t: a.currentTime, R: window.__hwtRenderAheadMs, p: a.paused, rate: a.playbackRate, lead: sy.seekLeadMs, drift: sy.lastDriftMs, skew: performance.timeOrigin + performance.now() - Date.now() });
    }
    return out;
})(secs);
await host.page.waitForTimeout(1000);
const perturb = +(process.env.PERTURB || 0);
const [hs, gs] = await Promise.all([host.page.evaluate(sampler, SECS), guest.page.evaluate(sampler, SECS),
    perturb ? guest.page.evaluate(async (ms) => { await new Promise((r) => setTimeout(r, 12000)); const a = document.getElementById('audio'); a.currentTime = a.currentTime + ms / 1000; }, perturb) : null]);
await host.page.evaluate(() => window.mpTogglePlay());
// Interpolate the host clock at each guest sample time.
const at = (arr, abs, key) => {
    for (let i = 1; i < arr.length; i++) {
        if (arr[i].abs >= abs) {
            const a = arr[i - 1], b = arr[i];
            if (a.p || b.p) return NaN;
            const f = (abs - a.abs) / (b.abs - a.abs);
            return a[key] + f * (b[key] - a[key]);
        }
    }
    return NaN;
};
const rows = gs.filter((g) => !g.p).map((g) => {
    const ht = at(hs, g.abs, 't'), hR = at(hs, g.abs, 'R');
    return { s: (g.abs - gs[0].abs) / 1000, render: (g.t - ht) * 1000, audible: ((g.t - g.R / 1000) - (ht - hR / 1000)) * 1000, rate: g.rate, gR: g.R, hR };
}).filter((r) => Number.isFinite(r.render));
if (process.env.TL) {
    for (let k = 0; k < rows.length; k += 10) { const r = rows[k]; const g = gs.find((x) => Math.abs((x.abs - gs[0].abs) / 1000 - r.s) < 0.01); console.log('  t', r.s.toFixed(1), 'ext', r.render.toFixed(1), 'self', g && g.drift != null ? g.drift.toFixed(1) : '-', 'rate', r.rate); }
}
const phase = (a, b) => rows.filter((r) => r.s >= a && r.s < b);
console.log('host R', JSON.stringify(stats(hs.map((x) => x.R))), 'guest R', JSON.stringify(stats(gs.map((x) => x.R))));
for (const [a, b] of [[0, 5], [5, 15], [15, SECS]]) {
    const p = phase(a, b);
    console.log(`t ${a}-${b}s  guest-host render ms ${JSON.stringify(stats(p.map((r) => r.render)))}`);
    console.log(`          guest-host audible ms ${JSON.stringify(stats(p.map((r) => r.audible)))}  rate!=1: ${p.filter((r) => r.rate !== 1).length}/${p.length}`);
}
const sk = (arr) => stats(arr.map((x) => x.skew)).p50;
console.log('process clock skew guest-host ms (timeOrigin vs Date.now, median):', (sk(gs) - sk(hs)).toFixed(2));
console.log('guest self-measured drift ms (15 s+)', JSON.stringify(stats(gs.slice(150).map((x) => x.drift))));
console.log('guest seek lead ms (end)', gs[gs.length - 1].lead, 'last self-measured drift', gs[gs.length - 1].drift);
for (const c of [host, guest]) console.log('errors', JSON.stringify(c.errors.filter((e) => !/Desktop audio API|404/.test(e)).slice(0, 4)));
for (const c of [host, guest]) { try { await c.browser.close(); } catch (_) {} }
