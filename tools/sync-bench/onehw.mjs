import { launch, BASE } from './common.mjs';
// 1) split panel saved as "Drums (3D Highway)" -> becomes the drum highway
{
  const { browser, page } = await launch();
  await page.addInitScript(() => {
    localStorage.setItem('splitscreenActive', 'true'); localStorage.setItem('splitscreenLayout', 'top-bottom'); localStorage.setItem('splitscreenPrefsMigrationV', '2');
    const p = (arrName) => ({ arrName, lyrics: false, inverted: false, lefty: false, detectChannel: 'mono', barHidden: false, mastery: 1 });
    localStorage.setItem('splitscreenPanelPrefs', JSON.stringify([p('__viz__:highway_3d:Lead'), p('__viz__:highway_3d:Drums')]));
  });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(2500);
  await page.evaluate(() => window.playSong('sloppak/1979.sloppak', 0)); await page.waitForTimeout(12000);
  await page.evaluate(() => { document.getElementById('audio').currentTime = 60; }); await page.waitForTimeout(1500);
  console.log('split', JSON.stringify(await page.evaluate(() => ({ panels: [...document.querySelectorAll('#splitscreen-wrap select')].filter(s => [...s.options].some(o => o.value.startsWith('__viz__'))).map(s => s.value + ' / ' + s.selectedOptions[0].textContent), hud: document.querySelectorAll('.drums3d-hud').length, results: (window.__drumsPanelResults() || []).map(r => r.state.totalNotes) }))));
  await page.screenshot({ path: 'onehw_split.png' });
  try { await browser.close(); } catch (_) {}
}
// 2) single player, main picker on Piano, Drums arrangement -> drum highway
{
  const { browser, page } = await launch();
  await page.addInitScript(() => { localStorage.setItem('splitscreenActive', 'false'); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(2500);
  await page.evaluate(() => { const vp = document.getElementById('viz-picker'); vp.value = 'piano'; vp.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => window.playSong('sloppak/1979.sloppak', 2)); await page.waitForTimeout(10000);
  await page.evaluate(() => { document.getElementById('audio').currentTime = 60; }); await page.waitForTimeout(1500);
  console.log('single', JSON.stringify(await page.evaluate(() => ({ picker: document.getElementById('viz-picker').value, hud: [...document.querySelectorAll('.drums3d-hud')].filter(c => c.offsetParent).length, results: (window.__drumsPanelResults() || []).map(r => r.state.totalNotes) }))));
  await page.screenshot({ path: 'onehw_single.png' });
  try { await browser.close(); } catch (_) {}
}
