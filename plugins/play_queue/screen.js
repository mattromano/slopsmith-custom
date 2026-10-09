// Count-in & Play Queue — user plugin.
//
// 1. Play queue. "+" on every library song (grid, tree, favorites) adds it to
//    the queue; album headers get ▶ (play the album in track order) and +
//    (queue it); artist headers get ▶ (all albums, oldest first — the server
//    side orders the tree by year and track number). When a song ends the
//    next one loads after a short pause (Note Detection's score card stays
//    up meanwhile) and starts on its own, on the same arrangement (Lead /
//    Rhythm / ...) as the song before when it has one. The queue panel
//    (Queue button: library bottom right, player bar) lists, reorders and
//    removes songs.
// 2. Count-in. Before a song starts from the top, one bar of clicks on the
//    song's own beat grid while the highway runs in from negative time, so
//    songs whose first note is at 0-1 s don't start instantly. Off / Auto
//    (only when the first note comes within 3 s) / Always, from the
//    "Count-in" button in the player bar. Skipped when the queue moves on
//    to the next song, so a queue plays back to back.
//
// Track numbers come from the songs' source audio (see routes.py).
// Settings and the queue are saved per browser (localStorage "pq.*").
(function () {
    'use strict';
    if (window.__playQueue) return;
    window.__playQueue = { version: '1.0.1' };

    const LS = {
        get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
    };
    const OPT = Object.assign({ countIn: 'auto', advance: true, gap: 5 }, LS.get('pq.opts', {}));
    const Q = Object.assign({ items: [], index: -1, active: false }, LS.get('pq.queue', {}));
    const saveOpts = () => LS.set('pq.opts', OPT);
    const saveQ = () => { LS.set('pq.queue', Q); renderAll(); };
    const COUNT_IN_MODES = ['off', 'auto', 'always'];
    const COUNT_IN_LABEL = { off: 'Off', auto: 'Auto', always: 'Always' };
    const AUTO_FIRST_NOTE_S = 3.0;
    const bus = window.slopsmith;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
    const normTitle = (s) => String(s || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\bsongsterr\b/ig, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '');

    // ── track numbers / arrangement lists from routes.py ───────────────────
    let TR = { tracks: {}, arrs: {}, built: new Set() };
    async function loadTracks(tries) {
        try {
            const r = await fetch('/api/plugins/play_queue/tracks');
            const d = await r.json();
            TR = { tracks: d.tracks || {}, arrs: d.arrs || {}, built: new Set(d.built || []) };
            if (!d.ready && (tries || 0) < 20) setTimeout(() => loadTracks((tries || 0) + 1), 1500);
            else redecorate();
        } catch (_) {
            if ((tries || 0) < 5) setTimeout(() => loadTracks((tries || 0) + 1), 3000);
        }
    }

    // ── app globals (classic scripts share the global scope) ───────────────
    const g = {
        playing() { try { return typeof isPlaying !== 'undefined' && !!isPlaying; } catch (_) { return false; } },
        audioTime() {
            try { if (typeof _audioTime === 'function') return _audioTime(); } catch (_) { /* fall through */ }
            const a = document.getElementById('audio');
            return a ? a.currentTime : 0;
        },
        countingIn() { try { return typeof _countingIn !== 'undefined' && !!_countingIn; } catch (_) { return false; } },
        setCountingIn(v) { try { _countingIn = v; } catch (_) { /* ignore */ } },
        gen() { try { return typeof _countInGen !== 'undefined' ? _countInGen : 0; } catch (_) { return 0; } },
        cancel() { try { if (typeof _cancelCountIn === 'function') _cancelCountIn(); } catch (_) { /* ignore */ } },
        overlay(n) { try { if (typeof showCountOverlay === 'function') showCountOverlay(n); } catch (_) { /* ignore */ } },
        hideOverlay() { try { if (typeof hideCountOverlay === 'function') hideCountOverlay(); } catch (_) { /* ignore */ } },
    };

    // ── 2. count-in ─────────────────────────────────────────────────────────
    let skipCountInOnce = false;   // set when the queue auto-advances
    let ci = null;                 // running count-in: { gen, iv, timers, nodes }
    let clickCtx = null;

    function firstNoteTime() {
        const hw = window.highway;
        let t = Infinity;
        try { for (const n of (hw.getNotes() || [])) if (n && n.t < t) { t = n.t; break; } } catch (_) { /* ignore */ }
        try { for (const c of (hw.getChords() || [])) if (c && c.t < t) { t = c.t; break; } } catch (_) { /* ignore */ }
        return t;
    }

    // Beat interval, beats per bar and first beat from the chart's beat grid.
    function beatGrid() {
        let beats = [];
        try { beats = (window.highway.getBeats() || []).filter((b) => b && Number.isFinite(b.time)); } catch (_) { /* ignore */ }
        if (beats.length >= 3) {
            const d = [];
            for (let i = 1; i < Math.min(beats.length, 9); i++) d.push(beats[i].time - beats[i - 1].time);
            d.sort((a, b) => a - b);
            const interval = d[d.length >> 1];
            const bars = [];
            for (let i = 0; i < beats.length && bars.length < 2; i++) if (beats[i].measure >= 0) bars.push(i);
            let n = bars.length === 2 ? bars[1] - bars[0] : 4;
            if (!(n >= 2 && n <= 8)) n = 4;
            if (interval > 0.15 && interval < 2) return { interval, n, b0: beats[0].time };
        }
        let bpm = 120;
        try { bpm = window.highway.getBPM(0) || 120; } catch (_) { /* ignore */ }
        return { interval: 60 / bpm, n: 4, b0: 0 };
    }

    function wantCountIn() {
        if (skipCountInOnce) { skipCountInOnce = false; return false; }
        if (OPT.countIn === 'off' || ci || g.countingIn() || g.playing()) return false;
        if (g.audioTime() > 0.05) return false;                 // resuming mid-song
        const first = firstNoteTime();
        if (!Number.isFinite(first)) return false;              // chart not loaded
        return OPT.countIn === 'always' || first < AUTO_FIRST_NOTE_S;
    }

    function click(at, high) {
        if (!clickCtx) clickCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = clickCtx.createOscillator(), gain = clickCtx.createGain();
        osc.connect(gain); gain.connect(clickCtx.destination);
        osc.frequency.value = high ? 1200 : 800;
        gain.gain.setValueAtTime(0.0001, Math.max(clickCtx.currentTime, at - 0.002));
        gain.gain.setValueAtTime(0.5, at);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.08);
        osc.start(at); osc.stop(at + 0.09);
        return osc;
    }

    function stopCountIn(restoreClock) {
        if (!ci) return;
        clearInterval(ci.iv);
        for (const t of ci.timers) clearTimeout(t);
        for (const o of ci.nodes) { try { o.stop(); } catch (_) { /* ignore */ } }
        ci = null;
        g.hideOverlay();
        if (restoreClock) {
            g.setCountingIn(false);
            try { window.highway.setTime(0); } catch (_) { /* ignore */ }
        }
        renderAll();
    }

    // One bar of clicks on the song's grid, ending on the last grid beat before
    // 0 s; the highway clock runs from before the first click up to 0, then the
    // real play starts.
    function runCountIn(startPlay) {
        const { interval, n, b0 } = beatGrid();
        const ref = b0 - interval * (Math.floor(b0 / interval + 1e-6) + 1);   // last grid beat < 0
        const clickTimes = [];
        for (let k = n - 1; k >= 0; k--) clickTimes.push(ref - k * interval);
        const startT = clickTimes[0] - 0.4;
        if (!clickCtx) clickCtx = new (window.AudioContext || window.webkitAudioContext)();
        try { clickCtx.resume(); } catch (_) { /* ignore */ }
        g.setCountingIn(true);
        const gen = g.gen();
        const t0 = clickCtx.currentTime + 0.05;          // song time startT == audio-context time t0
        const songNow = () => startT + (clickCtx.currentTime - t0);
        ci = { gen, iv: 0, timers: [], nodes: [] };
        clickTimes.forEach((ct, i) => {
            const at = t0 + (ct - startT);
            ci.nodes.push(click(at, i === 0));
            ci.timers.push(setTimeout(() => g.overlay(i + 1), Math.max(0, (at - clickCtx.currentTime) * 1000)));
        });
        try { window.highway.setTime(startT); } catch (_) { /* ignore */ }
        ci.iv = setInterval(() => {
            if (!ci) return;
            if (g.gen() !== gen) { stopCountIn(false); return; }      // song changed / player closed
            const st = songNow();
            if (st < -0.03) {
                try { window.highway.setTime(st); } catch (_) { /* ignore */ }
                return;
            }
            stopCountIn(false);
            g.setCountingIn(false);
            try { window.highway.setTime(0); } catch (_) { /* ignore */ }
            startPlay();
        }, 15);
        renderAll();
    }

    const origToggle = window.togglePlay;
    if (typeof origToggle === 'function') {
        window.togglePlay = function (...args) {
            if (ci) { stopCountIn(true); return; }            // pressed again: cancel the count-in
            if (wantCountIn()) {
                runCountIn(() => origToggle.apply(this, args));
                return;
            }
            return origToggle.apply(this, args);
        };
    }

    // ── 1. queue ────────────────────────────────────────────────────────────
    let expectFile = null;        // filename the queue just asked playSong for
    let autoStart = false;        // start playback once that song is ready
    let nextTimer = null, nextAt = 0;

    function lastArrangement() {
        const cs = bus && bus.currentSong;
        return (cs && cs.arrangement) || LS.get('pq.lastArr', null);
    }
    function arrIndexFor(filename, name) {
        const list = TR.arrs[filename];
        if (!list || !name) return undefined;
        const want = String(name).toLowerCase();
        let i = list.findIndex((a) => a.toLowerCase() === want);
        if (i < 0) i = list.findIndex((a) => a.toLowerCase().startsWith(want) || want.startsWith(a.toLowerCase()));
        return i >= 0 ? i : undefined;
    }

    function playAt(i, auto) {
        const it = Q.items[i];
        if (!it) return;
        cancelNext();
        Q.index = i; Q.active = true; saveQ();
        expectFile = it.filename;
        autoStart = true;
        skipCountInOnce = !!auto;
        const arr = arrIndexFor(it.filename, lastArrangement());
        window.playSong(encodeURIComponent(it.filename), arr);
    }

    function addItems(items, opts) {
        opts = opts || {};
        const fresh = items.filter((x) => x && x.filename);
        if (!fresh.length) return;
        if (opts.replace) { Q.items = fresh; Q.index = -1; Q.active = false; }
        else Q.items.push(...fresh);
        saveQ();
        if (opts.play) playAt(opts.replace ? 0 : Q.items.length - fresh.length, false);
        else flashPill('+' + fresh.length);
    }

    function cancelNext() {
        if (nextTimer) { clearInterval(nextTimer); nextTimer = null; }
        const b = document.getElementById('pq-next');
        if (b) b.remove();
    }

    function advance() {
        cancelNext();
        const ov = document.querySelector('.nd-summary-overlay');
        if (ov) { const c = ov.querySelector('.nd-summary-close'); if (c) c.click(); else ov.remove(); }
        playAt(Q.index + 1, true);
    }

    function onEnded() {
        if (!Q.active || !OPT.advance) return;
        if (Q.index + 1 >= Q.items.length) { Q.active = false; saveQ(); return; }
        const next = Q.items[Q.index + 1];
        const gap = Math.max(0, Number(OPT.gap) || 0);
        if (!gap) { advance(); return; }
        nextAt = performance.now() + gap * 1000;
        const b = document.createElement('div');
        b.id = 'pq-next';
        b.innerHTML = '<span>Up next: <b>' + esc(next.title) + '</b> <span class="pq-dim">' + esc(next.artist || '') +
            '</span> in <b class="pq-secs">' + gap + '</b> s</span>' +
            '<button data-a="now">Play now</button><button data-a="stop">Stop queue</button>';
        b.addEventListener('click', (e) => {
            const a = e.target.closest('button') && e.target.closest('button').dataset.a;
            if (a === 'now') advance();
            else if (a === 'stop') { cancelNext(); Q.active = false; saveQ(); }
        });
        document.body.appendChild(b);
        nextTimer = setInterval(() => {
            const left = Math.ceil((nextAt - performance.now()) / 1000);
            const s = b.querySelector('.pq-secs');
            if (s) s.textContent = String(Math.max(0, left));
            if (left <= 0) advance();
        }, 200);
    }

    function startWhenReady() {
        if (!autoStart) return;
        autoStart = false;
        const a = document.getElementById('audio');
        const t0 = performance.now();
        const go = () => {
            if (g.playing() || ci) return;
            const ready = a && Number.isFinite(a.duration) && a.duration > 0;
            if (!ready && performance.now() - t0 < 15000) { setTimeout(go, 200); return; }
            if (typeof window.togglePlay === 'function') window.togglePlay();
        };
        setTimeout(go, 400);
    }

    if (bus && bus.on) {
        bus.on('song:loading', (e) => {
            const f = e && e.detail && e.detail.filename ? dec(e.detail.filename) : null;
            if (f && expectFile && f === expectFile) return;
            // The user picked a song themselves: the queue stops driving playback.
            if (f && Q.active) { Q.active = false; saveQ(); }
            expectFile = null; autoStart = false; cancelNext();
            if (ci) stopCountIn(false);
        });
        bus.on('song:loaded', () => {
            const cs = bus.currentSong;
            if (cs && cs.arrangement) LS.set('pq.lastArr', cs.arrangement);
            injectPlayerButtons();
        });
        bus.on('song:ready', () => { injectPlayerButtons(); startWhenReady(); });
        bus.on('song:ended', onEnded);
        bus.on('song:stop', () => { cancelNext(); if (ci) stopCountIn(true); });
        bus.on('screen:changed', () => { renderAll(); setTimeout(redecorate, 50); });
    }

    // ── UI ──────────────────────────────────────────────────────────────────
    const css = document.createElement('style');
    css.textContent = `
        #pq-pill { position: fixed; right: 132px; bottom: 18px; z-index: 60; display: none; align-items: center; gap: 6px;
            padding: 8px 14px; border-radius: 999px; background: #1f2937; color: #e5e7eb; border: 1px solid #374151;
            font: 600 13px system-ui, sans-serif; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
        #pq-pill:hover { background: #273244; }
        #pq-pill.flash { background: #3b4f6b; }
        #pq-panel { position: fixed; right: 18px; bottom: 64px; z-index: 205; width: 380px; max-height: 66vh; display: none;
            flex-direction: column; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,.6); font: 13px system-ui, sans-serif; }
        #pq-panel.open { display: flex; }
        #pq-panel.on-player { bottom: 90px; }
        #pq-panel header { display: flex; align-items: center; padding: 10px 12px; border-bottom: 1px solid #1f2937; gap: 8px; }
        #pq-panel header b { flex: 1; font-size: 14px; }
        #pq-panel .pq-list { overflow: auto; padding: 4px 0; flex: 1; }
        #pq-panel .pq-empty { padding: 18px 14px; color: #6b7280; line-height: 1.5; }
        #pq-panel .pq-it { display: flex; align-items: center; gap: 6px; padding: 5px 10px; }
        #pq-panel .pq-it:hover { background: #1a2333; }
        #pq-panel .pq-it.cur { background: #1e3a5f; }
        #pq-panel .pq-it .n { width: 22px; text-align: right; color: #6b7280; font-variant-numeric: tabular-nums; }
        #pq-panel .pq-it .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #pq-panel .pq-it .t small { color: #6b7280; margin-left: 4px; }
        #pq-panel button, #pq-next button { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px;
            padding: 2px 8px; font: 12px system-ui, sans-serif; cursor: pointer; }
        #pq-panel button:hover, #pq-next button:hover { background: #2b3a52; }
        #pq-panel .pq-it button { padding: 1px 6px; opacity: .55; }
        #pq-panel .pq-it:hover button { opacity: 1; }
        #pq-panel footer { border-top: 1px solid #1f2937; padding: 8px 12px; display: grid; gap: 6px; }
        #pq-panel footer label { display: flex; align-items: center; gap: 6px; color: #9ca3af; }
        #pq-panel select { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 1px 4px; }
        .pq-add { margin-left: 4px; padding: 0 7px; border-radius: 6px; background: rgba(255,255,255,.06); color: #9ca3af;
            border: 1px solid rgba(255,255,255,.1); font: 600 12px/20px system-ui, sans-serif; cursor: pointer; }
        .pq-add:hover { background: rgba(96,165,250,.25); color: #fff; }
        .pq-hbtn { margin-left: 6px; padding: 0 8px; border-radius: 6px; background: rgba(255,255,255,.06); color: #cbd5e1;
            border: 1px solid rgba(255,255,255,.12); font: 600 11px/20px system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
        .pq-hbtn:hover { background: rgba(96,165,250,.3); color: #fff; }
        .pq-track { display: inline-block; min-width: 20px; color: #6b7280; font: 12px system-ui, sans-serif;
            font-variant-numeric: tabular-nums; text-align: right; margin-right: 2px; }
        #pq-next { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 210; display: flex; gap: 10px;
            align-items: center; padding: 10px 16px; border-radius: 10px; background: rgba(17,24,39,.95); color: #e5e7eb;
            border: 1px solid #374151; font: 14px system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.6); }
        #pq-next .pq-dim, #pq-panel .pq-dim { color: #9ca3af; }
    `;
    document.head.appendChild(css);

    const pill = document.createElement('div');
    pill.id = 'pq-pill';
    pill.title = 'Play queue';
    document.body.appendChild(pill);
    const panel = document.createElement('div');
    panel.id = 'pq-panel';
    document.body.appendChild(panel);
    pill.addEventListener('click', () => { panel.classList.toggle('open'); renderPanel(); });

    function onPlayer() {
        const p = document.getElementById('player');
        return !!(p && (p.classList.contains('active') || (p.offsetParent !== null && getComputedStyle(p).display !== 'none')));
    }
    function flashPill(text) {
        renderPill();
        pill.classList.add('flash');
        const old = pill.innerHTML;
        pill.innerHTML = '☰ Queue <b>' + esc(text) + '</b>';
        setTimeout(() => { pill.classList.remove('flash'); renderPill(); }, 900);
        return old;
    }
    function renderPill() {
        const show = !onPlayer();
        pill.style.display = show ? 'flex' : 'none';
        pill.innerHTML = '☰ Queue' + (Q.items.length ? ' <b>' + (Q.active && Q.index >= 0 ? (Q.index + 1) + '/' : '') + Q.items.length + '</b>' : '');
    }

    function renderPanel() {
        panel.classList.toggle('on-player', onPlayer());
        if (!panel.classList.contains('open')) return;
        const items = Q.items.map((it, i) => {
            const tr = TR.tracks[it.filename];
            return '<div class="pq-it' + (Q.active && i === Q.index ? ' cur' : '') + '" data-i="' + i + '">' +
                '<span class="n">' + (i + 1) + '</span>' +
                '<span class="t" title="' + esc(it.title + ' — ' + (it.artist || '') + (it.album ? ' · ' + it.album : '')) + '">' +
                    esc(it.title) + '<small>' + esc(it.artist || '') + (tr ? ' · #' + tr : '') + '</small></span>' +
                '<button data-a="play" title="Play from here">▶</button>' +
                '<button data-a="up" title="Move up">↑</button>' +
                '<button data-a="down" title="Move down">↓</button>' +
                '<button data-a="del" title="Remove">✕</button></div>';
        }).join('');
        panel.innerHTML =
            '<header><b>Queue</b><span class="pq-dim">' + Q.items.length + ' song' + (Q.items.length === 1 ? '' : 's') + '</span>' +
                '<button data-a="close">✕</button></header>' +
            '<div class="pq-list">' + (items || '<div class="pq-empty">Empty. Use <b>+</b> on a song, or <b>▶ Play</b> / <b>+ Queue</b> on an album or artist in the tree view, to queue songs.</div>') + '</div>' +
            '<footer>' +
                '<div style="display:flex;gap:6px">' +
                    '<button data-a="start" ' + (Q.items.length ? '' : 'disabled') + '>▶ ' + (Q.active ? 'Restart song' : (Q.index > 0 ? 'Resume queue' : 'Play queue')) + '</button>' +
                    (Q.active && Q.index + 1 < Q.items.length ? '<button data-a="next">Next ▶▶</button>' : '') +
                    '<span style="flex:1"></span><button data-a="clear" ' + (Q.items.length ? '' : 'disabled') + '>Clear</button></div>' +
                '<label><input type="checkbox" data-o="advance" ' + (OPT.advance ? 'checked' : '') + '> Play the next song automatically, after ' +
                    '<select data-o="gap">' + [0, 3, 5, 10, 15].map((s) => '<option value="' + s + '"' + (Number(OPT.gap) === s ? ' selected' : '') + '>' + s + ' s</option>').join('') + '</select></label>' +
                '<label>Count-in before a song starts: <select data-o="countIn">' +
                    COUNT_IN_MODES.map((m) => '<option value="' + m + '"' + (OPT.countIn === m ? ' selected' : '') + '>' +
                        (m === 'auto' ? 'Auto (first note within 3 s)' : COUNT_IN_LABEL[m]) + '</option>').join('') +
                    '</select></label>' +
                '<span class="pq-dim" style="font-size:12px">No count-in when the queue moves on to the next song.</span>' +
            '</footer>';
    }

    panel.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const a = b.dataset.a;
        const row = b.closest('.pq-it');
        const i = row ? Number(row.dataset.i) : -1;
        if (a === 'close') { panel.classList.remove('open'); return; }
        if (a === 'play') { playAt(i, false); }
        else if (a === 'up' && i > 0) { moveItem(i, i - 1); }
        else if (a === 'down' && i < Q.items.length - 1) { moveItem(i, i + 1); }
        else if (a === 'del') {
            Q.items.splice(i, 1);
            if (i < Q.index) Q.index--;
            else if (i === Q.index) { Q.active = false; Q.index = Math.min(Q.index, Q.items.length) - 1; }
            saveQ();
        } else if (a === 'start') { playAt(Q.active ? Q.index : Math.max(0, Q.index), false); }
        else if (a === 'next') { advance(); }
        else if (a === 'clear') { Q.items = []; Q.index = -1; Q.active = false; cancelNext(); saveQ(); }
        renderPanel();
    });
    panel.addEventListener('change', (e) => {
        const o = e.target.dataset.o;
        if (!o) return;
        if (o === 'advance') OPT.advance = e.target.checked;
        else if (o === 'gap') OPT.gap = Number(e.target.value);
        else if (o === 'countIn') OPT.countIn = e.target.value;
        saveOpts(); renderAll();
    });
    function moveItem(from, to) {
        const [it] = Q.items.splice(from, 1);
        Q.items.splice(to, 0, it);
        if (Q.index === from) Q.index = to;
        else if (Q.index === to) Q.index = from;
        saveQ();
    }

    // Player bar: Count-in mode button + Queue button (metronome-style).
    const BTN_CLS = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    function injectPlayerButtons() {
        const bar = document.getElementById('player-controls');
        if (!bar) return;
        let ciBtn = document.getElementById('pq-ci-btn');
        if (!ciBtn) {
            ciBtn = document.createElement('button');
            ciBtn.id = 'pq-ci-btn';
            ciBtn.className = BTN_CLS;
            ciBtn.title = 'Count-in before the song starts: Off / Auto (first note within 3 s) / Always';
            ciBtn.addEventListener('click', () => {
                OPT.countIn = COUNT_IN_MODES[(COUNT_IN_MODES.indexOf(OPT.countIn) + 1) % COUNT_IN_MODES.length];
                saveOpts(); renderAll();
            });
            const anchor = document.getElementById('btn-metronome') || document.getElementById('btn-lyrics');
            if (anchor && anchor.parentNode === bar) bar.insertBefore(ciBtn, anchor.nextSibling); else bar.appendChild(ciBtn);
        }
        let qBtn = document.getElementById('pq-q-btn');
        if (!qBtn) {
            qBtn = document.createElement('button');
            qBtn.id = 'pq-q-btn';
            qBtn.className = BTN_CLS;
            qBtn.title = 'Play queue';
            qBtn.addEventListener('click', () => { panel.classList.toggle('open'); renderPanel(); });
            bar.insertBefore(qBtn, ciBtn.nextSibling);
        }
        renderPlayerButtons();
    }
    function renderPlayerButtons() {
        const ciBtn = document.getElementById('pq-ci-btn');
        if (ciBtn) {
            ciBtn.textContent = 'Count-in: ' + COUNT_IN_LABEL[OPT.countIn] + (ci ? ' …' : '');
            ciBtn.className = BTN_CLS.replace('text-gray-400', OPT.countIn === 'off' ? 'text-gray-500' : 'text-amber-300');
        }
        const qBtn = document.getElementById('pq-q-btn');
        if (qBtn) qBtn.textContent = 'Queue' + (Q.items.length ? ' ' + (Q.active && Q.index >= 0 ? (Q.index + 1) + '/' : '') + Q.items.length : '');
    }
    function renderAll() { renderPill(); renderPanel(); renderPlayerButtons(); }

    // ── library decorations ─────────────────────────────────────────────────
    const CONTAINERS = ['lib-grid', 'lib-tree', 'fav-grid', 'fav-tree'];
    function rowInfo(el) {
        const filename = dec(el.dataset.play || '');
        const tEl = el.querySelector('h3') || el.querySelector('.text-sm.text-white');
        const title = tEl ? tEl.textContent.trim() : filename;
        let artist = el.dataset.artist || '';
        const albumHeader = el.closest('.album-group') && el.closest('.album-group').querySelector('.album-header .text-gray-300');
        return { filename, title, artist, album: albumHeader ? albumHeader.textContent.trim() : '' };
    }
    // One entry per song title: prefer songs built from the album audio, then
    // sloppaks over PSARCs (duplicates: old conversions, Songsterr variants).
    function dedupe(list) {
        const best = new Map(), order = [];
        const rank = (x) => (TR.built.has(x.filename) ? 0 : x.filename.toLowerCase().endsWith('.sloppak') ? 1 : 2);
        for (const x of list) {
            const k = normTitle(x.title) || x.filename;
            if (!best.has(k)) { best.set(k, x); order.push(k); }
            else if (rank(x) < rank(best.get(k))) best.set(k, x);
        }
        return order.map((k) => best.get(k));
    }
    const rowsIn = (el) => [...el.querySelectorAll('.song-row[data-play]')].map(rowInfo);

    function hbtn(label, title, fn) {
        const b = document.createElement('button');
        b.className = 'pq-hbtn';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); fn(b); });
        b.addEventListener('keydown', (e) => e.stopPropagation());
        return b;
    }

    function decorate(root) {
        for (const el of root.querySelectorAll('.song-row[data-play]:not([data-pq]), .song-card[data-play]:not([data-pq])')) {
            el.dataset.pq = '1';
            const filename = dec(el.dataset.play);
            const add = document.createElement('button');
            add.className = 'pq-add';
            add.textContent = '+';
            add.title = 'Add to queue';
            add.addEventListener('click', (e) => { e.stopPropagation(); addItems([rowInfo(el)]); });
            if (el.classList.contains('song-row')) {
                const tail = el.querySelector(':scope > div.flex-shrink-0') || el.lastElementChild;
                if (tail) tail.appendChild(add);
                const tr = TR.tracks[filename];
                const head = el.firstElementChild;
                if (tr && head && !head.querySelector('.pq-track')) {
                    const s = document.createElement('span');
                    s.className = 'pq-track';
                    s.textContent = tr + '.';
                    head.insertBefore(s, head.firstChild);
                }
            } else {
                const box = (el.querySelector('.fav-btn') && el.querySelector('.fav-btn').parentElement) || el.querySelector('.p-4 .flex.gap-1');
                if (box) box.appendChild(add);
            }
        }
        for (const h of root.querySelectorAll('.album-header:not([data-pq])')) {
            h.dataset.pq = '1';
            const body = h.nextElementSibling;
            const count = h.querySelector(':scope > .text-xs');
            const wrap = document.createElement('span');
            wrap.style.cssText = 'display:inline-flex;margin-right:8px';
            wrap.appendChild(hbtn('▶ Play', 'Play this album in track order', () => body && addItems(dedupe(rowsIn(body)), { replace: true, play: true })));
            wrap.appendChild(hbtn('+ Queue', 'Add this album to the queue', () => body && addItems(dedupe(rowsIn(body)))));
            if (count) h.insertBefore(wrap, count); else h.appendChild(wrap);
        }
        for (const h of root.querySelectorAll('.artist-header:not([data-pq])')) {
            h.dataset.pq = '1';
            const body = h.nextElementSibling;
            const count = h.querySelector(':scope > .text-xs');
            const albumsOf = () => [...body.querySelectorAll('.album-body')].flatMap((b) => dedupe(rowsIn(b)));
            const wrap = document.createElement('span');
            wrap.style.cssText = 'display:inline-flex;margin-right:8px';
            wrap.appendChild(hbtn('▶ Play all', 'Play every album, oldest first, in track order', () => body && addItems(albumsOf(), { replace: true, play: true })));
            wrap.appendChild(hbtn('+ Queue all', 'Add every album (oldest first) to the queue', () => body && addItems(albumsOf())));
            if (count) h.insertBefore(wrap, count); else h.appendChild(wrap);
        }
    }
    function redecorate() {
        for (const id of CONTAINERS) {
            const c = document.getElementById(id);
            if (!c) continue;
            // Track numbers may have arrived after the first pass.
            for (const el of c.querySelectorAll('.song-row[data-pq]')) {
                const tr = TR.tracks[dec(el.dataset.play)];
                const head = el.firstElementChild;
                if (tr && head && !head.querySelector('.pq-track')) {
                    const s = document.createElement('span');
                    s.className = 'pq-track';
                    s.textContent = tr + '.';
                    head.insertBefore(s, head.firstChild);
                }
            }
            decorate(c);
        }
    }
    let pending = 0;
    const mo = new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => { pending = 0; redecorate(); }, 30);
    });
    function observe() {
        for (const id of CONTAINERS) {
            const c = document.getElementById(id);
            if (c && !c.__pqObserved) { c.__pqObserved = true; mo.observe(c, { childList: true, subtree: true }); }
        }
    }
    observe();
    setTimeout(observe, 2000);

    // Public hooks (console / other plugins).
    window.playQueue = {
        add: (filenames) => addItems((filenames || []).map((f) => ({ filename: f, title: f }))),
        playAt: (i) => playAt(i, false),
        next: advance,
        clear: () => { Q.items = []; Q.index = -1; Q.active = false; saveQ(); },
        get state() { return JSON.parse(JSON.stringify({ queue: Q, options: OPT, countingIn: !!ci })); },
        countIn: (mode) => { if (COUNT_IN_MODES.includes(mode)) { OPT.countIn = mode; saveOpts(); renderAll(); } return OPT.countIn; },
    };

    loadTracks(0);
    renderAll();
    redecorate();
})();
