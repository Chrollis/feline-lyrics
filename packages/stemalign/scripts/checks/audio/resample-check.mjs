import assert from 'node:assert/strict';
import { resample } from '../../../out/main/index.js';

// Same kernel definition as src/main/audio/resample.ts, computed per tap per
// sample. This is the slow reference the polyphase table must reproduce.
const ZERO_CROSSINGS = 16;
const BETA = 8.6;
const I0_BETA = besselI0(BETA);

function besselI0(x) {
    let sum = 1;
    let term = 1;
    const half = x * 0.5;
    for (let k = 1; k < 64; k += 1) {
        const f = half / k;
        term *= f * f;
        sum += term;
        if (term < sum * 1e-16) break;
    }
    return sum;
}

function sinc(x) {
    if (x === 0) return 1;
    const px = Math.PI * x;
    return Math.sin(px) / px;
}

function naiveResample(audio, targetSampleRate) {
    const srcRate = audio.sampleRate;
    const frameCount = audio.channels[0].length;
    const ratio = srcRate / targetSampleRate;
    const outputFrames = Math.max(1, Math.round(frameCount / ratio));
    const cutoff = Math.min(1, targetSampleRate / srcRate);
    const halfWidth = ZERO_CROSSINGS / cutoff;
    const lastIndex = frameCount - 1;

    return {
        sampleRate: targetSampleRate,
        channels: audio.channels.map((channel) => {
            const output = new Float32Array(outputFrames);

            for (let index = 0; index < outputFrames; index += 1) {
                const center = index * ratio;
                const first = Math.ceil(center - halfWidth);
                const last = Math.floor(center + halfWidth);
                let acc = 0;
                let sum = 0;

                for (let tap = first; tap <= last; tap += 1) {
                    const offset = center - tap;
                    const t = offset / halfWidth;
                    if (t <= -1 || t >= 1) continue;

                    const window =
                        besselI0(BETA * Math.sqrt(1 - t * t)) / I0_BETA;
                    const weight = sinc(offset * cutoff) * window;
                    const clamped =
                        tap < 0 ? 0 : tap > lastIndex ? lastIndex : tap;

                    acc += channel[clamped] * weight;
                    sum += weight;
                }

                output[index] = sum === 0 ? 0 : acc / sum;
            }

            return output;
        }),
    };
}

function tone(sampleRate, frames, frequency, amplitude) {
    const signal = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
        signal[index] =
            amplitude *
            Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    }
    return signal;
}

// The first and last halfWidth samples read past the input and are clamped to
// the edge sample, so they are excluded from comparisons against an ideal tone.
function maxDifference(left, right, margin = 0) {
    const limit = Math.min(left.length, right.length) - margin;
    let worst = 0;
    for (let index = margin; index < limit; index += 1) {
        worst = Math.max(worst, Math.abs(left[index] - right[index]));
    }
    return worst;
}

function rootMeanSquare(signal) {
    let sum = 0;
    for (const value of signal) {
        sum += value * value;
    }
    return Math.sqrt(sum / signal.length);
}

const EDGES = 64;
const toneRms = 0.5 / Math.sqrt(2);

// The table must reproduce the per tap math for up, down and 1/3 conversion.
const shortSignal = {
    sampleRate: 48000,
    channels: [tone(48000, 4096, 997, 0.5), tone(48000, 4096, 3001, 0.25)],
};
for (const targetRate of [44100, 16000]) {
    const fast = resample(shortSignal, targetRate);
    const slow = naiveResample(shortSignal, targetRate);

    assert.equal(fast.sampleRate, targetRate);
    assert.equal(fast.channels.length, 2);
    for (let index = 0; index < fast.channels.length; index += 1) {
        const difference = maxDifference(
            fast.channels[index],
            slow.channels[index],
        );
        assert.ok(
            difference < 1e-6,
            `48k to ${targetRate} channel ${index} differs from the reference by ${difference}`,
        );
    }
}

{
    const upSignal = {
        sampleRate: 44100,
        channels: [tone(44100, 4096, 997, 0.5)],
    };
    const difference = maxDifference(
        resample(upSignal, 48000).channels[0],
        naiveResample(upSignal, 48000).channels[0],
    );
    assert.ok(
        difference < 1e-6,
        `44.1k to 48k differs from the reference by ${difference}`,
    );
}

// Same rate is a no-op, and the length follows the ratio.
assert.equal(resample(shortSignal, 48000), shortSignal);
assert.equal(
    resample(shortSignal, 44100).channels[0].length,
    Math.round(4096 * (44100 / 48000)),
);

// A constant level must stay constant, edges included: the clamped edge taps
// keep the row sum at one instead of fading the first samples to zero.
const constant = {
    sampleRate: 44100,
    channels: [new Float32Array(1000).fill(0.25)],
};
for (const value of resample(constant, 48000).channels[0]) {
    assert.ok(Math.abs(value - 0.25) < 1e-6, `dc level drifted to ${value}`);
}

// Degenerate inputs keep their channel count and produce finite samples.
assert.equal(
    resample({ sampleRate: 48000, channels: [new Float32Array(0)] }, 44100)
        .channels[0].length,
    0,
);
const single = resample(
    { sampleRate: 48000, channels: [Float32Array.from([0.5])] },
    44100,
);
assert.equal(single.channels[0].length, 1);
assert.ok(Math.abs(single.channels[0][0] - 0.5) < 1e-6);

// A 1 kHz tone survives a round trip through the model rate. Away from the
// clamped edges the error is the filter's passband accuracy, about -92dB.
const frames = 48000;
const original = tone(48000, frames, 1000, 0.5);
const roundTrip = resample(
    resample({ sampleRate: 48000, channels: [original] }, 44100),
    48000,
);
const roundTripInner = maxDifference(original, roundTrip.channels[0], EDGES);
const roundTripAll = maxDifference(original, roundTrip.channels[0]);
assert.ok(
    roundTripInner < 1e-4,
    `1 kHz tone lost ${roundTripInner} in the interior of 48k -> 44.1k -> 48k`,
);
assert.ok(
    roundTripAll < 5e-3,
    `1 kHz tone lost ${roundTripAll} including the edges`,
);

// Above the new Nyquist the kernel must attenuate instead of folding back.
// 12 kHz against a 16 kHz target sits well past the cutoff, so it is down by
// more than 40 dB; 23 kHz against a 44.1 kHz target is only 4 percent above
// Nyquist and lands inside the transition band, where the kernel is shallow by
// design (16 zero crossings trade that width for a short kernel).
const farLeak = rootMeanSquare(
    resample(
        { sampleRate: 48000, channels: [tone(48000, frames, 12000, 0.5)] },
        16000,
    ).channels[0],
);
assert.ok(
    farLeak < toneRms / 100,
    `12 kHz tone leaked back as ${farLeak} rms, expected 40 dB down`,
);
const nearLeak = rootMeanSquare(
    resample(
        { sampleRate: 48000, channels: [tone(48000, frames, 23000, 0.5)] },
        44100,
    ).channels[0],
);
assert.ok(
    nearLeak < toneRms / 3,
    `23 kHz tone leaked back as ${nearLeak} rms, expected 9 dB down`,
);

// Output samples that land exactly on a source frame reproduce that frame;
// this pins the integer phase arithmetic against the float position.
const smooth = tone(48000, frames, 1000, 0.5);
const converted = resample({ sampleRate: 48000, channels: [smooth] }, 44100)
    .channels[0];
let worstFrame = 0;
for (let index = 1; index * 147 < converted.length - EDGES; index += 1) {
    const sourceIndex = index * 160; // 147 output frames = 160 source frames
    if (sourceIndex + EDGES >= frames) break;
    worstFrame = Math.max(
        worstFrame,
        Math.abs(converted[index * 147] - smooth[sourceIndex]),
    );
}
assert.ok(worstFrame < 1e-4, `exact source frames moved by ${worstFrame}`);

const started = Date.now();
resample(
    { sampleRate: 48000, channels: [tone(48000, 48000, 1000, 0.5)] },
    44100,
);
console.log(
    `resampled one second of mono 48k -> 44.1k in ${Date.now() - started} ms`,
);
console.log(
    `table matches the per tap reference; round trip interior ` +
        `${roundTripInner.toExponential(2)}, edges ${roundTripAll.toExponential(2)}, ` +
        `exact frames ${worstFrame.toExponential(2)}, ` +
        `12k into 16k ${farLeak.toExponential(2)} rms, ` +
        `23k into 44.1k ${nearLeak.toExponential(2)} rms`,
);
