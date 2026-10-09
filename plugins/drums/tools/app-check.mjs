// End-to-end check of the drums renderer inside tools/app.html (real screen.js + routes.py, fake player).
//
//   python plugins/drums/tools/dev_server.py 8766           # repository root, separate shell
//   node plugins/drums/tools/app-check.mjs [baseUrl] [outDir]
//
// Plays the synthetic chart perfectly through the fake MIDI domain into the 3D view, checks the engine
// state (hits, star power from the fetched drums block), a keyboard hit, difficulty switches mid-song (HUD
// badge menu, D / Shift+D, settings selector; perfect play on the Hard level), the settings panel, a View
// switch to 2D (level notes in the 2D view) and back, a same-canvas re-init, and the Expert fallback for a
// drums block without levels. Exits non-zero on failure. outDir gets screenshots.
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
    await page.evaluate(() => window.__harness.frame());
    info = await page.evaluate(() => ({ meta: window.__metaRequests, st: window.__harness.renderer._engineState(),
        diff: window.__harness.renderer._difficulty(), count: window.__harness.renderer._chartNoteCount(),
        expert: window.__chart.notes.filter(n => n.s * 24 + n.f !== 35).length,
        badge: (() => { const b = document.querySelector('.drums-diff-badge'); return b && { d: b.dataset.difficulty, shown: b.style.display !== 'none' }; })() }));
    assert.deepEqual(info.meta, ['/api/sloppak/Preview.sloppak/file/arrangements/drums.json']);
    assert.equal(info.st.starPower.phrasesTotal, 4, 'star power phrases from drums.json');
    // default difficulty: Expert (2x kick dropped), every level available, Easy/Medium auto-generated
    assert.deepEqual([info.diff.id, info.diff.fallback], ['expert', false]);
    assert.equal(info.count, info.expert, 'Expert = the wire notes without 2x kick');
    assert.equal(info.st.totalNotes, info.expert);
    assert.deepEqual(info.diff.options.map(o => o.available), [true, true, true, true, true]);
    assert.deepEqual(info.diff.options.filter(o => o.generated).map(o => o.id), ['easy', 'medium']);
    assert.deepEqual(info.badge, { d: 'expert', shown: true }, 'clickable HUD badge');

    await page.evaluate(() => window.__harness.playDifficulty('expert'));
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

    // Mid-song difficulty switch from the HUD badge menu: the engine rebuilds from the current time with
    // the Hard level, and a perfect Hard player gets no misses / overhits.
    await page.evaluate(() => { window.__harness.pause(); window.__harness.frame(); });
    await page.click('.drums-diff-badge');
    await page.waitForTimeout(50);
    info = await page.evaluate(() => Array.from(document.querySelectorAll('.drums-diff-menu .drums-diff-option'))
        .map(b => [b.dataset.diff, b.disabled, b.getAttribute('aria-checked')]));
    assert.deepEqual(info, [['easy', false, 'false'], ['medium', false, 'false'], ['hard', false, 'false'],
        ['expert', false, 'true'], ['expert_plus', false, 'false']], 'badge opens the difficulty menu');
    await page.screenshot({ path: path.join(outDir, 'app-3d-menu.png') });
    await page.click('.drums-diff-option[data-diff="hard"]');
    info = await page.evaluate(() => {
        const h = window.__harness;
        h.frame();
        const t = h.time;
        return { t, st: h.renderer._engineState(), diff: h.renderer._difficulty().id, pref: localStorage.getItem('drums_difficulty_v1'),
            rest: window.__chart.levels.hard.filter(e => e[0] >= t - 0.001).length,
            menu: document.querySelector('.drums-diff-menu').style.display };
    });
    assert.deepEqual([info.diff, info.pref, info.menu], ['hard', 'hard', 'none']);
    assert.equal(info.st.totalNotes, info.rest, 'Hard chart from the current position');
    assert.deepEqual([info.st.notesHit, info.st.notesMissed, info.st.overhits], [0, 0, 0]);
    const t0 = info.t;
    await page.evaluate(() => window.__harness.playDifficulty('hard'));
    await page.evaluate((T) => window.__harness.play(T, 0.5), t0 + 6);
    info = await page.evaluate(() => window.__harness.renderer._engineState());
    console.log(`Hard after a mid-song switch: ${info.notesHit} hit, ${info.notesMissed} missed, ${info.overhits} overhits`);
    assert.ok(info.notesHit > 20);
    assert.deepEqual([info.notesMissed, info.overhits], [0, 0]);
    // D / Shift+D cycle through the difficulties (harder / easier)
    await page.keyboard.press('KeyD');
    info = await page.evaluate(() => { window.__harness.frame(); return [window.__harness.renderer._difficulty().id, localStorage.getItem('drums_difficulty_v1')]; });
    assert.deepEqual(info, ['expert', 'expert'], 'D = harder');
    await page.keyboard.press('KeyD');
    await page.keyboard.press('Shift+KeyD');
    await page.keyboard.press('Shift+KeyD');
    info = await page.evaluate(() => { window.__harness.frame(); return window.__harness.renderer._difficulty().id; });
    assert.equal(info, 'hard', 'Shift+D = easier');

    await page.click('.btn-drums-settings');
    await page.waitForTimeout(100);
    info = await page.evaluate(() => ({ v: document.querySelector('.drums-difficulty-select').value,
        off: Array.from(document.querySelectorAll('.drums-difficulty-select option')).filter(o => o.disabled).length }));
    assert.deepEqual(info, { v: 'hard', off: 0 }, 'settings panel difficulty selector');
    await page.selectOption('.drums-difficulty-select', 'medium');
    info = await page.evaluate(() => { window.__harness.frame(); return [window.__harness.renderer._difficulty().id, window.__harness.renderer._chartNoteCount(), window.__chart.levels.medium.length]; });
    assert.deepEqual(info.slice(0, 2), ['medium', info[2]], 'settings selector switches the level');
    assert.equal(await page.textContent('.drums-view-note'), '3D view active');
    await page.selectOption('.drums-view-select', '2d');
    await page.waitForTimeout(400);
    info = await page.evaluate(() => ({ ctx: window.__harness.renderer.contextType, hud: document.querySelectorAll('canvas.drums3d-hud').length }));
    assert.deepEqual(info, { ctx: '2d', hud: 0 }, 'View=2D installs the 2D renderer and removes the HUD');
    // 2D view: renders + scores the selected level (helpers + drums.json load in the 2D view too)
    await page.waitForFunction(() => { window.__harness.frame(); const d = window.__harness.renderer._difficulty(); return d && d.id === 'medium'; },
        null, { timeout: 5000 });
    info = await page.evaluate(() => ({ count: window.__harness.renderer._chartNoteCount(), medium: window.__chart.levels.medium.length,
        badges: document.querySelectorAll('.drums-diff-badge').length,
        shown: document.querySelector('.drums-diff-badge').style.display !== 'none' }));
    assert.deepEqual(info, { count: info.medium, medium: info.medium, badges: 1, shown: true }, '2D view uses the Medium level');
    await page.keyboard.press('KeyD');
    info = await page.evaluate(() => { window.__harness.frame(); return [window.__harness.renderer._difficulty().id, window.__harness.renderer._chartNoteCount(), window.__chart.levels.hard.length]; });
    assert.deepEqual(info.slice(0, 2), ['hard', info[2]], '2D mid-song switch with D');
    await page.keyboard.press('Shift+KeyD');
    info = await page.evaluate(() => { window.__harness.frame(); return [window.__harness.renderer._difficulty().id, window.__harness.renderer._chartNoteCount()]; });
    assert.equal(info[0], 'medium');
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

    // Old sloppak (drums block without levels) with Easy saved: plays Expert for this song, keeps the
    // saved choice, and shows Easy/Medium/Hard disabled with a reason.
    await page.goto(`${base}/plugins/drums/tools/app.html?view=3d&paused=1&t=4&difficulty=easy&levels=0`);
    await page.waitForFunction(() => document.title === 'ready', null, { timeout: 30000 });
    await page.waitForFunction(() => { window.__harness.frame(); const d = window.__harness.renderer._difficulty(); return d && !d.options.some(o => /Loading/.test(o.reason)); },
        null, { timeout: 5000 });
    await page.click('.btn-drums-settings');
    await page.click('.drums-diff-badge');
    info = await page.evaluate(() => {
        const r = window.__harness.renderer;
        const d = r._difficulty();
        return { id: d.id, requested: d.requested, fallback: d.fallback, pref: localStorage.getItem('drums_difficulty_v1'),
            badge: document.querySelector('.drums-diff-badge').dataset.fallback,
            disabled: Array.from(document.querySelectorAll('.drums-difficulty-select option')).filter(o => o.disabled).map(o => o.value),
            menuOff: Array.from(document.querySelectorAll('.drums-diff-option')).filter(b => b.disabled).map(b => b.dataset.diff),
            note: document.querySelector('.drums-difficulty-note').textContent,
            count: r._chartNoteCount(), expert: window.__chart.notes.filter(n => n.s * 24 + n.f !== 35).length };
    });
    assert.deepEqual([info.id, info.requested, info.fallback, info.pref, info.badge], ['expert', 'easy', true, 'easy', '1'],
        'fallback to Expert without overwriting the saved choice');
    assert.deepEqual(info.disabled, ['easy', 'medium', 'hard']);
    assert.deepEqual(info.menuOff, ['easy', 'medium', 'hard']);
    assert.match(info.note, /^Playing Expert: /);
    assert.equal(info.count, info.expert);
    await page.screenshot({ path: path.join(outDir, 'app-fallback.png') });
    assert.deepEqual(errors, []);
    console.log('app-check: ok');
} finally {
    await browser.close();
}
