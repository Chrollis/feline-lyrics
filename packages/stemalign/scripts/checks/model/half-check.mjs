import assert from 'node:assert/strict';
import { halfToFloat32 } from '../../../out/main/model/half.js';

const cases = [
    [0x0000, 0],
    [0x8000, -0],
    [0x3c00, 1],
    [0xbc00, -1],
    [0x3800, 0.5],
    [0x4248, 3.140625],
    [0x0001, 2 ** -24],
    [0x8001, -(2 ** -24)],
    [0x03ff, 1023 * 2 ** -24],
    [0x0400, 2 ** -14],
    [0x0401, (1 + 1 / 1024) * 2 ** -14],
    [0x7bff, 65504],
    [0x7c00, Number.POSITIVE_INFINITY],
    [0xfc00, Number.NEGATIVE_INFINITY],
];

const input = Uint16Array.from(cases, ([bits]) => bits);
const output = halfToFloat32(input);
for (const [index, [bits, expected]] of cases.entries()) {
    const actual = output[index];
    assert.ok(
        Object.is(actual, expected),
        `0x${bits.toString(16).padStart(4, '0')} must convert to ${expected}, got ${actual}`,
    );
}

const specials = halfToFloat32(Uint16Array.from([0x7e00, 0xfe00, 0x7c01]));
assert.ok(Number.isNaN(specials[0]), '0x7e00 must convert to NaN');
assert.ok(Number.isNaN(specials[1]), '0xfe00 must convert to NaN');
assert.ok(Number.isNaN(specials[2]), '0x7c01 must convert to NaN');
console.log('half to float32 matches every hand-checked bit pattern');
