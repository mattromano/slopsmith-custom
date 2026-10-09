// End-to-end check of the drums renderer inside tools/app.html (real screen.js + routes.py, fake player).
//
//   python plugins/drums/tools/dev_server.py 8766           # repository root, separate shell
//   node plugins/drums/tools/app-check.mjs [baseUrl] [outDir]
//
// Plays the synthetic chart perfectly through the fake MIDI domain into the 3D view, checks the engine
// state (hits, star power from the fetched drums block), a keyboard hit, the settings panel, a View switch
// to 2D and back, and a same-canvas re-init. Exits non-zero on failure. outDir gets screenshots.
// Playwright: see screenshot.mjs (PLAYWRIGHT_DIR, `playwright` on the module path, or slopsmith's dev deps).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
async function loadChromium() {
    if (process.env.PLAYWRIGHT_DIR) return createRequire(path.join(process.env.PLAYWRIGHT_DIR, 'x.js'))('.').chromium;
    try { return (await import('playwright')).chromium; } catch (_) { /* fall through */ }
    return createRequire(path.join(here, '..', '..', '..', 'slopsmith', 'package.json'))('@playwright/test').chromium;
}

const [, , base = 'http://127.0.0.1:8766', outDir = os.tmpdir()] = process.argv;
const chromium = await loadChromium();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
    await page.goto(`${base}/plugins/drums/tools/app.html?view=auto&paused=1`);
    await page.waitForFunction(() => document.title === 'ready', null, { timeout: 30000 });
    let info = await page.evaluate(() => ({
        ctx: window.__harness.renderer.contextType,
        hud: document.querySelectorAll('canvas.drums3d-hud').length,
        gear: !!document.querySelector('.btn-drums-settings'),
        listeners: window.__midiListeners(),
    }));
    assert.deepEqual(info, { ctx: 'webgl2', hud: 1, gear: true, listeners: 1 }, 'Auto picks the 3D view with WebGL2');

    await page.evaluate(() => window.__harness.frame());
    await page.waitForTimeout(150);
    info = await page.evaluate(() => ({ meta: window.__metaRequests, st: window.__harness.renderer._engineState() }));
    assert.deepEqual(info.meta, ['/api/sloppak/Preview.sloppak/file/arrangements/drums.json']);
    assert.equal(info.st.starPower.phrasesTotal, 4, 'star power phrases from drums.json');

    await page.evaluate(() => window.__harness.play(2 + 15 * 2 + 0.55, 0.7));
    info = await page.evaluate(() => window.__harness.renderer._engineState());
    console.log(`perfect MIDI play: ${info.notesHit} hit, ${info.notesMissed} missed, x${info.multiplier}, star power ${info.starPower.amount}`);
    assert.equal(info.notesMissed, 0);
    assert.equal(info.overhits, 0);
    assert.ok(info.notesHit > 200);
    assert.equal(info.multiplier, 4);
    assert.equal(info.starPower.canActivate, true);
    await page.screenshot({ path: path.join(outDir, 'app-3d.png') });

    await page.evaluate(() => window.__harness.resume());
    await page.keyboard.press('KeyF');
    await page.waitForTimeout(50);
    info = await page.evaluate(() => window.__harness.renderer._engineState());
    assert.equal(info.overhits, 1, 'keyboard F lands in the engine');

    await page.click('.btn-drums-settings');
    await page.waitForTimeout(100);
    assert.equal(await page.textContent('.drums-view-note'), '3D view active');
    await page.selectOption('.drums-view-select', '2d');
    await page.waitForTimeout(400);
    info = await page.evaluate(() => ({ ctx: window.__harness.renderer.contextType, hud: document.querySelectorAll('canvas.drums3d-hud').length }));
    assert.deepEqual(info, { ctx: '2d', hud: 0 }, 'View=2D installs the 2D renderer and removes the HUD');
    await page.screenshot({ path: path.join(outDir, 'app-2d.png') });

    await page.evaluate(() => window.__harness.useView('3d'));
    info = await page.evaluate(async () => {
        const h = window.__harness;
        h.pause();
        await window.highway.setRenderer(window.slopsmithViz_drums3d());   // same canvas, new instance
        const r = h.renderer;
        r.destroy(); r.init(document.getElementById('highway'), {}); await r.readyPromise;   // same instance again
        h.setTime(6); h.frame(); await new Promise((res) => setTimeout(res, 100)); h.setTime(6.1); h.frame();
        const st = r._engineState();
        return { ctx: r.contextType, hud: document.querySelectorAll('canvas.drums3d-hud').length, fromSix: st.totalNotes < 331 && st.notesMissed <= 2 };
    });
    assert.deepEqual(info, { ctx: 'webgl2', hud: 1, fromSix: true }, 're-init on the same canvas scores from the current time');
    assert.deepEqual(errors, []);
    console.log('app-check: ok');
} finally {
    await browser.close();
}
