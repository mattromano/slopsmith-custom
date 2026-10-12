// Player Bar Folders (asked for 2026-10-12): the player's bottom bar had ~35 buttons, sliders and
// selects in one wrapping row, added by the core and a dozen plugins. This keeps the essentials
// (seek / play, part, default pin, speed, Close, hide-controls) on the bar and moves everything else
// into folders that pop up above the bar: Practice, Audio, Guitar, View, and More (anything this
// file doesn't know yet, e.g. a newly installed plugin's button).
//
// The real elements are moved, never cloned or removed, so every plugin's handlers keep working and
// their "does my button already exist?" checks still find them inside #player-controls. The Close
// button stays a direct child of #player-controls: several plugins insert their button before it.
// Each folder row has a pin: a pinned row sits on the bar itself (saved per computer).
// All containers here use custom tag names (pb-*), and all labels are drawn by CSS: stem_mixer hides
// every short button / span / div / a in the bar whose TEXT mentions guitar, stems, drums, bass...
(function () {
    'use strict';
    if (window.__playerBar) return;

    const PIN_KEY = 'playerBarPins_v1';
    const FOLDERS = [
        ['practice', 'Learn'],   // not "Practice": the Section Practice pill sits right above
        ['audio', 'Audio'],
        ['guitar', 'Guitar'],
        ['view', 'View'],
        ['more', 'More'],
    ];
    // Row: a labelled group of controls inside a folder. ids / sel find the elements; their order
    // here is their order in the row.
    const ROWS = [
        { key: 'difficulty', folder: 'practice', label: 'Difficulty', ids: ['mastery-slider-label', 'mastery-slider', 'mastery-label'] },
        { key: 'loop', folder: 'practice', label: 'Loop', ids: ['btn-loop-a', 'btn-loop-b', 'loop-label', 'btn-loop-save', 'btn-loop-clear', 'saved-loops', 'btn-loop-delete'] },
        { key: 'step', folder: 'practice', label: 'Step mode', ids: ['btn-stepmode'] },
        { key: 'countin', folder: 'practice', label: 'Count-in', ids: ['pq-ci-btn'] },
        { key: 'queue', folder: 'practice', label: 'Play queue', ids: ['pq-q-btn'] },
        { key: 'metronome', folder: 'practice', label: 'Metronome', ids: ['btn-metronome', 'met-volume', 'met-vol-label', 'met-flash-label'] },
        { key: 'detect', folder: 'practice', label: 'Note detection', sel: ['.nd-detect-btn', '.nd-gear-btn'] },

        { key: 'mixer', folder: 'audio', label: 'Mixer', ids: ['mixer-control'] },
        { key: 'stems', folder: 'audio', label: 'Stems', ids: ['btn-stem-mixer'] },
        { key: 'gvol', folder: 'audio', label: 'Guitar volume', ids: ['gv-slider', 'gv-label'] },
        { key: 'av', folder: 'audio', label: 'A/V sync', ids: ['player-av-offset-slider-label', 'player-av-offset-slider', 'player-av-offset-label'] },

        { key: 'amp', folder: 'guitar', label: 'Amp & tone', ids: ['btn-nam', 'btn-tones', 'btn-chain-switch'] },
        { key: 'tuner', folder: 'guitar', label: 'Tuner', ids: ['btn-tuner-player'] },
        { key: 'capo', folder: 'guitar', label: 'Capo', ids: ['btn-capo'] },
        { key: 'pitch', folder: 'guitar', label: 'Pitch shift', ids: ['pitch-shift-ctl'] },
        { key: 'transpose', folder: 'guitar', label: 'Chord names', ids: ['btn-transpose-chords'] },
        { key: 'midi', folder: 'guitar', label: 'MIDI', ids: ['btn-midi'] },

        { key: 'viz', folder: 'view', label: 'Highway', ids: ['viz-picker-label', 'viz-picker', 'btn-invert'] },
        { key: 'quality', folder: 'view', label: 'Quality', ids: ['quality-select', 'min-scale-select'] },
        { key: 'lyrics', folder: 'view', label: 'Lyrics', ids: ['btn-lyrics', 'btn-karaoke'] },
        { key: 'fretboard', folder: 'view', label: 'Fretboard', ids: ['btn-fretboard'] },
        { key: 'split', folder: 'view', label: 'Split screen', ids: ['btn-splitscreen', 'splitscreen-layout-btn'] },
    ];
    // Left where they are: the stems plugin's old inline toggles (stem_mixer keeps them hidden).
    const IGNORE = new Set(['stems-mixer']);

    let controls = null, observer = null, busy = false, scheduled = false;
    let nav = null, pinsHost = null, openFolder = null;
    const folderEls = {};   // key -> { wrap, btn, panel, rows: {rowKey: {row, items}} }
    let pins = new Set();
    try { pins = new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]')); } catch (_) { /* ignore */ }
    const savePins = () => { try { localStorage.setItem(PIN_KEY, JSON.stringify([...pins])); } catch (_) { /* ignore */ } };

    // ── styles ──
    const css = document.createElement('style');
    css.textContent = `
        pb-nav, pb-pins { display: contents; }
        .pb-folder { position: relative; display: inline-flex; }
        pb-panel, pb-rows, pb-t, pb-row, pb-items, pb-l, pb-x { display: block; }
        .pb-fbtn { padding: 6px 12px; border-radius: 8px; border: 1px solid #2a3150; background: #181830; color: #cbd5e1;
            font: 600 12px system-ui, sans-serif; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
        .pb-fbtn:hover { border-color: rgb(64 128 224 / .7); color: #fff; }
        .pb-fbtn.pb-open { background: #22305a; border-color: #4080e0; color: #fff; }
        .pb-fbtn pb-l { display: inline; }
        .pb-fbtn .pb-n { font-weight: 500; color: #7a84a6; font-size: 11px; }
        [data-pb-label]::before { content: attr(data-pb-label); }
        .pb-fbtn .pb-n::before { content: attr(data-n); }
        .pb-fbtn .pb-car { font-size: 9px; opacity: .7; }
        .pb-panel { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 400; display: none !important; min-width: 300px;
            max-width: min(640px, calc(100vw - 24px)); overflow: visible;
            background: rgb(14 14 28 / .97); border: 1px solid #2a3150; border-radius: 12px; padding: 8px 10px 6px;
            box-shadow: 0 12px 32px rgba(0,0,0,.55); }
        .pb-panel.pb-right { left: auto; right: 0; }
        .pb-folder.pb-open .pb-panel { display: block !important; }
        .pb-ptitle { font: 700 10px system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #60a0ff; padding: 2px 2px 6px; }
        pb-row.pb-row { display: grid; grid-template-columns: 104px 1fr 22px; align-items: center; gap: 8px; padding: 5px 2px;
            border-top: 1px solid rgb(42 49 80 / .55); }
        .pb-row:first-of-type { border-top: 0; }
        .pb-rl { font: 500 12px system-ui, sans-serif; color: #9ca3af; }
        pb-items.pb-items { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 28px; }
        .pb-items .pb-onbar { font: 12px system-ui, sans-serif; color: #6b7280; font-style: italic; }
        .pb-pin { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: #4b5563; cursor: pointer;
            font-size: 12px; line-height: 22px; padding: 0; }
        .pb-pin { filter: grayscale(1); opacity: .3; }
        .pb-row:hover .pb-pin { opacity: .6; }
        .pb-pin:hover { background: rgba(255,255,255,.08); opacity: 1 !important; filter: none; }
        .pb-pin.pb-pinned { filter: none; opacity: 1; }
        /* the row label already says it; the original labels come back when the row is pinned */
        .pb-items #mastery-slider-label, .pb-items #player-av-offset-slider-label { display: none !important; }
        .pb-hint { font: 11px system-ui, sans-serif; color: #6b7280; padding: 6px 2px 2px; }
        [data-pb-hidden] { display: none !important; }
    `;
    document.head.appendChild(css);

    // ── element classification ──
    function isEssential(el) {
        if (el.id === 'btn-play' || el.id === 'arr-select' || el.id === 'arr-default-pin' || el.id === 'speed-slider' || el.id === 'speed-label') return true;
        if (el.classList.contains('hwt-tray-btn')) return true;
        const t = el.getAttribute && el.getAttribute('title');
        if (t === 'Seek Back 5s' || t === 'Seek Forward 5s') return true;
        if (el.matches('button[onclick*="showScreen"]') || el.querySelector('button[onclick*="showScreen"]')) return true;   // Close
        return false;
    }
    function isSeparator(el) {
        return el.tagName === 'SPAN' && !el.id && el.children.length === 0 && el.textContent.trim() === '|';
    }
    function rowElements(row) {
        const out = [];
        for (const id of row.ids || []) { const e = document.getElementById(id); if (e && controls.contains(e)) out.push(e); }
        for (const s of row.sel || []) for (const e of controls.querySelectorAll(s)) if (!out.includes(e)) out.push(e);
        return out;
    }
    function moreLabel(el) {
        const t = (el.getAttribute('title') || el.textContent || el.id || el.tagName).trim().replace(/\s+/g, ' ');
        return t.length > 22 ? t.slice(0, 21) + '…' : t;
    }

    // ── building ──
    function buildNav() {
        nav = document.createElement('pb-nav');
        nav.className = 'pb-nav';
        pinsHost = document.createElement('pb-pins');
        pinsHost.className = 'pb-pins';
        nav.appendChild(pinsHost);
        for (const [key, label] of FOLDERS) {
            const wrap = document.createElement('pb-folder');
            wrap.className = 'pb-folder';
            wrap.dataset.folder = key;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pb-fbtn';
            // Labels are drawn by CSS (data-pb-label), not text: stem_mixer hides any short element in
            // the bar whose text mentions guitar / stems / drums / bass, which included "Guitar".
            btn.innerHTML = `<pb-l data-pb-label="${label}"></pb-l><pb-l class="pb-n"></pb-l><pb-l class="pb-car" data-pb-label="▲"></pb-l>`;
            btn.title = label + ' controls';
            btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(key); });
            const panel = document.createElement('pb-panel');
            panel.className = 'pb-panel';
            panel.innerHTML = `<pb-t class="pb-ptitle" data-pb-label="${label}"></pb-t><pb-rows class="pb-rows"></pb-rows>
                <pb-t class="pb-hint" data-pb-label="📌 pins a row to the bar."></pb-t>`;
            wrap.append(btn, panel);
            nav.appendChild(wrap);
            folderEls[key] = { wrap, btn, panel, rowsHost: panel.querySelector('.pb-rows'), rows: {} };
        }
    }

    function getRow(folderKey, key, label) {
        const f = folderEls[folderKey];
        let r = f.rows[key];
        if (r) return r;
        const row = document.createElement('pb-row');
        row.className = 'pb-row';
        row.dataset.row = key;
        const l = document.createElement('pb-l');
        l.className = 'pb-rl';
        l.dataset.pbLabel = label;
        const items = document.createElement('pb-items');
        items.className = 'pb-items';
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'pb-pin';
        pin.dataset.pbLabel = '📌';
        pin.addEventListener('click', (e) => {
            e.stopPropagation();
            if (pins.has(key)) pins.delete(key); else pins.add(key);
            savePins();
            organize();
        });
        row.append(l, items, pin);
        f.rowsHost.appendChild(row);
        r = f.rows[key] = { row, items, pin, label: l };
        return r;
    }

    // Put every control where it belongs. Idempotent; runs on any change to the bar.
    function organize() {
        if (!controls || busy) return;
        busy = true;
        try {
            if (!nav || !controls.contains(nav)) {
                if (!nav) buildNav();
                const close = [...controls.children].find((c) => c !== nav && (c.matches('button[onclick*="showScreen"]') || c.querySelector('button[onclick*="showScreen"]')));
                controls.insertBefore(nav, close || null);
            }
            const used = new Set();
            const placeRow = (key, folder, label, els) => {
                const r = getRow(folder, key, label);
                const pinned = pins.has(key);
                const host = pinned ? pinsHost : r.items;
                for (const el of els) { used.add(el); if (el.parentNode !== host || el.dataset.pbRow !== key) { el.dataset.pbRow = key; host.appendChild(el); } }
                // keep the configured order inside the host
                r.row.style.display = els.length ? '' : 'none';
                r.pin.classList.toggle('pb-pinned', pinned);
                r.pin.title = pinned ? 'On the bar: click to put it back in this folder' : 'Pin to the bar';
                let note = r.items.querySelector(':scope > .pb-onbar');
                if (pinned && !note) { note = document.createElement('pb-x'); note.className = 'pb-onbar'; note.dataset.pbLabel = 'on the bar'; r.items.appendChild(note); }
                if (!pinned && note) note.remove();
            };
            for (const row of ROWS) placeRow(row.key, row.folder, row.label, rowElements(row));
            // Unknown controls (new plugins): one row each in More.
            for (const el of [...controls.children]) {
                if (el === nav || used.has(el) || isEssential(el) || IGNORE.has(el.id)) continue;
                if (isSeparator(el)) { el.setAttribute('data-pb-hidden', ''); continue; }
                if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
                if (!el.dataset.pbKey) el.dataset.pbKey = 'x:' + (el.id || moreLabel(el));
                placeRow(el.dataset.pbKey, 'more', moreLabel(el), [el]);
            }
            // Rows show only while one of their controls is shown (loop Save / ✕ appear once a loop
            // is set, Detect's gear while detecting...); folders with nothing to show disappear.
            const shown = (el) => !el.hasAttribute('data-pb-hidden') && !el.classList.contains('hidden')
                && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
            for (const f of Object.values(folderEls)) {
                let n = 0;
                for (const r of Object.values(f.rows)) {
                    const key = r.row.dataset.row;
                    const els = [...r.items.children].filter((e) => !e.classList.contains('pb-onbar'));
                    const onBar = pinsHost.querySelector(`[data-pb-row="${CSS.escape(key)}"]`);
                    const any = !!onBar || els.some(shown);
                    r.row.style.display = any ? '' : 'none';
                    if (any) n++;
                }
                f.wrap.style.display = n ? '' : 'none';
                f.btn.querySelector('.pb-n').dataset.n = n ? String(n) : '';
            }
        } catch (e) {
            console.warn('[player_bar] organize failed', e);
        } finally {
            if (observer) observer.takeRecords();
            busy = false;
        }
    }

    // Visibility changes inside the bar: at most 4 re-checks a second (never per frame).
    let laterTimer = 0;
    function scheduleLater() {
        if (laterTimer) return;
        laterTimer = setTimeout(() => { laterTimer = 0; organize(); }, 250);
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(() => { scheduled = false; organize(); });
    }

    // ── open / close ──
    function toggle(key) {
        const next = openFolder === key ? null : key;
        for (const [k, f] of Object.entries(folderEls)) {
            const on = k === next;
            f.wrap.classList.toggle('pb-open', on);
            f.btn.classList.toggle('pb-open', on);
            if (on) {
                f.panel.classList.remove('pb-right');
                const r = f.panel.getBoundingClientRect();
                if (r.right > window.innerWidth - 8) f.panel.classList.add('pb-right');
            }
        }
        openFolder = next;
    }
    document.addEventListener('pointerdown', (e) => {
        if (!openFolder) return;
        const f = folderEls[openFolder];
        if (f && !f.wrap.contains(e.target)) toggle(openFolder);
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openFolder) toggle(openFolder); });

    // Plugins insert relative to controls they expect to be direct children (metronome: "after the
    // Lyrics button", many: "before Close"), or remove their own. Once that control sits in a folder
    // the plain DOM call throws and breaks the plugin (and song loading with it). On this one element,
    // a reference that is no longer a direct child inserts at the folders instead, and removing a
    // moved control removes it from its folder.
    function guard(c) {
        if (c.__pbGuarded) return;
        c.__pbGuarded = true;
        const ins = Node.prototype.insertBefore, rem = Node.prototype.removeChild, rep = Node.prototype.replaceChild;
        c.insertBefore = function (node, ref) {
            if (ref && ref.parentNode !== this) ref = (nav && nav.parentNode === this) ? nav : null;
            return ins.call(this, node, ref);
        };
        c.removeChild = function (node) {
            if (node && node.parentNode !== this && this.contains(node)) { node.remove(); return node; }
            return rem.call(this, node);
        };
        c.replaceChild = function (node, old) {
            if (old && old.parentNode !== this && this.contains(old)) { old.replaceWith(node); return old; }
            return rep.call(this, node, old);
        };
    }

    // ── attach to the bar (the core may rebuild it) ──
    function attach() {
        const c = document.getElementById('player-controls');
        if (c === controls) return;
        if (observer) observer.disconnect();
        controls = c;
        nav = null;
        for (const k of Object.keys(folderEls)) delete folderEls[k];
        openFolder = null;
        if (!controls) return;
        guard(controls);
        observer = new MutationObserver((recs) => {
            if (busy) return;
            if (recs.some((r) => r.type === 'childList' && r.target === controls)) schedule();
            else scheduleLater();
        });
        observer.observe(controls, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        organize();
    }
    attach();
    setInterval(attach, 1000);

    window.__playerBar = { organize, toggle, pins: () => [...pins], ROWS, FOLDERS };
})();
