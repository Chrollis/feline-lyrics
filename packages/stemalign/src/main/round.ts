import { StemalignError } from './errors.js';

const HALF_EPSILON = 1e-12;

// Bankers rounding, ported from the reference. Word timings are rounded with
// digits = 3 at the assembly boundaries (inference-func.mjs:351-352 and
// add-word-timestamps-stable.mjs:151-152). The 0.02 s "time precision" is not a
// rounding grid: it only feeds tokensPerSec (round(1 / 0.02) = 50).
export function bankersRound(value: number, digits = 0): number {
    if (!Number.isInteger(digits)) {
        throw new StemalignError(
            'invalid-option',
            `digit count must be an integer, got ${digits}`,
            { actual: String(digits) },
        );
    }
    if (!Number.isFinite(value) || value === 0) {
        return value;
    }
    const factor = Math.pow(10, digits);
    if (!Number.isFinite(factor)) {
        return value;
    }
    const scaled = value * factor;
    if (!Number.isFinite(scaled)) {
        return value;
    }
    const sign = scaled < 0 ? -1 : 1;
    const absolute = Math.abs(scaled);
    const whole = Math.floor(absolute);
    const fraction = absolute - whole;
    let rounded: number;
    if (fraction > 0.5 + HALF_EPSILON) {
        rounded = whole + 1;
    } else if (fraction < 0.5 - HALF_EPSILON) {
        rounded = whole;
    } else {
        rounded = whole % 2 === 0 ? whole : whole + 1;
    }
    return (sign * rounded) / factor;
}
