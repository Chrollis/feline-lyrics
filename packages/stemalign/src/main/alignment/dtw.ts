import { StemalignError } from '../errors.js';

export interface DtwPath {
    readonly textIndices: Int32Array;
    readonly timeIndices: Int32Array;
}

export function dtwPath(
    costs: Float32Array,
    rows: number,
    columns: number,
): DtwPath {
    checkDimension(rows, 'row');
    checkDimension(columns, 'column');
    if (costs.length !== rows * columns) {
        throw new StemalignError(
            'invalid-option',
            `the cost matrix has ${costs.length} values but ${rows} by ${columns} needs ${rows * columns}`,
            {
                expected: `${rows * columns} values`,
                actual: `${costs.length} values`,
            },
        );
    }

    const width = columns + 1;
    const total = new Float64Array((rows + 1) * width);
    total.fill(Infinity);
    total[0] = 0;
    const trace = new Int8Array((rows + 1) * width);
    trace.fill(-1);

    for (let column = 1; column <= columns; column += 1) {
        for (let row = 1; row <= rows; row += 1) {
            const source = costs[(row - 1) * columns + (column - 1)];
            if (!Number.isFinite(source)) {
                throw new StemalignError(
                    'invalid-option',
                    `the cost matrix holds a non-finite value at row ${row - 1} column ${column - 1}`,
                    { actual: String(source) },
                );
            }

            const diagonal = total[(row - 1) * width + (column - 1)];
            const above = total[(row - 1) * width + column];
            const before = total[row * width + (column - 1)];

            let best: number;
            let step: number;
            if (diagonal < above && diagonal < before) {
                best = diagonal;
                step = 0;
            } else if (above < diagonal && above < before) {
                best = above;
                step = 1;
            } else {
                best = before;
                step = 2;
            }

            total[row * width + column] = source + best;
            trace[row * width + column] = step;
        }
    }

    return backtrace(trace, rows + 1, columns + 1);
}

function checkDimension(value: number, label: string): void {
    if (!Number.isInteger(value) || value < 1) {
        throw new StemalignError(
            'invalid-option',
            `the ${label} count must be a positive integer, got ${value}`,
            { actual: String(value) },
        );
    }
}

function backtrace(trace: Int8Array, rows: number, columns: number): DtwPath {
    const steps = trace.slice();
    for (let column = 0; column < columns; column += 1) {
        steps[column] = 2;
    }
    for (let row = 0; row < rows; row += 1) {
        steps[row * columns] = 1;
    }

    const text = new Int32Array(rows + columns);
    const time = new Int32Array(rows + columns);
    let length = 0;
    let row = rows - 1;
    let column = columns - 1;

    while (row > 0 || column > 0) {
        text[length] = row - 1;
        time[length] = column - 1;
        length += 1;

        const step = steps[row * columns + column];
        if (step === 0) {
            row -= 1;
            column -= 1;
        } else if (step === 1) {
            row -= 1;
        } else if (step === 2) {
            column -= 1;
        } else {
            throw new StemalignError(
                'model-invalid',
                `the trace holds an unexpected value ${step}`,
                { actual: String(step) },
            );
        }
    }

    const textIndices = new Int32Array(length);
    const timeIndices = new Int32Array(length);
    for (let index = 0; index < length; index += 1) {
        textIndices[index] = text[length - 1 - index];
        timeIndices[index] = time[length - 1 - index];
    }

    return { textIndices, timeIndices };
}
