import assert from 'node:assert/strict';
import { createFftPlan, realFft } from '../../../out/main/alignment/fft.js';

const SIZES = [7, 8, 100, 400, 512, 1000];

function pseudoRandom(count, seed) {
    const values = new Float32Array(count);
    let state = seed;
    for (let index = 0; index < count; index++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        values[index] = state / 0x3fffffff - 1;
    }
    return values;
}

function naiveDft(input, size) {
    const bins = Math.floor(size / 2) + 1;
    const real = new Float64Array(bins);
    const imag = new Float64Array(bins);
    for (let bin = 0; bin < bins; bin++) {
        let sumReal = 0;
        let sumImag = 0;
        for (let index = 0; index < size; index++) {
            const angle = (2 * Math.PI * bin * index) / size;
            sumReal += input[index] * Math.cos(angle);
            sumImag -= input[index] * Math.sin(angle);
        }
        real[bin] = sumReal;
        imag[bin] = sumImag;
    }
    return { real, imag };
}

function worstRelativeError(plan, actual, expected) {
    let worst = 0;
    for (let bin = 0; bin < plan.bins; bin++) {
        const difference = Math.hypot(
            actual.real[bin] - expected.real[bin],
            actual.imag[bin] - expected.imag[bin],
        );
        const scale = Math.max(
            1,
            Math.hypot(expected.real[bin], expected.imag[bin]),
        );
        worst = Math.max(worst, difference / scale);
    }
    return worst;
}

for (const size of SIZES) {
    const plan = createFftPlan(size);
    const input = pseudoRandom(size, size * 7919 + 13);
    const expected = naiveDft(input, size);
    const actual = {
        real: new Float32Array(plan.bins),
        imag: new Float32Array(plan.bins),
    };
    realFft(plan, input, actual.real, actual.imag);
    assert.equal(plan.bins, expected.real.length);
    const worst = worstRelativeError(plan, actual, expected);
    assert.ok(worst < 1e-6, `size ${size} worst relative error ${worst}`);
    console.log(
        `size ${size}: kind ${plan.kind}, bins ${plan.bins}, worst relative error ${worst.toExponential(2)}`,
    );
}

assert.equal(createFftPlan(512).kind, 'radix2');
assert.equal(createFftPlan(400).kind, 'bluestein');

const dcPlan = createFftPlan(400);
const dc = new Float32Array(400).fill(1);
const dcReal = new Float32Array(dcPlan.bins);
const dcImag = new Float32Array(dcPlan.bins);
realFft(dcPlan, dc, dcReal, dcImag);
assert.ok(Math.abs(dcReal[0] - 400) < 1e-9);
assert.ok(Math.abs(dcImag[0]) < 1e-9);
for (let bin = 1; bin < dcPlan.bins; bin++) {
    assert.ok(
        Math.hypot(dcReal[bin], dcImag[bin]) < 1e-9,
        `dc bin ${bin} is not zero`,
    );
}

const tonePlan = createFftPlan(400);
const tone = new Float32Array(400);
for (let index = 0; index < 400; index++) {
    tone[index] = Math.cos((2 * Math.PI * 5 * index) / 400);
}
const toneReal = new Float32Array(tonePlan.bins);
const toneImag = new Float32Array(tonePlan.bins);
realFft(tonePlan, tone, toneReal, toneImag);
assert.ok(Math.abs(toneReal[5] - 200) < 1e-9);
assert.ok(Math.abs(toneImag[5]) < 1e-9);

for (const bad of [1, 0, -8, 2.5, 1 << 21]) {
    assert.throws(
        () => createFftPlan(bad),
        (error) => error.code === 'invalid-option',
    );
}
assert.throws(
    () =>
        realFft(
            createFftPlan(8),
            new Float32Array(7),
            new Float32Array(5),
            new Float32Array(5),
        ),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () =>
        realFft(
            createFftPlan(8),
            new Float32Array(8),
            new Float32Array(4),
            new Float32Array(5),
        ),
    (error) => error.code === 'invalid-option',
);

const benchPlan = createFftPlan(400);
const benchInput = pseudoRandom(400, 12345);
const benchReal = new Float32Array(benchPlan.bins);
const benchImag = new Float32Array(benchPlan.bins);
for (let index = 0; index < 1000; index++) {
    realFft(benchPlan, benchInput, benchReal, benchImag);
}
const started = performance.now();
for (let index = 0; index < 3000; index++) {
    realFft(benchPlan, benchInput, benchReal, benchImag);
}
const elapsed = performance.now() - started;
console.log(
    `400 point fft: ${(elapsed / 3000).toFixed(3)} ms per frame, ${(elapsed / 1000).toFixed(2)} s for 3000 frames`,
);

console.log(
    'naive dft comparison, dc and tone bins, error cases and timing all pass',
);
