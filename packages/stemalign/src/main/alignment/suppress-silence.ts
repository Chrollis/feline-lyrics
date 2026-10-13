import { StemalignError } from '../errors.js';
import { bankersRound } from '../round.js';

export interface WordSpan {
    readonly start: number;
    readonly end: number;
}

export interface SilenceSpan {
    readonly start: number;
    readonly end: number;
}

export interface SuppressSilenceOptions {
    readonly minWordDur: number;
    readonly nonspeechError?: number;
    readonly keepEnd?: boolean | null;
}

const TIME_DIGITS = 3;
const DEFAULT_NONSPEECH_ERROR = 0.1;

export function suppressSilence(
    word: WordSpan,
    silences: readonly SilenceSpan[],
    options: SuppressSilenceOptions,
): WordSpan {
    const minWordDur = options.minWordDur;
    if (!Number.isFinite(minWordDur) || minWordDur < 0) {
        throw new StemalignError(
            'invalid-option',
            `the minimum word duration must be a non-negative number, got ${minWordDur}`,
            { expected: 'a non-negative duration', actual: String(minWordDur) },
        );
    }

    const nonspeechError = options.nonspeechError ?? DEFAULT_NONSPEECH_ERROR;
    // `null` is a real mode here: pick whichever edge overshoots less.
    const keepEnd = options.keepEnd === undefined ? true : options.keepEnd;

    if (silences.length === 0) return word;
    if (word.end - word.start <= minWordDur) return word;

    let start = word.start;
    let end = word.end;

    if (keepEnd === null || keepEnd) {
        const overlap = silences.find(
            (silence) =>
                silence.start <= start &&
                start < silence.end &&
                silence.end <= end,
        );
        if (overlap !== undefined) {
            start = bankersRound(
                Math.min(
                    overlap.end,
                    bankersRound(end - minWordDur, TIME_DIGITS),
                ),
                TIME_DIGITS,
            );
            if (end - start <= minWordDur) return { start, end };
        }
    }

    if (!keepEnd) {
        const overlap = silences.find(
            (silence) =>
                start <= silence.start &&
                silence.start < end &&
                end <= silence.end,
        );
        if (overlap !== undefined) {
            end = bankersRound(
                Math.max(
                    overlap.start,
                    bankersRound(start + minWordDur, TIME_DIGITS),
                ),
                TIME_DIGITS,
            );
            if (end - start <= minWordDur) return { start, end };
        }
    }

    if (nonspeechError) {
        const contained = silences.filter(
            (silence) => start <= silence.start && end >= silence.end,
        );
        if (contained.length !== 1) return { start, end };

        const silence = contained[0];
        const duration = silence.end - silence.start;
        const startExtra = (silence.start - start) / duration;
        const endExtra = (end - silence.end) / duration;
        const startWithin = startExtra <= nonspeechError;
        const endWithin = endExtra <= nonspeechError;
        if (!startWithin && !endWithin) return { start, end };

        const keep = keepEnd === null ? startExtra <= endExtra : keepEnd;
        if (keep) {
            start = bankersRound(
                Math.min(
                    silence.end,
                    bankersRound(end - minWordDur, TIME_DIGITS),
                ),
                TIME_DIGITS,
            );
        } else {
            end = bankersRound(
                Math.max(
                    silence.start,
                    bankersRound(start + minWordDur, TIME_DIGITS),
                ),
                TIME_DIGITS,
            );
        }
    }

    return { start, end };
}
