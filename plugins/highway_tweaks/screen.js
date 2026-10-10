// Highway Tweaks — user plugin (lives in AppData, so app updates don't wipe it).
//
// 1. Colorblind G/B strings. Bundled plugins can't be overridden by a user
//    copy, so instead this plugin (app.js loads plugins sorted by display
//    name — the leading '_' in plugin.json makes this one load first)
//    intercepts the <script> tags app.js appends for highway_3d / fretboard,
//    rewrites the G (index 3) and B (index 4) string colours in the source,
//    and loads the patched copy from a blob URL. If an app update changes
//    the source so a pattern no longer matches, that piece is skipped and
//    the stock colours are used — it never breaks loading.
//
// 2. Frame-drop watchdog. While a song is playing, measures real frame
//    intervals; when frames are being dropped it POSTs a diagnostic snapshot
//    to /api/plugins/highway_tweaks/log (-> jank_log.jsonl next to this file)
//    so the cause of the session-dependent lag can be read off disk without
//    restarting the app (restarting always makes the lag disappear).
//
// Also rewrites highway_3d for Rock Band-style hit / miss feedback (see
// rbVerdicts): hits burst and vanish, misses go grey and drift past the
// line, partly hit chords get an amber plate.
(function () {
    'use strict';
    if (window.__highwayTweaks) return;
    window.__highwayTweaks = { version: '1.16.0' };

    // ── 1. String colours ───────────────────────────────────────────────
    // G = saturated mid-tone orange, B = pale icy aqua: they differ on the
    // blue–yellow axis AND in lightness, both of which survive red-green
    // colour blindness (simulated deutan ΔE 9 -> 87, protan 16 -> 79).
    const G_HEX = 0xff7300, B_HEX = 0xb4f8ff;
    const G_GRAD = '[0xff8a1a, 0xd85a00]', B_GRAD = '[0xe4fdff, 0x7fe3f5]';
    const G_OUTLINE = '0xFFA040', B_OUTLINE = '0xF0FFFF';
    const G_CSS = '#ff7300', B_CSS = '#b4f8ff';
    const G_CSS_BRIGHT = '#ff9a40', B_CSS_BRIGHT = '#e6fdff';
    const hex = (n) => '0x' + n.toString(16).padStart(6, '0');

    // Replace entries 3 and 4 of a comma-separated literal list.
    function setGB(listSrc, g, b) {
        const parts = listSrc.split(',');
        let idx = -1;
        return parts.map((p) => {
            if (!p.trim()) return p;
            idx++;
            const lead = p.match(/^\s*/)[0], trail = p.match(/\s*$/)[0];
            if (idx === 3) return lead + g + trail;
            if (idx === 4) return lead + b + trail;
            return p;
        }).join(',');
    }

    // Injected at the top of highway_3d's smoothNow(bundle). With native
    // (JUCE) playback, sample the smoothed jucePlayer clock (see section 3)
    // at the exact moment this frame is drawn, instead of bundle.currentTime,
    // which was captured by app.js's free-running 60 Hz setInterval up to a
    // frame earlier (random phase -> uneven per-frame steps). The chart/AV
    // offset is recovered as bundle.currentTime minus the last raw audio time
    // passed to highway.setTime(). Falls through to stock logic otherwise.
    const SMOOTH_NOW_PREFIX = `function smoothNow(bundle) {
            {
                // [highway_tweaks] Frame-exact clock when the stems transport
                // (patched to a precise clock) is playing: read it now instead
                // of bundle.currentTime, which app.js sampled on its own 60 Hz
                // timer up to a frame earlier. Offset (chart + AV) recovered
                // from the last raw time passed to highway.setTime().
                const __a = document.getElementById('audio');
                if (bundle.isPlaying !== false && __a && typeof window.__hwtLastSetT === 'number'
                        && window.__hwtStemsSmooth && window.__hwtStemsSmooth()) {
                    const __t = __a.currentTime + (bundle.currentTime - window.__hwtLastSetT);
                    _clkAudioT = bundle.currentTime; _clkPerf = performance.now(); _clkRate = 1;
                    window.__h3dFrameNow = __t;
                    return (_frameNow = __t);
                }
            }
`;

    // Rock Band-style verdicts on the 3D highway (needs a note-state
    // provider, i.e. Note Detection on). Stock highway_3d only re-tints the
    // outline of a judged gem that sits on the now line, and its chord-frame
    // verdict colour is never drawn (the frame stops at the line, the verdict
    // lands ~0.4 s later), so chord runs give almost no feedback. Instead:
    //  - hit: the gem vanishes in a burst in its string colour; a fully hit
    //    chord adds one burst across the chord box;
    //  - miss: the gem (and its sustain) turns dark grey and keeps scrolling
    //    past the now line; a fully missed chord's frame turns grey and
    //    scrolls past too;
    //  - partly hit chord: an amber frame scrolls past with its grey notes.
    // Hit vs miss differs in brightness and motion (burst-and-gone vs grey
    // and moving), not only in hue, so it reads with colour blindness.
    // Kill switch: localStorage.highwayTweaksNoRbVerdicts = '1', then reload.
    const RB_DECL = `
        // [highway_tweaks] Rock Band-style verdicts. __rbV: verdict latch per note
        // (key __rbKey(t, s)) or chord (key -1 - verdictKey) ->
        // { v: 'hit' | 'miss' | 'chord', t0: performance.now() ms, t, end: chart s, x, y, s, w, h }.
        const __rbV = new Map();
        window.__rbVerdicts = __rbV;   // debug handle
        let __rbFx = null, __rbPlate = null, __rbBoxGeo = null, __rbGrey = null, __rbGreyOl = null;
        const __RB_AMBER = 0xffa31a, __RB_MISS_FRAME = 0x9aa0ad, __RB_BURST_S = 0.3, __RB_SHARDS = 8;
        // Past the now line notes head straight at the camera; misses drift at a fraction
        // of the highway speed so they stay on screen for the verdict window.
        const __RB_PAST_SPEED = 0.3;
        function __rbKey(t, s) { return Math.round(t * 1e4) * 10 + s; }
        function __rbFxMesh(x, y, z, sx, sy, sz, hex, op) {
            const m = __rbFx.get();
            m.position.set(x, y, z);
            m.rotation.set(0, 0, 0);
            m.scale.set(sx, sy, sz);
            m.material.color.setHex(hex);
            m.material.opacity = op;
        }
        function __rbPlateAt(x, y, z, sx, sy, hex, op) {
            const m = __rbPlate.get();
            m.position.set(x, y, z);
            m.rotation.set(0, 0, 0);
            m.scale.set(sx, sy, 0.5 * K);
            m.material.color.setHex(hex);
            m.material.opacity = op;
        }
        function __rbDrawFx(now) {
            if (!__rbFx) return;
            __rbFx.reset();
            if (__rbPlate) __rbPlate.reset();
            const pn = performance.now();
            for (const [k, e] of __rbV) {
                if (now < e.t - 0.25 || now > e.end + 2) { __rbV.delete(k); continue; }
                if (e.v === 'miss') continue;
                const p = (pn - e.t0) / 1000 / __RB_BURST_S;
                if (!(p >= 0 && p < 1)) continue;
                const q = 1 - p;
                if (e.v === 'chord') {
                    const sw = e.w / NW, sh = e.h / NH, g = 1 + 0.18 * p;
                    __rbFxMesh(e.x, e.y, 0, sw * g, sh * g, 0.6, 0xbff6ff, 0.55 * q * q);
                    for (let i = 0; i < 12; i++) {
                        const a = (i / 12) * Math.PI * 2 + 0.3;
                        const r = 0.5 + 0.35 * p;
                        __rbFxMesh(e.x + Math.cos(a) * e.w * r, e.y + Math.sin(a) * e.h * r, 0.002, 0.3, 0.3, 1, 0xffffff, q);
                    }
                    continue;
                }
                const col = (activePalette && activePalette[e.s] != null) ? activePalette[e.s] : 0xffffff;
                const g = 1.15 + 1.4 * p;
                __rbFxMesh(e.x, e.y, 0, e.w * g, e.h * g, 1.5, col, 0.95 * q * Math.sqrt(q));
                __rbFxMesh(e.x, e.y, 0.002, e.w * (0.9 + 0.5 * p), e.h * (0.9 + 0.5 * p), 2, 0xffffff, q * q);
                const d = NW * (0.55 + 1.9 * p);
                for (let i = 0; i < __RB_SHARDS; i++) {
                    const a = (i / __RB_SHARDS) * Math.PI * 2 + (k % 7) * 0.4;
                    __rbFxMesh(e.x + Math.cos(a) * d * (e.w > 1.5 ? 0.5 * e.w : 1), e.y + Math.sin(a) * d * 0.7, 0.004,
                        0.24, 0.32, 1, col, q);
                }
            }
        }
`;
    const RB_LATCH = `
            // [highway_tweaks] Rock Band-style verdict latch (see __rbV).
            const __rbK = __rbKey(n.t, n.s);
            let __rbE = __rbV.get(__rbK);
            if (__rbE && dt > 0.25) { __rbV.delete(__rbK); __rbE = undefined; }
            if (!__rbE && _ndHasProvider && dt < 0.12 && (_ndGood || _ndState === 'miss')) {
                __rbE = { v: _ndGood ? 'hit' : 'miss', t0: performance.now(), t: n.t, end: susEnd, x, y: y + techniqueYNow, s,
                    w: n.f === 0 ? (40 * K / NW) * openWScale : 1, h: n.f === 0 ? 0.1 * openSlabThickMul : 1 };
                __rbV.set(__rbK, __rbE);
            }
            const __rbHit = !!__rbE && __rbE.v === 'hit' && _ndState !== 'miss';
            const __rbMiss = !!__rbE && __rbE.v === 'miss';
            if (__rbMiss) {
                _ndState = 'miss'; _ndGood = false;
                if (!_ndCs) { _ndCs = 'miss'; _ndCsIsObj = false; }
                noteZ = dZ(dt) * __RB_PAST_SPEED;
            }
`;
    const RB_CHORD_SCAN = `let allHit = chordNotes.length > 0, anyMiss = false, anyHit = false, anyNull = false, anyState = false;
                                // [highway_tweaks] scan every constituent (partial = amber); the
                                // per-note latch fills in verdicts the provider has already dropped.
                                for (const cn of chordNotes) {
                                    let cs = null;
                                    try { cs = _ndGetNoteState(cn, ch.t); } catch (e) { cs = null; }
                                    let st = (cs && typeof cs === 'object') ? cs.state : cs;
                                    if (st !== 'hit' && st !== 'active' && st !== 'miss') {
                                        const __e = __rbV.get(__rbKey(ch.t, cn.s));
                                        if (__e) st = __e.v;
                                    }
                                    if (st === 'hit' || st === 'active') { anyHit = true; anyState = true; }
                                    else if (st === 'miss') { anyMiss = true; allHit = false; anyState = true; }
                                    else { allHit = false; anyNull = true; }
                                }
                                const __late = chDt < -_ND_UNMATCHED_LATCH_AFTER;
                                if (allHit) {
                                    _chordVerdicts.set(verdictKey, 'green');
                                    rimHex = CHORD_BOX_HIT_BRIGHT_HEX;
                                    __rbV.set(-1 - verdictKey, { v: 'chord', t0: performance.now(), t: ch.t, end: ch.t,
                                        x: cx, y: cY, s: 0, w: width, h: height });
                                } else if (anyHit && (anyMiss || __late)) {
                                    _chordVerdicts.set(verdictKey, 'amber');
                                    rimHex = __RB_AMBER;
                                } else if (anyMiss && (!anyNull || __late)) {
                                    _chordVerdicts.set(verdictKey, 'red');
                                    rimHex = CHORD_BOX_MISS_DARK_HEX;
                                } else if (__late && !anyState) {
                                    _chordVerdicts.set(verdictKey, 'unmatched');
                                }
                                // else: no verdict yet → leave teal default`;

    // Past the line the stock frame is hairline bars + a near-transparent
    // gradient fill, so a verdict frame gets its own solid plate instead.
    const RB_PLATE = `{
                            // [highway_tweaks] amber (partly hit) / grey (missed) chord plate past the line
                            const __rbL = _chordVerdicts.get(verdictKey);
                            if (chDt <= 0 && _ndHasProvider && __rbPlate && (__rbL === 'amber' || __rbL === 'red')) {
                                const hex = __rbL === 'amber' ? __RB_AMBER : __RB_MISS_FRAME;
                                const op = Math.max(0, 1 + chDt / NOTEDETECT_GEM_VERDICT_WINDOW);
                                const pz = dZ(chDt) * __RB_PAST_SPEED;
                                const pw = width, ph = fullChordBoxH, py = (yMinF + yMaxF) * 0.5;
                                const bt = Math.max(1.2 * K, ph * 0.07);
                                __rbPlateAt(cx, py, pz, pw, ph, hex, 0.3 * op);
                                __rbPlateAt(cx, py - ph / 2 + bt / 2, pz, pw, bt, hex, op);
                                __rbPlateAt(cx, py + ph / 2 - bt / 2, pz, pw, bt, hex, op);
                                __rbPlateAt(cx - pw / 2 + bt / 2, py, pz, bt, ph, hex, op);
                                __rbPlateAt(cx + pw / 2 - bt / 2, py, pz, bt, ph, hex, op);
                            }
                        }
                        `;

    // Apply every rbVerdicts edit to a copy; null if any anchor is missing.
    function rbVerdicts(code) {
        const edits = [
            // state + burst drawing, next to the provider handle
            [/( {8}let _ndHasProvider = false;[^\n]*\n)/, (m) => m + RB_DECL],
            // burst pool + grey materials, created with the note pool
            ['            pNote = pool(noteG, () => new T.Mesh(gNote, mStr[0]));', (m) => m +
                '\n            __rbFx = pool(noteG, () => { const fx = new T.Mesh(gNote, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true,' +
                ' opacity: 1, blending: T.AdditiveBlending, depthWrite: false })); fx.renderOrder = 950; return fx; });' +
                '\n            __rbBoxGeo = new T.BoxGeometry(1, 1, 1);' +
                '\n            __rbPlate = pool(noteG, () => { const pl = new T.Mesh(__rbBoxGeo, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true,' +
                ' opacity: 1, depthWrite: false, depthTest: false })); pl.renderOrder = 940; return pl; });' +
                '\n            __rbGrey = new T.MeshLambertMaterial({ color: 0x8a8f9c, emissive: 0x2c2e34, transparent: true, opacity: 0.92, depthWrite: false });' +
                '\n            __rbGreyOl = new T.MeshLambertMaterial({ color: 0x2a2c33, emissive: 0x000000, transparent: true, opacity: 1, depthWrite: false });'],
            ['            mMissOutline?.dispose?.();', (m) => m + ' __rbGrey?.dispose?.(); __rbGreyOl?.dispose?.(); __rbBoxGeo?.dispose?.(); __rbFx = __rbPlate = __rbBoxGeo = __rbGrey = __rbGreyOl = null; __rbV.clear();'],
            // draw the bursts each frame
            ['            const now = smoothNow(bundle);', (m) => m + ' __rbDrawFx(now);'],
            // a latched miss keeps the gem alive past its linger time (until the verdict window ends)
            ["if (_probeSt !== 'hit' && _probeSt !== 'active' && _probeSt !== 'miss') return;",
                () => "if (_probeSt !== 'hit' && _probeSt !== 'active' && _probeSt !== 'miss'" +
                    " && (__rbV.get(__rbKey(n.t, n.s)) || {}).v !== 'miss') return;"],
            ['const noteZ = sustained ? 0 : Math.min(0, dZ(dt));', () => 'let noteZ = sustained ? 0 : Math.min(0, dZ(dt));'],
            [/( {12})const _showHit = \(_ndState === 'miss'\) \? false/, (m) => RB_LATCH + m],
            // hit gems are gone; missed gems draw (grey) past the linger time
            ['if (!skipBody && !arpGhostOnlyMode && !_overLinger) {', (() => {
                let i = 0;
                return () => (i++ === 0
                    ? 'if (!skipBody && !arpGhostOnlyMode && (!_overLinger || __rbMiss) && !__rbHit) {'
                    : 'if (!skipBody && !arpGhostOnlyMode && !_overLinger && !__rbHit) {');
            })(), 2],
            ['outline.material = (n.ac && !_ndVerdict) ? mAccentOutline[s] : _ndOutline;',
                () => 'outline.material = __rbMiss ? __rbGreyOl : ((n.ac && !_ndVerdict) ? mAccentOutline[s] : _ndOutline);'],
            ['if (_ndFaceMat) {', () => 'if (_ndFaceMat && !__rbMiss) {'],
            ['core.material = n.ac ? mAccentCore[s] : mStr[s];', () => 'core.material = __rbMiss ? __rbGrey : (n.ac ? mAccentCore[s] : mStr[s]);'],
            ['core.geometry = (!n.ac && gNoteGrad[s]) ? gNoteGrad[s] : gNote;', () => 'core.geometry = (!__rbMiss && !n.ac && gNoteGrad[s]) ? gNoteGrad[s] : gNote;'],
            // missed sustains: grey trail
            ["const _susOlMat = _ndState === 'miss' ? mMissOutline", () => "const _susOlMat = _ndState === 'miss' ? __rbGreyOl"],
            ['tr.material = _ndState ? mGlow[s] : mSus[s];', () => "tr.material = _ndState === 'miss' ? __rbGrey : (_ndState ? mGlow[s] : mSus[s]);"],
            ['body.material = _ndState ? mGlow[s] : mSus[s];', () => "body.material = _ndState === 'miss' ? __rbGrey : (_ndState ? mGlow[s] : mSus[s]);"],
            // chord verdict: partial = amber; amber / grey frames keep drawing past the line
            [/let allHit = chordNotes\.length > 0;[\s\S]*?\/\/ else: no verdict yet → leave teal default/, () => RB_CHORD_SCAN],
            [/\} else if \(latched === 'red'\) \{/, () => "} else if (latched === 'amber') {\n                                rimHex = __RB_AMBER;\n                            } else if (latched === 'red') {"],
            // amber / grey verdict plate where the frame would be, drifting past the line
            ['if (chDt > 0) { // framebox only on highway, not on the fretboard', (m) => RB_PLATE + m],
        ];
        let out = code;
        for (const [find, rep, want = 1] of edits) {
            const n = typeof find === 'string'
                ? out.split(find).length - 1
                : (out.match(new RegExp(find.source, 'g')) || []).length;
            if (n !== want) {
                console.warn('[highway_tweaks] rb-verdicts anchor matched ' + n + 'x (want ' + want + '):', String(find).slice(0, 80));
                return null;
            }
            out = typeof find === 'string' ? out.split(find).map((p, i) => (i ? rep(find) : '') + p).join('') : out.replace(find, rep);
        }
        return { code: out };
    }

    const PATCHERS = {
        highway_3d(code, hits) {
            // Every selectable palette (default/neon/pastel/colorblind_hc).
            code = code.replace(/const PALETTES = \{[\s\S]*?\n {4}\};/, (block) => {
                hits.push('palettes');
                return block.replace(/\[([^\]]*)\]/g, (_, list) => '[' + setGB(list, hex(G_HEX), hex(B_HEX)) + ']');
            });
            // Frame-exact smooth clock for native playback (see SMOOTH_NOW_PREFIX).
            code = code.replace(/function smoothNow\(bundle\) \{\r?\n/, () => { hits.push('frame-clock'); return SMOOTH_NOW_PREFIX; });
            // Hardcoded per-string gem gradients.
            code = code.replace(/\[0xf77b0b, 0xdb5808\]/, () => { hits.push('gradG'); return G_GRAD; });
            code = code.replace(/\[0x37c40b, 0x139305\]/, () => { hits.push('gradB'); return B_GRAD; });
            // Hardcoded gem outline colours.
            code = code.replace(/(const _outlineColors = \[)([^\]]*)(\])/, (_, a, list, c) => {
                hits.push('outline');
                return a + setGB(list, G_OUTLINE, B_OUTLINE) + c;
            });
            // Rock Band-style hit / miss (all-or-nothing, see rbVerdicts).
            let noRb = false;
            try { noRb = localStorage.getItem('highwayTweaksNoRbVerdicts') === '1'; } catch (_) { /* ignore */ }
            const rb = noRb ? null : rbVerdicts(code);
            if (rb) { code = rb.code; hits.push('rb-verdicts'); }
            else if (!noRb) console.warn('[highway_tweaks] rb-verdicts: highway_3d changed, keeping the stock hit/miss look');
            return code;
        },
        fretboard(code, hits) {
            code = code.replace(/(const FB_STRING_COLORS = \[)([^\]]*)(\])/, (_, a, list, c) => {
                hits.push('colors');
                return a + setGB(list, `'${G_CSS}'`, `'${B_CSS}'`) + c;
            });
            code = code.replace(/(const FB_STRING_BRIGHT = \[)([^\]]*)(\])/, (_, a, list, c) => {
                hits.push('bright');
                return a + setGB(list, `'${G_CSS_BRIGHT}'`, `'${B_CSS_BRIGHT}'`) + c;
            });
            return code;
        },

        // ── Main-thread fixes (the actual cause of the highway frame drops) ──
        // capability_inspector re-renders its (normally hidden) dev panel on
        // every `slopsmith:capabilities:changed` event, which fires ~30x/s.
        // Each re-render rewrites innerHTML, which in turn wakes
        // sloppak_converter's document-wide MutationObserver, which rescans
        // the whole library DOM (+ forced layout via offsetParent) — measured
        // 61 full scans/s, ~30% of the renderer main thread, growing with the
        // library DOM. That steals the frame budget and the highway drops to
        // 40-50 fps.
        capability_inspector(code, hits) {
            // Defer renders while the screen is hidden; render once on show.
            code = code.replace(/ {4}function scheduleRender\(\) \{\r?\n/, () => {
                hits.push('render-when-visible');
                return '    function scheduleRender() {\n' +
                    "        const __ciScreen = document.getElementById('plugin-capability_inspector');\n" +
                    "        if (__ciScreen && !__ciScreen.classList.contains('active')) { __ciDirty = true; return; }\n";
            });
            code = code.replace(/ {4}if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', install\);\r?\n/, (line) => {
                hits.push('on-show-watch');
                return '    var __ciDirty = false;\n' +
                    '    (function __ciWatch() {\n' +
                    "        const s = document.getElementById('plugin-capability_inspector');\n" +
                    '        if (!s) { setTimeout(__ciWatch, 1000); return; }\n' +
                    '        new MutationObserver(() => {\n' +
                    "            if (__ciDirty && s.classList.contains('active')) { __ciDirty = false; scheduleRender(); }\n" +
                    "        }).observe(s, { attributes: true, attributeFilter: ['class'] });\n" +
                    '    })();\n' + line;
            });
            // Both pieces or neither — a half patch could leave the panel stale.
            return hits.length === 2 ? code : (hits.length = 0, null);
        },
        stems(code, hits) {
            // Precise stem playhead. transportPlayhead() read ctx.currentTime,
            // which only advances once per audio callback (~10 ms ticks), so
            // the highway clock built on it stuttered (76% of frames off by
            // >4 ms, frozen frames, backward steps). getOutputTimestamp() maps
            // context time to performance.now() to ~0.1 ms (measured); we
            // extrapolate from it and keep ctx.currentTime's render-ahead
            // offset (slowly averaged) so A/V sync is unchanged.
            code = code.replace(/ {4}function transportPlayhead\(\) \{\r?\n/, (m) => {
                hits.push('precise-clock');
                return '    let __hwtOff = null;\n' +
                    '    function __hwtCtxNow() {\n' +
                    '        const ct = ctx.currentTime;\n' +
                    '        let ts = null;\n' +
                    '        try { ts = ctx.getOutputTimestamp && ctx.getOutputTimestamp(); } catch (_) { ts = null; }\n' +
                    '        if (!ts || !(ts.performanceTime > 0)) return ct;\n' +
                    '        const est = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;\n' +
                    '        const d = ct - est;\n' +
                    '        if (__hwtOff === null || Math.abs(d - __hwtOff) > 0.2) __hwtOff = d;\n' +
                    '        else __hwtOff += (d - __hwtOff) * 0.002;\n' +
                    '        return est + __hwtOff;\n' +
                    '    }\n' +
                    '    window.__hwtStemsSmooth = () => !!(sloppakActive && buffersReady && transport.playing && ctx);\n' + m;
            });
            code = code.replace('const elapsed = Math.max(0, ctx.currentTime - transport.baseCtxTime);',
                () => { hits.push('use-precise'); return 'const elapsed = Math.max(0, __hwtCtxNow() - transport.baseCtxTime);'; });
            // The "full" stem is the complete original mix. When a sloppak also
            // has separated stems, playing it doubles the song underneath them,
            // and Stem Mixer has no slider for it (its keys are guitar/bass/
            // vocals/drums/piano/other), so muting every slider still leaves
            // the whole song playing. Keep "full" off whenever separated stems
            // exist; full-mix-only songs are unaffected.
            code = code.replace(/( {12})const vol = clampVolume\(savedVols\[r\.id\]\);/, (m, ind) => {
                hits.push('full-off');
                return ind + "if (/^full$/i.test(r.id) && ok.some((x) => !/^full$/i.test(x.id))) on = false;\n" + m;
            });
            if (hits.length !== 3) { hits.length = 0; return null; }
            // Cent-accurate pitch shift (UI: the pitch_shift plugin). Reuses the
            // master-bus SoundTouch worklet that already cancels the speed
            // slider's pitch change: target pitch = 2^(cents/1200) / rate.
            // All-or-nothing on a copy, so a future stems update that breaks
            // one anchor drops only this feature, not the fixes above.
            const pitchHits = [];
            let pc = code;
            pc = pc.replace('try { pitchNode.port.postMessage({ pitch: 1 / r }); } catch (_) {}', () => {
                pitchHits.push('cents');
                return 'try { pitchNode.port.postMessage({ pitch: Math.pow(2, (Number(window.__hwtPitchCents) || 0) / 1200) / r }); } catch (_) {}';
            });
            // Keep the highway delay-compensated whenever the worklet is engaged
            // for a cents shift, not only at non-1x speed.
            pc = pc.replace('        if (Math.abs(r - 1) < 1e-3) return 0;', () => {
                pitchHits.push('latency');
                return '        if (Math.abs(r - 1) < 1e-3 && !(Number(window.__hwtPitchCents) || 0)) return 0;';
            });
            // The worklet bypasses itself when |pitch - 1| < 1e-3 (~1.7 cents);
            // load a copy with a 1e-6 threshold so single-cent shifts are heard.
            pc = pc.replace('? ctx.audioWorklet.addModule(PITCH_WORKLET_URL).then(() => true)', () => {
                pitchHits.push('worklet');
                return '? fetch(PITCH_WORKLET_URL).then((r) => r.text())' +
                    '.then((src) => URL.createObjectURL(new Blob([src.split("Math.abs(p - 1) < 1e-3").join("Math.abs(p - 1) < 1e-6")], { type: "text/javascript" })))' +
                    '.catch(() => PITCH_WORKLET_URL)' +
                    '.then((u) => ctx.audioWorklet.addModule(u)).then(() => true)';
            });
            pc = pc.replace(/ {4}function applyPitchForRate\(\) \{\r?\n/, (m) => {
                pitchHits.push('expose');
                return '    window.__stemsApplyPitch = () => applyPitchForRate();\n' + m;
            });
            if (pitchHits.length === 4) { code = pc; hits.push(...pitchHits); }
            return code;
        },
        note_detect(code, hits) {
            // Capo charts. Rocksmith charts give fretted notes as ABSOLUTE
            // frets (fret 0 = "at the capo"): Fall Back Down, capo 4, writes
            // an E chord as A7 D6 G0 B5. Stock note_detect computes
            // open + capo + fret for every note, so each fretted note is
            // expected `capo` semitones too high and power chords almost never
            // match. Fix: open + (fret > 0 ? fret : capo). The native verifier
            // applies capo the same stock way and can't be patched, so it gets
            // capo 0 plus notes whose fret 0 is rewritten to the capo fret.
            // All-or-nothing, so a partial match can't mix the two models.
            const cp = [];
            let cc = code;
            cc = cc.replace('    return base[string] + offset + (capo || 0) + fret;', () => {
                cp.push('capo-expected');
                return '    return base[string] + offset + (fret > 0 ? fret : (capo || 0));';
            });
            cc = cc.replace('                f: n.f,\n', () => { cp.push('capo-engine-notes'); return '                f: (n.f > 0 || !capo) ? n.f : capo,\n'; });
            cc = cc.replace('                    f: cn.f,\n', () => { cp.push('capo-engine-chords'); return '                    f: (cn.f > 0 || !capo) ? cn.f : capo,\n'; });
            cc = cc.replace(/( {16})capo,\n( {16}\/\/ The engine's harmonic-comb)/, (m, a, b) => {
                cp.push('capo-engine-zero');
                return a + 'capo: 0,   // [highway_tweaks] frets above are already absolute\n' + b;
            });
            // Display fallback (detected pitch -> string/fret): report absolute frets too.
            cc = cc.replace('            bestFret = fret;\n', () => {
                cp.push('capo-display');
                return '            bestFret = (fret > 0 && capo) ? fret + capo : fret;\n';
            });
            if (cp.length === 5) { code = cc; hits.push(...cp); }
            // Keep scoring right when the song is pitch-shifted (pitch_shift
            // plugin, window.__hwtPitchCents): expected pitch = chart pitch +
            // the song shift, e.g. an E♭ song shifted +100¢ expects E standard.
            // Browser detector: exact fractional semitones. Native verifier
            // takes integer tuning offsets, so it gets the rounded semitones;
            // any remainder (≤50 ¢) sits inside the pitch tolerance.
            const OFF = '((Number(window.__hwtPitchCents) || 0) / 100)';
            const ph = [];
            let pc = code;
            // (Matches the stock line or the capo-patched one above.)
            pc = pc.replace(/    return base\[string\] \+ offset \+ (\(capo \|\| 0\) \+ fret|\(fret > 0 \? fret : \(capo \|\| 0\)\));/, (m, expr) => {
                ph.push('fractional-expected');
                return '    return base[string] + offset + ' + expr + ' + (typeof window !== "undefined" ? ' + OFF + ' : 0);';
            });
            pc = pc.replace('                tuningOffsets: tuningOffsets.slice(0, currentStringCount),', () => {
                ph.push('engine-semitones');
                return '                tuningOffsets: tuningOffsets.slice(0, currentStringCount).map((o) => o + Math.round(' + OFF + ')),';
            });
            // Fold the offset into the chart signature so a shift change
            // triggers the existing "chart changed → re-push to engine" path.
            pc = pc.replace("            + ':' + firstT + ':' + lastT;", () => {
                ph.push('resync-on-shift');
                return "            + ':' + firstT + ':' + lastT + ':' + Math.round(" + OFF + ");";
            });
            if (ph.length === 3) { code = pc; hits.push(...ph); }
            // Fast chord runs. While chord N still rings, chord N+1 (often the
            // same shape) is already "present" when its window opens, so its
            // time stamp sits at the early edge of the window, where the 50 ms
            // verdict poll flips it between OK and an EARLY miss at random.
            //  - engine verifier: stamp the chord with the string time closest
            //    to the chart time (stock: the first string listed), and treat
            //    a chord the engine verified inside its window as on time
            //    instead of EARLY by a poll's jitter;
            //  - browser detector: an EARLY strummed frame no longer locks the
            //    chord as a miss; later frames in the window can still hit
            //    (checkMisses retires it as before if none do).
            const cr = [];
            let rc = code;
            rc = rc.replace('if (detectedTime === null) detectedTime = v.detectedSongTime;', () => {
                cr.push('chord-closest-time');
                return 'if (detectedTime === null || Math.abs(v.detectedSongTime - grp.t) < Math.abs(detectedTime - grp.t))' +
                    ' detectedTime = v.detectedSongTime;';
            });
            rc = rc.replace('const chordIsHit = score >= chordHitRatio && detectedTime !== null;', (m) => {
                cr.push('chord-early-edge');
                return 'if (detectedTime !== null && detectedTime < grp.t - chordTimingHitThreshold' +
                    ' && detectedTime >= grp.t - timingTolerance - 0.1) detectedTime = grp.t - chordTimingHitThreshold;\n        ' + m;
            });
            rc = rc.replace('recordJudgment(chordKey, chordJudgment, { count: true, emit: true });', (m) => {
                cr.push('chord-no-early-lock');
                return "if (!chordJudgment.hit && chordJudgment.timingState === 'EARLY') continue;\n                " + m;
            });
            if (cr.length === 3) { code = rc; hits.push(...cr); }
            // Judgment log (section 4b): the engine verifier's raw per-string
            // verdict (heard?, cents off, SNR), so a note "not heard" can be
            // told apart as out of tune vs too weak.
            code = code.replace('const chordKey = _ndVerifierChordKeyOf.get(v.id);', (m) => {
                hits.push('verdict-hook');
                return 'try { if (window.__hwtOnVerdict) window.__hwtOnVerdict(v, cn); } catch (_) {}\n            ' + m;
            });
            // Timing gauge (section 4): forward every counted judgment and
            // expose the live latency offset. Independent of the pitch patch.
            code = code.replace(/( {12})_recordDiagnostic\(judgment\);\r?\n/, (m, ind) => {
                hits.push('timing-hook');
                return m + ind + 'try { if (isDefault) { window.__hwtNdLatency = () => latencyOffset;' +
                    ' if (window.__hwtOnJudgment) window.__hwtOnJudgment(judgment, currentSection); } } catch (_) {}\n';
            });
            return code;
        },
        sloppak_converter(code, hits) {
            // Only react to structural changes in the library / favorites
            // lists (or screen-level mounts on <body>), the same scoping
            // song_preview already uses — not to every DOM change in the app.
            return code.replace(
                "if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {",
                (s) => {
                    hits.push('scoped-observer');
                    return "if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length) && " +
                        "(m.target === document.body || (m.target.closest && m.target.closest('#lib-grid, #lib-tree, #fav-grid, #fav-tree')))) {";
                });
        },
    };

    const origAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (el) {
        const id = el && el.tagName === 'SCRIPT' && el.dataset ? el.dataset.pluginId : null;
        if (!id || !PATCHERS[id] || !el.src || el.__hwtPatched) return origAppendChild.call(this, el);
        // Kill switch for A/B testing the perf patches:
        // localStorage.highwayTweaksNoPerfFix = '1', then restart.
        let noPerf = false;
        try { noPerf = localStorage.getItem('highwayTweaksNoPerfFix') === '1'; } catch (_) { /* ignore */ }
        if (noPerf && (id === 'capability_inspector' || id === 'sloppak_converter')) return origAppendChild.call(this, el);
        el.__hwtPatched = true;
        const parent = this, src = el.src;
        fetch(src).then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        }).then((code) => {
            const hits = [];
            const patched = PATCHERS[id](code, hits);
            if (hits.length) {
                el.src = URL.createObjectURL(new Blob([patched + '\n//# sourceURL=' + src], { type: 'text/javascript' }));
                console.log('[highway_tweaks] patched ' + id + ':', hits.join(', '));
            } else {
                console.warn('[highway_tweaks] no patch patterns matched in ' + id + ' — loading stock');
            }
        }).catch((e) => {
            console.warn('[highway_tweaks] could not patch ' + id + ', loading stock:', e);
        }).finally(() => origAppendChild.call(parent, el));
        return el;
    };

    // ── 3. Smooth native-playback clock ─────────────────────────────────
    // app.js's jucePlayer polls the native engine's song position every
    // 100 ms over IPC, interpolates in between, then SNAPS to each new
    // (already-stale) sample — ~10 visible jumps per second ("skippy"
    // highway at a solid 60 fps). Replacement: keep the interpolated clock
    // continuous and absorb the error by nudging its speed (max ±3%,
    // invisible) instead of jumping. Samples are timestamped at the midpoint
    // of the IPC round trip. Errors > 250 ms (seek, loop, engine restart)
    // still snap. Kill switch: localStorage.highwayTweaksNoClockFix = '1'.
    (function smoothJuceClock() {
        // DISABLED 2026-10-01 pending investigation: the user's songs play via HTML5
        // audio (_juceMode false), so this path was never exercised. Re-enable by
        // setting this to false only after testing with the user.
        let off = true;
        const jp = window.jucePlayer;
        if (off || !jp || jp.__hwtSmooth) return;
        const MAX_CORR = 0.03, HORIZON_S = 1.0, SNAP_S = 0.25;
        let corr = 0, synced = false;
        const audio = window.slopsmithDesktop && window.slopsmithDesktop.audio;
        if (!audio || typeof audio.getBackingPosition !== 'function') return;
        jp.__hwtSmooth = true;
        Object.defineProperty(jp, 'currentTime', {
            configurable: true,
            get() {
                if (!this._polling) return this._pos;
                const el = (performance.now() - this._pollAt) / 1000;
                return Math.min(this._pos + el * this._speed * (1 + corr), this._dur > 0 ? this._dur : Infinity);
            },
        });
        const origSetRate = jp.setRate, origSeek = jp.seek;
        jp.setRate = function (rate) { const r = origSetRate.call(this, rate); synced = false; return r; };
        jp.seek = function (s) { synced = false; corr = 0; return origSeek.call(this, s); };
        jp._startPolling = function () {
            this._stopPolling();
            this._polling = true;
            this._pollAt = performance.now();
            synced = false; corr = 0;
            const self = this;
            function scheduleNext() {
                self._timer = setTimeout(async () => {
                    if (!self._polling) return;
                    try {
                        const t0 = performance.now();
                        const raw = await window.slopsmithDesktop.audio.getBackingPosition();
                        const now = performance.now();
                        if (!self._polling) return;
                        // Engine position as of ~mid round trip, projected to now.
                        const truth = raw + ((now - (t0 + now) / 2) / 1000) * self._speed;
                        const shown = self.currentTime;   // continuous clock, evaluated now
                        const err = truth - shown;
                        if (!synced || Math.abs(err) > SNAP_S) {
                            self._pos = truth; corr = 0; synced = true;
                        } else {
                            self._pos = shown;
                            corr = Math.max(-MAX_CORR, Math.min(MAX_CORR, err / (HORIZON_S * Math.max(self._speed, 0.05))));
                        }
                        self._pollAt = now;
                        window.__hwtClockErrMs = err * 1000;
                        _emitSongPositionChanged(self.currentTime, self.duration || null);
                    } catch (err) {
                        console.warn('[jucePlayer] position poll failed:', err);
                    } finally {
                        if (self._polling) scheduleNext();
                    }
                }, 100);
            }
            scheduleNext();
        };
        // If a song is already playing (plugin reload), restart polling under the new logic.
        if (jp._polling) jp._startPolling();
    })();

    // Record the raw audio time app.js feeds the highway each tick, so the 3D
    // renderer's patched smoothNow can recover the chart/AV offset.
    (function hookSetTime() {
        const hw = window.highway;
        if (!hw || typeof hw.setTime !== 'function') { setTimeout(hookSetTime, 500); return; }
        if (hw.__hwtSetTime) return;
        hw.__hwtSetTime = true;
        const orig = hw.setTime;
        hw.setTime = function (t) { window.__hwtLastSetT = t; return orig.apply(this, arguments); };
    })();

    // ── 2. Frame-drop watchdog ──────────────────────────────────────────
    // Track every canvas context created from here on so a snapshot can
    // show leaked / hidden WebGL canvases.
    const ctxInfo = new WeakMap();
    const ctxCanvases = new Set();
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const ctx = origGetContext.call(this, type, ...rest);
        if (ctx && !ctxInfo.has(this)) {
            ctxInfo.set(this, { type, at: Math.round(performance.now() / 1000) });
            ctxCanvases.add(new WeakRef(this));
        }
        return ctx;
    };

    // Count rAF callbacks per frame (leaked render loops show up here).
    let rafCalls = 0;
    const origRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) { rafCalls++; return origRaf.call(window, cb); };

    const events = [];   // display/visibility events, for correlating onset
    function noteEvent(type, extra) {
        events.push(Object.assign({ type, t: Math.round(performance.now() / 1000) }, extra || {}));
        if (events.length > 40) events.shift();
    }
    document.addEventListener('visibilitychange', () => noteEvent('visibility', { state: document.visibilityState }));
    window.addEventListener('resize', () => noteEvent('resize', { w: innerWidth, h: innerHeight, sx: screenX, sw: screen.width, dpr: devicePixelRatio }));
    window.addEventListener('blur', () => noteEvent('blur'));
    window.addEventListener('focus', () => noteEvent('focus'));
    try {
        const mq = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
        let m = mq();
        const onDpr = () => { noteEvent('dpr-change', { dpr: devicePixelRatio }); m.removeEventListener('change', onDpr); m = mq(); m.addEventListener('change', onDpr); };
        m.addEventListener('change', onDpr);
    } catch (_) { /* best effort */ }

    function canvasReport() {
        const out = [];
        for (const ref of ctxCanvases) {
            const c = ref.deref();
            if (!c) { ctxCanvases.delete(ref); continue; }
            const info = ctxInfo.get(c) || {};
            const r = c.isConnected ? c.getBoundingClientRect() : null;
            let lost = null;
            if (/webgl/.test(info.type)) {
                try { lost = origGetContext.call(c, info.type).isContextLost(); } catch (_) { /* ignore */ }
            }
            out.push({
                type: info.type, id: c.id || null, cls: (c.className && String(c.className).slice(0, 40)) || null,
                px: c.width + 'x' + c.height, css: r ? Math.round(r.width) + 'x' + Math.round(r.height) : null,
                connected: c.isConnected, shown: !!(r && r.width && r.height && c.offsetParent !== null),
                lost, bornAtS: info.at,
            });
        }
        return out;
    }

    function snapshot(kind, stats) {
        const hw = window.highway;
        let perf = null; try { perf = hw && hw.getPerfStats ? hw.getPerfStats() : null; } catch (_) { /* ignore */ }
        const canvases = canvasReport();
        const activeScreen = document.querySelector('.screen.active');
        const entry = {
            kind, stats,
            uptimeMin: +(performance.now() / 60000).toFixed(1),
            domNodes: document.getElementsByTagName('*').length,
            iframes: document.querySelectorAll('iframe').length,
            videosPlaying: [...document.querySelectorAll('video')].filter((v) => !v.paused).length,
            audiosPlaying: [...document.querySelectorAll('audio')].filter((a) => !a.paused).length,
            infiniteAnimations: (() => { try { return document.getAnimations().filter((a) => a.playState === 'running').length; } catch (_) { return null; } })(),
            canvasCount: canvases.length,
            webglLive: canvases.filter((c) => /webgl/.test(c.type) && c.lost === false).length,
            webglHiddenOrDetached: canvases.filter((c) => /webgl/.test(c.type) && c.lost === false && !c.shown).length,
            // Only the canvases that can cost GPU/compositor time: WebGL ones,
            // and big on-screen 2D ones (skip the dozens of tiny offscreen
            // texture canvases).
            canvases: canvases.filter((c) => /webgl/.test(c.type) || (c.connected && c.css && c.css !== '0x0')),
            screen: activeScreen ? activeScreen.id : null,
            win: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sx: screenX, sy: screenY, sw: screen.width, sh: screen.height },
            focused: document.hasFocus(), visibility: document.visibilityState,
            heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
            highway: perf,
            renderer: (() => { try { return hw && hw.isDefaultRenderer ? (hw.isDefaultRenderer() ? '2d' : 'plugin') : null; } catch (_) { return null; } })(),
            recentEvents: events.slice(-15),
        };
        console.warn('[highway_tweaks] ' + kind, entry);
        fetch('/api/plugins/highway_tweaks/log', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
        }).catch(() => { /* server not reachable — console copy above still exists */ });
    }

    // Sampling: 5 s windows, only while the chart clock is advancing.
    const WINDOW_MS = 5000;
    let intervals = [], lastFrame = 0, winStart = 0, rafAtWinStart = 0;
    let lastChartT = NaN, lastMoveAt = -Infinity, playingSince = 0, badWindows = 0;
    let lastJankLogAt = -Infinity, baselineLogged = false, jankEpisodes = 0;

    function isPlaying() {
        const hw = window.highway;
        if (!hw || typeof hw.getTime !== 'function') return false;
        let t; try { t = hw.getTime(); } catch (_) { return false; }
        const nowP = performance.now();
        if (Number.isFinite(t) && t !== lastChartT) { lastChartT = t; lastMoveAt = nowP; }
        // Chart clock moved recently = playing (tolerates a frame or two
        // where the clock didn't tick, which would otherwise reset windows).
        return nowP - lastMoveAt < 250 && document.visibilityState === 'visible';
    }

    function tick(now) {
        origRaf.call(window, tick);
        if (!isPlaying()) { intervals = []; lastFrame = 0; winStart = 0; playingSince = 0; return; }
        if (!playingSince) playingSince = now;
        if (lastFrame) intervals.push(now - lastFrame);
        lastFrame = now;
        if (!winStart) { winStart = now; rafAtWinStart = rafCalls; return; }
        if (now - winStart < WINDOW_MS || intervals.length < 30) return;

        const sorted = intervals.slice().sort((a, b) => a - b);
        const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
        const median = pct(0.5);
        // A "dropped" frame took noticeably longer than the typical frame.
        const dropped = intervals.filter((d) => d > median * 1.5).length;
        const stats = {
            fps: +(intervals.length * 1000 / (now - winStart)).toFixed(1),
            droppedPct: +(100 * dropped / intervals.length).toFixed(1),
            p50: median, p90: pct(0.9), p99: pct(0.99),
            rafPerFrame: +((rafCalls - rafAtWinStart) / intervals.length).toFixed(2),
        };
        intervals = []; winStart = now; rafAtWinStart = rafCalls;
        window.__highwayTweaks.lastStats = stats;

        // One healthy baseline per session, ~1 min into playback, for comparison.
        if (!baselineLogged && now - playingSince > 60000 && stats.droppedPct < 3) {
            baselineLogged = true;
            snapshot('baseline', stats);
        }
        badWindows = stats.droppedPct >= 10 ? badWindows + 1 : 0;
        if (badWindows >= 2 && now - lastJankLogAt > 120000) {
            lastJankLogAt = now;
            jankEpisodes++;
            snapshot('jank', stats);
        }
    }
    origRaf.call(window, tick);

    // Manual trigger from devtools / CDP: highwayTweaksSnapshot()
    window.highwayTweaksSnapshot = () => snapshot('manual', window.__highwayTweaks.lastStats || null);
})();

// ── 4. Early/late timing gauge ──────────────────────────────────────────
// note_detect only labels misses EARLY/LATE on the 2D highway (the 3D
// highway suppresses its overlay), and gives no running picture of whether
// you're consistently ahead or behind — which is what you need to set the
// Audio Latency Offset. This adds a gauge under note_detect's score HUD:
// the last N timed notes (hits and timing misses) as ticks, their median,
// and the latency value that would centre them (with an Apply button).
//
// Sign: timingError = (detect time - latencyOffset) - note time, so + is
// late and raising the offset by the median centres it. Samples are stored
// latency-independent (error + offset at judgment time), so moving the
// slider re-centres the gauge immediately. Colours are blue (early) vs
// orange (late) — safe for red-green colour blindness.
// Notes off by more than the Timing Tolerance can't be matched at all and
// never reach the gauge (they count as plain misses).
//
// A/V offset. note_detect judges against the highway's (visual) clock, so
// when you play by watching the highway a wrong A/V offset cancels out and
// never shows in these numbers; judgments alone can't tell input latency
// from A/V offset. The "A/V check" button measures the difference: keep
// playing normally (that median is the reference), press it, then play
// ~12 notes by ear without looking at the highway. If you land later or
// earlier by ear than by eye, the audio and visuals disagree, and the
// gauge suggests the A/V offset that lines them up (Apply sets it). The
// sample window resets whenever the A/V offset changes.
(function timingGauge() {
    const N = 24, RANGE = 150, MIN_N = 6, DEAD = 12, EAR_N = 12, AV_DEAD = 15;
    const EARLY = '#66c7ff', LATE = '#ff9a40', OK = '#e5e7eb';
    let raw = [], lastTotal = 0, lastMiss = null, el = null;
    let check = null;          // A/V check: { base: eye median (latency-free), ear: [], done: { delta } }
    let lastAv = null;

    const latMs = () => {
        try { return Math.round(window.__hwtNdLatency() * 1000); } catch (_) { return null; }
    };
    const avMs = () => {
        try { return Math.round(window.highway.getAvOffset()); } catch (_) { return null; }
    };
    const median = (a) => {
        const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const fmt = (ms) => (ms > 0 ? '+' : '') + Math.round(ms) + ' ms';
    const BTN = 'pointer-events:auto;cursor:pointer;margin-left:6px;padding:1px 7px;border-radius:4px;' +
        'border:1px solid #4b5563;background:#1f2937;color:#e5e7eb;font:12px system-ui,sans-serif;';

    function ensureEl() {
        const hud = document.querySelector('.nd-hud');
        if (!hud) return null;
        if (el && el.parentNode === hud) return el;
        el = document.createElement('div');
        el.className = 'hwt-timing';
        el.style.cssText = 'margin-top:10px;font:13px ui-monospace,monospace;color:#9ca3af;text-align:right;';
        el.innerHTML =
            '<div class="hwt-t-head"></div>' +
            '<div style="position:relative;width:240px;height:22px;margin:4px 0 2px auto;' +
                'background:rgba(0,0,0,.45);border-radius:3px;overflow:hidden">' +
                '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#6b7280"></div>' +
                '<div class="hwt-t-ticks"></div>' +
                '<div class="hwt-t-med" style="position:absolute;top:0;bottom:0;width:3px;margin-left:-1px;display:none"></div>' +
            '</div>' +
            '<div style="width:240px;margin-left:auto;display:flex;justify-content:space-between;color:#6b7280">' +
                '<span style="color:' + EARLY + '">early</span><span>' + RANGE + 'ms</span><span style="color:' + LATE + '">late</span></div>' +
            '<div class="hwt-t-hint" style="margin-top:2px"></div>' +
            '<div class="hwt-t-av" style="margin-top:4px"></div>' +
            '<div class="hwt-t-miss" style="margin-top:2px;font-weight:bold"></div>';
        el.addEventListener('click', onClick);
        hud.appendChild(el);
        return el;
    }

    function onClick(ev) {
        const b = ev.target.closest && ev.target.closest('button[data-act]');
        if (!b) return;
        ev.stopPropagation();
        const act = b.dataset.act, v = Number(b.dataset.v);
        if (act === 'lat' && Number.isFinite(v)) {
            try { window.noteDetect.applySettings({ latencyOffset: v / 1000 }); } catch (e) { console.warn('[highway_tweaks] latency apply failed', e); }
        } else if (act === 'av' && Number.isFinite(v)) {
            try { window.setAvOffsetMs(v); } catch (e) { console.warn('[highway_tweaks] A/V apply failed', e); }
            check = null;
        } else if (act === 'check') {
            if (raw.length >= MIN_N) check = { base: median(raw), ear: [], done: null };
        } else if (act === 'cancel') {
            check = null;
        }
        render();
    }

    function renderAv(box) {
        const av = avMs();
        const avTxt = 'A/V offset <b style="color:' + OK + '">' + (av == null ? '?' : av + ' ms') + '</b>';
        if (!check) {
            box.innerHTML = avTxt + (raw.length >= MIN_N
                ? '<button data-act="check" style="' + BTN + '" title="Compare playing by ear with playing by eye">A/V check</button>'
                : ' <span style="color:#6b7280">(A/V check after ' + MIN_N + ' notes)</span>');
            return;
        }
        if (!check.done) {
            box.innerHTML = '<b style="color:' + LATE + '">A/V check:</b> play by ear, eyes off the highway ' +
                check.ear.length + '/' + EAR_N + '<button data-act="cancel" style="' + BTN + '">cancel</button>';
            return;
        }
        const d = check.done.delta;
        if (av == null || Math.abs(d) < AV_DEAD) {
            box.innerHTML = avTxt + ' <span style="color:#6b7280">ear vs eye ' + fmt(d) + ': A/V looks right</span>' +
                '<button data-act="cancel" style="' + BTN + '">ok</button>';
        } else {
            const want = Math.max(-1000, Math.min(1000, Math.round(av - d)));
            box.innerHTML = 'by ear you play ' + fmt(d) + (d > 0 ? ' later' : ' earlier') + ' than by eye<br>' +
                (want > av ? '▲ raise' : '▼ lower') + ' A/V offset ' + av + ' → <b style="color:' + OK + '">' + want + ' ms</b>' +
                '<button data-act="av" data-v="' + want + '" style="' + BTN + '">Apply</button>' +
                '<button data-act="cancel" style="' + BTN + '">skip</button>';
        }
    }

    function render() {
        const e = ensureEl();
        if (!e) return;
        const L = latMs();
        const av = avMs();
        if (av != null && lastAv != null && av !== lastAv) { raw = []; check = null; }   // offset moved: old samples are stale
        lastAv = av;
        const head = e.querySelector('.hwt-t-head'), hint = e.querySelector('.hwt-t-hint');
        const ticks = e.querySelector('.hwt-t-ticks'), med = e.querySelector('.hwt-t-med');
        const missEl = e.querySelector('.hwt-t-miss');
        const pos = (ms) => (50 + 50 * Math.max(-1, Math.min(1, ms / RANGE))) + '%';
        const col = (ms) => (Math.abs(ms) < DEAD ? OK : ms < 0 ? EARLY : LATE);
        const byEar = !!(check && !check.done);

        const shown = byEar ? check.ear : raw;
        if (!shown.length || L == null) {
            head.textContent = byEar ? 'timing (by ear): waiting for notes' : 'timing: waiting for notes';
            ticks.innerHTML = ''; med.style.display = 'none'; hint.textContent = '';
        } else {
            const errs = shown.map((r) => r - L);
            ticks.innerHTML = errs.map((ms, i) =>
                '<div style="position:absolute;top:3px;bottom:3px;width:2px;margin-left:-1px;left:' + pos(ms) +
                ';background:' + col(ms) + ';opacity:' + (0.25 + 0.75 * (i + 1) / errs.length).toFixed(2) + '"></div>').join('');
            const m = median(errs);
            med.style.display = '';
            med.style.left = pos(m);
            med.style.background = col(m);
            med.style.boxShadow = '0 0 6px ' + col(m);
            const word = Math.abs(m) < DEAD ? 'on time' : m < 0 ? 'EARLY' : 'LATE';
            head.innerHTML = (byEar ? 'by ear ' : 'timing ') + '<span style="color:' + col(m) + ';font-weight:bold;font-size:17px">' +
                (Math.abs(m) < DEAD ? '' : fmt(m) + ' ') + word + '</span> <span style="color:#6b7280">(median of ' + errs.length + ')</span>';
            if (byEar || errs.length < MIN_N) {
                hint.textContent = '';
            } else if (Math.abs(m) < DEAD) {
                hint.innerHTML = '<span style="color:#6b7280">latency offset ' + L + ' ms looks right</span>';
            } else {
                const want = Math.round(L + m), clamped = Math.max(0, Math.min(250, want));
                hint.innerHTML = (m > 0 ? '▲ raise' : '▼ lower') + ' Audio Latency Offset ' + L + ' → <b style="color:' + OK + '">' +
                    clamped + ' ms</b>' + (clamped !== want ? ' (slider limit)' : '') +
                    (clamped !== L ? '<button data-act="lat" data-v="' + clamped + '" style="' + BTN + '">Apply</button>' : '');
            }
        }
        renderAv(e.querySelector('.hwt-t-av'));
        if (lastMiss && performance.now() - lastMiss.at < 1500) {
            missEl.style.color = lastMiss.ms < 0 ? EARLY : LATE;
            missEl.style.opacity = String(1 - (performance.now() - lastMiss.at) / 1500);
            missEl.textContent = 'miss: ' + (lastMiss.ms < 0 ? 'EARLY ' : 'LATE ') + fmt(lastMiss.ms);
        } else {
            missEl.textContent = '';
        }
    }

    window.__hwtOnJudgment = (j) => {
        if (!j) return;
        // New song / scoring reset → start the gauge over.
        try {
            const st = window.noteDetect && window.noteDetect.getStats && window.noteDetect.getStats();
            const total = st ? st.hits + st.misses : 0;
            if (st && total < lastTotal) { raw = []; lastMiss = null; check = null; }
            lastTotal = total;
        } catch (_) { /* ignore */ }
        const L = latMs();
        if (!Number.isFinite(j.timingError) || L == null) return;
        if (check && !check.done) {
            // The A/V check uses hits only: their timing is the trustworthy part.
            if (j.hit) check.ear.push(j.timingError + L);
            if (check.ear.length >= EAR_N) check.done = { delta: median(check.ear) - check.base };
        } else {
            raw.push(j.timingError + L);
            if (raw.length > N) raw.shift();
        }
        if (!j.hit && (j.timingState === 'EARLY' || j.timingState === 'LATE')) {
            lastMiss = { ms: j.timingError, at: performance.now() };
        }
        render();
    };
    // Repaint for slider moves and the fading miss label; cheap, and a no-op
    // while note_detect's HUD isn't on screen.
    setInterval(() => { if (document.querySelector('.nd-hud')) render(); }, 200);
    window.highwayTweaksTimingReset = () => { raw = []; lastMiss = null; check = null; render(); };
})();

// ── 4b. Judgment log ────────────────────────────────────────────────────
// Every counted note_detect judgment of a song (time, chord, hit, early /
// late, timing error, strings heard) is posted to the plugin's log
// (jank_log.jsonl, kind "judgments") when the song ends or changes, so
// missed notes can be analysed afterwards. Off: localStorage
// highwayTweaksNoJudgmentLog = '1'.
(function judgmentLog() {
    let off = false;
    try { off = localStorage.getItem('highwayTweaksNoJudgmentLog') === '1'; } catch (_) { /* ignore */ }
    if (off) return;
    let buf = [], verdicts = [], song = null;
    const r = (x, k) => (Number.isFinite(x) ? Math.round(x * k) / k : null);
    window.__hwtOnVerdict = (v, cn) => {
        if (!v || !cn || verdicts.length >= 6000) return;
        verdicts.push({ t: r(cn.t, 1000), s: cn.s, f: cn.f, d: v.detected ? 1 : 0, dt: r(v.detectedSongTime, 1000),
            ce: r(v.centsError, 1), snr: r(v.snr, 10) });
    };
    function flush(reason) {
        if (!buf.length) { verdicts = []; return; }
        let nd = null;
        try { nd = JSON.parse(localStorage.getItem('slopsmith_notedetect') || 'null'); } catch (_) { /* ignore */ }
        let av = null;
        try { av = window.highway.getAvOffset(); } catch (_) { /* ignore */ }
        const entry = { kind: 'judgments', reason, song, av_offset_ms: av, settings: nd && {
            latencyOffset: nd.latencyOffset, timingTolerance: nd.timingTolerance, timingHitThreshold: nd.timingHitThreshold,
            chordTimingHitThreshold: nd.chordTimingHitThreshold, pitchTolerance: nd.pitchTolerance, chordHitRatio: nd.chordHitRatio },
            events: buf, verdicts };
        buf = []; verdicts = [];
        try {
            fetch('/api/plugins/highway_tweaks/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry), keepalive: true }).catch(() => {});
        } catch (_) { /* ignore */ }
    }
    const prev = window.__hwtOnJudgment;
    window.__hwtOnJudgment = (j, section) => {
        if (prev) { try { prev(j, section); } catch (_) { /* ignore */ } }
        if (!j) return;
        if (!song) {
            const cs = window.slopsmith && window.slopsmith.currentSong;
            song = cs ? { filename: cs.filename, arrangement: cs.arrangement, title: cs.title } : null;
        }
        buf.push({ t: r(j.noteTime, 1000), c: j.chord ? 1 : 0, h: j.hit ? 1 : 0, ts: j.timingState || null,
            te: Number.isFinite(j.timingError) ? j.timingError : null, hs: j.hitStrings, tt: j.totalStrings,
            sc: r(j.score, 100), pe: r(j.pitchError, 1) });
        if (buf.length >= 2000) flush('full');
    };
    const bus = window.slopsmith;
    if (bus && bus.on) {
        bus.on('song:ended', () => flush('ended'));
        bus.on('song:loading', () => { flush('next-song'); song = null; });
        bus.on('song:stop', () => flush('stop'));
    }
    window.addEventListener('beforeunload', () => flush('unload'));
})();

// ── 5. Performance HUD + streak effects ─────────────────────────────────
// Replaces note_detect's small accuracy/streak/count lines with:
//  - a stats panel (top right, above the timing gauge): big accuracy, last-50
//    form, current section pass, single-note vs chord accuracy, pitch
//    tendency, and why notes were missed;
//  - a large Rock Band-style streak counter with a 1x–4x multiplier
//    (left, vertically centred), plus the per-song best kept in localStorage;
//  - an "on fire" glow around the highway once the streak reaches 50
//    (gold 50+, blue 100+, purple 200+), with milestone popups every 50 and
//    a "streak ended" popup when a 25+ streak breaks.
// Colours stay off the red-green axis. All DOM, so it works over the 3D
// highway. Settings: highwayTweaksHud({ scale: 1.2 }) / ({ off: true }).
(function perfHud() {
    const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
    const LSset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
    if (LS('hwtPerfHudOff', '0') === '1') {
        window.highwayTweaksHud = (o) => { if (o && o.off === false) LSset('hwtPerfHudOff', '0'); };
        return;
    }
    const GOLD = '#ffc531', BLUE = '#45c8ff', PURPLE = '#b77bff', ORANGE = '#ff9a40', DIM = '#8b95a5';
    const TIERS = [[200, PURPLE], [100, BLUE], [50, GOLD]];
    const fireColor = (s) => { for (const [n, c] of TIERS) if (s >= n) return c; return null; };
    const MULT_COL = ['#e5e7eb', BLUE, GOLD, ORANGE];

    const css = document.createElement('style');
    css.textContent = `
        /* The note_detect HUD becomes one stats card in the empty space on the
           right of the highway: below the 3D highway's "Now / Up Next" section
           card (top right) and above the fretboard. Children are zoomed by
           --hwt-scale (auto from window height) — the card itself isn't, so its
           %-based position stays put. */
        .nd-hud { top: 19% !important; right: 1.2% !important; text-align: left !important;
            background: rgba(8, 12, 18, .66); border: 1px solid rgba(255,255,255,.08);
            border-radius: calc(12px * var(--hwt-scale, 1));
            padding: calc(10px * var(--hwt-scale, 1)) calc(14px * var(--hwt-scale, 1));
            max-height: 62%; overflow: hidden;
            /* Two columns: live stats + timing | song / section / weak spots / Rocksmith */
            display: grid !important; grid-template-columns: auto auto; column-gap: calc(22px * var(--hwt-scale, 1));
            align-items: start; }
        .nd-hud > * { zoom: var(--hwt-scale, 1); width: 270px; grid-column: 1; }
        .nd-hud > .hwt-perf { grid-row: 1; }
        .nd-hud > .hwt-timing { grid-row: 3; }
        .nd-hud > .nd-hud-detected { grid-row: 4; }
        .nd-hud > .pc-score { grid-column: 2; grid-row: 1 / span 5; }
        .nd-hud > .nd-drill { grid-row: 5; }
        .nd-hud > .pc-score > :first-child { margin-top: 0 !important; border-top: 0 !important; padding-top: 0 !important; }
        .nd-hud .nd-hud-accuracy, .nd-hud .nd-hud-streak, .nd-hud .nd-hud-counts { display: none !important; }
        .nd-hud .nd-hud-detected { font-size: 14px !important; margin-top: 6px !important; text-align: right; }
        .nd-hud .nd-drill-header, .nd-hud .nd-drill-list { font-size: 13px !important; }
        .nd-hud .nd-hud-detected:empty { display: none; }
        /* Stat rows: label on the left, value(s) on the right. */
        .nd-hud .row { display: flex; align-items: baseline; justify-content: flex-end; gap: 5px; margin-top: 4px; white-space: nowrap; }
        .nd-hud .row > .lbl:first-child { margin-right: auto; }
        .hwt-perf { font: 15px system-ui, sans-serif; color: #cbd5e1; text-shadow: 0 1px 3px #000; }
        .hwt-perf .head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 4px; }
        .hwt-perf .acc { font: 800 44px/1 system-ui, sans-serif; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
        .hwt-perf .head .lbl { text-align: right; font-size: 13px; line-height: 1.25; }
        .hwt-perf .row b { color: #f1f5f9; }
        .hwt-perf .lbl { color: ${DIM}; }
        .hwt-timing { text-align: left !important; border-top: 1px solid rgba(255,255,255,.12); padding-top: 8px; }
        .hwt-timing > div[style*="width:240px"] { width: 100% !important; }
        .hwt-streak { position: absolute; left: 1.5%; top: 50%; transform: translateY(-50%); z-index: 20;
            pointer-events: none; text-align: center; width: max-content; font-family: system-ui, sans-serif;
            text-shadow: 0 2px 8px #000; transition: opacity .3s; }
        .hwt-streak > * { zoom: var(--hwt-scale, 1); }
        .hwt-streak .num { font: 900 104px/1 system-ui, sans-serif; letter-spacing: -3px; transition: color .3s; }
        .hwt-streak .cap { font: 700 14px system-ui, sans-serif; letter-spacing: 3px; color: ${DIM}; }
        .hwt-streak .mult { font: 900 34px/1 system-ui, sans-serif; margin-top: 10px; }
        .hwt-streak .pips { display: flex; gap: 4px; justify-content: center; margin-top: 6px; }
        .hwt-streak .pips i { width: 11px; height: 11px; border-radius: 50%; background: rgba(255,255,255,.12); }
        .hwt-streak .best { font: 13px/1.4 system-ui, sans-serif; color: ${DIM}; margin-top: 10px; white-space: pre-line; }
        .hwt-fire { position: absolute; inset: 0; z-index: 5; pointer-events: none; opacity: 0;
            transition: opacity .5s; will-change: opacity; }
        .hwt-fire.on { opacity: 1; }
        .hwt-fire > div { position: absolute; inset: 0; animation: hwt-pulse 1.1s ease-in-out infinite alternate; will-change: opacity; }
        @keyframes hwt-pulse { from { opacity: .55; } to { opacity: 1; } }
        .hwt-pop { position: absolute; left: 50%; top: 38%; z-index: 25; pointer-events: none; white-space: nowrap;
            transform: translate(-50%, -50%); font: 900 calc(64px * var(--hwt-scale, 1)) system-ui, sans-serif;
            text-shadow: 0 0 24px currentColor, 0 3px 8px #000; }
        .hwt-pop.small { font-size: calc(30px * var(--hwt-scale, 1)); top: 46%; text-shadow: 0 3px 8px #000; }
    `;
    document.head.appendChild(css);
    // Auto-size to the window: 1x at ~900 px tall (so ~2.2x on a 4K-height
    // window), times the user's own multiplier from highwayTweaksHud({scale}).
    const applyScale = () => {
        const auto = Math.max(1, Math.min(2.8, (window.innerHeight || 900) / 900));
        const user = Number(LS('hwtHudScale', '1')) || 1;
        document.documentElement.style.setProperty('--hwt-scale', (auto * user).toFixed(3));
    };
    applyScale();
    window.addEventListener('resize', applyScale);
    window.highwayTweaksHud = (o) => {
        o = o || {};
        if (Number.isFinite(o.scale)) { LSset('hwtHudScale', String(o.scale)); applyScale(); }
        if (o.off === true) LSset('hwtPerfHudOff', '1');
        return { scale: Number(LS('hwtHudScale', '1')), off: LS('hwtPerfHudOff', '0') === '1', note: 'off takes effect after restart' };
    };

    function stats() {
        try { return window.noteDetect && window.noteDetect.getStats ? window.noteDetect.getStats() : null; } catch (_) { return null; }
    }

    // ── per-song judgment stats ──
    let S, lastTotal = 0, dirty = true;
    const reset = () => {
        S = { recent: [], singles: [0, 0], chords: [0, 0], pitch: [], why: { unheard: 0, early: 0, late: 0, pitch: 0, chord: 0 },
            sec: null, secH: 0, secM: 0 };
    };
    reset();
    const prevHook = window.__hwtOnJudgment;
    window.__hwtOnJudgment = (j, section) => {
        if (prevHook) { try { prevHook(j, section); } catch (_) { /* ignore */ } }
        if (!j) return;
        const st = stats();
        const total = st ? st.hits + st.misses : 0;
        if (st && total < lastTotal) reset();
        lastTotal = total;
        S.recent.push(!!j.hit); if (S.recent.length > 50) S.recent.shift();
        const bucket = j.chord ? S.chords : S.singles;
        bucket[j.hit ? 0 : 1]++;
        if (!j.chord && Number.isFinite(j.pitchError)) { S.pitch.push(j.pitchError); if (S.pitch.length > 24) S.pitch.shift(); }
        if (!j.hit) {
            if (j.chord) S.why.chord++;
            else if (j.detectedMidi == null) S.why.unheard++;
            else if (j.timingState === 'EARLY') S.why.early++;
            else if (j.timingState === 'LATE') S.why.late++;
            else S.why.pitch++;
        }
        if (section !== S.sec) { S.sec = section || null; S.secH = 0; S.secM = 0; }
        if (j.hit) S.secH++; else S.secM++;
        dirty = true;
    };

    // ── DOM ──
    let perf = null, streakEl = null, fire = null;
    let lastStreak = -1, songKey = '', songBest = 0, bestAnnounced = false;
    function ensure(hud) {
        const root = hud.parentNode;
        if (!perf || perf.parentNode !== hud) {
            perf = document.createElement('div');
            perf.className = 'hwt-perf';
            hud.insertBefore(perf, hud.firstChild);
            dirty = true;
        }
        if (!streakEl || streakEl.parentNode !== root) {
            streakEl = document.createElement('div');
            streakEl.className = 'hwt-streak';
            streakEl.innerHTML = '<div class="num">0</div><div class="cap">NOTE STREAK</div>' +
                '<div class="mult"></div><div class="pips">' + '<i></i>'.repeat(10) + '</div><div class="best"></div>';
            root.appendChild(streakEl);
            fire = document.createElement('div');
            fire.className = 'hwt-fire';
            fire.innerHTML = '<div></div>';
            root.appendChild(fire);
            lastStreak = -1;
        }
    }
    const pct = (h, t) => (t > 0 ? Math.round(100 * h / t) : null);
    const accCol = (p) => (p >= 95 ? GOLD : p >= 85 ? '#f1f5f9' : p >= 70 ? '#9fd8ff' : DIM);
    const esc = (s) => String(s).replace(/[<>&"]/g, '');

    function renderPerf(st) {
        const total = st.hits + st.misses;
        const acc = pct(st.hits, total);
        const rows = [];
        rows.push('<div class="head"><div class="acc" style="color:' + (acc == null ? DIM : accCol(acc)) + '">' +
            (acc == null ? '–' : (100 * st.hits / total).toFixed(2) + '%') + '</div><div class="lbl">' + st.hits + ' / ' + total + '<br>notes hit</div></div>');
        if (S.recent.length >= 10) {
            const f = pct(S.recent.filter(Boolean).length, S.recent.length);
            const d = acc == null ? 0 : f - acc;
            const arrow = d >= 3 ? ' <span style="color:' + GOLD + '">▲</span>' : d <= -3 ? ' <span style="color:' + BLUE + '">▼</span>' : '';
            rows.push('<div class="row"><span class="lbl">last ' + S.recent.length + '</span> <b>' + f + '%</b>' + arrow + '</div>');
        }
        // Current-section pass vs. best lives in play_counts' "Section" block.
        if (S.sec && S.secH + S.secM > 0 && !window.__songScores) {
            rows.push('<div class="row"><span class="lbl">' + esc(S.sec) + '</span> <b>' +
                pct(S.secH, S.secH + S.secM) + '%</b> <span class="lbl">(' + S.secH + '/' + (S.secH + S.secM) + ')</span></div>');
        }
        const sp = pct(S.singles[0], S.singles[0] + S.singles[1]), cp = pct(S.chords[0], S.chords[0] + S.chords[1]);
        if (sp != null || cp != null) {
            if (sp != null) rows.push('<div class="row"><span class="lbl">single notes</span><b>' + sp + '%</b></div>');
            if (cp != null) rows.push('<div class="row"><span class="lbl">chords</span><b>' + cp + '%</b></div>');
        }
        if (S.pitch.length >= 6) {
            const s = S.pitch.slice().sort((a, b) => a - b), m = Math.round(s[s.length >> 1]);
            const word = Math.abs(m) <= 5 ? 'in tune' : m > 0 ? 'sharp' : 'flat';
            const c = Math.abs(m) <= 5 ? '#f1f5f9' : m > 0 ? ORANGE : BLUE;
            rows.push('<div class="row"><span class="lbl">pitch</span> <b style="color:' + c + '">' +
                (Math.abs(m) <= 5 ? '' : (m > 0 ? '+' : '') + m + '¢ ') + word + '</b></div>');
        }
        const w = S.why, parts = [];
        if (w.unheard) parts.push(w.unheard + ' not heard');
        if (w.late) parts.push(w.late + ' late');
        if (w.early) parts.push(w.early + ' early');
        if (w.pitch) parts.push(w.pitch + ' pitch');
        if (w.chord) parts.push(w.chord + ' chord');
        if (parts.length) {
            rows.push('<div class="row" style="font-size:13px"><span class="lbl">misses</span><span style="color:#cbd5e1;white-space:normal;text-align:right">' +
                parts.join(' · ') + '</span></div>');
        }
        perf.innerHTML = rows.join('');
    }

    // ── streak / fire / popups ──
    const curSongKey = () => {
        const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; };
        return t('hud-artist') + '|' + t('hud-title') + '|' + t('hud-arrangement');
    };
    function popup(text, color, small) {
        const root = streakEl && streakEl.parentNode;
        if (!root) return;
        const p = document.createElement('div');
        p.className = 'hwt-pop' + (small ? ' small' : '');
        p.style.color = color;
        p.textContent = text;
        root.appendChild(p);
        if (!p.animate) { setTimeout(() => p.remove(), 1600); return; }
        const a = p.animate(small
            ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }]
            : [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
               { opacity: 1, transform: 'translate(-50%,-50%) scale(1.12)', offset: 0.15 },
               { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.3 },
               { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.75 },
               { opacity: 0, transform: 'translate(-50%,-50%) scale(1.05)' }],
            { duration: small ? 1600 : 2000, easing: 'ease-out' });
        a.onfinish = () => p.remove();
    }
    window.__hwtPopup = (text, color, small) => popup(text, color || GOLD, small);
    function renderStreak(st) {
        const s = st.streak | 0;
        const k = curSongKey();
        if (k !== songKey) {
            songKey = k;
            songBest = Number(LS('hwtBest:' + k, '0')) || 0;
            bestAnnounced = false;
            lastStreak = -1;
        }
        if (s === lastStreak) return;
        const prev = lastStreak;
        lastStreak = s;
        // Milestone / break popups (skip the first sample after a (re)build).
        if (prev >= 0) {
            if (s > prev && s >= 50 && Math.floor(s / 50) > Math.floor(prev / 50)) {
                popup(Math.floor(s / 50) * 50 + ' NOTE STREAK!', fireColor(s) || GOLD);
            } else if (s > songBest && songBest >= 20 && !bestAnnounced) {
                bestAnnounced = true;
                popup('NEW SONG BEST!', GOLD, true);
            }
            if (s < prev && prev >= 25) popup('streak ended at ' + prev, DIM, true);
        }
        if (s > songBest) { songBest = s; LSset('hwtBest:' + k, String(s)); }

        const mult = Math.min(4, 1 + Math.floor(s / 10));
        const mc = MULT_COL[mult - 1];
        const fc = fireColor(s);
        for (const el of streakEl.querySelectorAll(':scope > .num, :scope > .cap')) el.style.opacity = s > 0 ? '1' : '0.45';
        const num = streakEl.querySelector('.num');
        num.textContent = s;
        num.style.color = fc || (s >= 10 ? mc : '#f1f5f9');
        const multEl = streakEl.querySelector('.mult');
        multEl.textContent = mult + 'x';
        multEl.style.color = mc;
        const lit = mult === 4 ? 10 : s % 10;
        streakEl.querySelectorAll('.pips i').forEach((p, i) => {
            p.style.background = i < lit ? mc : '';
            p.style.boxShadow = i < lit ? '0 0 6px ' + mc : '';
        });
        streakEl.querySelector('.best').textContent = 'session best ' + (st.bestStreak | 0) + (songBest ? '\nsong best ' + songBest : '');
        if (fc) {
            fire.firstChild.style.boxShadow = 'inset 0 0 90px 14px ' + fc + 'aa, inset 0 0 22px 2px ' + fc;
            fire.firstChild.style.background = 'linear-gradient(to top, ' + fc + '40, transparent 45%)';
            fire.classList.add('on');
        } else {
            fire.classList.remove('on');
        }
    }

    setInterval(() => {
        const hud = document.querySelector('.nd-hud');
        if (!hud) {
            if (streakEl) streakEl.style.display = 'none';
            if (fire) fire.classList.remove('on');
            return;
        }
        ensure(hud);
        streakEl.style.display = '';
        const st = stats();
        if (!st) return;
        const total = st.hits + st.misses;
        if (total < lastTotal) { reset(); dirty = true; }
        lastTotal = total;
        renderStreak(st);
        if (dirty) { dirty = false; renderPerf(st); }
    }, 100);
})();

// ── 5b. Score ───────────────────────────────────────────────────────────
// Rock Band-style score from note_detect's judgments:
//  - a hit single note is worth 50, a chord 50 per string heard;
//  - timing: within 25 ms x1, within 50 ms x0.8, else x0.6;
//  - technique bonus: +25% bends and slides, +100% harmonics, +200% pinch
//    harmonics (they are hard to sound; a pinch hit pops up);
//  - technical bonus x1.5 for single notes in dense passages (>= 6 notes in
//    the surrounding second); a run of them pops "TECHNICAL RUN h/n +pts";
//  - streak multiplier x1-x4 (one step per 10 notes in a row, same as the
//    streak counter); a miss scores nothing and resets the multiplier;
//  - everything scaled by playback speed x difficulty (mastery) slider;
//  - solos (chart sections named "solo"): a live solo meter (% of the
//    solo's notes hit) at the top of the highway, a blue glow on the
//    highway while the solo plays, and a solo bonus at its end: 100 per
//    note hit, doubled for a perfect solo, with a Rock Band-style rating.
// Accuracy elsewhere in the card shows two decimals. The final score and
// its breakdown are exposed as window.__hwtScore for play_counts (best
// score per song, end-of-song card).
(function scoreEngine() {
    const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
    if (LS('hwtPerfHudOff', '0') === '1') return;
    const GOLD = '#ffc531', BLUE = '#45c8ff', PURPLE = '#b77bff', ORANGE = '#ff9a40', DIM = '#8b95a5', WHITE = '#f1f5f9';
    const SOLO_RE = /solo/i;
    const DENSE_N = 6, DENSE_WIN = 0.5;           // >= 6 single notes within +-0.5 s
    const RUN_GAP_MS = 700, RUN_MIN = 8;
    // Tested on the highway's own chart notes (sl / slu = -1 means no slide);
    // judgment.chartNote can't be used: the engine path flags every note sl:true.
    // [name, test, bonus share]: harmonics are hard to sound, pinch harmonics hardest.
    const TECH = [['bend', (n) => Number(n.bn) > 0, 0.25], ['slide', (n) => Number(n.sl) >= 0 || Number(n.slu) >= 0, 0.25],
        ['harmonic', (n) => !!n.hm && !n.hp, 1.0], ['pinch harmonic', (n) => !!n.hp, 2.0]];
    const TECH_BONUS = Object.fromEntries(TECH.map(([name, , b]) => [name, b]));
    const rawKey = (t, s) => Math.round(t * 1000) * 10 + (s | 0);
    const fmt = (n) => Math.round(n).toLocaleString('en-US');
    const hw = () => window.highway;

    let SC, chart = null, lastTotal = 0;
    const reset = () => {
        SC = { score: 0, streak: 0, notes: 0, base: 0, timing: 0, tech: 0, techN: {}, dense: 0, soloBonus: 0,
            solos: {}, soloDone: [], run: null, runs: [], feed: [] };
    };
    reset();

    function factorNow() {
        const el = document.getElementById('speed-label');
        const v = el ? parseFloat(el.textContent) : NaN;
        const speed = Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1;
        let mastery = 1;
        try { const m = hw().getMastery(); if (Number.isFinite(m) && m > 0) mastery = Math.min(1, m); } catch (_) { /* ignore */ }
        return speed * mastery;
    }

    // Dense note times + solo sections, rebuilt when the chart changes.
    function chartInfo() {
        let notes = [], chords = [], sections = [];
        try { notes = hw().getNotes() || []; chords = hw().getChords() || []; sections = hw().getSections() || []; } catch (_) { /* ignore */ }
        let nBeats = 0;
        try { nBeats = (hw().getBeats() || []).length; } catch (_) { /* ignore */ }
        const key = notes.length + ':' + chords.length + ':' + (notes[0] ? notes[0].t : '') + ':' + sections.length + ':' + nBeats;
        if (chart && chart.key === key) return chart;
        const T = notes.map((n) => n.t).filter(Number.isFinite).sort((a, b) => a - b);
        const dense = new Set();
        for (let i = 0, lo = 0, hi = 0; i < T.length; i++) {
            while (T[lo] < T[i] - DENSE_WIN) lo++;
            while (hi + 1 < T.length && T[hi + 1] <= T[i] + DENSE_WIN) hi++;
            if (hi - lo + 1 >= DENSE_N) dense.add(Math.round(T[i] * 1000));
        }
        const secs = sections.filter((s) => s && Number.isFinite(s.time)).slice().sort((a, b) => a.time - b.time);
        const solos = [];
        const auto = detectSolos(notes, chords, secs);
        secs.forEach((s, i) => {
            if (!SOLO_RE.test(String(s.name || '')) && !auto.has(i)) return;
            const end = i + 1 < secs.length ? secs[i + 1].time : Infinity;
            // Adjacent solo sections (solo, solo) count as one solo.
            const prev = solos[solos.length - 1];
            if (prev && prev.end === s.time) { prev.end = end; return; }
            solos.push({ id: solos.length, name: auto.has(i) ? 'Solo (' + String(s.name) + ')' : String(s.name), start: s.time, end });
        });
        const raw = new Map();
        for (const n of notes) if (n && Number.isFinite(n.t)) raw.set(rawKey(n.t, n.s), n);
        for (const c of chords) for (const n of (c && c.notes) || []) if (n) raw.set(rawKey(c.t, n.s), n);
        chart = { key, dense, solos, raw };
        return chart;
    }
    const soloAt = (t) => (chart ? chart.solos.find((s) => t >= s.start && t < s.end) : null);

    // Solos the chart doesn't name: official charts often call a solo "interlude",
    // "bridge", "riff" or even "prechorus" (Don't Look Back in Anger, 3:17). A
    // section counts as a solo on the part being played when, compared to the
    // rest of the song, it is mostly single notes (>= 75 %), fast (>= 2.5 per
    // second and >= 1.8x the song's median section), not repeated elsewhere
    // (>= 60 % of its bars have pitch content found at most twice in the
    // chart), up the neck (median fret >= 6) and >= 3 bars. Verses, choruses,
    // intros and no-guitar sections never count. On songs that do name their
    // solo, this flags a real "solo" section ~86 % of the time.
    // Returns the set of section indexes.
    function detectSolos(notes, chords, secs) {
        const found = new Set();
        let beats = [];
        try { beats = (hw().getBeats() || []).filter((b) => b && b.measure >= 0 && Number.isFinite(b.time)); } catch (_) { /* ignore */ }
        if (beats.length < 4 || !secs.length) return found;
        const ev = [];
        for (const n of notes) if (n && Number.isFinite(n.t) && !n.mt) ev.push({ t: n.t, single: true, p: [n.s + ':' + n.f], f: [n.f] });
        for (const c of chords) if (c && Number.isFinite(c.t)) ev.push({ t: c.t, single: false, p: (c.notes || []).map((x) => x.s + ':' + x.f), f: [] });
        ev.sort((x, y) => x.t - y.t);
        const med = (a) => { if (!a.length) return 0; const q = a.slice().sort((x, y) => x - y), m = q.length >> 1; return q.length % 2 ? q[m] : (q[m - 1] + q[m]) / 2; };
        const bars = [];
        for (let i = 0, k = 0; i < beats.length; i++) {
            const a = beats[i].time, b = i + 1 < beats.length ? beats[i + 1].time : a + (a - beats[i - 1].time);
            while (k < ev.length && ev[k].t < a) k++;
            const seg = [];
            for (let j = k; j < ev.length && ev[j].t < b; j++) seg.push(ev[j]);
            const frets = seg.filter((e) => e.single).map((e) => e.f[0]);
            bars.push({ a, b, n: seg.length, singles: frets.length, fret: med(frets),
                sig: [...new Set(seg.flatMap((e) => e.p))].sort().join(',') });
        }
        const counts = new Map();
        for (const x of bars) if (x.n) counts.set(x.sig, (counts.get(x.sig) || 0) + 1);
        const songEnd = bars[bars.length - 1].b;
        const rows = secs.map((s, i) => {
            const end = i + 1 < secs.length ? secs[i + 1].time : songEnd;
            const bs = bars.filter((x) => x.a >= s.time - 0.01 && x.a < end - 0.01);
            const n = bs.reduce((q, x) => q + x.n, 0), singles = bs.reduce((q, x) => q + x.singles, 0);
            return { i, name: String(s.name || ''), bars: bs.length, n, frac: n ? singles / n : 0,
                uniq: bs.length ? bs.filter((x) => x.n && counts.get(x.sig) <= 2).length / bs.length : 0,
                nps: singles / Math.max(1e-3, end - s.time), fret: med(bs.filter((x) => x.singles).map((x) => x.fret)) };
        });
        const songMed = med(rows.filter((r) => r.n).map((r) => r.nps));
        const EXCL = /^(verse|chorus)\d*$|noguitar|silence|^intro/i;
        for (const r of rows) {
            if (!EXCL.test(r.name) && !SOLO_RE.test(r.name) && r.bars >= 3 && r.frac >= 0.75 && r.nps >= 2.5
                && r.uniq >= 0.6 && r.fret >= 6 && r.nps >= 1.8 * Math.max(songMed, 0.5)) found.add(r.i);
        }
        return found;
    }

    function feed(text, color) {
        SC.feed.push({ text, color, at: performance.now() });
        if (SC.feed.length > 4) SC.feed.shift();
    }

    function techniquesOf(j) {
        const strings = j.chord ? (j.notes || []).map((n) => n && n.s) : [(j.chartNote || j.note || {}).s];
        const list = strings.filter(Number.isFinite).map((s) => chart.raw.get(rawKey(j.noteTime, s))).filter(Boolean);
        const out = [];
        for (const [name, test] of TECH) if (list.some((n) => n && test(n))) out.push(name);
        return out;
    }

    function closeRun(force) {
        const r = SC.run;
        if (!r) return;
        if (!force && performance.now() - r.at < 900) return;
        SC.run = null;
        if (r.n >= RUN_MIN) {
            SC.runs.push({ h: r.h, n: r.n, pts: Math.round(r.pts) });
            const pop = window.__hwtPopup;
            if (pop) pop('TECHNICAL RUN ' + r.h + '/' + r.n + '  +' + fmt(r.pts), r.h === r.n ? GOLD : ORANGE, true);
        }
    }

    function closeSolo(s, st) {
        if (st.done) return;
        st.done = true;
        const pct = st.n ? 100 * st.h / st.n : 0;
        const perfect = st.n > 0 && st.h === st.n;
        const bonus = st.h * 100 * (perfect ? 2 : 1) * factorNow();
        SC.score += bonus; SC.soloBonus += bonus;
        const rating = perfect ? 'PERFECT SOLO!' : pct >= 95 ? 'AWESOME SOLO!' : pct >= 90 ? 'GREAT SOLO!' : pct >= 80 ? 'GOOD SOLO!'
            : pct >= 70 ? 'SOLID SOLO' : pct >= 60 ? 'OKAY SOLO' : 'MESSY SOLO';
        SC.soloDone.push({ name: s.name, h: st.h, n: st.n, pct: Math.round(pct * 100) / 100, bonus: Math.round(bonus), rating });
        const pop = window.__hwtPopup;
        if (pop && st.n > 0) {
            pop(rating, perfect ? GOLD : pct >= 90 ? BLUE : WHITE);
            setTimeout(() => pop(pct.toFixed(2) + '%  ·  solo bonus +' + fmt(bonus), perfect ? GOLD : BLUE, true), 900);
        }
    }

    const prevHook = window.__hwtOnJudgment;
    window.__hwtOnJudgment = (j, section) => {
        if (prevHook) { try { prevHook(j, section); } catch (_) { /* ignore */ } }
        if (!j || !Number.isFinite(j.noteTime)) return;
        try {
            const st = window.noteDetect.getStats();
            const total = st.hits + st.misses;
            if (total < lastTotal) reset();
            lastTotal = total;
        } catch (_) { /* ignore */ }
        const info = chartInfo();
        const tms = Math.round(j.noteTime * 1000);
        const mult = Math.min(4, 1 + Math.floor(SC.streak / 10));
        const f = factorNow();
        SC.notes++;
        const dense = !j.chord && info.dense.has(tms);
        let densePts = 0;
        if (j.hit) {
            SC.streak++;
            const base = j.chord ? 50 * Math.max(1, j.hitStrings || 0) : 50;
            const te = Number.isFinite(j.timingError) ? Math.abs(j.timingError) : null;
            const tf = te == null ? 0.8 : te <= 25 ? 1 : te <= 50 ? 0.8 : 0.6;
            const techs = techniquesOf(j);
            const techF = 1 + techs.reduce((q, t) => q + (TECH_BONUS[t] || 0), 0);
            const k = mult * f;
            const timed = base * tf;
            const techPts = timed * (techF - 1);
            densePts = dense ? (timed + techPts) * 0.5 : 0;
            SC.base += base * k;
            SC.timing += (timed - base) * k;
            SC.tech += techPts * k;
            SC.dense += densePts * k;
            densePts *= k;
            SC.score += (timed + techPts) * k + densePts;
            for (const t of techs) SC.techN[t] = (SC.techN[t] || 0) + 1;
            if (techs.length) feed('+' + fmt(techPts * k) + ' ' + techs.join(' + '), PURPLE);
            if (techs.includes('pinch harmonic') && window.__hwtPopup) window.__hwtPopup('PINCH HARMONIC!  +' + fmt(techPts * k), PURPLE, true);
        } else {
            SC.streak = 0;
        }
        if (dense) {
            if (!SC.run || tms - SC.run.lastT > RUN_GAP_MS) { closeRun(true); SC.run = { h: 0, n: 0, pts: 0, lastT: tms, at: 0 }; }
            const r = SC.run;
            r.n++; if (j.hit) r.h++; r.pts += densePts; r.lastT = tms; r.at = performance.now();
        }
        const solo = info.solos.find((s) => j.noteTime >= s.start && j.noteTime < s.end);
        if (solo) {
            const st = SC.solos[solo.id] || (SC.solos[solo.id] = { h: 0, n: 0, done: false });
            if (!st.done) { st.n++; if (j.hit) st.h++; }
        }
    };

    // ── DOM: score block in the stats card, solo meter + glow on the highway ──
    const css = document.createElement('style');
    css.textContent = `
        .hwt-score { font: 15px system-ui, sans-serif; color: #cbd5e1; text-shadow: 0 2px 8px #000; margin-top: 16px;
            text-align: center; min-width: 200px; }
        .hwt-score .pts { font: 900 46px/1 system-ui, sans-serif; color: ${WHITE}; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
        .hwt-score .cap2 { font: 700 13px system-ui, sans-serif; letter-spacing: 3px; color: ${DIM}; margin-top: 2px; }
        .hwt-score .tags { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
        .hwt-score .tag { font: 800 12px system-ui, sans-serif; letter-spacing: 1px; padding: 2px 7px; border-radius: 4px; }
        .hwt-score .feed { font: 700 15px system-ui, sans-serif; margin-top: 4px; }
        .hwt-solo-meter { position: absolute; left: 50%; top: 5%; transform: translateX(-50%); z-index: 22; pointer-events: none;
            text-align: center; font-family: system-ui, sans-serif; text-shadow: 0 2px 8px #000; transition: opacity .4s; opacity: 0; }
        .hwt-solo-meter.on { opacity: 1; }
        .hwt-solo-meter > * { zoom: var(--hwt-scale, 1); }
        .hwt-solo-meter .lbl { font: 800 14px system-ui, sans-serif; letter-spacing: 4px; color: #9fd0ff; }
        .hwt-solo-meter .pct { font: 900 64px/1 system-ui, sans-serif; color: ${WHITE}; font-variant-numeric: tabular-nums; }
        .hwt-solo-meter .bar { width: 260px; height: 8px; margin: 6px auto 0; border-radius: 4px; background: rgba(255,255,255,.12); overflow: hidden; }
        .hwt-solo-meter .bar > div { height: 100%; background: linear-gradient(90deg, #3d7bff, #8fd3ff); }
        .hwt-solo-meter .cnt { font: 13px system-ui, sans-serif; color: #9fb4cc; margin-top: 3px; }
        .hwt-solo-glow { position: absolute; inset: 0; z-index: 4; pointer-events: none; opacity: 0; transition: opacity .6s;
            box-shadow: inset 0 0 120px 24px rgba(61,123,255,.55), inset 0 0 26px 3px rgba(143,211,255,.8);
            background: linear-gradient(to top, rgba(61,123,255,.22), transparent 55%); }
        .hwt-solo-glow.on { opacity: 1; }
    `;
    document.head.appendChild(css);

    let box = null, meter = null, glow = null, lastHtml = '';
    function ensure(hud) {
        const root = hud.parentNode;
        // Score + bonuses live in the streak box on the left (it stays visible in
        // multiplayer, where the stats card is compact).
        const streak = root.querySelector(':scope > .hwt-streak');
        if (streak && (!box || box.parentNode !== streak)) {
            if (box) box.remove();
            box = document.createElement('div');
            box.className = 'hwt-score';
            streak.appendChild(box);
            lastHtml = '';
        }
        if (!meter || meter.parentNode !== root) {
            meter = document.createElement('div');
            meter.className = 'hwt-solo-meter';
            meter.innerHTML = '<div class="lbl">SOLO</div><div class="pct">0%</div><div class="bar"><div style="width:0"></div></div><div class="cnt"></div>';
            root.appendChild(meter);
            glow = document.createElement('div');
            glow.className = 'hwt-solo-glow';
            root.appendChild(glow);
        }
    }

    function render() {
        const hud = document.querySelector('.nd-hud');
        if (!hud) {
            if (meter) meter.classList.remove('on');
            if (glow) glow.classList.remove('on');
            return;
        }
        ensure(hud);
        if (!box) return;
        const info = chartInfo();
        let t = 0;
        try { t = hw().getTime(); } catch (_) { /* ignore */ }
        // Solo meter: from just before the solo until its last judgments are in.
        const live = info.solos.find((s) => t >= s.start - 0.5 && t < s.end + 1.0);
        for (const s of info.solos) {
            const st = SC.solos[s.id];
            if (st && !st.done && t >= s.end + 1.0) closeSolo(s, st);
        }
        if (live) {
            const st = SC.solos[live.id] || { h: 0, n: 0 };
            const p = st.n ? 100 * st.h / st.n : 100;
            meter.querySelector('.pct').textContent = (st.n ? Math.round(p) : 100) + '%';
            meter.querySelector('.pct').style.color = p >= 100 ? GOLD : p >= 90 ? '#8fd3ff' : WHITE;
            meter.querySelector('.bar > div').style.width = p + '%';
            meter.querySelector('.cnt').textContent = st.n ? st.h + ' / ' + st.n + ' notes' : live.name;
            meter.classList.add('on');
        } else {
            meter.classList.remove('on');
        }
        glow.classList.toggle('on', !!soloAt(t));
        closeRun(false);

        const tags = [];
        if (SC.run && SC.run.n >= 3) tags.push(['TECHNICAL ×1.5', ORANGE]);
        if (soloAt(t)) tags.push(['SOLO', BLUE]);
        const f = factorNow();
        if (f < 0.999) tags.push(['×' + f.toFixed(2) + ' speed/difficulty', DIM]);
        const now = performance.now();
        const feedHtml = SC.feed.filter((x) => now - x.at < 2500).map((x) =>
            '<div class="feed" style="color:' + x.color + ';opacity:' + (1 - (now - x.at) / 2500).toFixed(2) + '">' + x.text + '</div>').join('');
        const html = '<div class="pts">' + fmt(SC.score) + '</div><div class="cap2">SCORE</div>' +
            (tags.length ? '<div class="tags">' + tags.map(([s, c]) => '<span class="tag" style="color:' + c + ';border:1px solid ' + c + '66">' + s + '</span>').join('') + '</div>' : '') +
            feedHtml;
        if (html !== lastHtml) { lastHtml = html; box.innerHTML = html; }
    }
    setInterval(render, 120);

    // Song end: close any open solo / technical run so the final score is complete.
    const bus = window.slopsmith;
    if (bus && bus.on) {
        bus.on('song:ended', () => {
            const info = chartInfo();
            for (const s of info.solos) { const st = SC.solos[s.id]; if (st && !st.done) closeSolo(s, st); }
            closeRun(true);
        });
        bus.on('song:loading', () => { reset(); chart = null; lastTotal = 0; });
    }

    window.__hwtScore = {
        get() {
            const r = (x) => Math.round(x);
            return { score: r(SC.score), notes: SC.notes, factor: factorNow(),
                breakdown: { base: r(SC.base), timing: r(SC.timing), technique: r(SC.tech), technical: r(SC.dense), solo: r(SC.soloBonus) },
                techniques: Object.assign({}, SC.techN), solos: SC.soloDone.slice(), runs: SC.runs.slice() };
        },
    };
})();

// ── 6. Compact stats card (multiplayer) + hide it on drums ──────────────
// Side-by-side multiplayer windows leave little room for the full card, so
// in "auto" mode the card goes compact while this window is in a multiplayer
// room (the multiplayer plugin sets <html data-mp-room>): big accuracy +
// hits, and the timing readout/gauge/latency hint (to check sync). Hidden:
// play_counts' column (song/section/weak spots/Rocksmith), the detail rows,
// the drill panel; the streak counter shrinks.
// On a Drums arrangement the whole card + streak counter are hidden: note
// detection judges pitched notes, which means nothing on a drum chart (the
// drum highway has its own score HUD).
// Mode: the small button in the card's corner cycles auto → compact → full,
// or highwayTweaksHud({ mode: 'auto' | 'compact' | 'full' }).
(function compactCard() {
    const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
    const LSset = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
    const MODES = ['auto', 'compact', 'full'];
    const LABEL = { auto: 'auto', compact: 'compact', full: 'full' };
    let mode = MODES.includes(LS('hwtHudMode', 'auto')) ? LS('hwtHudMode', 'auto') : 'auto';

    const css = document.createElement('style');
    css.textContent = `
        html.hwt-compact .nd-hud { grid-template-columns: auto !important; top: 12% !important;
            padding-left: calc(10px * var(--hwt-scale, 1)) !important; padding-right: calc(10px * var(--hwt-scale, 1)) !important;
            padding-bottom: calc(6px * var(--hwt-scale, 1)) !important; }
        html.hwt-compact .nd-hud > * { width: 210px; }
        html.hwt-compact .nd-hud > .pc-score,
        html.hwt-compact .nd-hud > .nd-drill,
        html.hwt-compact .nd-hud > .nd-hud-detected { display: none !important; }
        html.hwt-compact .hwt-perf .row { display: none !important; }
        html.hwt-compact .hwt-perf .head { margin-bottom: 0; }
        html.hwt-compact .hwt-perf .acc { font-size: 36px; }

        html.hwt-compact .hwt-timing { margin-top: 6px !important; padding-top: 6px; }
        html.hwt-compact .hwt-timing > div:nth-child(3) { display: none !important; }   /* early/150ms/late legend */
        html.hwt-compact .hwt-streak > * { zoom: calc(var(--hwt-scale, 1) * .55); }
        html.hwt-drums .nd-hud, html.hwt-drums .hwt-streak, html.hwt-drums .hwt-fire,
        html.hwt-drums .hwt-solo-meter, html.hwt-drums .hwt-solo-glow { display: none !important; }
        .hwt-mode-btn { position: absolute; top: 4px; right: 6px; pointer-events: auto; cursor: pointer;
            font: 10px system-ui, sans-serif; color: #8b95a5; background: rgba(255,255,255,.06);
            border: 1px solid rgba(255,255,255,.1); border-radius: 4px; padding: 0 5px; line-height: 15px;
            width: auto !important; zoom: 1 !important; }
        .hwt-mode-btn:hover { color: #f1f5f9; }
        /* room for the mode button above the card's first line */
        .nd-hud:has(> .hwt-mode-btn) { padding-top: calc(20px + 4px * var(--hwt-scale, 1)) !important; }
    `;
    document.head.appendChild(css);

    const isDrums = () => {
        let a = '';
        try { const i = window.highway && window.highway.getSongInfo && window.highway.getSongInfo(); a = (i && i.arrangement) || ''; } catch (_) { /* ignore */ }
        if (!a) { const el = document.getElementById('hud-arrangement'); a = el ? el.textContent : ''; }
        return /drum/i.test(a);
    };
    const inRoom = () => !!document.documentElement.dataset.mpRoom;
    const compactNow = () => mode === 'compact' || (mode === 'auto' && inRoom());

    function apply() {
        const root = document.documentElement;
        root.classList.toggle('hwt-compact', compactNow());
        root.classList.toggle('hwt-drums', isDrums());
        const hud = document.querySelector('.nd-hud');
        if (!hud) return;
        let btn = hud.querySelector(':scope > .hwt-mode-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.className = 'hwt-mode-btn';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
            });
            hud.appendChild(btn);
        }
        const text = 'card: ' + LABEL[mode];
        if (btn.textContent !== text) {
            btn.textContent = text;
            btn.title = 'Stats card size. auto = compact while in a multiplayer room, full otherwise. Click to cycle auto → compact → full.';
        }
    }
    function setMode(m) {
        if (!MODES.includes(m)) return;
        mode = m;
        LSset('hwtHudMode', m);
        apply();
    }
    const prev = window.highwayTweaksHud;
    window.highwayTweaksHud = (o) => {
        if (o && o.mode) setMode(o.mode);
        const r = prev ? prev(o) : {};
        return Object.assign({}, r, { mode });
    };
    window.addEventListener('multiplayer:room', apply);
    setInterval(apply, 300);
    apply();
})();

// ── 7. Minimise the player controls tray ────────────────────────────────
// A ▾ button at the end of the bottom controls row hides the row, so the
// highway gets the space back; while hidden, a slim pill at the bottom
// centre has Play/Pause and ▴ Controls to bring the row back. Remembered
// per browser (localStorage hwtTrayMin).
(function trayMinimise() {
    const KEY = 'hwtTrayMin';
    const get = () => { try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; } };
    const set = (v) => { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) { /* ignore */ } };
    const css = document.createElement('style');
    css.textContent = `
        html.hwt-tray-min #player-controls { display: none !important; }
        .hwt-tray-btn { margin-left: auto; padding: 4px 10px; border-radius: 8px; font: 700 12px system-ui, sans-serif;
            color: #9ca3af; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); cursor: pointer; }
        .hwt-tray-btn:hover { color: #f1f5f9; background: rgba(255,255,255,.12); }
        .hwt-tray-pill { position: fixed; left: 50%; bottom: 6px; transform: translateX(-50%); z-index: 120; display: none;
            gap: 4px; padding: 3px; border-radius: 999px; background: rgba(15,20,32,.82); border: 1px solid rgba(255,255,255,.12);
            box-shadow: 0 4px 16px rgba(0,0,0,.5); opacity: .55; transition: opacity .2s; }
        .hwt-tray-pill:hover { opacity: 1; }
        html.hwt-tray-min .hwt-tray-pill { display: flex; }
        .hwt-tray-pill button { padding: 3px 12px; border-radius: 999px; border: 0; background: transparent; color: #e5e7eb;
            font: 700 12px system-ui, sans-serif; cursor: pointer; }
        .hwt-tray-pill button:hover { background: rgba(255,255,255,.12); }
    `;
    document.head.appendChild(css);

    function relayout() {
        try { if (window.highway && typeof window.highway.resize === 'function') window.highway.resize(); } catch (_) { /* ignore */ }
        window.dispatchEvent(new Event('resize'));
    }
    function apply(min) {
        document.documentElement.classList.toggle('hwt-tray-min', min);
        const play = document.querySelector('.hwt-tray-pill [data-a="play"]');
        if (play) play.textContent = (window.slopsmith && window.slopsmith.isPlaying) ? '❚❚' : '▶';
        requestAnimationFrame(relayout);
        setTimeout(relayout, 60);
    }
    function toggle(min) { set(min); apply(min); }

    function ensure() {
        const bar = document.getElementById('player-controls');
        if (bar && !bar.querySelector('.hwt-tray-btn')) {
            const b = document.createElement('button');
            b.className = 'hwt-tray-btn';
            b.textContent = '▾';
            b.title = 'Hide the controls (more room for the highway)';
            b.setAttribute('aria-label', 'Hide player controls');
            b.addEventListener('click', (e) => { e.stopPropagation(); toggle(true); });
            bar.appendChild(b);
        }
        const host = document.getElementById('player') || document.body;
        if (!host.querySelector(':scope > .hwt-tray-pill')) {
            const p = document.createElement('div');
            p.className = 'hwt-tray-pill';
            p.innerHTML = '<button data-a="play" title="Play / pause">▶</button><button data-a="show" title="Show the controls">▴ Controls</button>';
            p.addEventListener('click', (e) => {
                const a = e.target.closest('button') && e.target.closest('button').dataset.a;
                if (a === 'play' && typeof window.togglePlay === 'function') window.togglePlay();
                else if (a === 'show') toggle(false);
            });
            host.appendChild(p);
        }
    }
    const bus = window.slopsmith;
    if (bus && bus.on) {
        for (const ev of ['song:play', 'song:resume', 'song:pause', 'song:ended', 'song:stop']) {
            bus.on(ev, () => {
                const play = document.querySelector('.hwt-tray-pill [data-a="play"]');
                if (play) play.textContent = (ev === 'song:play' || ev === 'song:resume') ? '❚❚' : '▶';
            });
        }
        bus.on('song:loaded', () => { ensure(); apply(get()); });
        bus.on('screen:changed', () => { ensure(); apply(get()); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { ensure(); apply(get()); });
    else { ensure(); apply(get()); }
    setInterval(ensure, 2000);   // other plugins re-render the row
})();
