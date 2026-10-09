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
                // ours and the pack changed (new gear / Kilohearts installed): refresh, keep the
                // user's level / gate tweaks
                presets[name] = Object.assign({}, p, {
                    created: cur.created || Date.now(),
                    inputGain: cur.inputGain, outputGain: cur.outputGain,
                    noiseGate: cur.noiseGate, tonePolish: cur.tonePolish,
                });
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

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { mergePack };
        return;
    }
    // Run once the Audio plugin has had a chance to start (its UI reads localStorage on render).
    setTimeout(install, 1500);
})();
