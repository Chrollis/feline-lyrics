import assert from 'node:assert/strict';
import { clampWords } from '../../../out/main/alignment/clamp.js';

function word(text, start, end) {
    return { word: text, tokens: [1], start, end, probability: 0 };
}

// A duration at or below the cap comes back untouched, down to identity.
const short = [word('a', 0, 1), word('b', 1, 2), word('c', 2, 3)];
const untouched = clampWords(short, { maxDur: 3 });
assert.deepEqual(untouched, short);
assert.equal(untouched[0], short[0]);

// An explicit clipStart clamps every word on the requested side.
const long = [word('a', 0, 1), word('b', 2, 3), word('c', 4, 9)];
assert.deepEqual(
    clampWords(long, { mediumFactor: false, maxDur: 2, clipStart: false }),
    [word('a', 0, 1), word('b', 2, 3), word('c', 4, 6)],
);
assert.deepEqual(
    clampWords(long, { mediumFactor: false, maxDur: 2, clipStart: true }),
    [word('a', 0, 1), word('b', 2, 3), word('c', 7, 9)],
);

// The medium factor uses the upper median of the rounded durations: the
// durations 10, 1, 2 and 3 sort to 1, 2, 3, 10, so the cap is 2.5 * 3 = 7.5.
const uneven = [
    word('a', 0, 10),
    word('b', 11, 12),
    word('c', 13, 15),
    word('d', 16, 19),
];
assert.deepEqual(clampWords(uneven, { mediumFactor: 2.5 }), [
    word('a', 2.5, 10),
    word('b', 11, 12),
    word('c', 13, 15),
    word('d', 16, 19),
]);

// Without an explicit clipStart only the first and the last word are touched,
// so the long word in the middle stays long.
const mixed = [word('a', 0, 9), word('b', 10, 20), word('c', 21, 22)];
assert.deepEqual(clampWords(mixed, { maxDur: 3 }), [
    word('a', 6, 9),
    word('b', 10, 20),
    word('c', 21, 22),
]);
assert.deepEqual(clampWords(mixed, { maxDur: 3, clipStart: true }), [
    word('a', 6, 9),
    word('b', 17, 20),
    word('c', 21, 22),
]);

// A single word runs through both sides of the default branch, which is what
// the reference does too.
const single = [word('a', 0, 10)];
assert.deepEqual(clampWords(single, { maxDur: 3 }), [word('a', 7, 10)]);

// The rest of the word is carried over unchanged.
assert.deepEqual(
    clampWords(
        [{ word: 'a', tokens: [5, 6], start: 0, end: 9, probability: 0.25 }],
        { maxDur: 2 },
    ),
    [{ word: 'a', tokens: [5, 6], start: 7, end: 9, probability: 0.25 }],
);

// Nothing is mutated and every rejected option is rejected.
const original = [word('a', 0, 9), word('b', 10, 20), word('c', 21, 22)];
const snapshot = JSON.stringify(original);
clampWords(original, { maxDur: 3 });
assert.equal(JSON.stringify(original), snapshot);

assert.deepEqual(clampWords([], {}), []);
assert.throws(
    () => clampWords(short, { mediumFactor: false, maxDur: false }),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => clampWords(short, { mediumFactor: false }),
    (error) => error.code === 'invalid-option',
);

console.log('a duration at or below the cap keeps word objects untouched');
console.log('the medium factor uses the upper median of the durations');
console.log('an explicit clipStart clamps every word on the requested side');
console.log('interior words are left alone when clipStart is omitted');
console.log('every clamp invariant holds');
