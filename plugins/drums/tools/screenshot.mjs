// Capture the 3D drum highway preview (tools/preview.html) in headless Chromium with software WebGL.
//
//   python -m http.server 8765 --bind 127.0.0.1           # repository root, separate shell
//   node plugins/drums/tools/screenshot.mjs [outDir] [baseUrl] [scenario ...]
//
// Defaults: outDir plugins/drums/docs, baseUrl http://127.0.0.1:8765, scenarios play fill sp levels.
// Writes highway3d.png (play), highway3d-fill.png (star power ready + fill), highway3d-sp.png (active) and
// highway3d-levels.png (the auto-generated Medium level, difficulty badge).
// Needs Playwright: either `npm i playwright` anywhere on the module path, or slopsmith's dev deps
// (`cd slopsmith && npm ci && npx playwright install chromium`), which this script falls back to.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
async function loadChromium() {
    // PLAYWRIGHT_DIR: a node_modules/playwright directory installed elsewhere (e.g. a temp dir).
    if (process.env.PLAYWRIGHT_DIR) return createRequire(path.join(process.env.PLAYWRIGHT_DIR, 'x.js'))('.').chromium;
    try { return (await import('playwright')).chromium; } catch (_) { /* fall through */ }
    const req = createRequire(path.join(here, '..', '..', '..', 'slopsmith', 'package.json'));
    return req('@playwright/test').chromium;
}

const [, , outDir = path.join(here, '..', 'docs'), base = 'http://127.0.0.1:8765', ...scen] = process.argv;
const scenarios = scen.length ? scen : ['play', 'fill', 'sp', 'levels'];
const names = { play: 'highway3d.png', fill: 'highway3d-fill.png', sp: 'highway3d-sp.png', levels: 'highway3d-levels.png' };

const chromium = await loadChromium();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = false;
for (const s of scenarios) {
    const [name, extra] = s.split('?');
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => { failed = true; console.error(`[${name}] ${e.message}`); });
    await page.goto(`${base}/plugins/drums/tools/preview.html?scenario=${name}${extra ? '&' + extra : ''}`);
    await page.waitForFunction(() => document.title === 'ready', null, { timeout: 30000 });
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => window.__previewState);
    console.log(`${name}: score ${st.score}, streak ${st.combo}, x${st.multiplier}, star power ${Math.round(st.starPower.amount * 100)}%${st.starPower.active ? ' (active)' : ''}`);
    await page.screenshot({ path: path.join(outDir, names[name] || `${name}.png`) });
    await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
