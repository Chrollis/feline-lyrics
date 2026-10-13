import assert from 'node:assert/strict';
import { dtwPath } from '../../../out/main/alignment/dtw.js';
import { computeJumpIndices } from '../../../out/main/alignment/jumps.js';

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function weightsOf(nHeads, nTokens, nFrames, fill) {
    const values = new Float32Array(nHeads * nTokens * nFrames);
    for (let index = 0; index < values.length; index += 1) {
        values[index] = fill(index);
    }
    return { nHeads, nTokens, nFrames, maxQkLen: nFrames, weights: values };
}

function naiveJumpIndices(attention) {
    const { nHeads, nTokens, nFrames, weights } = attention;
    const matrix = new Float64Array(nTokens * nFrames);
    for (let head = 0; head < nHeads; head += 1) {
        for (let token = 0; token < nTokens; token += 1) {
            for (let frame = 0; frame < nFrames; frame += 1) {
                matrix[token * nFrames + frame] +=
                    weights[head * nTokens * nFrames + token * nFrames + frame];
            }
        }
    }
    const costs = Float32Array.from(matrix, (sum) => -sum / nHeads);
    const path = dtwPath(costs, nTokens, nFrames);
    const jumps = [];
    let previous = -1;
    for (let step = 0; step < path.textIndices.length; step += 1) {
        const text = path.textIndices[step];
        if (step === 0 || text !== previous) {
            jumps.push(Math.max(0, path.timeIndices[step]));
        }
        previous = text;
    }
    return jumps;
}

const ridge = weightsOf(1, 2, 10, (index) => {
    const token = Math.floor(index / 10);
    const frame = index % 10;
    return (token === 0 ? frame <= 4 : frame >= 5) ? 5 : 0;
});

// By construction: token 0 owns frames 0..4 and token 1 owns frames 5..9, while
// cells of the other row cost nothing. A cheapest path must collect all ten cheap
// cells and can only step up once, so the boundary lands on frame 4 or 5: the
// ten-cell path steps up at 5, the eleven-cell path takes the free cell at 4.
const ridgeJumps = Array.from(computeJumpIndices(ridge).jumpIndices);
assert.equal(ridgeJumps[0], 0);
assert.ok(
    ridgeJumps[1] === 4 || ridgeJumps[1] === 5,
    `the ridge boundary must land on frame 4 or 5, got ${ridgeJumps[1]}`,
);
assert.deepEqual(ridgeJumps, [0, 4]);

// A single text token can only jump once, at the first time step.
const single = computeJumpIndices(weightsOf(1, 1, 6, () => 1));
assert.deepEqual(Array.from(single.jumpIndices), [0]);

for (const seed of [1, 2, 3, 4]) {
    const random = mulberry32(seed);
    const attention = weightsOf(2, 5, 40, () => random());
    const result = computeJumpIndices(attention);
    const jumps = Array.from(result.jumpIndices);
    assert.deepEqual(jumps, naiveJumpIndices(attention), `seed ${seed}`);
    assert.equal(jumps.length, attention.nTokens, `seed ${seed} jump count`);
    assert.equal(jumps[0], 0, `seed ${seed} first jump`);
    for (const [index, jump] of jumps.entries()) {
        assert.ok(
            jump >= 0 && jump < attention.nFrames,
            `seed ${seed} jump ${index} is out of range`,
        );
        if (index > 0) {
            assert.ok(
                jump >= jumps[index - 1],
                `seed ${seed} jumps go backwards`,
            );
        }
    }
    assert.equal(result.matrix.length, attention.nTokens * attention.nFrames);
    assert.equal(result.textIndices.length, result.timeIndices.length);
}

const inconsistent = {
    nHeads: 2,
    nTokens: 3,
    nFrames: 4,
    maxQkLen: 4,
    weights: new Float32Array(5),
};
assert.throws(
    () => computeJumpIndices(inconsistent),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () =>
        computeJumpIndices({
            ...inconsistent,
            nHeads: 0,
            weights: new Float32Array(0),
        }),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () =>
        computeJumpIndices({
            ...inconsistent,
            nTokens: 0,
            weights: new Float32Array(0),
        }),
    (error) => error.code === 'invalid-option',
);

console.log('every jump invariant holds');
