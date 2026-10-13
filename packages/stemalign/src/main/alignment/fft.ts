import { StemalignError } from '../errors.js';

export interface RadixFftPlan {
    readonly kind: 'radix2';
    readonly size: number;
    readonly bins: number;
    readonly cosine: Float64Array;
    readonly sine: Float64Array;
    readonly reversed: Uint32Array;
    readonly scratchReal: Float64Array;
    readonly scratchImag: Float64Array;
}

export interface BluesteinFftPlan {
    readonly kind: 'bluestein';
    readonly size: number;
    readonly bins: number;
    readonly inner: RadixFftPlan;
    readonly chirpReal: Float64Array;
    readonly chirpImag: Float64Array;
    readonly kernelReal: Float64Array;
    readonly kernelImag: Float64Array;
}

export type FftPlan = RadixFftPlan | BluesteinFftPlan;

const MAX_SIZE = 1 << 20;

function nextPowerOfTwo(value: number): number {
    let size = 1;
    while (size < value) {
        size *= 2;
    }
    return size;
}

function reverseBits(value: number, bits: number): number {
    let result = 0;
    for (let index = 0; index < bits; index++) {
        result = (result << 1) | ((value >>> index) & 1);
    }
    return result;
}

function checkSize(size: number): void {
    if (!Number.isInteger(size) || size < 2 || size > MAX_SIZE) {
        throw new StemalignError(
            'invalid-option',
            `fft size must be an integer between 2 and ${MAX_SIZE}, got ${size}`,
            {
                expected: `integer in [2, ${MAX_SIZE}]`,
                actual: String(size),
            },
        );
    }
}

function buildRadixPlan(size: number): RadixFftPlan {
    const half = Math.floor(size / 2);
    const cosine = new Float64Array(half);
    const sine = new Float64Array(half);
    for (let index = 0; index < half; index++) {
        const angle = (2 * Math.PI * index) / size;
        cosine[index] = Math.cos(angle);
        sine[index] = Math.sin(angle);
    }
    const bits = Math.round(Math.log2(size));
    const reversed = new Uint32Array(size);
    for (let index = 0; index < size; index++) {
        reversed[index] = reverseBits(index, bits);
    }
    return {
        kind: 'radix2',
        size,
        bins: half + 1,
        cosine,
        sine,
        reversed,
        scratchReal: new Float64Array(size),
        scratchImag: new Float64Array(size),
    };
}

function buildBluesteinPlan(size: number): BluesteinFftPlan {
    const inner = buildRadixPlan(nextPowerOfTwo(2 * size - 1));
    const chirpReal = new Float64Array(size);
    const chirpImag = new Float64Array(size);
    for (let index = 0; index < size; index++) {
        const angle = (Math.PI * ((index * index) % (2 * size))) / size;
        chirpReal[index] = Math.cos(angle);
        chirpImag[index] = -Math.sin(angle);
    }
    const kernelReal = new Float64Array(inner.size);
    const kernelImag = new Float64Array(inner.size);
    kernelReal[0] = 1;
    for (let index = 1; index < size; index++) {
        const angle = (Math.PI * ((index * index) % (2 * size))) / size;
        const real = Math.cos(angle);
        const imag = Math.sin(angle);
        kernelReal[index] = real;
        kernelImag[index] = imag;
        kernelReal[inner.size - index] = real;
        kernelImag[inner.size - index] = imag;
    }
    transformRadix(inner, kernelReal, kernelImag, false);
    return {
        kind: 'bluestein',
        size,
        bins: Math.floor(size / 2) + 1,
        inner,
        chirpReal,
        chirpImag,
        kernelReal,
        kernelImag,
    };
}

function transformRadix(
    plan: RadixFftPlan,
    real: Float64Array,
    imag: Float64Array,
    inverse: boolean,
): void {
    const size = plan.size;
    const reversed = plan.reversed;
    for (let index = 0; index < size; index++) {
        const target = reversed[index];
        if (target > index) {
            const swapReal = real[index];
            const swapImag = imag[index];
            real[index] = real[target];
            imag[index] = imag[target];
            real[target] = swapReal;
            imag[target] = swapImag;
        }
    }
    const sign = inverse ? 1 : -1;
    for (let length = 2; length <= size; length *= 2) {
        const halfLength = length / 2;
        const step = size / length;
        for (let start = 0; start < size; start += length) {
            for (let offset = 0; offset < halfLength; offset++) {
                const tableIndex = offset * step;
                const twiddleReal = plan.cosine[tableIndex];
                const twiddleImag = sign * plan.sine[tableIndex];
                const evenIndex = start + offset;
                const oddIndex = evenIndex + halfLength;
                const oddReal = real[oddIndex];
                const oddImag = imag[oddIndex];
                const productReal =
                    twiddleReal * oddReal - twiddleImag * oddImag;
                const productImag =
                    twiddleReal * oddImag + twiddleImag * oddReal;
                real[oddIndex] = real[evenIndex] - productReal;
                imag[oddIndex] = imag[evenIndex] - productImag;
                real[evenIndex] += productReal;
                imag[evenIndex] += productImag;
            }
        }
    }
    if (inverse) {
        const scale = 1 / size;
        for (let index = 0; index < size; index++) {
            real[index] *= scale;
            imag[index] *= scale;
        }
    }
}

function checkBuffers(
    plan: FftPlan,
    input: Float32Array,
    outReal: Float32Array,
    outImag: Float32Array,
): void {
    if (input.length < plan.size) {
        throw new StemalignError(
            'invalid-option',
            `fft input must hold ${plan.size} samples, got ${input.length}`,
            {
                expected: String(plan.size),
                actual: String(input.length),
            },
        );
    }
    if (outReal.length < plan.bins || outImag.length < plan.bins) {
        throw new StemalignError(
            'invalid-option',
            `fft output must hold ${plan.bins} bins, got ${outReal.length} and ${outImag.length}`,
            {
                expected: String(plan.bins),
                actual: `${outReal.length}, ${outImag.length}`,
            },
        );
    }
}

export function createFftPlan(size: number): FftPlan {
    checkSize(size);
    if ((size & (size - 1)) === 0) {
        return buildRadixPlan(size);
    }
    return buildBluesteinPlan(size);
}

export function realFft(
    plan: FftPlan,
    input: Float32Array,
    outReal: Float32Array,
    outImag: Float32Array,
): void {
    checkBuffers(plan, input, outReal, outImag);
    if (plan.kind === 'radix2') {
        const real = plan.scratchReal;
        const imag = plan.scratchImag;
        for (let index = 0; index < plan.size; index++) {
            real[index] = input[index];
            imag[index] = 0;
        }
        transformRadix(plan, real, imag, false);
        for (let bin = 0; bin < plan.bins; bin++) {
            outReal[bin] = real[bin];
            outImag[bin] = imag[bin];
        }
        return;
    }
    const inner = plan.inner;
    const workReal = inner.scratchReal;
    const workImag = inner.scratchImag;
    workReal.fill(0);
    workImag.fill(0);
    for (let index = 0; index < plan.size; index++) {
        const sample = input[index];
        workReal[index] = sample * plan.chirpReal[index];
        workImag[index] = sample * plan.chirpImag[index];
    }
    transformRadix(inner, workReal, workImag, false);
    for (let index = 0; index < inner.size; index++) {
        const real = workReal[index];
        const imag = workImag[index];
        workReal[index] =
            real * plan.kernelReal[index] - imag * plan.kernelImag[index];
        workImag[index] =
            real * plan.kernelImag[index] + imag * plan.kernelReal[index];
    }
    transformRadix(inner, workReal, workImag, true);
    for (let bin = 0; bin < plan.bins; bin++) {
        const real = workReal[bin];
        const imag = workImag[bin];
        outReal[bin] = plan.chirpReal[bin] * real - plan.chirpImag[bin] * imag;
        outImag[bin] = plan.chirpReal[bin] * imag + plan.chirpImag[bin] * real;
    }
}
