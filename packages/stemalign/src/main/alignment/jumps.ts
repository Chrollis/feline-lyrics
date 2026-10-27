import { StemalignError } from '../errors.js';
import { dtwPath } from './dtw.js';
import type { AttenWeights } from './attention.js';

export interface JumpIndices {
    readonly jumpIndices: Int32Array;
    readonly textIndices: Int32Array;
    readonly timeIndices: Int32Array;
    readonly matrix: Float32Array;
}

export function computeJumpIndices(attention: AttenWeights): JumpIndices {
    const { nHeads, nTokens, nFrames } = attention;
    const plane = attention.weights;
    if (!Number.isInteger(nHeads) || nHeads < 1) {
        throw new StemalignError(
            'invalid-option',
            `the head count must be a positive integer, got ${nHeads}`,
            { actual: String(nHeads) },
        );
    }
    const needed = nHeads * nTokens * nFrames;
    if (plane.length !== needed) {
        throw new StemalignError(
            'invalid-option',
            `the weight plane holds ${plane.length} values but ${nHeads} heads by ${nTokens} tokens by ${nFrames} frames needs ${needed}`,
            { expected: String(needed), actual: String(plane.length) },
        );
    }

    const matrix = new Float32Array(nTokens * nFrames);
    for (let head = 0; head < nHeads; head += 1) {
        const base = head * nTokens * nFrames;
        for (let index = 0; index < matrix.length; index += 1) {
            matrix[index] += plane[base + index];
        }
    }
    const inverseHeads = 1 / nHeads;
    const costs = new Float32Array(matrix.length);
    for (let index = 0; index < matrix.length; index += 1) {
        matrix[index] *= inverseHeads;
        costs[index] = -matrix[index];
    }

    const { textIndices, timeIndices } = dtwPath(costs, nTokens, nFrames);

    const jumps: number[] = [];
    let previousText = -1;
    for (let step = 0; step < textIndices.length; step += 1) {
        const text = textIndices[step];
        if (step === 0 || text !== previousText) {
            const time = timeIndices[step];
            jumps.push(time < 0 ? 0 : time);
        }
        previousText = text;
    }

    return {
        jumpIndices: Int32Array.from(jumps),
        textIndices,
        timeIndices,
        matrix,
    };
}
