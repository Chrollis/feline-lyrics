import { StemalignError } from '../errors.js';
import { bankersRound } from '../round.js';
import type { WordTiming } from './timestamps.js';

// Word times are rounded to milliseconds, so durations are too.
const TIME_DIGITS = 3;
const DEFAULT_MEDIUM_FACTOR = 2.5;

export interface ClampOptions {
    readonly mediumFactor?: number | false;
    readonly maxDur?: number | false;
    readonly clipStart?: boolean;
}

// Port of WhisperResult.clamp_max (reference/whisper/src/regroup.mjs:232).
// The reference clamps one segment at a time, so a caller that runs it over a
// whole song should hand it the words of one window.
//
// Without an explicit clipStart the first word is shortened at its start and
// the last word at its end; interior words are left alone even when they are
// longer than the cap. That is the reference behavior, not an oversight.
export function clampWords(
    words: readonly WordTiming[],
    options: ClampOptions = {},
): readonly WordTiming[] {
    const mediumFactor =
        options.mediumFactor === undefined
            ? DEFAULT_MEDIUM_FACTOR
            : options.mediumFactor;
    const maxDur = options.maxDur === undefined ? false : options.maxDur;
    if (!mediumFactor && !maxDur) {
        throw new StemalignError(
            'invalid-option',
            'clamping needs a medium factor or a maximum duration',
            {
                expected: 'a medium factor or a maximum duration',
                actual: 'neither',
            },
        );
    }
    if (words.length === 0) {
        return [];
    }

    let current: number | false = false;
    if (mediumFactor && words.length > 1) {
        const durations = words.map((word) =>
            bankersRound(word.end - word.start, TIME_DIGITS),
        );
        durations.sort((left, right) => left - right);
        current = mediumFactor * durations[Math.floor(durations.length / 2)];
    }
    if (maxDur && (!current || current > maxDur)) {
        current = maxDur;
    }
    if (!current) {
        return words;
    }

    const clamped = words.slice();
    const clipStart = options.clipStart;
    if (clipStart === undefined) {
        clamped[0] = clampWord(clamped[0], current, true);
        clamped[clamped.length - 1] = clampWord(
            clamped[clamped.length - 1],
            current,
            false,
        );
    } else {
        for (let index = 0; index < clamped.length; index += 1) {
            clamped[index] = clampWord(clamped[index], current, clipStart);
        }
    }
    return clamped;
}

function clampWord(
    word: WordTiming,
    maxDur: number,
    clipStart: boolean,
): WordTiming {
    const duration = bankersRound(word.end - word.start, TIME_DIGITS);
    if (duration <= maxDur) {
        return word;
    }
    if (clipStart) {
        return { ...word, start: bankersRound(word.end - maxDur, TIME_DIGITS) };
    }
    return { ...word, end: bankersRound(word.start + maxDur, TIME_DIGITS) };
}
