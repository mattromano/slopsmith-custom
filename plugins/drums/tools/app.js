// Fake Slopsmith highway for tools/app.html: follows the setRenderer contract closely enough to run the
// drums plugin's real renderer (2D or 3D) with the synthetic chart from chart.js.
import { makeChart } from './chart.js';

const params = new URLSearchParams(location.search);
const chart = makeChart();
window.__chart = chart;

const player = document.getElementById('player');
const controls = document.getElementById('player-controls');
const clockEl = document.getElementById('clock');
let canvas = document.getElementById('highway');
let renderer = null;
let ctxType = null;
let time = params.has('t') ? +params.get('t') : 0;
let playing = !params.has('paused');
let lastWall = performance.now();
let midiCursor = 0;
let manual = false;
let fixedDt = 0;

const songInfo = {
    title: 'Preview', artist: 'Synthetic', arrangement: 'Drums', arrangement_index: 0,
    arrangements: [{ index: 0, name: 'Drums', notes: chart.notes.length }],
    format: 'sloppak', filename: 'Preview.sloppak',
};
window.slopsmith.currentSong = { filename: 'Preview.sloppak', format: 'sloppak', arrangement: 'Drums' };

const hooks = [];
window.highway = {
    setRenderer,
    getSongInfo: () => songInfo,
    getTime: () => time,
    addDrawHook: (fn) => hooks.push(fn),
    fireDrawHooks(ctx, W, H) { for (const h of hooks) { try { h(ctx, W, H); } catch (_) { /* ignore */ } } },
    isDefaultRenderer: () => false,
};

function bundle() {
    return {
        currentTime: time, isReady: true, songInfo, notes: chart.notes, chords: [], beats: chart.beats,
        sections: [], renderScale: 1, inverted: false, lefty: false, getNoteState: () => null,
    };
}

function sizeCanvas() {
    const w = player.clientWidth;
    const h = player.clientHeight - controls.offsetHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = w;
    canvas.height = h;
    if (renderer && typeof renderer.resize === 'function') renderer.resize(canvas.width, canvas.height);
}

function replaceCanvas(nextType) {
    const old = canvas;
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    canvas = fresh;
    window.slopsmith.emit('highway:canvas-replaced', { oldCanvas: old, newCanvas: fresh, contextType: nextType });
}

async function setRenderer(r) {
    if (renderer && typeof renderer.destroy === 'function') renderer.destroy();
    renderer = null;
    const want = (r && r.contextType) || '2d';
    if (ctxType && want !== ctxType) replaceCanvas(want);
    ctxType = want;
    sizeCanvas();
    r.init(canvas, bundle());
    renderer = r;
    if (typeof r.resize === 'function') r.resize(canvas.width, canvas.height);
    if (r.readyPromise) await r.readyPromise;
    window.slopsmith.emit('viz:renderer:ready', {});
    return r;
}

// Fire fake MIDI for every chart note the playhead crossed (a perfect player).
function playMidiUpTo(t) {
    const notes = chart.notes;
    while (midiCursor < notes.length && notes[midiCursor].t <= t) {
        const n = notes[midiCursor++];
        if (window.__skipMidi && window.__skipMidi(n)) continue;
        window.__midi(n.s * 24 + n.f, n.ac ? 120 : (n.mt ? 30 : 95));
    }
}
function resetMidiCursor(t) {
    midiCursor = 0;
    while (midiCursor < chart.notes.length && chart.notes[midiCursor].t < t) midiCursor++;
}

function frame() {
    if (!renderer) return;
    renderer.draw(bundle());
    clockEl.textContent = time.toFixed(2);
}

function loop() {
    const now = performance.now();
    if (playing && !manual) {
        time += fixedDt || (now - lastWall) / 1000;
    }
    lastWall = now;
    if (!manual) {
        frame();
        if (playing && window.__autoplay) playMidiUpTo(time);   // MIDI after the frame, like a real kit
    }
    requestAnimationFrame(loop);
}

// Test hooks (Playwright).
window.__harness = {
    get renderer() { return renderer; },
    get time() { return time; },
    frame,
    setTime(t) { time = t; resetMidiCursor(t); },
    // Fast-forward synchronously to T - tail at 60 fps with perfect MIDI, then play the tail in real time.
    async play(T, tail) {
        tail = tail == null ? 0.6 : tail;
        manual = true;
        const end = T - tail;
        // Step to each chart time (at most 0.1 s apart) so every hit lands on its note.
        while (time < end) {
            const next = midiCursor < chart.notes.length ? chart.notes[midiCursor].t : Infinity;
            time = Math.min(end, time + 0.1, Math.max(next, time + 0.001));
            frame();
            frame();   // second frame at the same time: the renderer sees a paused clock, so hits land exactly
            playMidiUpTo(time);
        }
        manual = false;
        playing = true;
        window.__autoplay = true;
        fixedDt = 1 / 30;   // deterministic tail even when software WebGL renders slowly
        lastWall = performance.now();
        await new Promise((resolve) => {
            const wait = () => (time >= T ? resolve() : requestAnimationFrame(wait));
            wait();
        });
        playing = false;
        window.__autoplay = false;
        fixedDt = 0;
        frame();
    },
    pause() { playing = false; },
    resume() { playing = true; lastWall = performance.now(); },
    async useView(view) {
        // explicit per-view factories (the View setting itself lives in the settings panel)
        return setRenderer(view === '2d' ? window.slopsmithViz_drums2d() : window.slopsmithViz_drums3d());
    },
};

window.addEventListener('resize', sizeCanvas);
await setRenderer(window.slopsmithViz_drums());
document.title = 'ready';
requestAnimationFrame(loop);
