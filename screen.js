// Auto-Tuner (Live Retune) — Slopsmith plugin frontend.
//
// Runtime overlay (Constitution IV): pitch-shifts song audio to a target
// tuning and couples note_detect so a physically detuned guitar can play
// along. NEVER writes DLC files.
//
// Build status (see PLAN.md / PROGRESS.md):
//   T2: IIFE skeleton — state, per-song persistence, song:loaded hook.
//   T3 (this): TUNE pill + semitone preset popover in #player-controls.
//   T5/T6: web AudioWorklet pitch-shift path; auto-apply persisted offset.
//   T7-T9: desktop (JUCE) native pitch path via slopsmithDesktop IPC.
//   T10-T12: emit 'retune:offset' to note_detect; highway tuning badge.
(function () {
    'use strict';
    if (window.__autotuneLoaded) return;
    window.__autotuneLoaded = true;

    // ── Constants ───────────────────────────────────────────────────────────
    const LS_PREFIX = 'autotune.';        // Constitution III: prefixed keys
    // Generous clamp: A Standard (-7) … F# Standard (+2) covers every preset
    // plus headroom for the [ / ] keyboard step (T13). Beyond ±7 semitones the
    // real-time pitch shift quality degrades badly, so we cap there.
    const MIN_SEMITONES = -7;
    const MAX_SEMITONES = 7;

    // Standard-tuning note name for a whole-string offset, mirroring the
    // `standard` map in lib/tunings.py (E-standard reference). Used for preset
    // labels and the pill; the highway badge (T12) computes the song's true
    // effective tuning from its actual base tuning + offset.
    const STANDARD_NOTE = {
        2: 'F♯', 1: 'F', 0: 'E', '-1': 'E♭', '-2': 'D',
        '-3': 'C♯', '-4': 'C', '-5': 'B', '-6': 'B♭', '-7': 'A',
    };
    function _standardNote(n) { return STANDARD_NOTE[String(n)] || `${n > 0 ? '+' : ''}${n}`; }

    // Preset ladder shown in the popover, high pitch → low pitch. Picking E
    // (0) is the reset/bypass. Matches PLAN.md §5 T3.
    const PRESETS = [2, 1, 0, -1, -2, -3, -4, -5];

    // Worklet source, inlined and loaded via a Blob URL: core only serves
    // screen.js / settings.html (no generic plugin-asset route), so we can't
    // addModule('/api/plugins/autotune/assets/...'). Kept byte-identical to
    // assets/pitch-shift-worklet.js — enforced by test/worklet-sync.test.js.
    // >>>WORKLET_SRC_BEGIN>>>
    const PITCH_WORKLET_SRC = `// pitch-shift-worklet.js — real-time, tempo-preserving pitch shifter.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Matt Romano. Original work; see assets/NOTICE.md for the
// algorithm reference and why SoundTouch/rubberband were not vendored here.
//
// Algorithm: constant-overlap-add (COLA) granular pitch shifter. Two read taps
// run over a circular input buffer, offset by half a Hann window and summed.
// Each tap's fractional delay advances by (1 - ratio) per sample, so the read
// head drifts relative to the write head at the pitch ratio while the output
// is produced at the real-time rate — i.e. pitch changes, tempo does not. Two
// Hann windows offset by W/2 sum to exactly 1.0, so there is no amplitude
// modulation. No FFT, fixed CPU per sample, safe for streaming live audio.
//
// Control: AudioParam \`pitchSemitones\` (k-rate) OR a port message
// { type: 'pitch', value: <semitones> }. 0 = bypass (sample-accurate
// passthrough). ratio = 2^(semitones/12).

class PitchShiftProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [{
            name: 'pitchSemitones',
            defaultValue: 0,
            minValue: -24,
            maxValue: 24,
            automationRate: 'k-rate',
        }];
    }

    constructor(options) {
        super();
        const opt = (options && options.processorOptions) || {};
        // Grain window in samples. ~1024 @ 44.1k ≈ 23 ms — a good music
        // tradeoff (shorter = more roughness, longer = more smear/echo).
        this.W = Math.max(256, (opt.windowSize | 0) || 1024);
        // Power-of-two ring so index wrapping is a cheap mask (and negative
        // indices wrap correctly under two's-complement \`& mask\`).
        let size = 1;
        while (size < this.W * 4) size <<= 1;
        this.bufSize = size;
        this.mask = size - 1;

        this.channels = [];     // Float32Array ring per channel (lazy)
        this.writeIdx = 0;
        this.delay = 0;         // fractional read delay, shared across channels

        this.hann = new Float32Array(this.W);
        for (let i = 0; i < this.W; i++) {
            this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.W);
        }

        this._semi = 0;         // fallback when no AudioParam connection
        this.port.onmessage = (e) => {
            const d = e.data;
            if (d && d.type === 'pitch' && typeof d.value === 'number') {
                this._semi = d.value;
            }
        };
    }

    _ensureChannels(n) {
        while (this.channels.length < n) {
            this.channels.push(new Float32Array(this.bufSize));
        }
    }

    _readTap(buf, delay) {
        // Read at (writeIdx - delay) with linear interpolation.
        const base = this.writeIdx - delay;
        const i0 = Math.floor(base) & this.mask;   // mask wraps negatives (pow2)
        const i1 = (i0 + 1) & this.mask;
        const frac = base - Math.floor(base);
        return buf[i0] * (1 - frac) + buf[i1] * frac;
    }

    process(inputs, outputs, params) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const frames = output[0].length;
        const nCh = output.length;
        this._ensureChannels(nCh);

        const pArr = params.pitchSemitones;
        const semi = (pArr && pArr.length) ? pArr[0] : this._semi;
        const ratio = Math.pow(2, semi / 12);
        const bypass = Math.abs(semi) < 1e-4;

        const haveInput = !!(input && input.length && input[0] && input[0].length);
        const W = this.W;
        const half = W * 0.5;

        for (let i = 0; i < frames; i++) {
            // Write the incoming frame into each channel's ring. Mono input
            // feeding a stereo node: fan channel 0 out to all outputs.
            for (let c = 0; c < nCh; c++) {
                const src = haveInput ? (input[c] || input[0]) : null;
                this.channels[c][this.writeIdx] = src ? src[i] : 0;
            }

            if (bypass) {
                for (let c = 0; c < nCh; c++) {
                    output[c][i] = this.channels[c][this.writeIdx];
                }
            } else {
                const d1 = this.delay;
                const d2 = (this.delay + half) % W;
                const w1 = this.hann[d1 | 0];
                const w2 = this.hann[d2 | 0];
                for (let c = 0; c < nCh; c++) {
                    const buf = this.channels[c];
                    output[c][i] = this._readTap(buf, d1) * w1 + this._readTap(buf, d2) * w2;
                }
                this.delay += (1 - ratio);
                if (this.delay >= W) this.delay -= W;
                else if (this.delay < 0) this.delay += W;
            }

            this.writeIdx = (this.writeIdx + 1) & this.mask;
        }

        return true;   // keep the processor alive across the whole song
    }
}

registerProcessor('pitch-shift-processor', PitchShiftProcessor);
`;
    // <<<WORKLET_SRC_END<<<

    // ── State ───────────────────────────────────────────────────────────────
    // Single source of truth for the live retune. Mutated only via _setOffset.
    const state = {
        song: null,        // window.slopsmith.currentSong snapshot for this song
        filename: null,    // identity used for the per-song localStorage key
        semitones: 0,      // current retune offset (negative = lower pitch)
    };

    let _popover = null;   // lazily-built popover element (appended to <body>)
    let _open = false;
    let _openTimer = null;

    // ── Persistence ─────────────────────────────────────────────────────────
    // Per-song key. djb2 hash keeps keys short and free of path separators /
    // unicode while staying stable across sessions for the same filename.
    function _hash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    function _songKey(filename) {
        return LS_PREFIX + _hash(filename || '');
    }

    function _clampSemitones(n) {
        n = Math.round(Number(n) || 0);
        return Math.max(MIN_SEMITONES, Math.min(MAX_SEMITONES, n));
    }

    function _loadOffset(filename) {
        if (!filename) return 0;
        try {
            const raw = localStorage.getItem(_songKey(filename));
            if (raw == null) return 0;
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? _clampSemitones(n) : 0;
        } catch (e) {
            console.warn('[autotune] load offset failed:', e && e.message || e);
            return 0;
        }
    }

    function _saveOffset(filename, semitones) {
        if (!filename) return;
        try {
            const key = _songKey(filename);
            if (!semitones) localStorage.removeItem(key);   // 0 = bypass, don't clutter
            else localStorage.setItem(key, String(semitones));
        } catch (e) {
            console.warn('[autotune] save offset failed:', e && e.message || e);
        }
    }

    // ── Core mutation ─────────────────────────────────────────────────────────
    // The one place the offset changes: persist, apply to audio, refresh UI.
    // Later tasks extend the body:
    //   T11 — window.slopsmith.emit('retune:offset', {...}) for note_detect
    //   T12 — refresh the highway tuning badge
    // Returns the clamped value actually applied.
    function _setOffset(n) {
        const clamped = _clampSemitones(n);
        state.semitones = clamped;
        _saveOffset(state.filename, clamped);
        _updatePill();
        _renderPresets();
        Promise.resolve(_setPitch(clamped)).catch(() => {});   // apply to audio
        _emitRetune();                                          // couple note_detect
        console.info('[autotune] offset =', clamped, 'semitones');
        return clamped;
    }

    // ── UI: TUNE pill ─────────────────────────────────────────────────────────
    // Mirrors nam_tone's button-injection: a pill in #player-controls inserted
    // before the trailing close button, sharing the same Tailwind classes so it
    // looks native next to AMP.
    function _injectPill() {
        const controls = document.getElementById('player-controls');
        if (!controls) return;
        if (document.getElementById('btn-autotune')) { _updatePill(); return; }

        const closeBtn = controls.querySelector('button:last-child');
        const btn = document.createElement('button');
        btn.id = 'btn-autotune';
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        btn.title = 'Live retune — shift song pitch to match your guitar’s tuning';
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        btn.onclick = (e) => { e.stopPropagation(); _togglePopover(); };
        controls.insertBefore(btn, closeBtn);
        _updatePill();
    }

    function _updatePill() {
        _updateBadge();
        const btn = document.getElementById('btn-autotune');
        if (!btn) return;
        const n = state.semitones;
        if (n === 0) {
            btn.textContent = 'TUNE';
            btn.style.color = '';            // inherit gray-400 (off)
        } else {
            const sign = n > 0 ? '+' : '';
            btn.textContent = `TUNE ${_standardNote(n)} (${sign}${n})`;
            btn.style.color = '#e8c040';     // gold accent = active
        }
    }

    // Highway tuning badge (T12): a small DOM badge in #player-controls showing
    // the EFFECTIVE tuning = tuning_name(base + offset). Read-only — never
    // mutates chart data. Shown only while a retune is active (offset != 0); at
    // 0 the tuning is just the song's original, so we hide it to avoid clutter.
    function _updateBadge() {
        const controls = document.getElementById('player-controls');
        if (!controls) return;
        let badge = document.getElementById('autotune-badge');
        const n = state.semitones;
        if (n === 0) { if (badge) badge.style.display = 'none'; return; }
        if (!badge) {
            badge = document.createElement('span');
            badge.id = 'autotune-badge';
            Object.assign(badge.style, {
                padding: '4px 8px', borderRadius: '0.5rem', fontSize: '11px',
                border: '1px solid #e8c040', color: '#e8c040',
                background: 'rgba(232,192,64,0.08)', whiteSpace: 'nowrap',
            });
            badge.title = 'Effective tuning with live retune applied';
            const closeBtn = controls.querySelector('button:last-child');
            controls.insertBefore(badge, closeBtn);
        }
        badge.style.display = '';
        badge.textContent = _effectiveTuningName(n);
    }

    // ── UI: preset popover ────────────────────────────────────────────────────
    function _buildPopover() {
        if (_popover) return _popover;
        const pop = document.createElement('div');
        pop.id = 'autotune-popover';
        pop.className = 'hidden';
        // Self-contained inline styling so we don't depend on Tailwind shades
        // that may not be defined; colours match the app theme.
        Object.assign(pop.style, {
            position: 'fixed', zIndex: '10000', minWidth: '200px',
            background: '#23272e', border: '1px solid #3a4048',
            borderRadius: '0.5rem', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            padding: '8px', color: '#d1d5db', font: '12px system-ui, sans-serif',
        });

        const header = document.createElement('div');
        header.textContent = 'Retune';
        Object.assign(header.style, {
            fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em',
            color: '#9ca3af', padding: '2px 4px 6px',
        });
        pop.appendChild(header);

        const grid = document.createElement('div');
        grid.id = 'autotune-preset-grid';
        Object.assign(grid.style, {
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px',
        });
        for (const semis of PRESETS) {
            const b = document.createElement('button');
            b.className = 'autotune-preset';
            b.dataset.semitones = String(semis);
            b.dataset.autotunePreset = String(semis);   // stable test hook
            Object.assign(b.style, {
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: '1px', padding: '6px 4px', borderRadius: '0.375rem',
                background: '#2a2f37', border: '1px solid transparent',
                color: '#d1d5db', cursor: 'pointer', transition: 'background 0.12s',
            });
            const note = document.createElement('span');
            note.textContent = _standardNote(semis);
            note.style.fontSize = '14px';
            note.style.fontWeight = '600';
            const sub = document.createElement('span');
            sub.textContent = semis === 0 ? 'std' : `${semis > 0 ? '+' : ''}${semis}`;
            sub.style.fontSize = '10px';
            sub.style.color = '#9ca3af';
            b.appendChild(note);
            b.appendChild(sub);
            b.onmouseenter = () => { if (Number(b.dataset.semitones) !== state.semitones) b.style.background = '#343a44'; };
            b.onmouseleave = () => { _stylePreset(b); };
            b.onclick = (e) => { e.stopPropagation(); _setOffset(semis); };
            grid.appendChild(b);
        }
        pop.appendChild(grid);

        document.body.appendChild(pop);
        _popover = pop;
        return pop;
    }

    // Apply active/inactive styling to one preset button.
    function _stylePreset(b) {
        const active = Number(b.dataset.semitones) === state.semitones;
        b.style.background = active ? '#3a4048' : '#2a2f37';
        b.style.borderColor = active ? '#e8c040' : 'transparent';
        b.style.color = active ? '#e8c040' : '#d1d5db';
    }

    function _renderPresets() {
        if (!_popover) return;
        _popover.querySelectorAll('.autotune-preset').forEach(_stylePreset);
    }

    function _positionPopover() {
        const pill = document.getElementById('btn-autotune');
        if (!pill || !_popover) return;
        const r = pill.getBoundingClientRect();
        // Player controls sit at the bottom, so anchor the popover above the pill.
        _popover.style.left = Math.round(r.left) + 'px';
        _popover.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px';
        _popover.style.right = 'auto';
        _popover.style.top = 'auto';
        // Keep it on-screen horizontally.
        const pw = _popover.offsetWidth || 200;
        if (r.left + pw > window.innerWidth - 8) {
            _popover.style.left = Math.max(8, window.innerWidth - pw - 8) + 'px';
        }
    }

    function _openPopover() {
        _buildPopover();
        if (!_popover || _open) return;
        _renderPresets();
        _popover.classList.remove('hidden');
        _positionPopover();
        const btn = document.getElementById('btn-autotune');
        if (btn) btn.setAttribute('aria-expanded', 'true');
        _open = true;
        // Defer the dismiss listeners a tick so the opening click doesn't
        // immediately close it (mirrors audio-mixer).
        _openTimer = setTimeout(() => {
            _openTimer = null;
            if (_open) {
                document.addEventListener('click', _onDocClick, true);
                document.addEventListener('keydown', _onDocKeydown, true);
                window.addEventListener('resize', _positionPopover);
            }
        }, 0);
    }

    function _closePopover() {
        if (!_popover) return;
        if (_openTimer !== null) { clearTimeout(_openTimer); _openTimer = null; }
        _popover.classList.add('hidden');
        const btn = document.getElementById('btn-autotune');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        _open = false;
        document.removeEventListener('click', _onDocClick, true);
        document.removeEventListener('keydown', _onDocKeydown, true);
        window.removeEventListener('resize', _positionPopover);
    }

    function _togglePopover() { if (_open) _closePopover(); else _openPopover(); }

    function _onDocClick(e) {
        if (!_popover) return;
        if (_popover.contains(e.target)) return;
        const btn = document.getElementById('btn-autotune');
        if (btn && btn.contains(e.target)) return;
        _closePopover();
    }

    function _onDocKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _closePopover(); }
    }

    // ── Audio engine ─────────────────────────────────────────────────────────
    // Two paths (PLAN deliverables A/B): prefer the native desktop engine when
    // present, else the web AudioWorklet. Feature-detected per call so the
    // desktop IPC (deliverable B, added in T8) is picked up as soon as it exists.
    function _engine() {
        const d = window.slopsmithDesktop;
        if (d && d.audio && typeof d.audio.setBackingPitchSemitones === 'function') return 'desktop';
        return 'web';
    }

    function _getAudioEl() {
        return window.audio || document.getElementById('audio') || null;
    }

    const _web = {
        ctx: null, source: null, node: null,
        ready: false, building: false, unavailable: false, moduleUrl: null,
    };

    // Lazily build the web graph: #audio → MediaElementSource → pitch worklet
    // → destination. createMediaElementSource is irrevocable and once-per-
    // element, so we publish ours on window.slopsmith.audio for future
    // cooperators. If another consumer already grabbed the element without
    // publishing (today's highway_3d does, for its analyser), our create throws
    // InvalidStateError and we disable the web path with a clear message — the
    // desktop engine path is unaffected. Built lazily on first non-zero shift so
    // we don't tap (and break) the shared source unless retune is actually used.
    async function _ensureWebGraph() {
        if (_web.ready) return true;
        if (_web.unavailable || _web.building) return false;
        const audioEl = _getAudioEl();
        if (!audioEl) return false;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
            _web.unavailable = true;
            console.warn('[autotune] Web Audio API unavailable; web retune disabled');
            return false;
        }

        _web.building = true;
        // Re-seek guard (PLAN T5): routing the element through Web Audio
        // shouldn't move the playhead, but capture+restore in case a swap does.
        const t0 = audioEl.currentTime;
        const wasPaused = audioEl.paused;
        try {
            _web.ctx = new Ctx();
            _web.source = _web.ctx.createMediaElementSource(audioEl);
            _publishSharedSource();

            if (!_web.moduleUrl) {
                const blob = new Blob([PITCH_WORKLET_SRC], { type: 'application/javascript' });
                _web.moduleUrl = URL.createObjectURL(blob);
            }
            await _web.ctx.audioWorklet.addModule(_web.moduleUrl);
            _web.node = new AudioWorkletNode(_web.ctx, 'pitch-shift-processor', {
                processorOptions: { windowSize: 1024 },
            });
            // Inline: source → worklet → destination. The worklet is a
            // sample-accurate passthrough at 0 st, so leaving it permanently
            // inline is harmless when bypassed.
            _web.source.connect(_web.node);
            _web.node.connect(_web.ctx.destination);

            // Autoplay policy may hand back a suspended context; resume now and
            // on every play so the first user-initiated play unblocks the graph.
            const resume = () => {
                if (_web.ctx.state === 'suspended') _web.ctx.resume().catch(() => {});
            };
            resume();
            audioEl.addEventListener('play', resume);

            _web.ready = true;
            console.info('[autotune] web pitch graph ready');
        } catch (e) {
            const permanent = !!(e && e.name === 'InvalidStateError');
            _web.unavailable = permanent;
            try { if (_web.ctx && _web.ctx.close) _web.ctx.close(); } catch (_) {}
            _web.ctx = null; _web.source = null; _web.node = null;
            console.warn('[autotune] web pitch graph setup failed' +
                (permanent ? ' — the #audio element is already routed by another plugin '
                           + '(e.g. 3D Highway). Web retune unavailable here; use the desktop engine.'
                           : ':'),
                e && e.message || e);
        } finally {
            _web.building = false;
            if (Math.abs(audioEl.currentTime - t0) > 0.05) {
                try { audioEl.currentTime = t0; } catch (_) {}
            }
            if (!wasPaused && audioEl.paused) { audioEl.play().catch(() => {}); }
        }
        return _web.ready;
    }

    // Publish our source so a future cooperator (or an updated highway_3d) can
    // tap it instead of fighting over createMediaElementSource.
    function _publishSharedSource() {
        if (!window.slopsmith) return;
        window.slopsmith.audio = window.slopsmith.audio || {};
        if (typeof window.slopsmith.audio.getMediaElementSource !== 'function') {
            window.slopsmith.audio.getMediaElementSource = () =>
                (_web.source ? { ctx: _web.ctx, source: _web.source } : null);
        }
    }

    function _setWebPitch(semitones) {
        if (!_web.node) return;
        const p = _web.node.parameters && _web.node.parameters.get('pitchSemitones');
        if (p) {
            try { p.setValueAtTime(semitones, _web.ctx.currentTime); }
            catch (_) { p.value = semitones; }
        }
        // Belt-and-suspenders for engines that don't surface the AudioParam.
        try { _web.node.port.postMessage({ type: 'pitch', value: semitones }); } catch (_) {}
    }

    // setPitch: apply through whichever engine is active. Returns a promise that
    // resolves once applied (web graph build is async on first use).
    async function _setPitch(semitones) {
        if (_engine() === 'desktop') {
            try { window.slopsmithDesktop.audio.setBackingPitchSemitones(semitones); }
            catch (e) { console.warn('[autotune] desktop setBackingPitchSemitones failed:', e && e.message || e); }
            return;
        }
        if (!_web.ready) {
            if (semitones === 0) return;          // don't tap the source just to bypass
            const ok = await _ensureWebGraph();
            if (!ok) return;
        }
        _setWebPitch(semitones);
    }

    // ── note_detect coupling + tuning label ───────────────────────────────────
    // Effective tuning label after applying the global retune to the song's base
    // tuning. Standard (all-strings-equal) tunings get a proper name; unknown
    // base assumes E-standard; non-uniform base (drop/open) shows a signed shift.
    function _effectiveTuningName(offset) {
        const base = state.song && Array.isArray(state.song.tuning) ? state.song.tuning : null;
        if (base && base.length && base.every((o) => o === base[0])) {
            return _standardNote(base[0] + offset) + ' Standard';
        }
        if (!base || !base.length) {
            return _standardNote(offset) + ' Standard';
        }
        return offset === 0 ? 'Original tuning' : `Detuned ${offset > 0 ? '+' : ''}${offset} st`;
    }

    // Tell note_detect (deliverable C) to shift its expected pitches by the same
    // amount, so a physically detuned guitar still scores. note_detect adds
    // `semitones` to every expected MIDI; cents stays 0 (semitone presets only).
    function _emitRetune() {
        if (!window.slopsmith || typeof window.slopsmith.emit !== 'function') return;
        window.slopsmith.emit('retune:offset', {
            semitones: state.semitones,
            cents: 0,
            tuningName: _effectiveTuningName(state.semitones),
        });
    }

    // ── Song lifecycle ──────────────────────────────────────────────────────
    function _onSongLoaded(song) {
        state.song = song || null;
        state.filename = (song && song.filename) || null;
        state.semitones = _loadOffset(state.filename);
        _injectPill();
        _updatePill();
        _renderPresets();
        console.info(
            '[autotune] song loaded:', state.filename,
            '→ persisted offset', state.semitones, 'st');
        // Auto-apply the persisted offset. Desktop: re-asserts the offset on the
        // freshly-loaded backing track (incl. 0 = reset). Web: a 0 offset is a
        // no-op that won't tap the shared <audio> source; non-zero builds/sets
        // the graph lazily.
        Promise.resolve(_setPitch(state.semitones)).catch(() => {});
        // Re-emit on a deferred tick so it lands AFTER the synchronous
        // song:loaded handlers — note_detect clears its retune on song:loaded,
        // so a synchronous emit here would be wiped. The microtask runs once the
        // current dispatch finishes, re-applying the loaded song's offset last.
        if (typeof queueMicrotask === 'function') queueMicrotask(_emitRetune);
        else Promise.resolve().then(_emitRetune);
    }

    function _onScreenChanged(e) {
        const id = e && e.detail ? e.detail.id : undefined;
        if (id !== 'player') _closePopover();
    }

    // ── Wiring ──────────────────────────────────────────────────────────────
    // The slopsmith bus is an EventTarget; emit() dispatches a CustomEvent so
    // payloads arrive on event.detail. The namespace can attach late during
    // boot, so retry on window 'load' if it isn't ready yet.
    function _init() {
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') {
            window.addEventListener('load', _init, { once: true });
            return;
        }
        window.slopsmith.on('song:loaded', (e) => {
            const payload = (e && e.detail !== undefined) ? e.detail : e;
            _onSongLoaded(payload);
        });
        window.slopsmith.on('screen:changed', _onScreenChanged);
        // If a song is already loaded when we attach (plugin loaded mid-song),
        // hydrate from it immediately.
        if (window.slopsmith.currentSong) _onSongLoaded(window.slopsmith.currentSong);
        console.info('[autotune] initialised');
    }

    // ── Public handle (for tests / keyboard shortcuts later) ──────────────────
    window.autotune = {
        getState: () => ({ ...state }),
        setOffset: (n) => _setOffset(n),
        openPopover: _openPopover,
        closePopover: _closePopover,
        engine: _engine,
        setPitch: _setPitch,           // apply to audio without touching UI/persistence
        _internals: { hash: _hash, songKey: _songKey, clamp: _clampSemitones,
                      loadOffset: _loadOffset, saveOffset: _saveOffset,
                      standardNote: _standardNote, PRESETS,
                      MIN_SEMITONES, MAX_SEMITONES, web: _web,
                      ensureWebGraph: _ensureWebGraph },
    };

    _init();
})();
