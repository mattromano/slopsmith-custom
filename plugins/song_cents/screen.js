// Song Cents: show how many cents a song's recording sits off its chart tuning (asked for
// 2026-10-13: lots of Oasis records are +25..+50c sharp but showed plain "E Standard").
//
// routes.py resolves an offset from the cache, the chart, or the source PSARC's CentOffset. When
// nothing is known, this script measures it from the song's guitar stem: decodeAudioData only, no
// playback (assets/estimate.js), then posts it back so it is cached for everyone.
// Shown as a small "+45c" badge next to the library's tuning badge. Live Retune reads
// window.__songCents.current for its "Match song" toggle.
(function () {
    'use strict';
    const VERSION = '1.0.1';
    const MIN_CONFIDENCE = 0.35;   // below this the measurement is noise (drum solos, ambient)
    const IN_TUNE = 8;             // |cents| under this counts as in tune (measurement is ~±5c)
    const API = '/api/plugins/song_cents';

    const sc = window.__songCents = window.__songCents || {};
    sc.known = sc.known || {};
    sc.current = sc.current || null;

    const emit = () => window.dispatchEvent(new CustomEvent('songcents:change', { detail: sc.current }));

    let estimatorP = null;
    function estimator() {
        if (window.__songCentsEstimate) return Promise.resolve(window.__songCentsEstimate);
        if (!estimatorP) {
            estimatorP = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = `${API}/assets/estimate.js?v=${VERSION}`;
                s.onload = () => resolve(window.__songCentsEstimate);
                s.onerror = reject;
                document.head.append(s);
            });
        }
        return estimatorP;
    }

    const pathUrl = (p) => p.split('/').map(encodeURIComponent).join('/');

    async function getJson(url, init) {
        const r = await fetch(url, init);
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return r.json();
    }

    // Measure one sloppak from its stem. Returns the record the server cached.
    async function measure(file, stem) {
        const est = await estimator();
        const res = await fetch(`/api/sloppak/${pathUrl(file)}/file/${pathUrl(stem)}`);
        if (!res.ok) throw new Error(`stem ${res.status}`);
        const buf = await res.arrayBuffer();
        // Decoding into an OfflineAudioContext resamples to 44.1 kHz and never plays anything.
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const audio = await ctx.decodeAudioData(buf);
        let mono = audio.getChannelData(0);
        if (audio.numberOfChannels > 1) {
            const mix = new Float32Array(audio.length);
            for (let c = 0; c < audio.numberOfChannels; c++) {
                const d = audio.getChannelData(c);
                for (let i = 0; i < d.length; i++) mix[i] += d[i] / audio.numberOfChannels;
            }
            mono = mix;
        }
        const r = est.estimateCents(mono, audio.sampleRate);
        let cents = null;
        if (r.confidence >= MIN_CONFIDENCE) cents = Math.abs(r.cents) < IN_TUNE ? 0 : Math.round(r.cents);
        return getJson(`${API}/measured`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file, cents, confidence: r.confidence, raw: r.cents }),
        });
    }

    // Resolve (and if needed measure) one song's offset.
    async function resolve(file) {
        let rec = await getJson(`${API}/offset?file=${encodeURIComponent(file)}`);
        if (rec.source === 'unmeasured' && rec.stem) rec = await measure(file, rec.stem);
        sc.known[file] = { cents: rec.cents, source: rec.source };
        scheduleBadges();
        return rec;
    }
    sc.resolve = resolve;

    // ── Current song ────────────────────────────────────────────────────────
    async function onSong(evOrSong) {
        // The bus is an EventTarget: handlers get a CustomEvent with the song in .detail.
        const song = evOrSong && evOrSong.detail !== undefined ? evOrSong.detail : evOrSong;
        const file = song && song.filename;
        if (!file) return;
        sc.current = { file, cents: null, source: 'pending' };
        emit();
        try {
            const rec = await resolve(file);
            if (sc.current && sc.current.file === file) {
                sc.current = { file, cents: rec.cents, source: rec.source, confidence: rec.confidence };
                emit();
            }
        } catch (e) {
            console.warn('[song_cents]', file, e);
            if (sc.current && sc.current.file === file) { sc.current.source = 'error'; emit(); }
        }
    }

    // ── Library badges ──────────────────────────────────────────────────────
    const fmt = (c) => (c > 0 ? '+' : '') + Math.round(c) + 'c';
    const SRC = { psarc: 'from the original PSARC chart', chart: 'from the chart', audio: 'measured from the recording (±5c)' };
    let badgeTimer = null;
    function scheduleBadges() {
        if (badgeTimer) return;
        badgeTimer = setTimeout(() => { badgeTimer = null; badges(); }, 150);
    }
    function badges() {
        for (const el of document.querySelectorAll('[data-play]')) {
            let file;
            try { file = decodeURIComponent(el.getAttribute('data-play')); } catch (_) { continue; }
            const k = sc.known[file];
            const has = el.querySelector('.sc-badge');
            if (!k || !k.cents) { if (has) has.remove(); continue; }
            const label = fmt(k.cents);
            if (has) { if (has.textContent !== label) has.textContent = label; continue; }
            const tun = el.querySelector('span.text-green-400, span.text-yellow-400');
            if (!tun) continue;
            const b = document.createElement('span');
            b.className = 'sc-badge px-1.5 py-0.5 rounded';
            b.style.cssText = 'background:rgba(14,116,144,.25);color:#7dd3fc';
            b.textContent = label;
            b.title = `Recording is ${label} off the chart tuning, ${SRC[k.source] || k.source}. Live Retune → Match song plays your guitar in tune with it.`;
            tun.after(b);
        }
    }

    async function loadKnown() {
        try {
            Object.assign(sc.known, await getJson(`${API}/known`));
            scheduleBadges();
        } catch (_) { /* server route not up yet */ }
    }

    // ── Library scan (Settings → Song Cents) ────────────────────────────────
    let scanning = false;
    sc.scanLibrary = async function (onProgress) {
        if (scanning) return;
        scanning = true;
        try {
            const { files } = await getJson(`${API}/pending`);
            let done = 0, failed = 0;
            for (const f of files) {
                try { await resolve(f); } catch (_) { failed++; }
                done++;
                if (onProgress) onProgress(done, files.length, failed, f);
            }
            return { total: files.length, failed };
        } finally {
            scanning = false;
        }
    };

    const bus = window.slopsmith;
    if (bus && bus.on) bus.on('song:loaded', onSong);
    if (bus && bus.currentSong) onSong(bus.currentSong);
    new MutationObserver(scheduleBadges).observe(document.body, { childList: true, subtree: true });
    loadKnown();
})();
