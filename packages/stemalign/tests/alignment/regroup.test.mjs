import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    DEFAULT_REGROUP_ALGO,
    parseRegroupAlgo,
    regroupSegments,
} from '../../src/main/alignment/regroup.js';
import { makeSegment } from '../../src/main/alignment/segment.js';

const word = (text, start, end, probability = 0.9, tokens = [1]) => ({
    word: text,
    tokens,
    start,
    end,
    probability,
});

const carried = (segment) => ({
    seek: segment.seek,
    temperature: segment.temperature,
    avg_logprob: segment.avg_logprob,
    compression_ratio: segment.compression_ratio,
    no_speech_prob: segment.no_speech_prob,
});

const build = (segment) => makeSegment(segment.words, carried(segment));

const texts = (segments) => segments.map((segment) => segment.text);

const golden = JSON.parse(
    readFileSync(
        new URL('../fixtures/regroup-golden.json', import.meta.url),
        'utf8',
    ),
);

const gapped = [
    makeSegment([
        word(' a', 0, 0.2),
        word(' b', 0.9, 1.1),
        word(' c', 1.2, 1.4),
    ]),
];

const sentences = [
    makeSegment([
        word('Mr.', 0, 0.2),
        word(' Smith', 0.2, 0.5),
        word(' went.', 0.5, 0.8),
    ]),
];

const letters = [
    makeSegment([
        word('aaaa', 0, 0.1),
        word('bbbb', 0.1, 0.2),
        word('cccc', 0.2, 0.3),
        word('dddd', 0.3, 0.4),
        word('eeee', 0.4, 0.5),
        word('ffff', 0.5, 0.6),
    ]),
];

describe('parseRegroupAlgo', () => {
    it('expands the default chain into the seven calls of result.py:2924', () => {
        const calls = parseRegroupAlgo(DEFAULT_REGROUP_ALGO);
        assert.deepEqual(
            calls.map((call) => call.method),
            ['isp', 'cm', 'sp', 'sg', 'sp', 'sl', 'cm'],
        );
        assert.deepEqual(calls[0].kwargs, {});
        assert.deepEqual(calls[1].kwargs, {});
        assert.deepEqual(calls[2].kwargs, {
            punctuation: [['.', ' '], '。', '?', '？'],
        });
        assert.deepEqual(calls[3].kwargs, { max_gap: 0.5 });
        assert.deepEqual(calls[4].kwargs, {
            punctuation: [[',', ' '], '，'],
            min_chars: 50,
        });
        assert.deepEqual(calls[5].kwargs, { max_chars: 70 });
        assert.deepEqual(calls[6].kwargs, {});
    });
});

describe('regroupSegments', () => {
    it('reproduces the stable-whisper golden segments and history', () => {
        const input = golden.input.segments.map(build);
        const regrouped = regroupSegments(input);
        assert.deepEqual(regrouped.segments, golden.regroup.segments);
        assert.equal(regrouped.history, golden.regroup.regroup_history);
        const flatWords = (segments) =>
            segments
                .flatMap((segment) => segment.words.map((w) => w.word))
                .join('');
        assert.equal(
            flatWords(input),
            flatWords(golden.input.segments),
            'regrouping must not touch the segments it was given',
        );
    });

    it('splits after the word before a gap above the limit', () => {
        assert.deepEqual(
            texts(regroupSegments(gapped, { algo: 'sg=.5' }).segments),
            [' a', ' b c'],
        );
    });

    it('splits punctuation pairs only where the two strings meet', () => {
        // A lone `.* ` is not a pair: without `/` it stays one string, like
        // Python's str_to_valid_type, so it splits nothing.
        assert.deepEqual(
            texts(regroupSegments(sentences, { algo: 'sp=.* ' }).segments),
            ['Mr. Smith went.'],
        );
        assert.deepEqual(
            texts(regroupSegments(sentences, { algo: 'sp=.* /x' }).segments),
            ['Mr.', ' Smith went.'],
        );
    });

    it('keeps an abbreviation inside its sentence when it ignores special periods', () => {
        assert.deepEqual(
            texts(
                regroupSegments(sentences, { algo: 'isp_sp=.* /x' }).segments,
            ),
            ['Mr. Smith went.'],
        );
    });

    it('splits by length evenly or sequentially', () => {
        assert.deepEqual(
            texts(regroupSegments(letters, { algo: 'sl=12' }).segments),
            ['aaaabbbbcccc', 'ddddeeeeffff'],
        );
        assert.deepEqual(
            texts(regroupSegments(letters, { algo: 'sl=6++0' }).segments),
            ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff'],
        );
    });

    it('marks the split point instead of splitting in newline mode', () => {
        const marked = regroupSegments(gapped, { algo: 'sg=.5+0+1' }).segments;
        assert.deepEqual(texts(marked), [' a\n b c']);
        assert.equal(marked.length, 1);
    });

    it('clamps the first word at its start and the last at its end', () => {
        const long = [
            makeSegment([
                word(' a', 0, 10),
                word(' b', 10, 11),
                word(' c', 11, 12),
            ]),
        ];
        const clamped = regroupSegments(long, { algo: 'cm' }).segments[0];
        assert.equal(clamped.words[0].start, 7.5);
        assert.equal(clamped.words[0].end, 10);
        assert.equal(clamped.words[2].end, 12);
    });

    it('rejects invalid algorithms and arguments', () => {
        const rejects = [
            ['', 'invalid-option'],
            ['zz', 'invalid-option'],
            ['mg=.5', 'invalid-option'],
            ['sg=abc', 'invalid-option'],
            ['sg=.5+1', 'invalid-option'],
            ['sl=70++++1', 'invalid-option'],
            ['sl=0', 'invalid-option'],
            ['sp', 'invalid-option'],
        ];
        for (const [algo, code] of rejects) {
            assert.throws(
                () => regroupSegments(gapped, { algo }),
                (error) => error.code === code,
                `expected ${JSON.stringify(algo)} to be rejected`,
            );
        }
    });
});
