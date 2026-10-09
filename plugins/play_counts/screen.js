// Play Counts — library badges + "Most Played" sort.
// Counts come from routes.py: Rocksmith 2014 profile plays + Slopsmith
// practice-journal plays, shared between a song's PSARC and sloppak.
(function () {
    'use strict';
    if (window.__playCounts) return;
    window.__playCounts = { counts: {} };

    const API = '/api/plugins/play_counts/counts';
    const CONTAINERS = ['lib-grid', 'lib-tree', 'fav-grid', 'fav-tree'];
    let counts = {};
    let scores = {};
    let fetchedAt = 0;
    let fetching = null;

    function fetchCounts(force) {
        if (fetching) return fetching;
        if (!force && Date.now() - fetchedAt < 10000) return Promise.resolve(counts);
        fetching = fetch(API).then((r) => r.json()).then((d) => {
            counts = d.counts || {};
            scores = d.scores || {};
            window.__playCounts.counts = counts;
            fetchedAt = Date.now();
            // Background build still running on first launch: poll until ready.
            if (!d.ready) setTimeout(() => fetchCounts(true).then(decorateAll), 3000);
            return counts;
        }).catch(() => counts).finally(() => { fetching = null; });
        return fetching;
    }

    function badgeHtml(c, cls) {
        const total = c[0] + c[1];
        const tip = `${total} play${total === 1 ? '' : 's'}: ${c[0]} in Rocksmith, ${c[1]} in Slopsmith`;
        return `<span class="pc-badge ${cls}" title="${tip}">▶ ${total}</span>`;
    }

    // Scores: [Slopsmith best note-detect %, Rocksmith best mastery %].
    function scoreHtml(sc, cls) {
        let h = '';
        if (sc[0] != null) h += `<span class="pc-badge pc-best ${cls}" title="Best full-speed, full-song note detection accuracy in Slopsmith">★ ${Math.round(sc[0])}%</span>`;
        if (sc[2]) h += `<span class="pc-badge pc-fc ${cls}" title="Full combo: a full-speed, full-song run with no misses">FC</span>`;
        if (sc[1]) h += `<span class="pc-badge pc-rs ${cls}" title="Best Rocksmith mastery (any arrangement)">RS ${Math.round(sc[1])}%</span>`;
        return h;
    }

    function decorate(el) {
        const enc = el.getAttribute('data-play');
        if (!enc) return;
        let fn;
        try { fn = decodeURIComponent(enc); } catch (_) { return; }
        const c = counts[fn], sc = scores[fn];
        const key = (c ? c[0] + ',' + c[1] : '') + '|' + (sc ? sc.join(',') : '');
        if (el.dataset.pcKey === key) return;   // already up to date
        el.dataset.pcKey = key;
        el.querySelectorAll('.pc-badge').forEach((b) => b.remove());
        if (!c && !sc) return;
        const html = (cls) => (c ? badgeHtml(c, cls) : '') + (sc ? scoreHtml(sc, cls) : '');
        if (el.classList.contains('song-row')) {
            // Row: just before the duration / tuning badges on the right.
            const right = el.querySelector(':scope > div.flex-shrink-0');
            if (right) right.insertAdjacentHTML('afterbegin', html('pc-row'));
        } else {
            // Card: in the badge strip under the title.
            const strip = el.querySelector('.p-4 .flex.items-center.flex-wrap');
            if (strip) strip.insertAdjacentHTML('afterbegin', html('pc-card'));
        }
    }

    function decorateAll() {
        for (const id of CONTAINERS) {
            const root = document.getElementById(id);
            if (root) root.querySelectorAll('.song-row[data-play], .song-card[data-play]').forEach(decorate);
        }
    }

    // Re-decorate when the library / favorites lists re-render. Observers are
    // scoped to those four containers (never document-wide — see the
    // highway_tweaks plugin for why) and coalesced to one pass per frame.
    let pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            fetchCounts(false).then(decorateAll);
        });
    }
    const observed = new WeakSet();
    function attach() {
        let missing = false;
        for (const id of CONTAINERS) {
            const el = document.getElementById(id);
            if (!el) { missing = true; continue; }
            if (observed.has(el)) continue;
            observed.add(el);
            new MutationObserver((ms) => {
                // Ignore our own badge insertions.
                for (const m of ms) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType === 1 && !n.classList.contains('pc-badge')) { schedule(); return; }
                    }
                }
            }).observe(el, { childList: true, subtree: true });
        }
        if (missing) setTimeout(attach, 1000);
    }

    // "Most Played" sort option (server-side sort added by routes.py).
    function addSortOption() {
        const sel = document.getElementById('lib-sort');
        if (!sel) { setTimeout(addSortOption, 1000); return; }
        try { if (typeof _LIB_SORT_VALUES !== 'undefined') _LIB_SORT_VALUES.add('plays'); } catch (_) { /* ignore */ }
        if (!sel.querySelector('option[value="plays"]')) {
            const opt = document.createElement('option');
            opt.value = 'plays';
            opt.textContent = 'Most Played';
            sel.insertBefore(opt, sel.firstChild);
        }
        // Restore the choice if it was persisted (app.js restored before this
        // option existed, so it fell back to the default).
        try {
            if (localStorage.getItem('slopsmith.libSort') === 'plays' && sel.value !== 'plays') {
                sel.value = 'plays';
                if (typeof sortLibrary === 'function') sortLibrary();
            }
        } catch (_) { /* ignore */ }
    }

    const style = document.createElement('style');
    style.textContent = `
        .pc-badge { display:inline-flex; align-items:center; padding:0.125rem 0.375rem; border-radius:0.25rem;
            font-size:11px; font-weight:600; background:rgba(56,189,248,0.12); color:#7dd3fc;
            border:1px solid rgba(56,189,248,0.25); white-space:nowrap; font-variant-numeric:tabular-nums; }
        .pc-badge + .pc-badge { margin-left:4px; }
        .pc-best { background:rgba(255,197,49,0.12); color:#ffd36b; border-color:rgba(255,197,49,0.3); }
        .pc-fc { background:rgba(255,197,49,0.25); color:#ffe08a; border-color:rgba(255,197,49,0.5); font-weight:800; }
        .pc-rs { background:rgba(148,163,184,0.10); color:#a5b1c2; border-color:rgba(148,163,184,0.25); }
    `;
    document.head.appendChild(style);

    // Refresh after playing a song (a new journal session) when returning to the library.
    window.addEventListener('focus', () => fetchCounts(true).then(decorateAll));
    try {
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('screen:changed', () => fetchCounts(true).then(decorateAll));
        }
    } catch (_) { /* ignore */ }

    attach();
    addSortOption();
    fetchCounts(true).then(decorateAll);
})();

// ── Song scores: record note-detection runs, show best/last/trend in-game ──
// A run = one stretch of note detection on one song + arrangement. It is
// saved when the song ends, another song/arrangement loads, detection is
// turned off, or the app closes (if it had at least MIN_JUDGED notes).
// It counts toward the song's best only when complete (song ended or ≥92%
// reached, no A-B loop) at 1.00x; slower or partial runs still go in the
// history (drawn dim). A miss-free counted run is a full combo.
//
// Per run it also keeps:
//  - section passes: accuracy of each pass through a chart section
//    (keyed "<index>:<name>", so the 2nd verse is its own section), counted
//    only at 1.00x and when ≥70% of the section's notes were judged — the
//    best pass per section is that section's best;
//  - accuracy per technique (bends, slides, hammer-ons, …) and per string.
// In-game it shows song best / last / pace / trend, the current section vs
// its best, a full-combo indicator, weakest techniques and per-string bars.
// At song end it adds a card to note_detect's summary popup.
(function () {
    'use strict';
    if (window.__songScores) return;
    const API = '/api/plugins/play_counts';
    const MIN_JUDGED = 20, COMPLETE_AT = 0.92, PASS_MIN_COVER = 0.7;
    const GOLD = '#ffc531', BLUE = '#45c8ff', DIM = '#8b95a5', WHITE = '#f1f5f9';
    const TECH = { B: 'bends', S: 'slides', H: 'harmonics', h: 'hammer-ons', p: 'pull-offs', t: 'taps',
        PM: 'palm mutes', TR: 'tremolo', A: 'accents', SUS: 'sustains' };
    let curFile = null, run = null, song = null, songFor = '', panel = null, lastPaint = '';
    // Stats already saved as a run: don't start another run from the same
    // numbers (note_detect keeps them after the song ends) until they reset.
    let spent = null;

    const hw = () => window.highway;
    const info = () => { try { return (hw() && hw().getSongInfo && hw().getSongInfo()) || {}; } catch (_) { return {}; } };
    const ndStats = () => { try { return window.noteDetect && window.noteDetect.getStats ? window.noteDetect.getStats() : null; } catch (_) { return null; } };
    const speedNow = () => {
        const el = document.getElementById('speed-label');
        const v = el ? parseFloat(el.textContent) : NaN;
        return Number.isFinite(v) && v > 0 ? v : 1;
    };
    const loopOn = () => {
        try { const l = window.slopsmith.getLoop({ reason: 'song-scores' }); return l && l.loopA != null && l.loopB != null; } catch (_) { return false; }
    };
    const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, '');
    const pct = (h, n) => (n > 0 ? Math.round(100 * h / n) : null);
    const levelCol = (p) => (p == null ? DIM : p >= 90 ? GOLD : p >= 75 ? WHITE : p >= 60 ? '#9fd8ff' : BLUE);

    // ── chart sections ──
    let secCache = { src: null, list: [] };
    function sections() {
        const h = hw();
        const src = h && h.getSections ? h.getSections() : null;
        if (src === secCache.src) return secCache.list;
        const list = [];
        if (Array.isArray(src)) {
            const seen = {};
            const notes = (h.getNotes && h.getNotes()) || [], chords = (h.getChords && h.getChords()) || [];
            src.forEach((s, i) => {
                const t0 = +s.time, t1 = i + 1 < src.length ? +src[i + 1].time : Infinity;
                const count = (arr) => arr.reduce((n, x) => n + (x.t >= t0 && x.t < t1 && !x.mt ? 1 : 0), 0);
                seen[s.name] = (seen[s.name] || 0) + 1;
                list.push({ key: i + ':' + s.name, name: s.name, nth: seen[s.name], t0, t1, notes: count(notes) + count(chords) });
            });
            // Only number names that repeat ("verse 2"); unique ones stay plain.
            list.forEach((s) => { s.label = seen[s.name] > 1 ? s.name + ' ' + s.nth : s.name; });
        }
        secCache = { src, list };
        return list;
    }
    function sectionAt(t) {
        const list = sections();
        let cur = null;
        for (const s of list) { if (s.t0 <= t) cur = s; else break; }
        return cur;
    }

    // ── per-run judgment details (fed by note_detect via highway_tweaks' hook) ──
    function closePass(r) {
        const p = r && r.pass;
        if (!p) return;
        r.pass = null;
        const n = p.h + p.m;
        if (!p.fullSpeed || n < 3 || (p.sec.notes && n < PASS_MIN_COVER * p.sec.notes)) return;
        const acc = pct(p.h, n);
        const prev = r.sections[p.sec.key];
        if (!prev || acc > prev[0]) r.sections[p.sec.key] = [acc, n];
    }
    const prevHook = window.__hwtOnJudgment;
    window.__hwtOnJudgment = (j, section) => {
        if (prevHook) { try { prevHook(j, section); } catch (_) { /* ignore */ } }
        if (!j) return;
        // Start the run on the first judgment rather than at the next tick,
        // so the opening notes' details aren't lost.
        if (!run && curFile && document.querySelector('.nd-hud')) {
            const i = info(), st = ndStats();
            const total = st ? st.hits + st.misses : 0;
            if ((i.arrangement || i.title) && !(spent && spent.file === curFile && total > spent.total)) {
                spent = null;
                run = newRun(i, i.arrangement || '');
            }
        }
        const r = run;
        if (!r) return;
        const n = j.chartNote || j.note || {};
        const hit = !!j.hit;
        // strings (single notes only; a chord-level judgment has no one string)
        if (!j.chord && Number.isInteger(n.s) && n.s >= 0 && n.s < 8) r.strings[n.s][hit ? 0 : 1]++;
        // techniques
        const flags = [];
        if (n.bn) flags.push('B');
        if (n.sl != null && n.sl >= 0) flags.push('S');
        if (n.hm || n.hp) flags.push('H');
        if (n.ho) flags.push('h');
        if (n.po) flags.push('p');
        if (n.tp) flags.push('t');
        if (n.pm) flags.push('PM');
        if (n.tr) flags.push('TR');
        if (n.ac) flags.push('A');
        if ((+n.sus || 0) > 0.5) flags.push('SUS');
        for (const f of flags) { const c = r.tech[f] || (r.tech[f] = [0, 0]); c[hit ? 0 : 1]++; }
        // section passes
        const t = Number.isFinite(j.noteTime) ? j.noteTime : null;
        if (t != null) {
            const sec = sectionAt(t);
            if (sec) {
                if (!r.pass || r.pass.sec.key !== sec.key || t < r.pass.lastT - 0.5) {
                    closePass(r);
                    r.pass = { sec, h: 0, m: 0, fullSpeed: true, lastT: t };
                }
                r.pass.lastT = t;
                if (speedNow() < 0.999) r.pass.fullSpeed = false;
                r.pass[hit ? 'h' : 'm']++;
            }
        }
    };

    function detailsOf(r) {
        closePass(r);
        return { sections: r.sections, tech: r.tech, strings: r.strings };
    }

    function payloadOf(r, reason) {
        const complete = !r.looped && (reason === 'ended' || r.maxProgress >= COMPLETE_AT);
        return {
            filename: r.filename, title: r.title, artist: r.artist, arrangement: r.arrangement,
            hits: r.hits, misses: r.misses, best_streak: r.bestStreak, complete,
            speed: r.minSpeed, progress: +r.maxProgress.toFixed(3), played_s: (performance.now() - r.t0) / 1000,
            details: detailsOf(r),
        };
    }

    function finalize(reason, beacon) {
        const r = run;
        run = null;
        if (!r) return;
        spent = { file: r.filename, total: r.hits + r.misses };
        const st = ndStats();
        // Take the freshest numbers if note_detect still holds this run's stats.
        if (st && st.hits + st.misses >= r.hits + r.misses) {
            r.hits = st.hits; r.misses = st.misses; r.bestStreak = Math.max(r.bestStreak, st.bestStreak | 0);
        }
        spent.total = Math.max(spent.total, r.hits + r.misses);
        if (r.hits + r.misses < MIN_JUDGED) return;
        const payload = payloadOf(r, reason);
        const body = JSON.stringify(payload);
        if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon(API + '/run', new Blob([body], { type: 'application/json' }));
            return;
        }
        fetch(API + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
            .then((x) => x.json()).then((d) => {
                if (!d || !d.ok) return;
                if (songFor === r.filename + '|' + r.arrangement) { song = d; lastPaint = ''; }
                const pop = window.__hwtPopup;
                if (pop) {
                    if (d.full_combo) pop('FULL COMBO!');
                    else if (d.new_best) pop('NEW BEST ' + Math.round(d.accuracy) + '%!');
                }
                if (reason === 'ended') endCard(d, payload);
                window.dispatchEvent(new CustomEvent('songscores:run', { detail: d }));
            }).catch(() => { /* ignore */ });
    }

    function loadSong(filename, arrangement, i) {
        const key = filename + '|' + arrangement;
        if (songFor === key) return;
        songFor = key; song = null; lastPaint = '';
        const q = new URLSearchParams({ filename, arrangement, artist: i.artist || '', title: i.title || '' });
        fetch(API + '/song?' + q).then((x) => x.json()).then((d) => { if (songFor === key) { song = d; lastPaint = ''; } }).catch(() => {});
    }

    // Wrap playSong: close the previous song's run before note_detect's own
    // wrapper (loaded earlier, so it's inside ours) resets the stats.
    function wrapPlaySong() {
        const orig = window.playSong;
        if (typeof orig !== 'function') { setTimeout(wrapPlaySong, 500); return; }
        if (orig.__songScores) return;
        const wrapped = async function (filename, arrangement) {
            finalize('switch');
            curFile = null;
            const res = await orig.apply(this, arguments);
            try { curFile = decodeURIComponent(filename); } catch (_) { curFile = filename; }
            return res;
        };
        wrapped.__songScores = true;
        window.playSong = wrapped;
    }
    wrapPlaySong();

    try {
        window.slopsmith.on('song:ended', () => finalize('ended'));
        window.slopsmith.on('song:arrangement-changed', () => finalize('switch'));
    } catch (_) { /* ignore */ }
    window.addEventListener('beforeunload', () => finalize('closed', true));

    function newRun(i, arrangement) {
        return {
            filename: curFile, arrangement, title: i.title || '', artist: i.artist || '', hits: 0, misses: 0,
            bestStreak: 0, maxProgress: 0, minSpeed: 9, looped: false, t0: performance.now(),
            sections: {}, tech: {}, strings: Array.from({ length: 8 }, () => [0, 0]), pass: null,
            bass: /bass/i.test(arrangement),
        };
    }

    function tick() {
        const hud = document.querySelector('.nd-hud');
        const st = ndStats();
        if (!hud || !st || !curFile) {
            if (run && !hud) finalize('stopped');
            return;
        }
        const i = info();
        if (!i.arrangement && !i.title) return;
        const arrangement = i.arrangement || '';
        loadSong(curFile, arrangement, i);
        const total = st.hits + st.misses;
        if (run && (run.filename !== curFile || run.arrangement !== arrangement || total < run.hits + run.misses)) {
            finalize('switch');   // stats were reset (restart / re-enable) or the song changed under us
        }
        if (!run) {
            if (spent && spent.file === curFile && total >= spent.total && total > 0) { paint(hud, st); return; }
            spent = null;
            if (total === 0) { paint(hud, st); return; }
            run = newRun(i, arrangement);
        }
        run.hits = st.hits; run.misses = st.misses; run.bestStreak = Math.max(run.bestStreak, st.bestStreak | 0);
        const dur = Number(i.duration);
        const t = hw() && hw().getTime ? hw().getTime() : 0;
        if (dur > 0) run.maxProgress = Math.max(run.maxProgress, Math.min(1, t / dur));
        run.minSpeed = Math.min(run.minSpeed, speedNow());
        if (loopOn()) run.looped = true;
        paint(hud, st);
    }

    // ── rendering helpers ──
    function spark(runs, best) {
        const pts = runs.slice(0, 15).reverse();
        if (pts.length < 2) return '';
        const W = 270, H = 40, lo = Math.max(0, Math.min(...pts.map((r) => r.accuracy)) - 5), hi = 100;
        const x = (k) => 4 + k * (W - 8) / (pts.length - 1);
        const y = (a) => H - 4 - (a - lo) / Math.max(1, hi - lo) * (H - 8);
        const counted = (r) => r.complete && r.speed >= 0.999;
        let svg = `<svg width="${W}" height="${H}" style="display:block;margin:4px 0 0 auto;overflow:visible">`;
        if (best != null) svg += `<line x1="0" x2="${W}" y1="${y(best)}" y2="${y(best)}" stroke="${GOLD}" stroke-opacity=".45" stroke-dasharray="3 3"/>`;
        svg += `<polyline fill="none" stroke="#cbd5e1" stroke-opacity=".5" stroke-width="1.5" points="${pts.map((r, k) => x(k) + ',' + y(r.accuracy)).join(' ')}"/>`;
        pts.forEach((r, k) => {
            const c = counted(r) ? (best != null && r.accuracy >= best ? GOLD : WHITE) : DIM;
            svg += `<circle cx="${x(k)}" cy="${y(r.accuracy)}" r="${counted(r) ? 3.2 : 2.2}" fill="${c}"><title>${esc(r.ts)} — ${r.accuracy}%${counted(r) ? (r.misses ? '' : ' FULL COMBO') : ' (partial or slowed)'}</title></circle>`;
        });
        return svg + '</svg>';
    }

    function stringLabels(n, bass) {
        if (bass) return n <= 4 ? ['E', 'A', 'D', 'G'] : ['B', 'E', 'A', 'D', 'G', 'C'].slice(0, n);
        return n <= 6 ? ['E', 'A', 'D', 'G', 'B', 'e'] : ['B', 'E', 'A', 'D', 'G', 'B', 'e', 'a'].slice(0, n);
    }
    function stringBars(strings, bass, big) {
        let n = bass ? 4 : 6;
        strings.forEach((c, s) => { if (c[0] + c[1] > 0 && s + 1 > n) n = s + 1; });
        if (!strings.slice(0, n).some((c) => c[0] + c[1] > 0)) return '';
        const labels = stringLabels(n, bass), H = big ? 46 : 30, Wc = big ? 26 : 18;
        // High string on top in the tab view, but bars read left→right low→high like a fretboard from above.
        let html = `<div style="display:inline-flex;gap:${big ? 6 : 4}px;align-items:flex-end">`;
        for (let s = 0; s < n; s++) {
            const [h, m] = strings[s] || [0, 0];
            const p = pct(h, h + m);
            const fill = p == null ? 0 : Math.max(3, Math.round(H * p / 100));
            html += `<div style="width:${Wc}px;text-align:center" title="${labels[s]} string: ${p == null ? 'no notes' : p + '% (' + h + '/' + (h + m) + ')'}">` +
                `<div style="height:${H}px;background:rgba(255,255,255,.07);border-radius:3px;position:relative;overflow:hidden">` +
                `<div style="position:absolute;left:0;right:0;bottom:0;height:${fill}px;background:${levelCol(p)};opacity:${p == null ? 0 : 0.9}"></div></div>` +
                `<div style="font-size:${big ? 12 : 10}px;color:${DIM};margin-top:2px">${labels[s]}</div>` +
                (big ? `<div style="font-size:11px;color:${levelCol(p)}">${p == null ? '–' : p + '%'}</div>` : '') + '</div>';
        }
        return html + '</div>';
    }
    function weakTech(tech, minN, max) {
        return Object.entries(tech)
            .map(([k, c]) => ({ k, name: TECH[k] || k, h: c[0], n: c[0] + c[1], p: pct(c[0], c[0] + c[1]) }))
            .filter((x) => x.n >= minN)
            .sort((a, b) => a.p - b.p || b.n - a.n)
            .slice(0, max);
    }
    const fmtDur = (s) => {
        s = Math.round(s || 0);
        const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
        return h ? h + 'h ' + m + 'm' : m + 'm';
    };

    // ── in-game HUD block ──
    function paint(hud, st) {
        if (!panel || panel.parentNode !== hud) {
            panel = document.createElement('div');
            panel.className = 'pc-score';
            const after = hud.querySelector('.hwt-perf');
            if (after) after.after(panel); else hud.insertBefore(panel, hud.firstChild);
            lastPaint = '';
        }
        const total = st.hits + st.misses;
        const live = total > 0 ? 100 * st.hits / total : null;
        const r = run;
        const t = hw() && hw().getTime ? hw().getTime() : 0;
        const sec = sectionAt(t);
        const pass = r && r.pass && sec && r.pass.sec.key === sec.key ? r.pass : null;
        const key = [song ? song.run_count + ':' + (song.best && song.best.accuracy) : 'none', total, st.hits,
            sec ? sec.key : '', pass ? pass.h + '/' + pass.m : ''].join('|');
        if (key === lastPaint) return;
        lastPaint = key;
        const rows = [];
        const row = (label, value) => '<div class="row"><span class="lbl">' + label + '</span>' + value + '</div>';
        if (total >= 10 && st.misses === 0) {
            rows.push('<div class="fc">★ FULL COMBO</div>');
        }
        if (song) {
            const best = song.best ? song.best.accuracy : null;
            const last = song.runs && song.runs.length ? song.runs[0].accuracy : null;
            rows.push('<div class="sub">This song</div>');
            rows.push(row('best', '<b style="color:' + GOLD + ';font-size:22px">' + (best != null ? Math.round(best) + '%' : '–') + '</b>'));
            if (last != null) rows.push(row('last run', '<b>' + Math.round(last) + '%</b>'));
            if (best != null && live != null && total >= 10) {
                const d = Math.round(live - best);
                rows.push(row('pace vs best', '<b style="color:' + (d >= 0 ? GOLD : BLUE) + '">' + (d >= 0 ? '▲ +' : '▼ ') + d + '%</b>'));
            }
            rows.push(spark(song.runs || [], best));
        }
        if (sec) {
            const sb = song && song.section_best ? song.section_best[sec.key] : null;
            const now = pass ? pct(pass.h, pass.h + pass.m) : null;
            rows.push('<div class="sub">Section · <span style="color:#f1f5f9;text-transform:none;letter-spacing:0">' + esc(sec.label) + '</span></div>');
            rows.push(row('this pass', '<b style="color:' + levelCol(now) + '">' + (now != null ? now + '%' : '–') + '</b>'));
            rows.push(row('section best', '<b style="color:' + GOLD + '">' + (sb != null ? sb + '%' : '–') + '</b>'));
        }
        if (r) {
            const weak = weakTech(r.tech, 4, 3).filter((x) => live == null || x.p < live - 5);
            const sbars = stringBars(r.strings, r.bass, false);
            if (weak.length || sbars) rows.push('<div class="sub">Weak spots</div>');
            for (const x of weak) {
                rows.push(row(x.name, '<b style="color:' + levelCol(x.p) + '">' + x.p + '%</b><span class="lbl" style="font-size:12px">(' + x.h + '/' + x.n + ')</span>'));
            }
            if (sbars) rows.push('<div class="row" style="margin-top:6px;align-items:flex-end"><span class="lbl">strings</span>' + sbars + '</div>');
        }
        const rsd = song && song.rocksmith;
        if (rsd) {
            rows.push('<div class="sub">Rocksmith · ' + esc(rsd.arrangement) + '</div>');
            rows.push(row('best mastery', '<b>' + Math.round(rsd.mastery_peak) + '%</b>'));
            rows.push(row('best streak', '<b>' + rsd.streak + '</b>'));
        }
        panel.innerHTML = rows.join('');
    }

    // ── end-of-song card (added to note_detect's summary popup) ──
    function endCard(d, payload) {
        let tries = 0;
        (function attach() {
            const ov = document.querySelector('.nd-summary-overlay');
            if (!ov) { if (++tries < 20) setTimeout(attach, 150); return; }
            const box = ov.firstElementChild;
            if (!box || box.querySelector('.pc-endcard')) return;
            box.style.width = '30rem';
            const el = document.createElement('div');
            el.className = 'pc-endcard';
            el.innerHTML = endCardHtml(d, payload);
            const head = box.querySelector('.text-center');
            if (head) head.after(el); else box.prepend(el);
        })();
    }
    function endCardHtml(d, payload) {
        const acc = d.accuracy;
        const parts = [];
        let banner;
        if (!d.counted) banner = ['Practice run', DIM, payload.speed < 0.999 ? 'played at ' + Math.round(payload.speed * 100) + '% speed' : 'partial or looped — not counted toward your best'];
        else if (d.full_combo) banner = ['FULL COMBO!', GOLD, 'every note hit'];
        else if (d.first_full_run) banner = ['First full run', WHITE, 'this is the score to beat'];
        else if (d.new_best) banner = ['NEW BEST!', GOLD, 'previous ' + Math.round(d.prev_best) + '%  ▲ +' + (acc - d.prev_best).toFixed(1) + '%'];
        else banner = ['Best ' + Math.round(d.prev_best) + '%', WHITE, (acc - d.prev_best).toFixed(1) + '% from your best'];
        parts.push(`<div style="text-align:center;margin:-4px 0 10px"><div style="font:900 22px system-ui;color:${banner[1]};letter-spacing:1px">${banner[0]}</div>` +
            `<div style="font-size:12px;color:${DIM}">${banner[2]}</div></div>`);
        const stat = (v, label, col) => `<div style="text-align:center"><div style="font-weight:700;color:${col || WHITE}">${v}</div><div style="font-size:11px;color:${DIM}">${label}</div></div>`;
        const trend = d.week_ago_best != null ? [acc - d.week_ago_best, 'vs a week ago']
            : (d.first_counted != null && d.run_count > 1 && d.counted ? [acc - d.first_counted, 'vs first full run'] : null);
        parts.push('<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px">' +
            stat(d.best ? Math.round(d.best.accuracy) + '%' : '–', 'song best', GOLD) +
            stat(trend ? (trend[0] >= 0 ? '+' : '') + trend[0].toFixed(1) + '%' : '–', trend ? trend[1] : 'trend', trend ? (trend[0] >= 0 ? GOLD : BLUE) : DIM) +
            stat(d.best_streak, 'best streak ever') +
            stat(fmtDur(d.practice_s), 'time on song') + '</div>');
        const rsd = d.rocksmith;
        if (rsd || d.full_combos) {
            parts.push(`<div style="font-size:12px;color:${DIM};text-align:center;margin-bottom:8px">` +
                (rsd ? `Rocksmith ${esc(rsd.arrangement)}: mastery <b style="color:${WHITE}">${Math.round(rsd.mastery_peak)}%</b> · streak <b style="color:${WHITE}">${rsd.streak}</b> · ${rsd.plays} plays` : '') +
                (rsd && d.full_combos ? ' · ' : '') + (d.full_combos ? `<b style="color:${GOLD}">${d.full_combos} full combo${d.full_combos > 1 ? 's' : ''}</b>` : '') + '</div>');
        }
        // sections this run vs best
        const list = sections();
        const secs = payload.details.sections || {};
        const rowsS = list.filter((s) => secs[s.key]);
        if (rowsS.length) {
            let h = `<div style="font-size:12px;color:${DIM};margin:6px 0 4px">Sections (★ = new section best)</div>`;
            for (const s of rowsS) {
                const a = secs[s.key][0], prev = d.prev_section_best ? d.prev_section_best[s.key] : undefined;
                const isNew = prev == null ? false : a > prev;
                const best = d.section_best[s.key];
                h += `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:3px">` +
                    `<span style="width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cbd5e1">${esc(s.label)}</span>` +
                    `<div style="flex:1;height:8px;background:rgba(255,255,255,.07);border-radius:4px;position:relative">` +
                    `<div style="position:absolute;left:0;top:0;bottom:0;width:${a}%;background:${levelCol(a)};border-radius:4px"></div>` +
                    (best != null ? `<div title="best ${best}%" style="position:absolute;top:-2px;bottom:-2px;left:${best}%;width:2px;background:${GOLD}"></div>` : '') + '</div>' +
                    `<span style="width:48px;text-align:right;color:${levelCol(a)}">${isNew ? '★ ' : ''}${a}%</span></div>`;
            }
            parts.push(h);
        }
        const weak = weakTech(payload.details.tech || {}, 3, 4);
        if (weak.length) {
            parts.push(`<div style="font-size:12px;color:${DIM};margin:10px 0 4px">Techniques (weakest first)</div>` +
                '<div style="display:flex;flex-wrap:wrap;gap:6px">' + weak.map((x) =>
                    `<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.06);color:${levelCol(x.p)}">${x.name} ${x.p}% <span style="color:${DIM}">(${x.h}/${x.n})</span></span>`).join('') + '</div>');
        }
        const sb = stringBars(payload.details.strings || [], /bass/i.test(payload.arrangement), true);
        if (sb) parts.push(`<div style="font-size:12px;color:${DIM};margin:10px 0 4px">Per string</div><div style="text-align:center">${sb}</div>`);
        return '<div style="border-top:1px solid rgba(255,255,255,.1);border-bottom:1px solid rgba(255,255,255,.1);padding:10px 0;margin-bottom:12px">' + parts.join('') + '</div>';
    }

    const css = document.createElement('style');
    css.textContent = `
        /* Sized/zoomed as a child of the highway_tweaks stats card (.nd-hud > *). */
        .pc-score { font: 15px system-ui, sans-serif; color: #cbd5e1; text-shadow: 0 1px 3px #000; }
        .pc-score .row { display: flex; align-items: baseline; justify-content: flex-end; gap: 5px; margin-top: 3px; white-space: nowrap; }
        .pc-score .row > .lbl:first-child { margin-right: auto; }
        .pc-score .row b { color: ${WHITE}; }
        .pc-score .lbl { color: ${DIM}; }
        .pc-score .sub { margin-top: 10px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.12);
            font: 700 11px system-ui, sans-serif; letter-spacing: 1.5px; text-transform: uppercase; color: ${DIM}; }
        .pc-score .fc { margin-top: 8px; text-align: center; font: 900 20px system-ui, sans-serif; letter-spacing: 2px;
            color: ${GOLD}; text-shadow: 0 0 12px ${GOLD}88, 0 1px 3px #000; }
    `;
    document.head.appendChild(css);
    setInterval(tick, 500);
    window.__songScores = { finalize, get run() { return run; }, get song() { return song; } };
})();

// ── Compact table view for the library ──────────────────────────────────
// A third view next to Grid and Artist/Album: one dense row per song with
// sortable columns (click a header; again to reverse) for plays, best
// score, Rocksmith mastery, full combo, last played and time practised.
// Honours the library's search box and format filter. PSARC/sloppak copies
// of the same song are merged by default (their stats are shared anyway;
// clicking plays the sloppak). Rows are virtualised, so the DOM stays
// small (see the highway_tweaks notes on DOM-size-driven jank).
(function () {
    'use strict';
    if (window.__pcTable) return;
    window.__pcTable = true;
    const API = '/api/plugins/play_counts/table';
    const ROW_H = 30, OVERSCAN = 12;
    const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
    const LSset = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

    const LAST = String.fromCharCode(0xffff);   // sorts blank artist/title/album after everything
    // [key, header, width, align, sort accessor]
    const COLS = [
        ['fc', '', '34px', 'center', (r) => (r.fc ? 1 : 0)],
        ['artist', 'Artist', 'minmax(120px,1.1fr)', 'left', (r) => r.artistSort || LAST],
        ['title', 'Title', 'minmax(140px,1.5fr)', 'left', (r) => r.titleSort || LAST],
        ['album', 'Album', 'minmax(100px,1fr)', 'left', (r) => r.albumSort || LAST],
        ['year', 'Year', '52px', 'right', (r) => r.year || ''],
        ['tuning', 'Tuning', '104px', 'left', (r) => r.tuning],
        ['parts', 'Parts', '50px', 'left', (r) => r.parts],
        ['duration', 'Len', '50px', 'right', (r) => r.duration],
        ['plays', 'Plays', '58px', 'right', (r) => r.plays],
        ['best', 'Best', '56px', 'right', (r) => (r.best == null ? -1 : r.best)],
        ['rs', 'RS', '52px', 'right', (r) => (r.rs == null ? -1 : r.rs)],
        ['last', 'Last played', '96px', 'right', (r) => r.last || ''],
        ['time', 'Time', '58px', 'right', (r) => r.practice],
    ];
    const DESC_FIRST = new Set(['fc', 'plays', 'best', 'rs', 'last', 'time', 'year', 'duration']);
    let sortKey = LS('pcTableSort', 'plays'), sortDir = Number(LS('pcTableDir', '-1')) || -1;
    let merge = LS('pcTableMerge', '1') === '1';
    let all = [], view = [], wrap = null, body = null, spacer = null, header = null, info = null, active = false, loadedAt = 0;

    function load(force) {
        if (!force && Date.now() - loadedAt < 15000 && all.length) return Promise.resolve();
        return fetch(API).then((r) => r.json()).then((d) => {
            const ix = Object.fromEntries(d.cols.map((c, i) => [c, i]));
            const rows = d.rows.map((a) => ({
                filename: a[ix.filename], artist: a[ix.artist], title: a[ix.title], album: a[ix.album], year: a[ix.year],
                duration: a[ix.duration], tuning: a[ix.tuning], parts: a[ix.parts], format: a[ix.format],
                plays: a[ix.rs_plays] + a[ix.slop_plays], rsPlays: a[ix.rs_plays], slopPlays: a[ix.slop_plays],
                best: a[ix.best], rs: a[ix.rs_mastery], fc: a[ix.fc], last: a[ix.last_played], practice: a[ix.practice_s],
                formats: [a[ix.format]],
            }));
            for (const r of rows) {
                r.artistSort = norm(r.artist.replace(/^the\s+/i, ''));
                r.titleSort = norm(r.title);
                r.albumSort = norm(r.album);
                r.search = (r.artist + ' ' + r.title + ' ' + r.album).toLowerCase();
            }
            all = rows;
            loadedAt = Date.now();
            if (!d.ready) setTimeout(() => load(true).then(refresh), 3000);
        }).catch(() => { /* keep old data */ });
    }

    function filtered() {
        const q = ((document.getElementById('lib-filter') || {}).value || '').trim().toLowerCase();
        const fmt = (document.getElementById('lib-format') || {}).value || '';
        let rows = all;
        if (merge) {
            const by = new Map();
            for (const r of all) {
                const k = r.titleSort ? r.artistSort + '|' + r.titleSort : r.filename;
                const cur = by.get(k);
                if (!cur) { by.set(k, Object.assign({}, r, { formats: [r.format] })); continue; }
                if (!cur.formats.includes(r.format)) cur.formats.push(r.format);
                // Prefer the sloppak copy to play (it carries stems); stats are shared.
                if (r.format === 'sloppak' && cur.format !== 'sloppak') {
                    Object.assign(cur, { filename: r.filename, format: r.format, parts: r.parts || cur.parts });
                }
            }
            rows = [...by.values()];
        }
        if (fmt) rows = rows.filter((r) => r.formats.includes(fmt));
        if (q) {
            const terms = q.split(/\s+/);
            rows = rows.filter((r) => terms.every((t) => r.search.includes(t)));
        }
        const col = COLS.find((c) => c[0] === sortKey) || COLS[8];
        const acc = col[4];
        return rows.slice().sort((a, b) => {
            const x = acc(a), y = acc(b);
            const c = x < y ? -1 : x > y ? 1 : 0;
            return c * sortDir || (a.artistSort < b.artistSort ? -1 : a.artistSort > b.artistSort ? 1 : 0) || (a.titleSort < b.titleSort ? -1 : 1);
        });
    }

    const grid = () => COLS.map((c) => c[2]).join(' ');
    const fmtLen = (s) => (s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '');
    const fmtTime = (s) => (!s ? '' : s >= 3600 ? (s / 3600).toFixed(1) + 'h' : Math.max(1, Math.round(s / 60)) + 'm');
    function fmtLast(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (!t) return '';
        const days = Math.floor((Date.now() - t) / 86400000);
        if (days < 1) return 'today';
        if (days < 2) return 'yesterday';
        if (days < 31) return days + 'd ago';
        if (days < 365) return Math.round(days / 30) + 'mo ago';
        return (days / 365).toFixed(1) + 'y ago';
    }
    const scoreCol = (p) => (p == null ? '' : p >= 95 ? '#ffd36b' : p >= 85 ? '#f1f5f9' : p >= 70 ? '#9fd8ff' : '#8b95a5');

    function cell(r, c) {
        switch (c[0]) {
            case 'fc': return r.fc ? '<span class="pc-fc-tag" title="Full combo">FC</span>' : '';
            case 'artist': return esc(r.artist);
            case 'title': return '<span style="color:#f1f5f9">' + esc(r.title) + '</span>' +
                (merge && r.formats.length > 1 ? '' : r.format === 'sloppak' ? ' <span class="pc-t-fmt">slop</span>' : '');
            case 'album': return esc(r.album);
            case 'year': return esc(r.year);
            case 'tuning': return esc(r.tuning);
            case 'parts': return esc(r.parts);
            case 'duration': return fmtLen(r.duration);
            case 'plays': return r.plays ? '<span title="' + r.rsPlays + ' in Rocksmith, ' + r.slopPlays + ' in Slopsmith" style="color:#7dd3fc">' + r.plays + '</span>' : '';
            case 'best': return r.best == null ? '' : '<span style="color:' + scoreCol(r.best) + ';font-weight:600">' + Math.round(r.best) + '%</span>';
            case 'rs': return r.rs == null ? '' : '<span style="color:#a5b1c2">' + Math.round(r.rs) + '%</span>';
            case 'last': return '<span title="' + esc(r.last || '') + '">' + fmtLast(r.last) + '</span>';
            case 'time': return fmtTime(r.practice);
        }
        return '';
    }

    function renderRows() {
        if (!active || !body) return;
        const top = wrap.scrollTop, h = wrap.clientHeight || 600;
        const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
        const last = Math.min(view.length, Math.ceil((top + h) / ROW_H) + OVERSCAN);
        let html = '';
        for (let i = first; i < last; i++) {
            const r = view[i];
            html += '<div class="pc-t-row" data-i="' + i + '" style="top:' + (i * ROW_H) + 'px">' +
                COLS.map((c) => '<div style="text-align:' + c[3] + '">' + cell(r, c) + '</div>').join('') + '</div>';
        }
        body.innerHTML = html;
    }

    function renderHeader() {
        header.innerHTML = COLS.map((c) => {
            const on = c[0] === sortKey;
            return '<div data-k="' + c[0] + '" style="text-align:' + c[3] + '" class="' + (on ? 'on' : '') + '">' +
                (c[1] || '★') + (on ? (sortDir < 0 ? ' ▼' : ' ▲') : '') + '</div>';
        }).join('');
    }

    function refresh() {
        if (!active) return;
        view = filtered();
        spacer.style.height = (view.length * ROW_H) + 'px';
        info.querySelector('.pc-t-count').textContent = view.length + ' songs';
        renderHeader();
        renderRows();
    }

    function build() {
        if (wrap) return;
        const tree = document.getElementById('lib-tree');
        if (!tree) return;
        const box = document.createElement('div');
        box.id = 'pc-table';
        box.className = 'hidden';
        box.innerHTML =
            '<div class="pc-t-info"><span class="pc-t-count"></span>' +
            '<label><input type="checkbox" class="pc-t-merge"> merge PSARC + sloppak copies</label>' +
            '<span style="flex:1"></span><span>click a column to sort · click a row to play</span></div>' +
            '<div class="pc-t-head"></div>' +
            '<div class="pc-t-wrap"><div class="pc-t-spacer"><div class="pc-t-body"></div></div></div>';
        tree.after(box);
        info = box.querySelector('.pc-t-info');
        header = box.querySelector('.pc-t-head');
        wrap = box.querySelector('.pc-t-wrap');
        spacer = box.querySelector('.pc-t-spacer');
        body = box.querySelector('.pc-t-body');
        header.style.gridTemplateColumns = grid();
        const m = info.querySelector('.pc-t-merge');
        m.checked = merge;
        m.onchange = () => { merge = m.checked; LSset('pcTableMerge', merge ? '1' : '0'); refresh(); };
        header.onclick = (e) => {
            const k = e.target.closest('[data-k]');
            if (!k) return;
            const key = k.dataset.k;
            if (key === sortKey) sortDir = -sortDir;
            else { sortKey = key; sortDir = DESC_FIRST.has(key) ? -1 : 1; }
            LSset('pcTableSort', sortKey); LSset('pcTableDir', String(sortDir));
            wrap.scrollTop = 0;
            refresh();
        };
        let raf = 0;
        wrap.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderRows(); }); }, { passive: true });
        body.addEventListener('click', (e) => {
            const row = e.target.closest('.pc-t-row');
            if (!row) return;
            e.stopPropagation();
            const r = view[+row.dataset.i];
            if (r && typeof window.playSong === 'function') window.playSong(encodeURIComponent(r.filename));
        });
        const f = document.getElementById('lib-filter');
        if (f) f.addEventListener('input', () => { if (active) { wrap.scrollTop = 0; refresh(); } });
        const fmt = document.getElementById('lib-format');
        if (fmt) fmt.addEventListener('change', () => { if (active) refresh(); });
        window.addEventListener('resize', () => { if (active) renderRows(); });
    }

    const BTN_ON = 'px-3 py-2.5 text-sm transition text-accent-light';
    const BTN_OFF = 'px-3 py-2.5 text-sm transition text-gray-600 hover:text-gray-400';
    function show() {
        build();
        if (!wrap) return;
        active = true;
        LSset('pcLibView', 'table');
        for (const id of ['lib-grid', 'lib-tree']) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
        document.querySelectorAll('.lib-grid-ctrl, .lib-tree-ctrl').forEach((el) => el.classList.add('hidden'));
        for (const id of ['view-grid-btn', 'view-tree-btn']) { const b = document.getElementById(id); if (b) b.className = BTN_OFF; }
        const mine = document.getElementById('view-table-btn');
        if (mine) mine.className = BTN_ON;
        try { if (typeof stopInfiniteScroll === 'function') stopInfiniteScroll(); } catch (_) { /* ignore */ }
        document.getElementById('pc-table').classList.remove('hidden');
        load(false).then(refresh);
        refresh();
    }
    function hide() {
        active = false;
        LSset('pcLibView', null);
        const box = document.getElementById('pc-table');
        if (box) box.classList.add('hidden');
        const mine = document.getElementById('view-table-btn');
        if (mine) mine.className = BTN_OFF;
    }

    function install() {
        const tree = document.getElementById('view-tree-btn');
        if (!tree || typeof window.setLibView !== 'function') { setTimeout(install, 500); return; }
        if (!document.getElementById('view-table-btn')) {
            const b = document.createElement('button');
            b.id = 'view-table-btn';
            b.title = 'Table view (sortable: plays, scores, last played)';
            b.className = BTN_OFF;
            b.innerHTML = '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 16 16"><rect x="1" y="1.5" width="14" height="2" rx=".5"/><rect x="1" y="5.5" width="14" height="2" rx=".5"/><rect x="1" y="9.5" width="14" height="2" rx=".5"/><rect x="1" y="13" width="14" height="2" rx=".5"/></svg>';
            b.onclick = show;
            tree.after(b);
        }
        const orig = window.setLibView;
        if (!orig.__pcTable) {
            const wrapped = function () { hide(); return orig.apply(this, arguments); };
            wrapped.__pcTable = true;
            window.setLibView = wrapped;
        }
        if (LS('pcLibView', '') === 'table') setTimeout(show, 300);
    }

    // Refresh numbers when coming back to the library after playing.
    window.addEventListener('songscores:run', () => { loadedAt = 0; });
    try {
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('screen:changed', () => { if (active) load(true).then(refresh); });
        }
    } catch (_) { /* ignore */ }

    const style = document.createElement('style');
    style.textContent = `
        #pc-table { font-size: 13px; }
        #pc-table .pc-t-info { display:flex; gap:16px; align-items:center; color:#6b7280; font-size:12px; margin-bottom:8px; }
        #pc-table .pc-t-info label { display:flex; gap:6px; align-items:center; cursor:pointer; }
        #pc-table .pc-t-count { color:#cbd5e1; font-weight:600; }
        #pc-table .pc-t-head, #pc-table .pc-t-row { display:grid; grid-template-columns:${COLS.map((c) => c[2]).join(' ')}; gap:10px; padding:0 10px; align-items:center; }
        #pc-table .pc-t-head { height:32px; color:#9ca3af; font-size:11px; text-transform:uppercase; letter-spacing:.5px;
            border-bottom:1px solid rgba(255,255,255,.08); user-select:none; }
        #pc-table .pc-t-head > div { cursor:pointer; white-space:nowrap; }
        #pc-table .pc-t-head > div:hover, #pc-table .pc-t-head > div.on { color:#f1f5f9; }
        #pc-table .pc-t-wrap { height:calc(100vh - 300px); min-height:300px; overflow-y:auto; position:relative; }
        #pc-table .pc-t-spacer { position:relative; }
        #pc-table .pc-t-row { position:absolute; left:0; right:0; height:${ROW_H}px; color:#9ca3af; cursor:pointer;
            border-bottom:1px solid rgba(255,255,255,.03); }
        #pc-table .pc-t-row:hover { background:rgba(255,255,255,.05); }
        #pc-table .pc-t-row > div { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; }
        #pc-table .pc-t-fmt { font-size:10px; color:#6b7280; border:1px solid #374151; border-radius:3px; padding:0 3px; }
        #pc-table .pc-fc-tag { font-size:10px; font-weight:800; color:#ffe08a; background:rgba(255,197,49,.2); border-radius:3px; padding:1px 4px; }
    `;
    document.head.appendChild(style);
    install();
})();
