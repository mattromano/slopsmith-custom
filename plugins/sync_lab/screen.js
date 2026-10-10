// Sync Lab — measured calibration of A/V offset, guitar latency and drum input
// offset, for one player or split view (one result per panel).
//
// How it works. The calibration song (built by routes.py, in the library as
// "Sync Calibration") is an ordinary song played through the normal player, so
// every judgment comes from the same clocks, highway, Note Detection and drum
// engine as real play. One note per beat, three sections:
//   listen  clicks + notes, the screen is blanked: you play by ear
//   watch   no clicks: you play by eye
//   play    both (a check)
// Every judgment is stored offset-free (error + the offset in use), so later
// offset changes don't invalidate it. Judgments are made on the highway's
// visual clock (Note Detection and the drum engine both work that way), so:
//   eye error = display latency + input latency          (A/V offset cancels)
//   ear error = input latency + audio latency + A/V offset
// Ear and eye agree when A/V offset = current + (eye - ear): that is the A/V
// suggestion (one per machine: averaged over the players). The eye median is
// each player's input offset (Note Detection latency for guitar, drums input
// offset for drums), and does not depend on the A/V offset.
//
// A/V auto-follow: Web Audio reports how far ahead of the speakers it renders
// (highway_tweaks' __hwtRenderAheadMs). After a calibration (or any manual A/V
// change) that value is stored with the A/V offset; when a later song shows a
// different output latency (other headphones / speakers), the A/V offset is
// shifted by the difference, so the picture stays in sync with the sound.
(function () {
    'use strict';
    if (window.__syncLab) return;
    const API = '/api/plugins/sync_lab';
    const LS = { ref: 'synclab_av_ref_v1', follow: 'synclab_follow_v1', last: 'synclab_last_v1', prevSplit: 'synclab_prev_split_v1' };
    const MIN_N = 8;
    const COL = { early: '#66c7ff', late: '#ff9a40', ok: '#e5e7eb', dim: '#6b7280', accent: '#60a0ff' };

    let plan = null;           // from /info (sections, blank window, file)
    let run = null;            // current calibration run
    let ui = { banner: null, blank: null, card: null };

    const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } };
    const median = (a) => {
        if (!a.length) return NaN;
        const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const iqr = (a) => {
        if (a.length < 4) return NaN;
        const s = a.slice().sort((x, y) => x - y);
        return s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)];
    };
    const fmt = (ms) => (ms > 0 ? '+' : '') + Math.round(ms) + ' ms';
    const audio = () => document.getElementById('audio');
    const avMs = () => { try { return Math.round(window.highway.getAvOffset()); } catch (_) { return 0; } };
    // Live value from highway_tweaks once a note was judged; else the saved setting (default 80 ms).
    const ndLatMs = () => {
        try { if (window.__hwtNdLatency) return Math.round(window.__hwtNdLatency() * 1000); } catch (_) { /* fall through */ }
        if (!window.noteDetect) return null;
        try {
            const v = JSON.parse(localStorage.getItem('slopsmith_notedetect') || '{}').latencyOffset;
            return Math.round((Number.isFinite(v) ? v : 0.08) * 1000);
        } catch (_) { return 80; }
    };
    const drumOffMs = () => { try { return window.__drumsGetConfig().inputOffsetMs || 0; } catch (_) { return null; } };

    function loadPlan() {
        return fetch(API + '/info').then((r) => r.json()).then((d) => { plan = d.plan; return plan; }).catch(() => null);
    }

    function isCalibrationSong() {
        try {
            const i = window.highway.getSongInfo();
            return !!(i && i.title === 'Sync Calibration' && i.artist === 'Slopsmith Sync Lab');
        } catch (_) { return false; }
    }

    function sectionOf(t) {
        if (!plan) return null;
        for (const [name, [a, b]] of Object.entries(plan.sections)) {
            if (t >= a - plan.beat * 0.5 && t < b - plan.beat * 0.5) return name;
        }
        return null;
    }

    // ── players: one per input (main guitar / main drums / split panel) ──
    function panelIndexOf(el) {
        const wrap = document.getElementById('splitscreen-wrap');
        if (!wrap || !el) return -1;
        let n = el;
        while (n && n.parentElement !== wrap) n = n.parentElement;
        return n ? [...wrap.children].filter((c) => c.tagName === 'DIV').indexOf(n) : -1;
    }
    function player(key, kind, label) {
        if (!run) return null;
        if (!run.players[key]) run.players[key] = { key, kind, label, listen: [], watch: [], play: [], misses: 0 };
        return run.players[key];
    }

    function onGuitar(ev) {
        if (!run || !ev.detail) return;
        const { j, latencyMs, container } = ev.detail;
        if (!j || !Number.isFinite(j.noteTime)) return;
        const sec = sectionOf(j.noteTime);
        if (!sec) return;
        const idx = container ? panelIndexOf(container) : -1;
        let arr = 'Guitar';
        try { arr = (window.highway.getSongInfo() || {}).arrangement || arr; } catch (_) { /* ignore */ }
        const p = player(idx >= 0 ? 'p' + idx + '-g' : 'main-g', 'guitar', idx >= 0 ? 'P' + (idx + 1) + ' guitar' : arr);
        if (!p) return;
        if (!Number.isFinite(j.timingError) || Math.abs(j.timingError) > 250) { if (!j.hit) p.misses++; return; }
        p[sec].push(j.timingError + (Number.isFinite(latencyMs) ? latencyMs : 0));
        render();
    }

    function onDrums(ev) {
        if (!run || !ev.detail) return;
        const { noteTime, errMs, inputOffsetMs, canvas } = ev.detail;
        if (!Number.isFinite(noteTime) || !Number.isFinite(errMs)) return;
        const sec = sectionOf(noteTime);
        if (!sec) return;
        let idx = -1;
        try { const ss = window.slopsmithSplitscreen; if (ss && ss.isActive()) { const i = ss.panelIndexFor(canvas); if (i != null) idx = i; } } catch (_) { /* ignore */ }
        const p = player(idx >= 0 ? 'p' + idx + '-d' : 'main-d', 'drums', idx >= 0 ? 'P' + (idx + 1) + ' drums' : 'Drums');
        if (!p) return;
        p[sec].push(errMs + (inputOffsetMs || 0));
        render();
    }

    // ── analysis ──
    function analyse() {
        const av = avMs();
        const rows = [];
        let dSum = 0, dW = 0;
        for (const p of Object.values(run ? run.players : {})) {
            const ear = median(p.listen), eye = median(p.watch), both = median(p.play);
            const okEar = p.listen.length >= MIN_N, okEye = p.watch.length >= MIN_N;
            const r = { key: p.key, kind: p.kind, label: p.label, n: [p.listen.length, p.watch.length, p.play.length],
                ear, eye, both, spread: Math.max(iqr(p.watch) || 0, iqr(p.listen) || 0) || NaN, d: NaN, input: NaN, current: NaN };
            if (okEar && okEye) {
                r.d = eye - ear;
                const w = Math.min(p.listen.length, p.watch.length);
                dSum += r.d * w; dW += w;
            }
            if (okEye) {
                if (p.kind === 'guitar') { r.current = ndLatMs(); r.input = Math.max(0, Math.min(250, Math.round(eye))); r.wanted = Math.round(eye); }
                else { r.current = drumOffMs(); r.input = Math.max(-250, Math.min(250, Math.round(eye))); r.wanted = Math.round(eye); }
            }
            rows.push(r);
        }
        const d = dW ? dSum / dW : NaN;
        return { av, d, avNew: Number.isFinite(d) ? Math.max(-1000, Math.min(1000, Math.round(av + d))) : NaN, rows,
            aheadMs: renderAhead() };
    }

    // ── render-ahead (Web Audio output latency the stems clock runs ahead by) ──
    const aheadSamples = [];
    function renderAhead() { return aheadSamples.length >= 5 ? median(aheadSamples) : NaN; }
    setInterval(() => {
        const a = audio();
        const v = window.__hwtRenderAheadMs;
        if (!a || a.paused || !Number.isFinite(v) || !(window.__hwtStemsSmooth && window.__hwtStemsSmooth())) return;
        aheadSamples.push(v);
        if (aheadSamples.length > 30) aheadSamples.shift();
    }, 250);

    // ── apply ──
    function applyAv(v) {
        try {
            window.__syncLabSettingAv = true;
            window.setAvOffsetMs(v);
        } finally { window.__syncLabSettingAv = false; }
        saveRef(v);
    }
    function applyGuitar(ms) {
        const dets = window.__hwtDetectors ? window.__hwtDetectors() : (window.noteDetect ? [window.noteDetect] : []);
        for (const d of dets) { try { d.applySettings({ latencyOffset: ms / 1000 }); } catch (e) { console.warn('[sync_lab] latency apply failed', e); } }
    }
    function applyDrums(ms) {
        try { window.__drumsSetInputOffset(ms); } catch (e) { console.warn('[sync_lab] drums apply failed', e); }
    }
    function saveRef(av) {
        const ah = renderAhead();
        if (Number.isFinite(ah)) lsSet(LS.ref, { av, aheadMs: Math.round(ah * 10) / 10, at: Date.now() });
    }

    // Manual A/V changes become the new reference (so auto-follow never undoes them).
    (function hookAv() {
        const orig = window.setAvOffsetMs;
        if (typeof orig !== 'function') { setTimeout(hookAv, 500); return; }
        if (orig.__syncLab) return;
        const w = function (ms, skipPersist) {
            const r = orig.apply(this, arguments);
            if (!skipPersist && !window.__syncLabSettingAv && !window.__syncLabFollowing) saveRef(avMs());
            return r;
        };
        w.__syncLab = true;
        window.setAvOffsetMs = w;
    })();

    // A/V auto-follow: once per song, ~3 s into playback.
    let followSong = null;
    setInterval(() => {
        const a = audio();
        if (!a || a.paused || !lsGet(LS.follow, true)) return;
        let key = null;
        try { const i = window.highway.getSongInfo(); key = i ? i.title + '|' + i.artist : null; } catch (_) { /* ignore */ }
        if (!key || key === followSong || aheadSamples.length < 10) return;
        followSong = key;
        const ref = lsGet(LS.ref, null);
        const ah = renderAhead();
        if (!ref || !Number.isFinite(ah) || !Number.isFinite(ref.aheadMs)) return;
        const delta = ah - ref.aheadMs;
        if (Math.abs(delta) < 10) return;
        const want = Math.max(-1000, Math.min(1000, Math.round(ref.av - delta)));
        if (want === avMs()) return;
        try { window.__syncLabFollowing = true; window.setAvOffsetMs(want); } finally { window.__syncLabFollowing = false; }
        toast('Audio output latency changed (' + Math.round(ref.aheadMs) + ' → ' + Math.round(ah) + ' ms): A/V offset ' +
            ref.av + ' → ' + want + ' ms');
        post({ kind: 'av-follow', from: ref, aheadMs: ah, av: want });
    }, 1000);
    // Each new song gathers fresh latency samples.
    document.addEventListener('play', (e) => { if (e.target && e.target.id === 'audio' && e.target.currentTime < 1) aheadSamples.length = 0; }, true);

    function toast(text) {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:9500;padding:8px 14px;border-radius:8px;' +
            'background:rgba(17,24,39,.95);border:1px solid #374151;color:#e5e7eb;font:13px system-ui,sans-serif;pointer-events:none';
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 6000);
    }
    function post(entry) {
        try { fetch(API + '/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }); } catch (_) { /* ignore */ }
    }

    // ── in-song UI: banner, blank screen, results card ──
    const BTN = 'pointer-events:auto;cursor:pointer;margin-left:8px;padding:3px 10px;border-radius:6px;border:1px solid #4b5563;' +
        'background:#1f2937;color:#e5e7eb;font:600 13px system-ui,sans-serif;';
    function ensureUi() {
        if (!ui.banner) {
            ui.banner = document.createElement('div');
            ui.banner.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9400;padding:8px 16px;border-radius:10px;' +
                'background:rgba(10,12,24,.9);border:1px solid #1f2937;color:#e5e7eb;font:600 15px system-ui,sans-serif;text-align:center;pointer-events:none;';
            ui.banner.addEventListener('click', onCardClick);
            document.body.appendChild(ui.banner);
        }
        if (!ui.blank) {
            ui.blank = document.createElement('div');
            ui.blank.style.cssText = 'position:fixed;inset:0;z-index:9300;background:#000;display:none;align-items:center;justify-content:center;' +
                'flex-direction:column;color:#9ca3af;font:700 34px system-ui,sans-serif;text-align:center;pointer-events:none;';
            ui.blank.innerHTML = '<div style="color:#e5e7eb">LISTEN</div><div style="font-size:18px;font-weight:500;margin-top:10px">' +
                'Close your eyes and play one note on every click.<br>The picture comes back for the next part.</div>';
            document.body.appendChild(ui.blank);
        }
    }
    function removeUi() {
        for (const k of Object.keys(ui)) { if (ui[k]) ui[k].remove(); ui[k] = null; }
    }

    function bannerText(t) {
        const s = plan.sections;
        const instr = run && run.split ? 'everyone' : 'you';
        if (t < plan.blank[0]) return 'Sync calibration: press Play. First part: <b style="color:#ffc531">eyes closed</b>, ' + instr + ' play on every click.';
        if (t < s.watch[0] - plan.beat * 0.5) return 'Next: <b style="color:#ffc531">WATCH</b>: no clicks, play exactly when the notes hit the line.';
        if (t < s.watch[1]) return '<b style="color:#ffc531">WATCH</b>: play to the notes (no clicks)';
        if (t < s.play[0] - plan.beat * 0.5) return 'Next: <b style="color:#ffc531">PLAY</b> normally (clicks + notes)';
        if (t < s.play[1]) return '<b style="color:#ffc531">PLAY</b> normally';
        return 'Calibration done';
    }

    function tick() {
        if (!plan) return;
        const on = isCalibrationSong();
        const a = audio();
        if (!on) {
            if (run) endRun(false);
            return;
        }
        if (!run) startRun();
        const t = a ? a.currentTime : 0;
        // Restarted from the top: start over.
        if (run.maxT > plan.sections.listen[0] + 2 && t < plan.sections.listen[0] - 0.5 && a && !a.paused) { startRun(); }
        run.maxT = Math.max(run.maxT, t);
        ensureUi();
        const blank = a && !a.paused && t >= plan.blank[0] && t < plan.blank[1];
        ui.blank.style.display = blank ? 'flex' : 'none';
        if (!run.cardShown) {
            ui.banner.style.display = blank ? 'none' : '';
            ui.banner.innerHTML = bannerText(t);
        }
        const finished = t >= plan.sections.play[1] + 0.3 || (a && a.ended);
        if (finished && !run.cardShown) showCard();
    }

    function startRun() {
        const split = !!(window.slopsmithSplitscreen && window.slopsmithSplitscreen.isActive && window.slopsmithSplitscreen.isActive());
        run = { players: {}, maxT: 0, cardShown: false, split, mutedPads: false, startedAt: Date.now() };
        if (!window.__drumsMutePads) { window.__drumsMutePads = true; run.mutedPads = true; }
        // Wide drum hit window (+-250 ms) so hits far off (wrong A/V, by ear) are measured, not missed.
        window.__drumsCalibrationWindow = 0.5;
        if (window.__drumsRefreshParams) window.__drumsRefreshParams();
        if (ui.card) { ui.card.remove(); ui.card = null; }
    }
    function endRun() {
        if (run && run.mutedPads) window.__drumsMutePads = false;
        window.__drumsCalibrationWindow = 0;
        if (window.__drumsRefreshParams) window.__drumsRefreshParams();
        run = null;
        removeUi();
    }

    function onCardClick(ev) {
        const b = ev.target.closest && ev.target.closest('button[data-act]');
        if (!b) return;
        ev.stopPropagation();
        const act = b.dataset.act, v = Number(b.dataset.v);
        const res = analyse();
        if (act === 'av' && Number.isFinite(v)) applyAv(v);
        else if (act === 'guitar' && Number.isFinite(v)) applyGuitar(v);
        else if (act === 'drums' && Number.isFinite(v)) applyDrums(v);
        else if (act === 'all') {
            if (Number.isFinite(res.avNew)) applyAv(res.avNew);
            for (const r of res.rows) {
                if (!Number.isFinite(r.input)) continue;
                if (r.kind === 'guitar') applyGuitar(r.input); else applyDrums(r.input);
            }
            post({ kind: 'apply-all', result: summary(res) });
        } else if (act === 'close') {
            if (ui.card) ui.card.remove();
            ui.card = null;
            return;
        } else if (act === 'again') {
            const a = audio();
            if (ui.card) ui.card.remove();
            ui.card = null;
            startRun();
            if (a) { a.currentTime = 0; a.play(); }
            return;
        }
        b.textContent = '✓ applied';
        b.disabled = true;
        renderCard();
    }

    function summary(res) {
        return { av: res.av, d: res.d, avNew: res.avNew, aheadMs: res.aheadMs, split: run && run.split,
            rows: res.rows.map((r) => ({ label: r.label, kind: r.kind, n: r.n, ear: r.ear, eye: r.eye, both: r.both, spread: r.spread, d: r.d, input: r.input, current: r.current })),
            raw: run ? Object.values(run.players).map((p) => ({ key: p.key, listen: p.listen, watch: p.watch, play: p.play, misses: p.misses })) : [] };
    }

    function showCard() {
        run.cardShown = true;
        ui.banner.style.display = 'none';
        const res = analyse();
        lsSet(LS.last, Object.assign({ at: Date.now() }, summary(res), { raw: undefined }));
        post({ kind: 'calibration', result: summary(res) });
        renderCard();
    }

    function renderCard() {
        if (!run) return;
        if (!ui.card) {
            ui.card = document.createElement('div');
            ui.card.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9600;min-width:440px;max-width:92vw;' +
                'padding:18px 22px;border-radius:14px;background:rgba(10,12,24,.97);border:1px solid #374151;color:#d1d5db;' +
                'font:14px system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)';
            ui.card.addEventListener('click', onCardClick);
            document.body.appendChild(ui.card);
        }
        const res = analyse();
        const btn = (act, v, label) => '<button data-act="' + act + '" data-v="' + v + '" style="' + BTN + '">' + (label || 'Apply') + '</button>';
        let h = '<div style="font:800 20px system-ui;color:#fff;margin-bottom:4px">Sync calibration</div>' +
            '<div style="color:' + COL.dim + ';font-size:12px;margin-bottom:12px">Timing medians (+ = late). Ear = eyes closed, eye = no clicks.</div>';
        h += '<table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:' + COL.dim + '">' +
            '<td>player</td><td>ear</td><td>eye</td><td>both</td><td>spread</td></tr>';
        for (const r of res.rows) {
            const c = (v, n) => n >= MIN_N && Number.isFinite(v) ? fmt(v) + ' <span style="color:' + COL.dim + '">(' + n + ')</span>' : '<span style="color:' + COL.dim + '">' + n + ' notes</span>';
            h += '<tr><td style="padding:3px 8px 3px 0;color:#fff;font-weight:600">' + r.label + '</td><td>' + c(r.ear, r.n[0]) + '</td><td>' + c(r.eye, r.n[1]) +
                '</td><td>' + c(r.both, r.n[2]) + '</td><td>' + (Number.isFinite(r.spread) ? Math.round(r.spread) + ' ms' : '–') + '</td></tr>';
        }
        h += '</table>';
        if (!res.rows.length) h += '<div style="margin-top:10px;color:' + COL.late + '">No notes were judged. Is Note Detection on (guitar) or the kit connected (drums)?</div>';
        h += '<div style="margin-top:14px;border-top:1px solid #1f2937;padding-top:10px">';
        if (Number.isFinite(res.avNew)) {
            const same = Math.abs(res.avNew - res.av) < 8;
            h += '<div style="margin:6px 0">A/V offset: <b>' + res.av + ' ms</b> → <b style="color:#fff">' + res.avNew + ' ms</b>' +
                (same ? ' <span style="color:' + COL.dim + '">(already right)</span>' : btn('av', res.avNew)) +
                '<div style="color:' + COL.dim + ';font-size:12px">by ear you play ' + fmt(-res.d) + ' vs by eye' +
                (Number.isFinite(res.aheadMs) ? '; audio output latency ' + Math.round(res.aheadMs) + ' ms' : '') + '</div></div>';
        } else {
            h += '<div style="margin:6px 0;color:' + COL.dim + '">A/V offset: needs ' + MIN_N + '+ notes in both the ear and the eye part.</div>';
        }
        for (const r of res.rows) {
            if (!Number.isFinite(r.input)) continue;
            const what = r.kind === 'guitar' ? (/guitar/i.test(r.label) ? '' : 'guitar ') + 'latency (Note Detection)' : (/drums/i.test(r.label) ? '' : 'drums ') + 'input offset';
            const clampNote = r.wanted !== r.input ? ' <span style="color:' + COL.late + '">(limit; wanted ' + r.wanted + ')</span>' : '';
            const same = Number.isFinite(r.current) && Math.abs(r.input - r.current) < 5;
            h += '<div style="margin:6px 0">' + r.label + ' ' + what + ': <b>' + (r.current == null ? '?' : r.current + ' ms') + '</b> → <b style="color:#fff">' +
                r.input + ' ms</b>' + clampNote + (same ? ' <span style="color:' + COL.dim + '">(already right)</span>' : btn(r.kind, r.input)) + '</div>';
        }
        if (res.rows.some((r) => r.kind === 'guitar') && res.rows.filter((r) => r.kind === 'guitar').length > 1) {
            h += '<div style="color:' + COL.dim + ';font-size:12px">Guitar latency is one setting for every guitar panel: Apply uses that panel\'s value for all.</div>';
        }
        if (res.rows.some((r) => Number.isFinite(r.spread) && r.spread > 60)) {
            h += '<div style="color:' + COL.late + ';font-size:12px;margin-top:4px">Timing was very uneven (spread over 60 ms): consider running it again.</div>';
        }
        h += '</div><div style="margin-top:14px;text-align:right">' + btn('all', 0, 'Apply all') + btn('again', 0, 'Run again') + btn('close', 0, 'Close') + '</div>';
        ui.card.innerHTML = h;
    }

    // Late judgments (the last notes) still update an open results card.
    function render() { if (run && run.cardShown && ui.card) renderCard(); }

    // ── starting a calibration (Sync screen) ──
    async function start(mode) {
        if (!plan) await loadPlan();
        if (!plan) { alert('Sync Lab: could not build the calibration song (no sloppak folder in the library?)'); return; }
        const ss = window.slopsmithSplitscreen;
        const btn = document.getElementById('btn-splitscreen');
        if (mode.startsWith('split')) {
            const prev = localStorage.getItem('splitscreenPanelPrefs');
            if (prev && !lsGet(LS.prevSplit, null)) lsSet(LS.prevSplit, prev);
            const panel = (arrName) => ({ arrName, lyrics: false, inverted: false, lefty: false, detectChannel: 'mono', barHidden: false, mastery: 1 });
            const prefs = mode === 'split-gd'
                ? [panel('__viz__:highway_3d:Lead'), panel('__viz__:drums:Drums')]
                : [panel('__viz__:highway_3d:Lead'), panel('__viz__:highway_3d:Lead')];
            localStorage.setItem('splitscreenPanelPrefs', JSON.stringify(prefs));
            localStorage.setItem('splitscreenActive', 'true');
            await window.playSong(plan.file, 0);
            // Give Matt's own split layout back once this one has been read.
            setTimeout(() => {
                const p = lsGet(LS.prevSplit, null);
                if (p) { try { localStorage.setItem('splitscreenPanelPrefs', p); } catch (_) { /* ignore */ } }
                try { localStorage.removeItem(LS.prevSplit); } catch (_) { /* ignore */ }
            }, 8000);
        } else {
            if (ss && ss.isActive && ss.isActive() && btn) btn.click();
            try { localStorage.setItem('splitscreenActive', 'false'); } catch (_) { /* ignore */ }
            const idx = mode === 'bass' ? 1 : mode === 'drums' ? 2 : 0;
            await window.playSong(plan.file, idx);
        }
    }

    // ── Sync screen (nav) ──
    function renderScreen() {
        const root = document.getElementById('sync-lab-root');
        if (!root) return;
        const last = lsGet(LS.last, null);
        const ref = lsGet(LS.ref, null);
        const follow = lsGet(LS.follow, true);
        const L = ndLatMs(), D = drumOffMs();
        root.querySelector('[data-k=av]').textContent = avMs() + ' ms';
        root.querySelector('[data-k=gl]').textContent = L == null ? 'Note Detection not loaded' : L + ' ms';
        root.querySelector('[data-k=dr]').textContent = D == null ? 'Drums not loaded' : D + ' ms';
        root.querySelector('[data-k=ah]').textContent = Number.isFinite(renderAhead()) ? Math.round(renderAhead()) + ' ms (while playing)'
            : ref && Number.isFinite(ref.aheadMs) ? ref.aheadMs + ' ms (at last calibration)' : 'measured while a song plays';
        root.querySelector('[data-k=follow]').checked = !!follow;
        const lastEl = root.querySelector('[data-k=last]');
        if (last && last.rows) {
            lastEl.innerHTML = new Date(last.at).toLocaleString() + ': ' + (Number.isFinite(last.avNew) ? 'A/V ' + last.av + ' → ' + last.avNew + ' ms; ' : '') +
                last.rows.map((r) => r.label + ' eye ' + (Number.isFinite(r.eye) ? fmt(r.eye) : '–') + ' / ear ' + (Number.isFinite(r.ear) ? fmt(r.ear) : '–')).join('; ');
        } else lastEl.textContent = 'none yet';
        measurePadLatency(root.querySelector('[data-k=pad]'));
    }

    let padLatency = null;
    async function measurePadLatency(el) {
        if (!el) return;
        if (padLatency != null) { el.textContent = padLatency; return; }
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            const g = ctx.createGain(); g.gain.value = 0; const o = ctx.createOscillator(); o.connect(g).connect(ctx.destination); o.start();
            await new Promise((r) => setTimeout(r, 500));
            const ts = ctx.getOutputTimestamp();
            const ms = (ctx.currentTime - ts.contextTime) * 1000 - (performance.now() - ts.performanceTime);
            const base = ctx.baseLatency * 1000, out = (ctx.outputLatency || 0) * 1000;
            await ctx.close();
            padLatency = '~' + Math.round(ms) + ' ms from a pad hit to the sound (Web Audio: ' + Math.round(base) + ' ms buffer + ' + Math.round(out) +
                ' ms device), plus up to a frame of main-thread delay.';
        } catch (_) { padLatency = 'could not be measured'; }
        el.textContent = padLatency;
    }

    function wireScreen() {
        const root = document.getElementById('sync-lab-root');
        if (!root || root.__wired) return;
        root.__wired = true;
        root.addEventListener('click', (e) => {
            const b = e.target.closest && e.target.closest('button[data-start]');
            if (b) start(b.dataset.start);
            const p = e.target.closest && e.target.closest('button[data-act=module-sound]');
            if (p) {
                if (typeof window.__drumsSetPadVolume === 'function') { window.__drumsSetPadVolume(0); p.textContent = '✓ pad sounds off'; }
                else p.textContent = 'Drums plugin not loaded';
            }
        });
        root.querySelector('[data-k=follow]').addEventListener('change', (e) => { lsSet(LS.follow, !!e.target.checked); });
        new MutationObserver(() => { if (root.offsetParent) renderScreen(); }).observe(root.closest('.screen') || root, { attributes: true, attributeFilter: ['class', 'style'] });
        renderScreen();
    }

    window.addEventListener('hwt:judgment', onGuitar);
    window.addEventListener('drums:judgment', onDrums);
    loadPlan();
    setInterval(tick, 50);
    (function waitScreen() { if (document.getElementById('sync-lab-root')) wireScreen(); else setTimeout(waitScreen, 500); })();

    window.__syncLab = { version: '1.0.0', start, analyse: () => (run ? summary(analyse()) : null), get run() { return run; }, get plan() { return plan; } };
})();
