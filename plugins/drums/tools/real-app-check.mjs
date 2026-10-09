// Headless check against the REAL running app (./run-mac.sh): plays sloppak/1979.sloppak on Drums,
// then on Lead, and saves screenshots to /tmp/claude-501/shot/. PW=<path to playwright package>.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW + '/x.js');
const { chromium } = req('.');
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
await p.evaluate(() => window.playSong('sloppak/1979.sloppak', 2));
await p.waitForTimeout(6000);
await p.evaluate(() => { const a = document.querySelector('audio'); if (a) { a.muted = true; a.currentTime = 60; a.play().catch(()=>{}); } });
await p.waitForTimeout(4000);
await p.screenshot({ path: '/tmp/claude-501/shot/real-1979-drums.png' });
  await p.evaluate(() => window.playSong('sloppak/1979.sloppak', 0));
  await p.waitForTimeout(6000);
  await p.evaluate(() => { const a = document.querySelector('audio'); if (a) { a.muted = true; a.currentTime = 60; a.play().catch(()=>{}); } });
  await p.waitForTimeout(3000);
  await p.screenshot({ path: '/tmp/claude-501/shot/real-1979-lead.png' });
const info = await p.evaluate(() => ({ arr: window.highway && highway.getSongInfo && highway.getSongInfo().arrangement,
  viz: document.querySelector('#viz-picker, select[id*=viz]') && document.querySelector('#viz-picker, select[id*=viz]').value,
  t: window.highway && highway.getTime && highway.getTime() }));
console.log(JSON.stringify(info), 'errors:', JSON.stringify(errs.slice(0, 8)));
await b.close();
