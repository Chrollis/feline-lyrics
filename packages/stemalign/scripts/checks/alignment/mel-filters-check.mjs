import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildMelFilters } from '../../../out/main/alignment/mel-filters.js';

const EXPECTED_SHA256 =
    '4f2701b1d287d74a0dc9871026e9519d98cb76426615f2539b0d151a0ae4ec2e';
const SAMPLE_RATE = 16000;
const FFT_SIZE = 400;
const MEL_BINS = 80;
const BINS = 201;

const bytes = readFileSync(
    new URL('../../fixtures/mel-80.bin', import.meta.url),
);
assert.equal(bytes.length, MEL_BINS * BINS * 4);
assert.equal(createHash('sha256').update(bytes).digest('hex'), EXPECTED_SHA256);

const reference = new Float32Array(bytes.length / 4);
for (let index = 0; index < reference.length; index += 1) {
    reference[index] = bytes.readFloatLE(index * 4);
}

const filters = buildMelFilters(SAMPLE_RATE, FFT_SIZE, MEL_BINS);
assert.equal(filters.melBins, MEL_BINS);
assert.equal(filters.bins, BINS);
assert.equal(filters.values.length, MEL_BINS * BINS);

let worst = 0;
let worstIndex = 0;
for (let index = 0; index < reference.length; index += 1) {
    const difference = Math.abs(filters.values[index] - reference[index]);
    if (difference > worst) {
        worst = difference;
        worstIndex = index;
    }
}
console.log(
    `worst difference against the whisper mel_80 matrix: ${worst} at mel ${Math.floor(worstIndex / BINS)} bin ${worstIndex % BINS}`,
);
assert.ok(
    worst <= 1e-6,
    `mel filters must match the whisper matrix, worst difference ${worst}`,
);

const rejected = [
    () => buildMelFilters(0, FFT_SIZE, MEL_BINS),
    () => buildMelFilters(SAMPLE_RATE, FFT_SIZE, 0),
    () => buildMelFilters(SAMPLE_RATE, 1, MEL_BINS),
    () => buildMelFilters(SAMPLE_RATE, FFT_SIZE, 2.5),
];
for (const call of rejected) {
    assert.throws(call, (error) => error.code === 'invalid-option');
}
console.log('every invalid option is rejected');
