// Integration test for screen.js wiring (headless). Browser audio can't run
// here, but the control flow can: load the REAL screen.js under stubbed DOM +
// WebAudio globals and assert the plumbing T2/T3/T5/T6 established:
//   - setOffset persists per song; a fresh instance hydrates it on song:loaded
//   - engine detection (web vs desktop)
//   - desktop dispatch calls setBackingPitchSemitones with the offset
//   - web dispatch builds the graph and drives the worklet's pitchSemitones
//   - auto-apply on song load re-asserts the persisted offset
//
// Run: node test/integration.test.js   (exit 0 = pass, 1 = fail)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCREEN = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok   ${name}`);
    else { console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stubs ─────────────────────────────────────────────────────────────────────
function makeEl() {
    const el = {
        style: {}, dataset: {}, children: [], textContent: '', value: '',
        classList: { add() {}, remove() {}, contains() { return false; } },
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.push(c); return c; },
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return makeEl(); }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0 }; },
        contains() { return false; }, focus() {}, offsetWidth: 200, offsetHeight: 40,
        set onclick(_) {}, set onchange(_) {}, set onmouseenter(_) {}, set onmouseleave(_) {},
    };
    return el;
}

class FakeParam { constructor() { this.value = 0; } setValueAtTime(v) { this.value = v; } }
class FakeWorkletNode {
    constructor() {
        this.parameters = new Map([['pitchSemitones', new FakeParam()]]);
        this.port = { postMessage() {} };
    }
    connect() {} disconnect() {}
}
class FakeAudioCtx {
    constructor() {
        this.state = 'running'; this.currentTime = 0; this.destination = {};
        this.audioWorklet = { addModule: async () => {} };
    }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() {}
}

// Build a sandbox + load screen.js into it. Returns { window, autotune, store }.
function load({ desktopSpy = null, sharedStore = null, badSource = false } = {}) {
    const store = sharedStore || new Map();
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };

    const elements = new Map();
    const document = {
        body: makeEl(),
        getElementById: (id) => { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
        createElement: () => makeEl(),
        addEventListener() {}, removeEventListener() {},
        readyState: 'complete',
    };

    const slop = new EventTarget();
    slop.currentSong = null;
    slop.emit = function (e, d) { this.dispatchEvent(new CustomEvent(e, { detail: d })); };
    slop.on = function (e, f, o) { this.addEventListener(e, f, o); };
    slop.off = function (e, f, o) { this.removeEventListener(e, f, o); };

    const audioEl = {
        currentTime: 5, paused: true,
        addEventListener() {}, removeEventListener() {}, play: () => Promise.resolve(),
    };

    const FakeCtx = badSource
        ? class extends FakeAudioCtx {
            createMediaElementSource() { const e = new Error('already connected'); e.name = 'InvalidStateError'; throw e; }
        }
        : FakeAudioCtx;

    const window = {
        slopsmith: slop,
        audio: audioEl,
        AudioContext: FakeCtx,
        addEventListener() {}, removeEventListener() {},
    };
    if (desktopSpy) window.slopsmithDesktop = { audio: { setBackingPitchSemitones: desktopSpy } };

    const sandbox = {
        window, document, localStorage, console: { info() {}, warn() {}, error: console.error, log() {} },
        setTimeout, clearTimeout, Promise, Math, Date, JSON,
        EventTarget, CustomEvent, Event, Blob: function Blob() {},
        URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
        AudioWorkletNode: FakeWorkletNode, Float32Array, Array, Object,
    };
    vm.createContext(sandbox);
    vm.runInContext(SCREEN, sandbox, { filename: 'screen.js' });
    return { window, autotune: window.autotune, store };
}

function loadSong(window, filename, semitonesAlreadySaved) {
    window.slopsmith.emit('song:loaded', { filename, tuning: [0, 0, 0, 0, 0, 0] });
}

// ── Scenarios ───────────────────────────────────────────────────────────────
(async function run() {
    console.log('screen.js integration');

    // 1. Persistence round-trips across instances.
    {
        const store = new Map();
        const a = load({ sharedStore: store });
        loadSong(a.window, 'song-A.psarc');
        a.autotune.setOffset(-3);
        check('setOffset updates state', a.autotune.getState().semitones === -3);
        check('setOffset persists to localStorage', [...store.values()].includes('-3'));

        const b = load({ sharedStore: store });           // fresh instance, same storage
        loadSong(b.window, 'song-A.psarc');
        check('fresh instance hydrates persisted offset on song:loaded',
              b.autotune.getState().semitones === -3, `got ${b.autotune.getState().semitones}`);

        a.autotune.setOffset(0);
        check('offset 0 clears the persisted key', ![...store.values()].includes('-3') && ![...store.values()].includes('0'));
    }

    // 2. Engine detection.
    {
        const web = load();
        check('engine() is "web" without slopsmithDesktop', web.autotune.engine() === 'web');
        const desk = load({ desktopSpy: () => {} });
        check('engine() is "desktop" with slopsmithDesktop IPC', desk.autotune.engine() === 'desktop');
    }

    // 3. Desktop dispatch.
    {
        const calls = [];
        const desk = load({ desktopSpy: (n) => calls.push(n) });
        loadSong(desk.window, 'song-D.psarc');
        desk.autotune.setOffset(-2);
        await delay(0);
        check('desktop setOffset calls setBackingPitchSemitones(-2)', calls.includes(-2), `calls=${calls}`);
    }

    // 4. Web dispatch builds graph + drives the worklet param.
    {
        const web = load();
        loadSong(web.window, 'song-W.psarc');
        web.autotune.setOffset(-1);
        await delay(5);
        const node = web.autotune._internals.web.node;
        check('web setOffset builds the worklet node', !!node, 'node not built');
        check('web worklet pitchSemitones set to -1',
              node && node.parameters.get('pitchSemitones').value === -1,
              node ? `value=${node.parameters.get('pitchSemitones').value}` : 'no node');
        web.autotune.setOffset(0);
        await delay(5);
        check('web setOffset(0) resets pitchSemitones to 0',
              node && node.parameters.get('pitchSemitones').value === 0);
    }

    // 5. Auto-apply persisted offset on song load (web).
    {
        const store = new Map();
        const seed = load({ sharedStore: store });
        loadSong(seed.window, 'song-AA.psarc');
        seed.autotune.setOffset(-4);
        await delay(5);

        const fresh = load({ sharedStore: store });
        loadSong(fresh.window, 'song-AA.psarc');           // should auto-apply -4
        await delay(5);
        const node = fresh.autotune._internals.web.node;
        check('song load auto-applies persisted offset to audio',
              node && node.parameters.get('pitchSemitones').value === -4,
              node ? `value=${node.parameters.get('pitchSemitones').value}` : 'no node');
    }

    // 6. Graceful degradation when the <audio> element is already routed.
    {
        const web = load({ badSource: true });
        loadSong(web.window, 'song-X.psarc');
        web.autotune.setOffset(-2);
        await delay(5);
        check('web path marks itself unavailable on InvalidStateError',
              web.autotune._internals.web.unavailable === true);
    }

    // 7. note_detect coupling: emit on preset change, and the DEFERRED song-load
    //    re-emit must win over note_detect's synchronous song:loaded clear.
    {
        const store = new Map();
        const seed = load({ sharedStore: store });
        loadSong(seed.window, 'song-ND.psarc');
        seed.autotune.setOffset(-3);                 // persist -3 for this song
        await delay(5);

        const inst = load({ sharedStore: store });
        // Mirror note_detect, registered AFTER autotune (matches alphabetical
        // plugin load order: autotune < note_detect). It clears on song:loaded
        // and sets on retune:offset — exactly the T10 handlers.
        let ndRetune = null;
        inst.window.slopsmith.on('song:loaded', () => { ndRetune = 0; });
        inst.window.slopsmith.on('retune:offset', (e) => { ndRetune = e.detail.semitones; });

        // Synchronous preset change emits immediately.
        loadSong(inst.window, 'song-ND.psarc');      // hydrates -3, queues deferred emit
        inst.autotune.setOffset(-2);
        check('preset change emits retune:offset synchronously', ndRetune === -2, `ndRetune=${ndRetune}`);

        // Now exercise the song-load ordering: clear (sync) then deferred re-emit.
        ndRetune = 999;                              // sentinel
        loadSong(inst.window, 'song-ND.psarc');      // song:loaded → mirror clears to 0
        check('song:loaded clear runs synchronously first', ndRetune === 0, `ndRetune=${ndRetune}`);
        await delay(5);                              // let the deferred emit fire
        check('deferred retune re-emit wins over the clear (ND sees -2)',
              ndRetune === -2, `ndRetune=${ndRetune}`);

        // retune:offset payload shape.
        let payload = null;
        inst.window.slopsmith.on('retune:offset', (e) => { payload = e.detail; });
        inst.autotune.setOffset(-1);
        check('retune:offset payload is {semitones, cents:0, tuningName}',
              payload && payload.semitones === -1 && payload.cents === 0 && typeof payload.tuningName === 'string',
              JSON.stringify(payload));
    }

    if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    console.log('\nall checks passed');
})();
