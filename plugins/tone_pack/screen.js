// Tone pack: adds ready-made presets for every Tone Automation category to the Audio plugin
// (Clean, OD, Dist, Solo, Bass, Acoustic, Mod) and points the empty category targets at them.
// routes.py builds the presets from the captures / IRs on this computer.
//
// Rules: presets the user made are never touched. Presets this plugin made
// (`generatedBy: 'tone_pack'`) are refreshed when the pack changes, unless the user deleted one
// (remembered in `tone-pack-removed`) — then it stays deleted. Targets the user already set stay.
(function () {
    'use strict';
    const PRESETS_KEY = 'slopsmith-chain-presets';
    const TA_KEY = 'slopsmith-tone-automation';
    const SEEN_KEY = 'tone-pack-seen';        // names this pack has installed before
    const STATE_KEY = 'tone-pack-state';      // {version, kilohearts}

    function readJson(key, fallback) {
        try {
            const v = JSON.parse(localStorage.getItem(key) || 'null');
            return v && typeof v === 'object' ? v : fallback;
        } catch (_) { return fallback; }
    }

    function writeJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
    }

    // Pure merge (tested): returns {presets, ta, seen, added, updated}.
    function mergePack(pack, presets, ta, seen) {
        presets = Object.assign({}, presets || {});
        ta = Object.assign({ enabled: false, customKeywords: {}, targets: {} }, ta || {});
        ta.targets = Object.assign({}, ta.targets || {});
        seen = Array.isArray(seen) ? seen.slice() : [];
        const added = [], updated = [];
        for (const [name, p] of Object.entries(pack.presets || {})) {
            const cur = presets[name];
            if (!cur) {
                if (seen.includes(name)) continue;           // the user deleted it: leave it gone
                presets[name] = Object.assign({}, p, { created: Date.now() });
                added.push(name);
            } else if (cur.generatedBy === 'tone_pack' && cur.nativePreset !== p.nativePreset) {
                // ours and the pack changed (new gear, level fix, Kilohearts installed): refresh.
                // Keep level / gate settings only where the user changed them from what the pack
                // set (packLevels); older pack presets have no record, so they take the new values.
                const was = cur.packLevels || null;
                const tweaked = (k) => !!was && JSON.stringify(cur[k]) !== JSON.stringify(was[k]);
                const next = Object.assign({}, p, { created: cur.created || Date.now() });
                for (const k of ['inputGain', 'outputGain', 'noiseGate', 'tonePolish']) {
                    if (tweaked(k)) next[k] = cur[k];
                }
                presets[name] = next;
                updated.push(name);
            }
            if (!seen.includes(name)) seen.push(name);
        }
        // Retarget categories that are empty or still point at a pack preset that no longer
        // exists (e.g. the Mod preset renamed when Kilohearts got installed).
        for (const [cat, name] of Object.entries(pack.targets || {})) {
            const cur = ta.targets[cat];
            const stale = cur && !presets[cur] && seen.includes(cur);
            if ((!cur || stale) && presets[name]) ta.targets[cat] = name;
        }
        // Idle fallback: the user's own default lead if there is one, else Crunch.
        if (!ta.targets.idle) {
            const own = Object.keys(presets).find(n => presets[n].generatedBy !== 'tone_pack');
            ta.targets.idle = own || pack.targets.od || null;
            if (!ta.targets.idle) delete ta.targets.idle;
        }
        return { presets, ta, seen, added, updated };
    }

    async function install() {
        let pack;
        try {
            const r = await fetch('/api/plugins/tone_pack/presets');
            if (!r.ok) return;
            pack = await r.json();
        } catch (_) { return; }
        const firstRun = localStorage.getItem(TA_KEY) === null;
        const res = mergePack(pack, readJson(PRESETS_KEY, {}), readJson(TA_KEY, null), readJson(SEEN_KEY, []));
        if (firstRun) res.ta.enabled = true;            // never configured: turn Tone Automation on
        writeJson(PRESETS_KEY, res.presets);
        writeJson(TA_KEY, res.ta);
        writeJson(SEEN_KEY, res.seen);
        writeJson(STATE_KEY, { version: pack.version, kilohearts: !!pack.kilohearts, missing: pack.missing || [] });
        if (res.added.length || res.updated.length) {
            console.log('[tone-pack] added', res.added, 'updated', res.updated);
            const ta = window._aeToneAutomation;
            try { if (ta && ta.renderSettings) ta.renderSettings(); } catch (_) { /* audio plugin UI not ready */ }
            try { if (ta && ta.renderTargets) ta.renderTargets(); } catch (_) { /* ignore */ }
        }
    }

    // ── Per-song categories from the song's gear ───────────────────────────
    // Tone Automation classifies tone *names*. Names it can't place ("Tone 1", "Default",
    // "George_Rhythm"...) fall back to Idle, every tone of a Bass arrangement whose name says
    // "dist" got the guitar Dist preset, and single-tone arrangements classify the song's file
    // name. For the loaded sloppak, routes.py classifies each tone from its amp / pedals; those
    // become session overrides (the Audio plugin's own per-song mechanism, cleared on each song).

    // Pure (tested): {toneName: presetName} overrides for one song.
    function songOverrides(gearCats, classify, targets, opts) {
        opts = opts || {};
        const out = {};
        for (const [name, cat] of Object.entries(gearCats || {})) {
            const key = name === '$song' ? opts.songKey : name;
            if (!key) continue;
            const byName = name === '$song' ? null : classify(name);
            // keep what the name says, except on a bass part, where everything is Bass
            if (byName && !(opts.bass && byName !== 'bass')) continue;
            const preset = targets[cat];
            if (preset && preset !== targets[byName || 'idle']) out[key] = preset;
        }
        return out;
    }

    let _songSeq = 0;
    async function applySongOverrides() {
        const ta = window._aeToneAutomation;
        if (!ta || !ta.isEnabled || !ta.isEnabled()) return;
        const hw = window.highway;
        const si = (hw && hw.getSongInfo && hw.getSongInfo()) || {};
        const cs = (window.slopsmith && window.slopsmith.currentSong) || {};
        const filename = window._currentSongFile || si.filename || cs.filename || '';
        let arrangement = si.arrangement || '';
        if (!arrangement && Array.isArray(si.arrangements)) {
            const a = si.arrangements.find(x => x && x.index === si.arrangement_index);
            if (a) arrangement = a.name || '';
        }
        if (!/\.sloppak\/?$/i.test(filename) || !arrangement) return;
        const seq = ++_songSeq;
        let cats = {};
        try {
            const r = await fetch('/api/plugins/tone_pack/song_tones?filename=' + encodeURIComponent(filename)
                + '&arrangement=' + encodeURIComponent(arrangement));
            if (!r.ok) return;
            cats = (await r.json()).tones || {};
        } catch (_) { return; }
        if (seq !== _songSeq) return;
        const cfg = ta.getConfig ? ta.getConfig() : {};
        const ov = songOverrides(cats, (n) => ta.classify(n, cfg), cfg.targets || {},
            { songKey: window._currentSongFile || filename, bass: /\bbass\b/i.test(arrangement) });
        if (!Object.keys(ov).length) return;
        const cur = window._aeTaSessionOverrides || {};
        for (const [k, v] of Object.entries(ov)) {
            if (!Object.prototype.hasOwnProperty.call(cur, k)) cur[k] = v;   // a manual pick wins
        }
        window._aeTaSessionOverrides = cur;
        console.log('[tone-pack] gear-based tones for this song:', ov);
        // re-apply the tone that's playing now (the switcher skips a preset that's already loaded)
        const sw = window._toneSwitcher;
        if (sw && sw.taSwitcher && sw.activeTone) {
            try { await sw.switchToTone(sw.activeTone); } catch (_) { /* ignore */ }
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { mergePack, songOverrides };
        return;
    }
    try {
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            // song:ready, then once more after the Audio plugin's own (debounced) tone setup
            window.slopsmith.on('song:ready', () => {
                applySongOverrides();
                setTimeout(applySongOverrides, 2500);
            });
        }
    } catch (_) { /* no host */ }
    // Run once the Audio plugin has had a chance to start (its UI reads localStorage on render).
    setTimeout(install, 1500);
})();
