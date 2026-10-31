import assert from 'node:assert/strict';
import {
    filterSilences,
    maskSpans,
    mergeSilences,
    nonSilentUnits,
    SILENCE_UNIT_SAMPLES,
    silenceMask,
} from '../../src/main/alignment/non-speech.js';
import { describe, it } from 'node:test';

const SAMPLE_RATE = 16000;
const SECONDS_PER_UNIT = SILENCE_UNIT_SAMPLES / SAMPLE_RATE;

function audio(samples, fill = 0) {
    const channel = new Float32Array(samples);
    channel.fill(fill);
    return { sampleRate: SAMPLE_RATE, channels: [channel] };
}

describe('non-speech', () => {
    it('maps the last unit one unit past the audio end, like the reference', async () => {
        const samples = 3 * SAMPLE_RATE;
        // Half voice, half silence: the mask is long enough to measure and the
        // silence run reaches the last unit.
        const half = new Float32Array(samples);
        half.fill(0.5, 0, samples / 2);
        const mask = silenceMask({
            sampleRate: SAMPLE_RATE,
            channels: [half],
        });

        assert.notEqual(mask, null);
        // round(48000 / 320) + 1 = 151 units, which price to 3.02 s. The extra
        // unit is the reference behavior, not an off-by-one to fix here.
        assert.equal(mask.length, 151);
        const spans = maskSpans(mask, SECONDS_PER_UNIT);
        assert.equal(spans.length, 1);
        assert.equal(spans[0].end, 151 * SECONDS_PER_UNIT);
        assert.ok(spans[0].start > 1.4 && spans[0].start < 1.6);

        console.log('the mask length is round(n / unit) + 1 units');
        console.log('the last span can end one unit past the audio');
    });

    it('prices a mask from its index, not from a duration', async () => {
        assert.deepEqual(maskSpans(null, SECONDS_PER_UNIT), []);
        const full = new Uint8Array(151).fill(1);
        assert.deepEqual(maskSpans(full, SECONDS_PER_UNIT), [
            { start: 0, end: 151 * SECONDS_PER_UNIT },
        ]);
    });

    it('returns null when the audio is too short to measure', async () => {
        assert.equal(silenceMask(audio(SILENCE_UNIT_SAMPLES)), null);
    });

    it('rejects audio it cannot read and a mask it cannot price', async () => {
        assert.throws(
            () =>
                silenceMask({
                    sampleRate: SAMPLE_RATE,
                    channels: [new Float32Array(4800), new Float32Array(4800)],
                }),
            (error) => error.code === 'unsupported-layout',
        );
        assert.throws(
            () => maskSpans(new Uint8Array([1]), 0),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => silenceMask(audio(4800), { unitSamples: 0 }),
            (error) => error.code === 'invalid-option',
        );
    });

    it('keeps a silence exactly as long as the minimum', async () => {
        const spans = [
            { start: 0, end: 1 },
            { start: 2, end: 2.5 },
            { start: 5, end: 5.05 },
        ];

        assert.deepEqual(filterSilences(spans, 0), spans);
        assert.deepEqual(filterSilences(spans, 0.5), [spans[0], spans[1]]);
        // 0.05 is shorter than 0.5000001, so the last span drops out.
        assert.deepEqual(filterSilences(spans, 0.5000001), [spans[0]]);
        assert.deepEqual(filterSilences([{ start: 3, end: 3 }], 0), [
            { start: 3, end: 3 },
        ]);

        assert.throws(
            () => filterSilences(spans, -1),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => filterSilences(spans, Number.NaN),
            (error) => error.code === 'invalid-option',
        );
    });

    it('merges overlapping silences but leaves touching ones apart', async () => {
        assert.deepEqual(mergeSilences([]), []);
        // end == next start is adjacency, not overlap: the reference keeps both.
        assert.deepEqual(
            mergeSilences([
                { start: 0, end: 1 },
                { start: 1, end: 2 },
            ]),
            [
                { start: 0, end: 1 },
                { start: 1, end: 2 },
            ],
        );
        assert.deepEqual(
            mergeSilences([
                { start: 0, end: 2 },
                { start: 1, end: 3 },
            ]),
            [{ start: 0, end: 3 }],
        );
        // Out of order input comes back sorted.
        assert.deepEqual(
            mergeSilences([
                { start: 4, end: 5 },
                { start: 0, end: 1 },
                { start: 2, end: 3 },
            ]),
            [
                { start: 0, end: 1 },
                { start: 2, end: 3 },
                { start: 4, end: 5 },
            ],
        );
        // A zero-length span touching its neighbours stays where it is.
        assert.deepEqual(
            mergeSilences([
                { start: 0, end: 1 },
                { start: 1, end: 1 },
                { start: 1, end: 2 },
            ]),
            [
                { start: 0, end: 1 },
                { start: 1, end: 1 },
                { start: 1, end: 2 },
            ],
        );
    });

    it('counts the zeros of the mask as voice units', async () => {
        // The mask marks silence with a non-zero byte, so every zero is voice.
        assert.equal(nonSilentUnits(new Uint8Array(0)), 0);
        assert.equal(nonSilentUnits(Uint8Array.from([0, 0, 0])), 3);
        assert.equal(nonSilentUnits(Uint8Array.from([1, 1, 1])), 0);
        assert.equal(nonSilentUnits(Uint8Array.from([0, 1, 1, 0, 1])), 2);
        // Any non-zero value is silence; the magnitude does not matter.
        assert.equal(nonSilentUnits(Uint8Array.from([0, 2, 0])), 2);
        assert.equal(nonSilentUnits(Uint8Array.from([255, 0])), 1);
    });
});
