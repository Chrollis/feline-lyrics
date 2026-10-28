import { LyricoreError } from '../errors.js';

export const MS_PER_S = 1_000;
export const MS_PER_M = 60_000;
export const MS_PER_H = 3_600_000;
export const MS_PER_D = 86_400_000;

export const TIME_MIN = -2_147_483_648;
export const TIME_MAX = 2_147_483_647;

export type TimeLevel = 1 | 2 | 3 | 4 | 5;
export type TimeUnit = 'ms' | 's' | 'm' | 'h' | 'd';

export interface TimeParts {
    readonly d: number;
    readonly h: number;
    readonly m: number;
    readonly s: number;
    readonly ms: number;
}

export type TimePartsInput = Partial<Record<TimeUnit, number>>;

export interface TimeSpan {
    readonly start: number;
    readonly duration: number;
}

const UNITS_ASC: readonly TimeUnit[] = ['ms', 's', 'm', 'h', 'd'];

const UNIT_MS: Record<TimeUnit, number> = {
    ms: 1,
    s: MS_PER_S,
    m: MS_PER_M,
    h: MS_PER_H,
    d: MS_PER_D,
};

// Only the largest kept unit can be negative; joinTime(splitTime(ms, level)) === ms.
export function splitTime(ms: number, level: TimeLevel): TimeParts {
    checkLevel(level);
    let rest = checkTime(roundMs(ms), 'time');

    const parts = { d: 0, h: 0, m: 0, s: 0, ms: 0 };
    for (let index = level - 1; index >= 0; index -= 1) {
        const unit = UNITS_ASC[index];
        const value = Math.floor(rest / UNIT_MS[unit]);
        rest -= value * UNIT_MS[unit];
        parts[unit] = value;
    }
    return parts;
}

export function joinTime(parts: TimePartsInput): number {
    let total = 0;
    for (const unit of UNITS_ASC) {
        const value = parts[unit];
        if (value === undefined) {
            continue;
        }
        total += value * UNIT_MS[unit];
    }
    return checkTime(roundMs(total), 'joined time');
}

export function isValidSpan(span: TimeSpan): boolean {
    if (span === null || typeof span !== 'object') {
        return false;
    }
    if (
        !isTime(span.start) ||
        !isTime(span.duration) ||
        span.duration < 0 ||
        span.start + span.duration > TIME_MAX
    ) {
        return false;
    }
    return isTime(span.start + span.duration);
}

export function endOf(span: TimeSpan): number {
    if (!isValidSpan(span)) {
        throw new LyricoreError(
            'invalid-time-span',
            `time span must be a valid start plus a non-negative duration, got ${String(span.start)} + ${String(span.duration)}`,
            {
                expected: `a start and a duration in ${TIME_MIN}..${TIME_MAX} milliseconds, duration >= 0`,
                actual: `${String(span.start)} + ${String(span.duration)}`,
            },
        );
    }
    return checkTime(span.start + span.duration, 'time span end');
}

function checkLevel(level: number): void {
    if (!Number.isInteger(level) || level < 1 || level > 5) {
        throw new LyricoreError(
            'invalid-time-level',
            `time level must be 1..5, got ${String(level)}`,
            {
                expected: 'a time level in 1..5',
                actual: String(level),
            },
        );
    }
}

function checkTime(ms: number, label: string): number {
    if (!isTime(ms)) {
        throw new LyricoreError(
            'invalid-time',
            `${label} must be an integer millisecond count in ${TIME_MIN}..${TIME_MAX}, got ${String(ms)}`,
            {
                expected: `an integer in ${TIME_MIN}..${TIME_MAX} milliseconds`,
                actual: String(ms),
            },
        );
    }
    return ms;
}

export function isTime(ms: number): boolean {
    return Number.isInteger(ms) && ms >= TIME_MIN && ms <= TIME_MAX;
}

function roundMs(value: number): number {
    const rounded = Math.round(value);
    return rounded === 0 ? 0 : rounded;
}
