import { StemalignError } from '../errors.js';

export function medianFilter(
    values: Float32Array,
    width: number,
): Float32Array {
    return medianFilterRows(values, values.length, width);
}

export function medianFilterRows(
    values: Float32Array,
    rowLength: number,
    width: number,
): Float32Array {
    if (values.length === 0) {
        return new Float32Array(0);
    }
    if (!Number.isInteger(rowLength) || rowLength <= 0) {
        throw new StemalignError(
            'invalid-option',
            `row length must be a positive integer, got ${rowLength}`,
            { actual: String(rowLength) },
        );
    }
    if (values.length % rowLength !== 0) {
        throw new StemalignError(
            'invalid-option',
            `${values.length} values do not fill rows of ${rowLength}`,
            {
                expected: `a multiple of ${rowLength}`,
                actual: String(values.length),
            },
        );
    }
    if (!Number.isInteger(width) || width < 1 || width % 2 === 0) {
        throw new StemalignError(
            'invalid-option',
            `median filter width must be a positive odd integer, got ${width}`,
            { actual: String(width) },
        );
    }
    const output = new Float32Array(values.length);
    const half = (width - 1) / 2;
    if (rowLength <= half) {
        output.set(values);
        return output;
    }
    const window = new Float32Array(width);
    for (let rowStart = 0; rowStart < values.length; rowStart += rowLength) {
        for (let index = 0; index < rowLength; index += 1) {
            for (let tap = 0; tap < width; tap += 1) {
                // PyTorch 'reflect': the boundary sample is not repeated.
                const position = index + tap;
                if (position < half) {
                    window[tap] = values[rowStart + half - position];
                } else if (position < half + rowLength) {
                    window[tap] = values[rowStart + position - half];
                } else {
                    window[tap] =
                        values[
                            rowStart + 2 * rowLength - 2 - (position - half)
                        ];
                }
            }
            window.sort();
            output[rowStart + index] = window[half];
        }
    }
    return output;
}
