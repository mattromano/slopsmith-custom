// Split view: panel 1 Drum Highway (Drums), panel 2 3D highway (Lead). Clock judder per panel, A/V offset per
// panel, and synthetic drum-hit timing error in the drum panel.
import { launch, stats, judder, BASE } from './common.mjs';
const { browser, page, errors } = await launch();
await page.addInitScript(() => {
  localStorage.setItem('splitscreenActive', 'true');
  localStorage.setItem('splitscreenLayout', 'top-bottom');
  localStorage.setItem('splitscreenPrefsMigrationV', '2');
  localStorage.setItem('splitscreenPanelPrefs', JSON.stringify([
    { arrName: '__viz__:drums:Drums', lyrics: false, inverted: false, lefty: false, detectChannel: 'mono', barHidden: false, mastery: 1 },
    { arrName: '__viz__:highway_3d:Lead', lyrics: false, inverted: false, lefty: false, detectChannel: 'mono', barHidden: false, mastery: 1 },
  ]));
});
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const AV = +(process.env.AV || 30);
await page.evaluate((av) => window.setAvOffsetMs ? window.setAvOffsetMs(av, true) : window.highway.setAvOffset(av), AV);
await page.evaluate(() => window.playSong('sloppak/1979.sloppak', 0));
await page.waitForTimeout(10000);
await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = 30; if (a.paused) a.play(); });
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({
  active: window.slopsmithSplitscreen && window.slopsmithSplitscreen.isActive(),
  selects: [...document.querySelectorAll('#splitscreen-wrap select')].map(s => s.value),
  mainAv: window.highway.getAvOffset(),
  route: !!(window.__drumsDebug && window.__drumsDebug.routeTarget()),
}));
console.log('info', JSON.stringify(info));
await page.evaluate(() => { window.__frameLog = []; window.__logFrames = true; });
await page.waitForTimeout(6000);
const log = await page.evaluate(() => { window.__logFrames = false; return window.__frameLog; });
const hws = [...new Set(log.map(e => e.hw))];
console.log('frames', log.length, 'highways drawing', hws);
for (const h of hws) {
  const f = log.filter(e => e.hw === h);
  const offs = f.map(e => (e.ct - e.a) * 1000);
  console.log(h, 'render-audio offset ms', JSON.stringify(stats(offs)));
  console.log(h, ' raw judder', JSON.stringify(judder(log, h, 'ct')));
  if (f.some(e => Number.isFinite(e.h3d))) console.log(h, ' 3D smoothNow judder', JSON.stringify(judder(log, h, 'h3d')), 'offset vs audio', JSON.stringify(stats(f.map(e => (e.h3d - e.a) * 1000))));
  if (f.some(e => Number.isFinite(e.drum))) console.log(h, ' drum frame judder', JSON.stringify(judder(log, h, 'drum')), 'offset vs audio', JSON.stringify(stats(f.map(e => (e.drum - e.a) * 1000))));
}
const res = await page.evaluate(async (n) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const a = document.getElementById('audio');
  let rec = NaN;
  window.__drumsHitTap = (h) => { rec = h.t; };
  const out = [];
  for (let i = 0; i < n; i++) {
    await sleep(60 + Math.random() * 120);
    const strike = performance.now();
    const truth = a.currentTime + window.highway.getAvOffset() / 1000;
    await new Promise(r => setTimeout(r, Math.random() * 25));
    rec = NaN;
    window.__drumsDebug.midi([0x99, 38, 100], strike);
    out.push((rec - truth) * 1000);
  }
  return out;
}, 120);
await page.evaluate(() => document.getElementById('audio').pause());
console.log('split drum hit-time error vs (audio + A/V) ms', JSON.stringify(stats(res)));
console.log('errors', JSON.stringify(errors.filter(e => !/Desktop audio API|404/.test(e)).slice(0, 5)));
try { await browser.close(); } catch (_) {}
