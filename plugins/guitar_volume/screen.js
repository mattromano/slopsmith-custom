// Guitar Volume: a master level for the guitar you're playing (asked for 2026-10-10).
//
// The native engine's 'chain' gain is the guitar-only amp output. Every preset sets it (Audio
// Engine presets, Tone Automation switches, Rig Builder fades, NAM Tone), so a plain setGain from
// here would be overwritten on the next tone change. Instead those plugins send their level through
// window.__guitarVolume.setChain(api, level), which applies level x master and remembers the level,
// so moving this slider re-applies the current preset's level at the new master volume.
// Callers that run before this script record their level in window.__guitarChainRaw.
//
// The bridge API object (window.slopsmithDesktop.audio) is read-only, which is why the callers are
// patched instead of wrapping setGain here.
(function () {
    'use strict';
    const KEY = 'guitarVolumeDb';
    const MIN = -24, MAX = 12;

    function readDb() {
        let v = 0;
        try { v = Number(localStorage.getItem(KEY)); } catch (_) { /* ignore */ }
        return Number.isFinite(v) ? Math.max(MIN, Math.min(MAX, Math.round(v))) : 0;
    }

    const gv = window.__guitarVolume = window.__guitarVolume || {
        db: readDb(),
        api: null,
        lastRaw: Number.isFinite(window.__guitarChainRaw) ? window.__guitarChainRaw : null,
        lin() { return Math.pow(10, this.db / 20); },
        setChain(api, level) {
            this.api = api || this.api;
            this.lastRaw = level;
            return this.api.setGain('chain', level * this.lin());
        },
        setDb(db) {
            db = Math.max(MIN, Math.min(MAX, Math.round(Number(db) || 0)));
            this.db = db;
            try { localStorage.setItem(KEY, String(db)); } catch (_) { /* ignore */ }
            const api = this.api || (window.slopsmithDesktop && window.slopsmithDesktop.audio);
            if (api && typeof api.setGain === 'function' && this.lastRaw !== null) {
                this.api = api;
                api.setGain('chain', this.lastRaw * this.lin()).catch(() => {});
            }
            render();
        },
    };

    // What the patched callers call: (window.__gvChain ? window.__gvChain(api, v) : api.setGain('chain', v)).
    window.__gvChain = (api, level) => gv.setChain(api, level);

    const fmt = (db) => (db > 0 ? '+' : '') + db + ' dB';

    function render() {
        const s = document.getElementById('gv-slider');
        const l = document.getElementById('gv-label');
        if (s && Number(s.value) !== gv.db) s.value = String(gv.db);
        if (l) l.textContent = fmt(gv.db);
    }

    function ensure() {
        const bar = document.getElementById('player-controls');
        if (!bar || document.getElementById('gv-slider')) return;
        const name = document.createElement('span');
        name.id = 'gv-name';
        name.className = 'text-xs text-gray-500 ml-1';
        name.textContent = 'Guitar vol';
        const s = document.createElement('input');
        s.type = 'range';
        s.id = 'gv-slider';
        s.min = String(MIN); s.max = String(MAX); s.step = '1'; s.value = String(gv.db);
        s.className = 'w-20 accent-accent slider-input';
        s.title = 'Volume of the guitar you are playing (your amp sound), on top of every tone preset. Double-click to reset.';
        s.setAttribute('aria-labelledby', 'gv-name');
        s.addEventListener('input', () => gv.setDb(s.value));
        s.addEventListener('dblclick', () => gv.setDb(0));
        const l = document.createElement('span');
        l.id = 'gv-label';
        l.className = 'text-xs text-gray-500 w-12 tabular-nums';
        l.textContent = fmt(gv.db);
        // Next to the A/V offset (the other "global" slider); else at the end of the bar.
        const after = document.getElementById('player-av-offset-label');
        if (after && after.parentNode === bar) after.after(name, s, l);
        else bar.append(name, s, l);
    }

    const bus = window.slopsmith;
    if (bus && bus.on) bus.on('song:loaded', ensure);
    setInterval(ensure, 1500);
    ensure();
})();
