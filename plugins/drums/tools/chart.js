// Synthetic pro-drums chart in the Slopsmith wire format (midi = s*24 + f) for the preview / app harnesses.
// 24 measures at 120 BPM: rock beats with hi-hat, a ride section, double kick (35 = 2x kick), tom fills,
// crash accents and ghost notes, plus a `drums` block (star power phrases and fill windows).

export const BPM = 120;
export const BEAT = 60 / BPM;
export const MEASURE = BEAT * 4;
export const START = 2.0; // first downbeat

export const at = (m, beat) => START + m * MEASURE + (beat || 0) * BEAT;

function wire(t, midi, extra) {
    return Object.assign({ t: Math.round(t * 1000) / 1000, s: Math.floor(midi / 24), f: midi % 24 }, extra || {});
}

export function makeChart() {
    const notes = [];
    const beats = [];
    const M = 24;
    for (let m = 0; m < M + 1; m++) {
        for (let b = 0; b < 4; b++) beats.push({ time: at(m, b), measure: b === 0 ? m + 1 : -1 });
    }
    const fillMeasures = new Set([7, 15, 23]);
    for (let m = 0; m < M; m++) {
        const t0 = at(m);
        const ride = m >= 8 && m < 12;
        const dbl = m >= 12 && m < 14;
        if (fillMeasures.has(m)) {
            // beats 1-2: groove; beats 3-4: 16th tom fill down the kit
            for (let e = 0; e < 4; e++) notes.push(wire(t0 + e * BEAT / 2, 42));
            notes.push(wire(t0, 36), wire(t0 + BEAT, 38, { ac: true }));
            const toms = [38, 38, 48, 48, 45, 45, 41, 41];
            for (let i = 0; i < 8; i++) notes.push(wire(t0 + 2 * BEAT + i * BEAT / 4, toms[i]));
            notes.push(wire(t0 + 2 * BEAT, 36), wire(t0 + 3 * BEAT, 36));
            continue;
        }
        for (let e = 0; e < 8; e++) {
            const t = t0 + e * BEAT / 2;
            if (e === 0 && (m % 4 === 0 || fillMeasures.has(m - 1))) notes.push(wire(t, 49, { ac: true }));
            else notes.push(wire(t, ride ? 51 : 42, e % 2 === 0 ? {} : { mt: !ride && m % 2 === 1 }));
            if (dbl) notes.push(wire(t, e % 2 === 0 ? 36 : 35));
            else if (e === 0 || e === 4 || (e === 5 && m % 2 === 1)) notes.push(wire(t, 36));
            if (e === 2 || e === 6) notes.push(wire(t, 38, e === 6 && m % 2 === 1 ? { ac: true } : {}));
        }
        if (m % 2 === 0 && !dbl) notes.push(wire(t0 + 3.75 * BEAT, 38, { mt: true })); // ghost 16th
    }
    notes.sort((a, b) => a.t - b.t || (a.s * 24 + a.f) - (b.s * 24 + b.f));   // wire notes arrive time-sorted
    const starPower = [[at(2), at(4)], [at(5), at(7)], [at(10), at(11)], [at(17), at(19)]];
    const fills = [[at(15, 2), at(16)], [at(23, 2), at(24)]];
    const levels = makeLevels(notes);
    return {
        notes,
        beats,
        starPower,
        fills,
        levels,
        // the arrangement JSON's top-level `drums` block, as the converters write it
        drums: { version: 1, pro: true, kick2x: true, star_power: starPower, fills,
            levels, levels_generated: ['easy', 'medium'] },
    };
}

// Lower difficulties as the converters store them ([t, gm, flag], flag 1 accent / 2 ghost), reduced from
// Expert: Hard drops ghost notes and 2x kick; Medium also keeps cymbals and kicks on beats only and halves
// the fills; Easy keeps snare / kick on beats plus crashes, and quarter-note toms in fills.
function makeLevels(notes) {
    const midi = (n) => n.s * 24 + n.f;
    const beatPos = (t) => (t - START) / BEAT;
    const onGrid = (t, step) => { const p = beatPos(t) / step; return Math.abs(p - Math.round(p)) < 1e-3; };
    const entry = (n) => [n.t, midi(n), n.ac ? 1 : (n.mt ? 2 : 0)];
    const cym = new Set([42, 46, 51, 53, 49, 57]);
    const toms = new Set([48, 45, 41]);
    const hard = notes.filter(n => !n.mt && midi(n) !== 35);
    const medium = hard.filter((n) => {
        const m = midi(n);
        if (m === 49) return true;
        if (cym.has(m) || m === 36) return onGrid(n.t, 1);
        if (toms.has(m)) return onGrid(n.t, 0.5);
        return true;
    });
    const easy = medium.filter((n) => {
        const m = midi(n);
        if (m === 49) return onGrid(n.t, 1);
        if (cym.has(m)) return false;
        if (toms.has(m)) return onGrid(n.t, 1);
        return onGrid(n.t, 1);
    });
    return { easy: easy.map(entry), medium: medium.map(entry), hard: hard.map(entry) };
}
