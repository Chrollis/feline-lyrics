import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    melLogPower,
    melMaximum,
    melSpectrogram,
    normalizeMel,
} from '../../../out/main/alignment/mel.js';

const SAMPLE_RATE = 16000;
const FFT_SIZE = 400;
const HOP_LENGTH = 160;
const MEL_BINS = 80;
const BINS = FFT_SIZE / 2 + 1;
const CHUNK_SAMPLES = SAMPLE_RATE;
const FRAMES = CHUNK_SAMPLES / HOP_LENGTH;

// Only the fields mel.ts reads; a real WhisperSettings carries the decoding settings too.
const settings = {
    sampleRate: SAMPLE_RATE,
    melBins: MEL_BINS,
    nFft: FFT_SIZE,
    hopLength: HOP_LENGTH,
    chunkLength: 1,
    nbMaxFrames: FRAMES,
    nSamples: CHUNK_SAMPLES,
};

const bytes = readFileSync(
    new URL('../../fixtures/mel-80.bin', import.meta.url),
);
const filters = new Float64Array(MEL_BINS * BINS);
for (let index = 0; index < filters.length; index += 1) {
    filters[index] = bytes.readFloatLE(index * 4);
}

function waveform(amplitude) {
    const samples = new Float32Array(CHUNK_SAMPLES);
    let state = 1;
    for (let index = 0; index < samples.length; index += 1) {
        state = (Math.imul(state, 1103515245) + 12345) | 0;
        const time = index / SAMPLE_RATE;
        const tone =
            0.6 * Math.sin(2 * Math.PI * 220 * time) +
            0.35 * Math.sin(2 * Math.PI * 3100 * time);
        samples[index] = amplitude * (tone + 0.05 * (state / 2147483648));
    }
    return samples;
}

function hannWindow() {
    const window = new Float64Array(FFT_SIZE);
    for (let index = 0; index < FFT_SIZE; index += 1) {
        window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / FFT_SIZE));
    }
    return window;
}

function reflectPad(samples) {
    const pad = FFT_SIZE / 2;
    const padded = new Float64Array(samples.length + 2 * pad);
    for (let index = 0; index < pad; index += 1) {
        padded[index] = samples[pad - index];
    }
    padded.set(samples, pad);
    const last = samples.length - 1;
    for (let index = 0; index < pad; index += 1) {
        padded[pad + samples.length + index] = samples[last - 1 - index];
    }
    return padded;
}

function referenceLogPower(samples) {
    const window = hannWindow();
    const padded = reflectPad(samples);
    const cosine = new Float64Array(BINS * FFT_SIZE);
    const sine = new Float64Array(BINS * FFT_SIZE);
    for (let bin = 0; bin < BINS; bin += 1) {
        for (let tap = 0; tap < FFT_SIZE; tap += 1) {
            const angle = (2 * Math.PI * bin * tap) / FFT_SIZE;
            cosine[bin * FFT_SIZE + tap] = Math.cos(angle);
            sine[bin * FFT_SIZE + tap] = Math.sin(angle);
        }
    }
    const values = new Float64Array(MEL_BINS * FRAMES);
    for (let frame = 0; frame < FRAMES; frame += 1) {
        const start = frame * HOP_LENGTH;
        const real = new Float64Array(BINS);
        const imag = new Float64Array(BINS);
        for (let bin = 0; bin < BINS; bin += 1) {
            let sumReal = 0;
            let sumImag = 0;
            for (let tap = 0; tap < FFT_SIZE; tap += 1) {
                const value = padded[start + tap] * window[tap];
                sumReal += value * cosine[bin * FFT_SIZE + tap];
                sumImag -= value * sine[bin * FFT_SIZE + tap];
            }
            real[bin] = sumReal;
            imag[bin] = sumImag;
        }
        for (let mel = 0; mel < MEL_BINS; mel += 1) {
            let power = 0;
            for (let bin = 0; bin < BINS; bin += 1) {
                const weight = filters[mel * BINS + bin];
                if (weight !== 0) {
                    power +=
                        weight *
                        (real[bin] * real[bin] + imag[bin] * imag[bin]);
                }
            }
            values[mel * FRAMES + frame] = Math.log10(Math.max(power, 1e-10));
        }
    }
    return values;
}

const loud = waveform(0.9);
const quiet = waveform(0.05);

const power = melLogPower(
    { sampleRate: SAMPLE_RATE, channels: [loud] },
    settings,
);
assert.equal(power.melBins, MEL_BINS);
assert.equal(power.frames, FRAMES);
assert.equal(power.values.length, MEL_BINS * FRAMES);

const reference = referenceLogPower(loud);
let worst = 0;
for (let index = 0; index < reference.length; index += 1) {
    const difference = Math.abs(power.values[index] - reference[index]);
    if (difference > worst) {
        worst = difference;
    }
}
console.log(`worst difference against the naive dft reference: ${worst}`);
assert.ok(
    worst <= 1e-4,
    `mel log power must match the naive dft reference, worst difference ${worst}`,
);

const maximum = melMaximum(power);
let expectedMaximum = -Infinity;
for (const value of reference) {
    if (value > expectedMaximum) {
        expectedMaximum = value;
    }
}
assert.ok(
    Math.abs(maximum - expectedMaximum) < 1e-5,
    `mel maximum ${maximum} must be ${expectedMaximum}`,
);

const normalized = normalizeMel(power, maximum);
for (let index = 0; index < normalized.values.length; index += 1) {
    const want = (Math.max(reference[index], expectedMaximum - 8) + 4) / 4;
    assert.ok(
        Math.abs(normalized.values[index] - want) < 1e-4,
        `mel value ${index} must match the reference chain`,
    );
}
console.log('the clamp, log and offset chain matches the reference');

const fallback = melSpectrogram(
    { sampleRate: SAMPLE_RATE, channels: [loud] },
    settings,
);
for (let index = 0; index < fallback.values.length; index += 1) {
    assert.ok(
        Math.abs(fallback.values[index] - normalized.values[index]) < 1e-6,
        `mel value ${index} must use the block maximum by default`,
    );
}
console.log('the default maximum is the block maximum');

const quietPower = melLogPower(
    { sampleRate: SAMPLE_RATE, channels: [quiet] },
    settings,
);
const quietOwn = normalizeMel(quietPower, melMaximum(quietPower));
const quietShared = normalizeMel(quietPower, maximum);
let different = 0;
for (let index = 0; index < quietOwn.values.length; index += 1) {
    if (Math.abs(quietOwn.values[index] - quietShared.values[index]) > 1e-3) {
        different += 1;
    }
}
assert.ok(different > 0, 'a shared maximum must change a quieter block');
console.log(
    `a shared maximum changes ${different} of ${quietOwn.values.length} mel values`,
);

const rejected = [
    () => melLogPower({ sampleRate: 44100, channels: [loud] }, settings),
    () =>
        melLogPower(
            { sampleRate: SAMPLE_RATE, channels: [loud, loud] },
            settings,
        ),
    () =>
        melLogPower(
            {
                sampleRate: SAMPLE_RATE,
                channels: [new Float32Array(CHUNK_SAMPLES + 1)],
            },
            settings,
        ),
    () => normalizeMel(power, Number.NaN),
];
const codes = [
    'invalid-pcm',
    'unsupported-layout',
    'invalid-option',
    'invalid-option',
];
for (let index = 0; index < rejected.length; index += 1) {
    assert.throws(
        rejected[index],
        (error) => error.code === codes[index],
        `case ${index} must be rejected with ${codes[index]}`,
    );
}
console.log('every invalid input is rejected');
