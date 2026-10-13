import { StemalignError } from '../errors.js';
import type { WhisperTokenizer } from './tokenizer.js';

export const DEFAULT_PREPEND_PUNCTUATIONS = `"'“¿([{-「`;
export const DEFAULT_APPEND_PUNCTUATIONS = `"'.。,，!！?？:：”)]}、」`;

export interface WordSplit {
    readonly words: readonly string[];
    readonly tokens: readonly (readonly number[])[];
}

export interface WordSplitOptions {
    readonly splitBySpace?: boolean;
    readonly prependPunctuations?: string;
    readonly appendPunctuations?: string;
}

interface MutableWord {
    word: string;
    tokens: number[];
}

const STRIP_PATTERN =
    /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$/g;

export function stripWord(word: string): string {
    return word.replace(STRIP_PATTERN, '');
}

function mergePunctuations(
    entries: MutableWord[],
    prepend: string,
    append: string,
): void {
    if (entries.length < 2) {
        return;
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const punctuation = entries[index];
        if (
            index !== entries.length - 1 &&
            punctuation.word.startsWith(' ') &&
            prepend.indexOf(stripWord(punctuation.word)) >= 0
        ) {
            entries.splice(index, 1);
            const following = entries[index];
            following.word = punctuation.word + following.word;
            following.tokens = punctuation.tokens.concat(following.tokens);
        }

        const entry = entries[index];
        if (
            index !== 0 &&
            !entry.word.endsWith(' ') &&
            append.indexOf(entry.word) >= 0
        ) {
            entries.splice(index, 1);
            const previous = entries[index - 1];
            previous.word = previous.word + entry.word;
            previous.tokens = previous.tokens.concat(entry.tokens);
        }
    }
}

export function splitWords(
    tokenizer: WhisperTokenizer,
    tokenIds: readonly number[],
    options: WordSplitOptions = {},
): WordSplit {
    const splitBySpace = options.splitBySpace ?? true;
    const prepend = options.prependPunctuations ?? DEFAULT_PREPEND_PUNCTUATIONS;
    const append = options.appendPunctuations ?? DEFAULT_APPEND_PUNCTUATIONS;

    if (typeof splitBySpace !== 'boolean') {
        throw new StemalignError(
            'invalid-option',
            `splitBySpace must be a boolean, got ${typeof splitBySpace}`,
        );
    }
    if (typeof prepend !== 'string' || typeof append !== 'string') {
        throw new StemalignError(
            'invalid-option',
            'the punctuation options must be strings',
        );
    }

    const entries: MutableWord[] = [];
    let remaining = tokenizer.decode(tokenIds);
    let pending: number[] = [];

    for (const tokenId of tokenIds) {
        pending.push(tokenId);
        const piece = tokenizer.decode(pending);
        if (remaining.slice(0, piece.length) !== piece) {
            continue;
        }

        const isAppend = splitBySpace && !piece.startsWith(' ');
        const last = entries[entries.length - 1];
        if (isAppend && last !== undefined) {
            last.word += piece;
            last.tokens = last.tokens.concat(pending);
        } else {
            entries.push({ word: piece, tokens: pending.slice() });
        }

        remaining = remaining.slice(piece.length);
        pending = [];
    }

    if (pending.length > 0) {
        entries.push({ word: remaining, tokens: pending.slice() });
    } else if (remaining.length !== 0) {
        const last = entries[entries.length - 1];
        if (last !== undefined) {
            last.word += remaining;
        }
    }

    mergePunctuations(entries, prepend, append);

    return {
        words: entries.map((entry) => entry.word),
        tokens: entries.map((entry) => entry.tokens),
    };
}
