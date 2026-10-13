import assert from 'node:assert/strict';
import { dtwPath } from '../../../out/main/alignment/dtw.js';

function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function pathCost(costs, rows, columns, path) {
    let total = 0;
    for (let index = 0; index < path.textIndices.length; index += 1) {
        total +=
            costs[path.textIndices[index] * columns + path.timeIndices[index]];
    }
    return total;
}

function bestCost(costs, rows, columns) {
    let best = Infinity;
    const walk = (row, column, total) => {
        const here = total + costs[row * columns + column];
        if (row === rows - 1 && column === columns - 1) {
            best = Math.min(best, here);
            return;
        }
        if (row + 1 < rows) {
            walk(row + 1, column, here);
        }
        if (column + 1 < columns) {
            walk(row, column + 1, here);
        }
        if (row + 1 < rows && column + 1 < columns) {
            walk(row + 1, column + 1, here);
        }
    };
    walk(0, 0, 0);
    return best;
}

const diagonal = dtwPath(Float32Array.from([0, 5, 5, 0]), 2, 2);
assert.deepEqual(Array.from(diagonal.textIndices), [0, 1]);
assert.deepEqual(Array.from(diagonal.timeIndices), [0, 1]);

const flat = dtwPath(new Float32Array(6), 2, 3);
assert.deepEqual(Array.from(flat.textIndices), [0, 1, 1, 1]);
assert.deepEqual(Array.from(flat.timeIndices), [0, 0, 1, 2]);

const random = makeRandom(20260101);
for (let round = 0; round < 5; round += 1) {
    const rows = 3;
    const columns = 4;
    const costs = new Float32Array(rows * columns);
    for (let index = 0; index < costs.length; index += 1) {
        costs[index] = random() * 4 - 2;
    }
    const path = dtwPath(costs, rows, columns);
    assert.equal(
        pathCost(costs, rows, columns, path),
        bestCost(costs, rows, columns),
    );
    assert.equal(path.textIndices[0], 0);
    assert.equal(path.timeIndices[0], 0);
    assert.equal(path.textIndices[path.textIndices.length - 1], rows - 1);
    assert.equal(path.timeIndices[path.timeIndices.length - 1], columns - 1);
    for (let index = 1; index < path.textIndices.length; index += 1) {
        const textStep = path.textIndices[index] - path.textIndices[index - 1];
        const timeStep = path.timeIndices[index] - path.timeIndices[index - 1];
        assert.ok(textStep >= 0 && timeStep >= 0);
        assert.ok(textStep <= 1 && timeStep <= 1);
        assert.ok(textStep + timeStep >= 1);
    }
}

assert.throws(
    () => dtwPath(new Float32Array(4), 0, 2),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => dtwPath(new Float32Array(4), 2, 1.5),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => dtwPath(new Float32Array(5), 2, 2),
    (error) => error.code === 'invalid-option',
);
const broken = Float32Array.from([0, 1, Number.NaN, 2]);
assert.throws(
    () => dtwPath(broken, 2, 2),
    (error) => error.code === 'invalid-option',
);

console.log('every dtw invariant holds');
