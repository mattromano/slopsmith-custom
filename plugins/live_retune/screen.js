// Live Retune: shift the pitch of the guitar you're playing (asked for 2026-10-13).
//
// The shift runs in the native engine (LivePitchShifter in our slopsmith_audio.node build), right
// after input gain, so note detection hears the shifted guitar and the amp/IR chain gets the
// retuned DI. The tuner keeps reading the dry strings. Control rides on setTonePolish({ pitch })
// because the installed app's IPC bridge forwards that payload untouched; status comes back on
// getDeviceMetrics().livePitch. A stock .node ignores the pitch payload and has no livePitch
// field, which is how "not installed" is detected.
//
// This is separate from the pitch_shift plugin (which shifts the song's stems, not your playing).
(function () {
    'use strict';
    const KEY = 'liveRetune';
    const MAX_ST = 5;
    const MODES = [
        { id: 'tight', label: 'Tight', ms: 8 },
        { id: 'balanced', label: 'Balanced', ms: 14 },
        { id: 'smooth', label: 'Smooth', ms: 22 },
    ];
    const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

    function load() {
        let s = {};
        try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { /* ignore */ }
        const st = Math.max(-MAX_ST, Math.min(MAX_ST, Math.round(Number(s.semitones) || 0)));
        const c = Math.max(-100, Math.min(100, Math.round(Number(s.cents) || 0)));
        const mode = MODES.some((m) => m.id === s.mode) ? s.mode : 'balanced';
        return { semitones: st, cents: c, mode };
    }

    const state = load();
    let supported = null;      // null = unknown yet
    let latencyMs = 0;

    const api = () => window.slopsmithDesktop && window.slopsmithDesktop.audio;
    const totalCents = () => state.semitones * 100 + state.cents;
    const windowMs = () => (MODES.find((m) => m.id === state.mode) || MODES[1]).ms;

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
    }

    function apply() {
        const a = api();
        if (!a || typeof a.setTonePolish !== 'function') return;
        Promise.resolve(a.setTonePolish({
            pitch: { semitones: state.semitones, cents: state.cents, windowMs: windowMs() },
        })).catch(() => {});
    }

    function set(patch) {
        Object.assign(state, patch);
        state.semitones = Math.max(-MAX_ST, Math.min(MAX_ST, state.semitones));
        state.cents = Math.max(-100, Math.min(100, state.cents));
        save();
        apply();
        render();
    }

    // E standard's low string after the shift, e.g. -1 st -> "Eb".
    function tuningName() {
        const t = totalCents();
        if (t === 0) return 'standard';
        const st = Math.round(t / 100);
        const rest = t - st * 100;
        const name = NOTES[((4 + st) % 12 + 12) % 12];
        return rest ? `${name} ${rest > 0 ? '+' : ''}${rest}c` : name;
    }

    function render() {
        const st = document.getElementById('lr-st');
        const sl = document.getElementById('lr-cents');
        const cl = document.getElementById('lr-cents-label');
        const md = document.getElementById('lr-mode');
        const info = document.getElementById('lr-info');
        if (!st) return;
        st.textContent = (state.semitones > 0 ? '+' : '') + state.semitones + ' st';
        if (Number(sl.value) !== state.cents) sl.value = String(state.cents);
        cl.textContent = (state.cents > 0 ? '+' : '') + state.cents + 'c';
        if (md.value !== state.mode) md.value = state.mode;
        if (supported === false) {
            info.textContent = 'not installed';
            info.title = 'The native engine in this app does not have the live retune. Run slopsmith-custom/tools/install_native_audio.py.';
        } else {
            const lat = totalCents() !== 0 && latencyMs > 0 ? ` +${latencyMs.toFixed(0)}ms` : '';
            info.textContent = tuningName() + lat;
            info.title = 'Low string after the shift, and the delay the retune adds.';
        }
        const wrap = document.getElementById('lr-ctl');
        if (wrap) wrap.classList.toggle('lr-on', totalCents() !== 0);
    }

    function btn(text, title, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.title = title;
        b.className = 'px-1.5 rounded bg-dark-600 hover:bg-dark-500 text-xs text-gray-300';
        b.addEventListener('click', onClick);
        return b;
    }

    function ensure() {
        const bar = document.getElementById('player-controls');
        if (!bar || document.getElementById('lr-ctl')) return;
        const wrap = document.createElement('span');
        wrap.id = 'lr-ctl';
        wrap.className = 'inline-flex items-center gap-1 text-xs text-gray-500';

        const name = document.createElement('span');
        name.textContent = 'Retune';
        name.title = 'Shift the pitch of what you play (semitones + cents). Note detection follows it; the tuner shows your real strings.';

        const down = btn('−', 'Down a semitone', () => set({ semitones: state.semitones - 1 }));
        const st = document.createElement('span');
        st.id = 'lr-st';
        st.className = 'w-9 text-center tabular-nums';
        const up = btn('+', 'Up a semitone', () => set({ semitones: state.semitones + 1 }));

        const sl = document.createElement('input');
        sl.type = 'range';
        sl.id = 'lr-cents';
        sl.min = '-100'; sl.max = '100'; sl.step = '1';
        sl.className = 'w-20 accent-accent slider-input';
        sl.title = 'Fine tune in cents. Double-click to reset.';
        sl.addEventListener('input', () => set({ cents: Number(sl.value) }));
        sl.addEventListener('dblclick', () => set({ cents: 0 }));
        const cl = document.createElement('span');
        cl.id = 'lr-cents-label';
        cl.className = 'w-9 tabular-nums';

        const md = document.createElement('select');
        md.id = 'lr-mode';
        md.className = 'bg-dark-600 rounded text-xs text-gray-300';
        md.title = 'Tight: least delay. Smooth: cleanest on big shifts and chords.';
        for (const m of MODES) {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.label;
            md.append(o);
        }
        md.addEventListener('change', () => set({ mode: md.value }));

        const reset = btn('0', 'Back to standard (no shift)', () => set({ semitones: 0, cents: 0 }));
        const info = document.createElement('span');
        info.id = 'lr-info';
        info.className = 'tabular-nums text-gray-400';

        wrap.append(name, down, st, up, sl, cl, md, reset, info);
        const after = document.getElementById('gv-label');
        if (after && after.parentNode === bar) after.after(wrap);
        else bar.append(wrap);
        render();
    }

    // Keep the engine in step: re-send after an engine restart or device change (the native state
    // resets to 0), and pick up the measured latency.
    async function poll() {
        const a = api();
        if (!a || typeof a.getDeviceMetrics !== 'function') return;
        try {
            const m = await a.getDeviceMetrics();
            const lp = m && m.livePitch;
            if (!lp) {
                if (m) supported = false;
            } else {
                supported = true;
                latencyMs = Number(lp.latencyMs) || 0;
                if (Math.round(Number(lp.cents)) !== totalCents()
                    || Math.round(Number(lp.windowMs)) !== windowMs()) apply();
            }
        } catch (_) { /* ignore */ }
        render();
    }

    window.__liveRetune = { state, set, apply };

    const bus = window.slopsmith;
    if (bus && bus.on) bus.on('song:loaded', () => { ensure(); apply(); });
    setInterval(ensure, 1500);
    setInterval(poll, 2000);
    ensure();
    apply();
    poll();
})();
