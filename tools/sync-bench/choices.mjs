import { launch, BASE } from './common.mjs';
const SONG = process.env.SONG || 'sloppak/1979.sloppak';
const { browser, page } = await launch();
await page.addInitScript(() => {
  localStorage.setItem('splitscreenActive', 'true'); localStorage.setItem('splitscreenLayout', 'top-bottom'); localStorage.setItem('splitscreenPrefsMigrationV', '2');
  const p = (arrName) => ({ arrName, lyrics: false, inverted: false, lefty: false, detectChannel: 'mono', barHidden: false, mastery: 1 });
  localStorage.setItem('splitscreenPanelPrefs', JSON.stringify([p('__viz__:highway_3d:Lead'), p('__viz__:drums:Drums')]));
});
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.evaluate((s) => window.playSong(s, 0), SONG);
await page.waitForTimeout(10000);
const r = await page.evaluate(() => ({
  main: [...document.getElementById('viz-picker').options].map(o => o.value + ' = ' + o.textContent),
  arrSel: [...document.querySelectorAll('#arr-select, select[id*=arrangement]')].map(s => [...s.options].map(o => o.value + ' = ' + o.textContent)),
  panel: [...document.querySelectorAll('#splitscreen-wrap select')].filter(s => [...s.options].some(o => o.value.startsWith('__viz__'))).map(s => ({ selected: s.value, visible: [...s.options].filter(o => !o.hidden).map(o => o.value + ' = ' + o.textContent) })),
}));
console.log(JSON.stringify(r, null, 1));
try { await browser.close(); } catch (_) {}
