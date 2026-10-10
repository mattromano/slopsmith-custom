// Shared helpers: a MUTED headed Edge (--mute-audio: nothing reaches the speakers) driving a Slopsmith test server.
import { chromium } from 'playwright-core';

export const BASE = process.env.BASE || 'http://127.0.0.1:8003';

// Closing the browser rejects Playwright's pending navigation promise; that is harmless.
process.on('unhandledRejection', (e) => { if (!/Target page, context or browser has been closed/.test(String(e))) { console.error(e); process.exitCode = 1; } });

export async function launch() {
    const browser = await chromium.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        headless: false,
        args: [
            '--mute-audio',
            '--autoplay-policy=no-user-gesture-required',
            '--window-position=-2400,0',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
        ],
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // Belt and braces on top of --mute-audio: zero every media element.
    await page.addInitScript(() => {
        const op = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () { this.muted = true; this.volume = 0; return op.apply(this, arguments); };
        window.__frameLog = [];
        window.__logFrames = false;
        // Wrap every highway instance's renderer draw: log render time vs the precise audio clock.
        const wrapHw = (hw, label) => {
            if (!hw || hw.__pwWrapped) return hw;
            hw.__pwWrapped = true;
            const sr = hw.setRenderer;
            hw.setRenderer = function (r) {
                if (r && typeof r.draw === 'function' && !r.__pwDraw) {
                    r.__pwDraw = true;
                    const d = r.draw;
                    r.draw = function (bundle) {
                        if (window.__logFrames) {
                            const a = document.getElementById('audio');
                            window.__frameLog.push({ hw: label, wall: performance.now(), ct: bundle.currentTime,
                                a: a ? a.currentTime : NaN, p: bundle.isPlaying });
                        }
                        const r = d.apply(this, arguments);
                        if (window.__logFrames) {
                            const e = window.__frameLog[window.__frameLog.length - 1];
                            e.h3d = window.__h3dFrameNow; window.__h3dFrameNow = undefined;
                            e.drum = window.__drumsFrameT; window.__drumsFrameT = undefined;
                        }
                        return r;
                    };
                }
                return sr.apply(this, arguments);
            };
            return hw;
        };
        let n = 0;
        const poll = setInterval(() => {
            if (window.highway && !window.highway.__pwWrapped) wrapHw(window.highway, 'main');
            if (typeof window.createHighway === 'function' && !window.createHighway.__pw) {
                const orig = window.createHighway;
                window.createHighway = function () { return wrapHw(orig.apply(this, arguments), 'panel' + (++n)); };
                window.createHighway.__pw = true;
            }
        }, 5);
        setTimeout(() => clearInterval(poll), 30000);
    });
    return { browser, page, errors };
}

export function stats(xs) {
    const a = xs.filter(Number.isFinite).slice().sort((p, q) => p - q);
    if (!a.length) return null;
    const q = (f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
    return { n: a.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2), p5: +q(0.05).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), min: +a[0].toFixed(2), max: +a[a.length - 1].toFixed(2) };
}

// Per-frame judder: render-time step minus wall step (ms). 0 = perfectly smooth.
export function judder(log, hw, key = 'ct') {
    const f = log.filter((e) => e.hw === hw && e.p !== false && Number.isFinite(e[key]));
    const d = [];
    for (let i = 1; i < f.length; i++) {
        const dw = f[i].wall - f[i - 1].wall;
        if (dw <= 0 || dw > 40) continue;
        d.push((f[i][key] - f[i - 1][key]) * 1000 - dw);
    }
    return stats(d);
}
