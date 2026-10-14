import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    makeSegment,
    suppressSegmentSilence,
} from '../../../out/main/alignment/segment.js';

const golden = JSON.parse(
    readFileSync(
        new URL('../../fixtures/suppress-golden.json', import.meta.url),
        'utf8',
    ),
);
const silences = golden.input.silences.map(([start, end]) => ({ start, end }));
const options = {
    minWordDur: golden.producer.minWordDur,
    nonspeechError: golden.producer.nonspeechError,
    wordLevel: golden.producer.wordLevel,
    useWordPosition: golden.producer.useWordPosition,
};
const metaOf = (segment) => ({
    seek: segment.seek,
    temperature: segment.temperature,
    avg_logprob: segment.avg_logprob,
    compression_ratio: segment.compression_ratio,
    no_speech_prob: segment.no_speech_prob,
});

// Every segment of the fixture is real stable-whisper output, so rebuilding it from its
// words and suppressing at the segment level has to reproduce it exactly.
const segments = golden.input.segments.map((segment) =>
    makeSegment(segment.words, metaOf(segment)),
);
let moved = 0;
segments.forEach((segment, index) => {
    const result = suppressSegmentSilence(segment, silences, options);
    assert.deepEqual(result, golden.suppress[index]);
    result.words.forEach((word, position) => {
        const before = segment.words[position];
        if (before.start !== word.start || before.end !== word.end) moved += 1;
    });
});
assert.ok(moved > 0, 'the fixture has to contain words that a silence moves');

// word_level off touches only the edge words of a segment.
const long = segments[2];
const edges = suppressSegmentSilence(long, silences, {
    ...options,
    wordLevel: false,
});
for (let index = 1; index < edges.words.length - 1; index += 1) {
    assert.deepEqual(edges.words[index], long.words[index]);
}

// use_word_position off suppresses both edges of every word (keep_end = None), while
// the default keeps the end of a word that is neither edge nor punctuation.
const words = [
    { word: ' first', start: 0, end: 0.4, probability: 0.9, tokens: [1] },
    { word: ' inside', start: 0.5, end: 2.1, probability: 0.9, tokens: [2] },
    { word: ' after', start: 2.2, end: 2.6, probability: 0.9, tokens: [3] },
];
const gap = [{ start: 1.95, end: 2.15 }];
const positioned = suppressSegmentSilence(makeSegment(words), gap, options);
assert.deepEqual(positioned.words[1], words[1]);
const both = suppressSegmentSilence(makeSegment(words), gap, {
    ...options,
    useWordPosition: false,
});
assert.deepEqual(both.words[1], { ...words[1], end: 1.95 });

console.log(
    `matched ${segments.length} stable-whisper segments, ${moved} words moved`,
);
console.log(
    'word_level keeps the inner words and use_word_position decides the edge',
);
