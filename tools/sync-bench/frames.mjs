import { launch, judder, BASE } from './common.mjs';
const { browser, page, errors } = await launch();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const arr = +(process.env.ARR || 2);
await page.evaluate((arr) => window.playSong('sloppak/1979.sloppak', arr), arr);
await page.waitForTimeout(8000);
await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = 40; if (a.paused) a.play(); });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({
  viz: document.getElementById('viz-picker') && document.getElementById('viz-picker').value,
  av: window.highway.getAvOffset(), paused: document.getElementById('audio').paused,
  t: document.getElementById('audio').currentTime, stemsSmooth: !!(window.__hwtStemsSmooth && window.__hwtStemsSmooth()),
}));
console.log('info', JSON.stringify(info));
await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = 40; if (a.paused) a.play(); });
await page.waitForTimeout(2000);
await page.evaluate(() => { window.__frameLog = []; window.__logFrames = true; });
await page.waitForTimeout(8000);
const log = await page.evaluate(() => { window.__logFrames = false; const a = document.getElementById('audio'); a.pause(); return window.__frameLog; });
console.log('frames', log.length, 'hws', [...new Set(log.map(e => e.hw))]);
console.log('raw bundle clock judder', JSON.stringify(judder(log, 'main', 'ct')));
console.log('h3d smoothNow judder', JSON.stringify(judder(log, 'main', 'h3d')));
console.log('drum frame judder', JSON.stringify(judder(log, 'main', 'drum')));
console.log('errors', JSON.stringify(errors.slice(0, 10)));
try { await browser.close(); } catch (_) {}
