// pitch-shift-worklet.js — real-time, tempo-preserving pitch shifter.
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
// Control: AudioParam `pitchSemitones` (k-rate) OR a port message
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
        // indices wrap correctly under two's-complement `& mask`).
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
