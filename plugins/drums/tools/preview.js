// Preview harness for the 3D drum highway (see preview.html). Builds a synthetic pro-drums chart in the
// Slopsmith wire format (midi = s*24 + f), plays it perfectly up to a chosen time through the real
// DrumsEngine + DrumsHighway3D session, and renders one frame (or runs live with ?live=1).

const params = new URLSearchParams(location.search);
const THREE_URL = params.get('three') || '../../../slopsmith/static/vendor/three/three.module.min.js';
const THREE = await import(THREE_URL);
const H = window.DrumsHighway3D;
const E = window.DrumsEngine;

const { makeChart, START, BEAT, MEASURE } = await import('./chart.js');

const chart = makeChart();
let simWall = 0;
const session = H.createSession(E, { now: () => simWall });
session.load({ notes: chart.notes, chords: [], beats: chart.beats });
session.setMeta(H.parseDrumsMeta({ drums: chart.drums }));

// Perfect play (with a couple of deliberate mistakes) up to time T.
function simulate(T, mistakes) {
    const decoded = session.engine ? session.gems : [];
    const skip = new Set(mistakes && mistakes.skip || []);
    let i = 0;
    for (let t = 0; t <= T + 1e-9; t = Math.round((t + 1 / 120) * 1e6) / 1e6) {
        simWall = t * 1000;
        session.update(t);
        while (i < decoded.length && decoded[i].t <= t) {
            const g = decoded[i++];
            if (skip.has(Math.round(g.t * 1000) + ':' + g.pad)) continue;
            simWall = g.t * 1000 + 4;
            session.hit(g.t + 0.004, g.pad, { cymbal: g.cymbal, velocity: g.accent ? 120 : (g.ghost ? 30 : 90) });
        }
        if (mistakes && mistakes.overhitAt != null && Math.abs(t - mistakes.overhitAt) < 1 / 240) {
            session.hit(t, 3, { cymbal: false });
        }
    }
    simWall = T * 1000;
}

const scenario = params.get('scenario') || 'play';
const presets = {
    // normal play: x4, SP phrase gems approaching, a fresh red tint from an overhit on blue
    play: { t: START + 9 * MEASURE + 2.3 * BEAT },
    // a fresh overhit on blue (red lane tint, combo reset) and a skipped kick
    miss: { t: START + 9 * MEASURE + 1.62 * BEAT,
        mistakes: { overhitAt: START + 9 * MEASURE + 1.5 * BEAT, skip: [Math.round((START + 9 * MEASURE + BEAT) * 1000) + ':1'] } },
    // SP ready: fill window + activator ahead
    fill: { t: START + 15 * MEASURE + 1.15 * BEAT },
    // SP active right after the fill activator
    sp: { t: START + 16 * MEASURE + 1.4 * BEAT },
};
const preset = presets[scenario] || presets.play;
const T = params.has('t') ? +params.get('t') : preset.t;

const canvas = document.getElementById('highway');
const hud = document.getElementById('hud');
const view = H.createView(THREE, canvas, { hudCanvas: hud });
function size() {
    view.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio || 1, 2));
}
size();
window.addEventListener('resize', size);

if (params.get('live')) {
    // Real-time loop with the keyboard fallback.
    const t0 = performance.now() - (params.has('t') ? T * 1000 : 0);
    const now = () => (performance.now() - t0) / 1000;
    window.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const m = H.keyToPad(e);
        if (!m) return;
        e.preventDefault();
        simWall = performance.now();
        if (m.action === 'activate') session.activate(now());
        else session.hit(now(), m.pad, { cymbal: m.cymbal });
    });
    const loop = () => {
        simWall = performance.now();
        const t = now();
        session.update(t);
        view.render({ time: t, session, wallNow: simWall, hint: 'Hit the marked note to activate' });
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
} else {
    simulate(T, preset.mistakes);
    const frame = () => view.render({ time: T, session, wallNow: T * 1000 + 30, hint: 'Hit the marked note to activate' });
    frame();
    requestAnimationFrame(() => { frame(); document.title = 'ready'; window.__previewState = session.getState(); });
}
