import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DEFAULT_REGROUP_ALGO,
    parseRegroupAlgo,
    regroupSegments,
} from '../../../out/main/alignment/regroup.js';
import { makeSegment } from '../../../out/main/alignment/segment.js';

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

// The default algorithm expands to the seven calls of result.py:2924.
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

// The golden fixture is real stable-whisper output: regrouping its input has to
// reproduce its segments and its history string exactly.
const golden = JSON.parse(
    readFileSync(
        new URL('../../fixtures/regroup-golden.json', import.meta.url),
        'utf8',
    ),
);
const input = golden.input.segments.map(build);
const regrouped = regroupSegments(input);
assert.deepEqual(regrouped.segments, golden.regroup.segments);
assert.equal(regrouped.history, golden.regroup.regroup_history);
const flatWords = (segments) =>
    segments.flatMap((segment) => segment.words.map((w) => w.word)).join('');
assert.equal(input.length, golden.input.segments.length);
assert.equal(
    flatWords(input),
    flatWords(golden.input.segments),
    'regrouping must not touch the segments it was given',
);

// A gap above the limit splits after the word before it.
const gapped = [
    makeSegment([
        word(' a', 0, 0.2),
        word(' b', 0.9, 1.1),
        word(' c', 1.2, 1.4),
    ]),
];
assert.deepEqual(texts(regroupSegments(gapped, { algo: 'sg=.5' }).segments), [
    ' a',
    ' b c',
]);

// A punctuation pair splits only where the trailing and leading strings meet.
// A lone `.* ` is not a pair: without `/` it stays one string, like Python's
// str_to_valid_type, so it splits nothing.
const sentences = [
    makeSegment([
        word('Mr.', 0, 0.2),
        word(' Smith', 0.2, 0.5),
        word(' went.', 0.5, 0.8),
    ]),
];
assert.deepEqual(
    texts(regroupSegments(sentences, { algo: 'sp=.* ' }).segments),
    ['Mr. Smith went.'],
);
assert.deepEqual(
    texts(regroupSegments(sentences, { algo: 'sp=.* /x' }).segments),
    ['Mr.', ' Smith went.'],
);
// ... and ignoring special periods keeps an abbreviation in its sentence.
assert.deepEqual(
    texts(regroupSegments(sentences, { algo: 'isp_sp=.* /x' }).segments),
    ['Mr. Smith went.'],
);

// An even split picks the word nearest to the requested character counts.
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
assert.deepEqual(texts(regroupSegments(letters, { algo: 'sl=12' }).segments), [
    'aaaabbbbcccc',
    'ddddeeeeffff',
]);
// A sequential split cuts after the word that pushes the count over the limit.
assert.deepEqual(
    texts(regroupSegments(letters, { algo: 'sl=6++0' }).segments),
    ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff'],
);

// Newline mode marks the split point inside one segment instead of splitting.
const marked = regroupSegments(gapped, { algo: 'sg=.5+0+1' }).segments;
assert.deepEqual(texts(marked), [' a\n b c']);
assert.equal(marked.length, 1);

// Clamping shortens the first word of a segment at its start and the last at its end.
const long = [
    makeSegment([word(' a', 0, 10), word(' b', 10, 11), word(' c', 11, 12)]),
];
const clamped = regroupSegments(long, { algo: 'cm' }).segments[0];
assert.equal(clamped.words[0].start, 7.5);
assert.equal(clamped.words[0].end, 10);
assert.equal(clamped.words[2].end, 12);

// Invalid algorithms and arguments are rejected instead of ignored.
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

console.log(
    `matched ${golden.regroup.segments.length} stable-whisper segments and the regroup history`,
);
console.log(`the default algorithm parses into ${calls.length} calls`);
console.log('every regroup invariant holds');
