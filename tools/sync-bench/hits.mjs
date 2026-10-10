// Synthetic MIDI hits with known strike times -> error of the song time the drums plugin assigns.
import { launch, stats, BASE } from './common.mjs';
const { browser, page, errors } = await launch();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.evaluate(() => window.playSong('sloppak/1979.sloppak', 2));
await page.waitForTimeout(8000);
const av = +(process.env.AV || 0);
await page.evaluate((av) => { if (window.setAvOffsetMs) window.setAvOffsetMs(av, true); else window.highway.setAvOffset(av); }, av);
await page.evaluate(() => { const a = document.getElementById('audio'); a.currentTime = 30; if (a.paused) a.play(); });
await page.waitForTimeout(2000);
const res = await page.evaluate(async ({ n, load }) => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const a = document.getElementById('audio');
  let rec = NaN;
  window.__drumsHitTap = (h) => { rec = h.t; };
  let stop = false;
  if (load) (function burn() { if (stop) return; const e = performance.now() + load; while (performance.now() < e); requestAnimationFrame(burn); })();
  const out = [];
  for (let i = 0; i < n; i++) {
    await sleep(60 + Math.random() * 120);
    const strike = performance.now();
    const truth = a.currentTime + window.highway.getAvOffset() / 1000;
    const d = Math.random() * 25;
    await new Promise(r => setTimeout(r, d));
    rec = NaN;
    window.__drumsDebug.midi([0x99, 38, 100], strike);
    out.push({ err: (rec - truth) * 1000, late: performance.now() - strike, errNoTs: NaN });
  }
  stop = true;
  return out;
}, { n: +(process.env.N || 150), load: +(process.env.LOAD || 0) });
await page.evaluate(() => document.getElementById('audio').pause());
console.log('AV', av, 'load', process.env.LOAD || 0);
console.log('delivery delay ms', JSON.stringify(stats(res.map(r => r.late))));
console.log('hit-time error ms', JSON.stringify(stats(res.map(r => r.err))));
console.log('errors', JSON.stringify(errors.filter(e => !/Desktop audio API|404/.test(e)).slice(0, 5)));
try { await browser.close(); } catch (_) {}
