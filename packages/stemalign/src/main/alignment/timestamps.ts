import { StemalignError } from '../errors.js';
import { bankersRound } from '../round.js';
import type { JumpIndices } from './jumps.js';
import type { WhisperSettings } from './settings.js';
import { WHISPER_ENCODER_DOWNSAMPLE } from './whisper.js';
import type { WordSplit } from './words.js';

export interface WordTiming {
    readonly word: string;
    readonly tokens: readonly number[];
    readonly start: number;
    readonly end: number;
    readonly probability: number;
}

export interface TimingOptions {
    readonly probabilities?: ArrayLike<number>;
}

// Word times leave this layer the way the reference reports them:
// jump frame / token rate, rounded to milliseconds (inference-func.mjs:351).
const TIME_DIGITS = 3;

export function wordTimings(
    split: WordSplit,
    jumps: JumpIndices,
    settings: WhisperSettings,
    options: TimingOptions = {},
): readonly WordTiming[] {
    if (split.words.length !== split.tokens.length) {
        throw new StemalignError(
            'invalid-option',
            `the word split has ${split.words.length} words but ${split.tokens.length} token groups`,
            {
                expected: 'one token group per word',
                actual: `${split.words.length} words, ${split.tokens.length} groups`,
            },
        );
    }

    const tokensPerSecond =
        settings.sampleRate / (settings.hopLength * WHISPER_ENCODER_DOWNSAMPLE);
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
        throw new StemalignError(
            'invalid-option',
            `the token rate must be a positive number, got ${tokensPerSecond}`,
            {
                expected: 'a positive token rate',
                actual: String(tokensPerSecond),
            },
        );
    }

    const boundaries: number[] = [0];
    let total = 0;
    for (const group of split.tokens) {
        total += group.length;
        boundaries.push(total);
    }

    const jumpCount = jumps.jumpIndices.length;
    if (total >= jumpCount) {
        throw new StemalignError(
            'invalid-option',
            `the word split ends at token ${total} but the jump list has ${jumpCount} entries`,
            {
                expected: `fewer than ${jumpCount} tokens`,
                actual: String(total),
            },
        );
    }

    const probabilities = options.probabilities;
    const timings: WordTiming[] = [];

    for (let index = 0; index < split.words.length; index += 1) {
        const first = boundaries[index];
        const last = boundaries[index + 1];
        timings.push({
            word: split.words[index],
            tokens: split.tokens[index],
            start: bankersRound(
                jumps.jumpIndices[first] / tokensPerSecond,
                TIME_DIGITS,
            ),
            end: bankersRound(
                jumps.jumpIndices[last] / tokensPerSecond,
                TIME_DIGITS,
            ),
            probability: averageProbability(probabilities, first, last),
        });
    }

    return timings;
}

function averageProbability(
    probabilities: ArrayLike<number> | undefined,
    first: number,
    last: number,
): number {
    if (probabilities === undefined) {
        return 0;
    }
    if (first >= probabilities.length) {
        throw new StemalignError(
            'invalid-option',
            `the probability list has ${probabilities.length} entries but a word starts at token ${first}`,
            {
                expected: `more than ${first} entries`,
                actual: String(probabilities.length),
            },
        );
    }
    const stop = Math.min(last, probabilities.length);
    let sum = 0;
    for (let index = first; index < stop; index += 1) {
        sum += probabilities[index];
    }
    const count = stop - first;
    return count > 0 ? sum / count : 0;
}
