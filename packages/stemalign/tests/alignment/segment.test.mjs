import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    makeSegment,
    splitSegmentByChars,
} from '../../src/main/alignment/segment.js';
import { describe, it } from 'node:test';

describe('segments', () => {
    it('derives shapes from the words', async () => {
        const word = (text, start, end, probability, tokens) => ({
            word: text,
            tokens,
            start,
            end,
            probability,
        });

        // An empty word list reports the Segment() defaults.
        assert.deepEqual(makeSegment([]), {
            start: 0,
            end: 0,
            text: '',
            seek: null,
            tokens: null,
            temperature: null,
            avg_logprob: null,
            compression_ratio: null,
            no_speech_prob: null,
            words: [],
        });

        const alpha = [
            word(' alpha', 5.2, 5.5, 0.9, [1013]),
            word(' beta', 5.5, 5.8, 0.9, [1014]),
            word(' gamma', 5.8, 6.1, 0.9, [1015]),
        ];

        // Every shape field comes from the words.
        assert.deepEqual(makeSegment(alpha), {
            start: 5.2,
            end: 6.1,
            text: ' alpha beta gamma',
            seek: null,
            tokens: [1013, 1014, 1015],
            temperature: null,
            avg_logprob: null,
            compression_ratio: null,
            no_speech_prob: null,
            words: alpha,
        });

        // Metadata passes through and stays null while it is missing.
        const meta = {
            seek: 0,
            temperature: 0,
            avg_logprob: -0.35,
            compression_ratio: 1.2,
            no_speech_prob: 0.02,
        };
        assert.deepEqual(makeSegment(alpha, meta), {
            start: 5.2,
            end: 6.1,
            text: ' alpha beta gamma',
            tokens: [1013, 1014, 1015],
            ...meta,
            words: alpha,
        });
        const partial = makeSegment(alpha, { seek: 0 });
        assert.equal(partial.seek, 0);
        assert.equal(partial.temperature, null);

        // The golden fixture is real stable-whisper output, so deriving every segment from
        // its own words has to reproduce it exactly.
        const golden = JSON.parse(
            readFileSync(
                new URL('../fixtures/regroup-golden.json', import.meta.url),
                'utf8',
            ),
        );
        const carried = (segment) => ({
            seek: segment.seek,
            temperature: segment.temperature,
            avg_logprob: segment.avg_logprob,
            compression_ratio: segment.compression_ratio,
            no_speech_prob: segment.no_speech_prob,
        });
        for (const segment of golden.regroup.segments) {
            assert.deepEqual(
                makeSegment(segment.words, carried(segment)),
                segment,
            );
        }

        // Splitting at character offsets keeps every word, in order.
        const texts = (indexes) =>
            splitSegmentByChars(alpha, indexes).map((segment) => segment.text);
        assert.deepEqual(texts([]), [' alpha beta gamma']);
        assert.deepEqual(texts([1]), [' alpha', ' beta gamma']);
        assert.deepEqual(texts([7]), [' alpha beta', ' gamma']);
        // An offset at or past the text length starts an empty trailing segment, so the whole
        // text stays in one segment.
        assert.deepEqual(texts([17]), [' alpha beta gamma']);
        assert.deepEqual(texts([18]), [' alpha beta gamma']);
        assert.deepEqual(texts([3, 9]), [' alpha', ' beta', ' gamma']);
        assert.deepEqual(texts([3, 3]), [' alpha', ' beta gamma']);
        assert.deepEqual(texts([6, 11]), [' alpha', ' beta', ' gamma']);

        // Offsets count code points, not UTF-16 units.
        const astral = [
            word(String.fromCodePoint(0x1d11e), 0, 1, 0.5, [1]),
            word('b', 1, 2, 0.5, [2]),
        ];
        assert.deepEqual(
            splitSegmentByChars(astral, [2]).map((segment) => segment.text),
            [String.fromCodePoint(0x1d11e) + 'b'],
        );

        // Splitting keeps the shape and the metadata of every part.
        const parts = splitSegmentByChars(alpha, [7], meta);
        assert.deepEqual(
            parts.map((segment) => [
                segment.start,
                segment.end,
                segment.tokens,
                segment.seek,
            ]),
            [
                [5.2, 5.8, [1013, 1014], 0],
                [5.8, 6.1, [1015], 0],
            ],
        );

        // Invalid offsets are rejected.
        for (const indexes of [[0], [-1], [1.5], ['1'], [9, 3]]) {
            assert.throws(
                () => splitSegmentByChars(alpha, indexes),
                (error) => error.code === 'invalid-option',
                `expected ${JSON.stringify(indexes)} to be rejected`,
            );
        }

        console.log('every segment shape derives from its words');
        console.log(
            `rebuilt ${golden.regroup.segments.length} stable-whisper segments from the regroup golden`,
        );
        console.log('every split invariant holds');
    });
});
