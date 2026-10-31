import { LINE_BREAKS } from '../lyrics/char.js';
import { newLosses, type Loss } from './loss.js';

/** One run of text and the time tag in front of it, if there was one. */
export interface TagChunk {
    /** When this chunk starts, or null when it continues the previous one. */
    readonly time: number | null;
    readonly text: string;
    /** How many checks the tag asked for (`[n|...]` / `[n]`), or 0 for none. */
    readonly checks: number;
}

export interface ScannedLine {
    readonly chunks: readonly TagChunk[];
    /** The time of a trailing tag with no text after it, if there was one. */
    readonly end: number | null;
    readonly losses: readonly Loss[];
}

const TIME_TAG = /^(\d+):(\d{1,2})(?:[.,:](\d{1,3}))?$/;
const COUNT_TAG = /^\d{1,3}$/;
/** The inside of an Enhanced LRC word tag, `<mm:ss.cc>`. */
const WORD_TAG = /^\d{1,3}:\d{2}(?:[.,:]\d{1,3})?$/;

/**
 * A tag's fraction width decides its unit: one digit is tenths, two are
 * hundredths (`[mm:ss:cc]`), three are milliseconds. Guessing the width from
 * the string instead (pad or truncate) is how a 1-digit tag becomes 10x wrong.
 */
export function parseTag(value: string): number | null {
    const match = TIME_TAG.exec(value);
    if (match === null) {
        return null;
    }
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    if (seconds >= 60) {
        return null;
    }
    const fraction = match[3] ?? '';
    const scaled =
        fraction === '' ? 0 : Number(fraction) * 10 ** (3 - fraction.length);
    const ms = minutes * 60_000 + seconds * 1_000 + scaled;
    if (!Number.isInteger(ms) || ms < 0 || ms > 2_147_483_647) {
        return null;
    }
    return ms;
}

/**
 * Reads what sits between the brackets. `[mm:ss:cc]` and `[n|mm:ss:cc]` open a
 * timed chunk; `[n]` opens an untimed one that only says how many checks the
 * next column has. Anything else is not a tag.
 */
export function parseTagContent(
    inside: string,
): { time: number | null; checks: number } | null {
    const bar = inside.indexOf('|');
    if (bar > 0) {
        const head = inside.slice(0, bar);
        const time = parseTag(inside.slice(bar + 1));
        if (!COUNT_TAG.test(head) || time === null) {
            return null;
        }
        return { time, checks: Number(head) };
    }
    const time = parseTag(inside);
    if (time !== null) {
        return { time, checks: 0 };
    }
    if (COUNT_TAG.test(inside)) {
        return { time: null, checks: Number(inside) };
    }
    return null;
}

/** `[mm:ss:cc]`, the form every reader in this family accepts. */
/** Writes `[mm:ss:cc]`. A start before zero is written as zero: the grammar has no sign. */
export function formatTag(ms: number): string {
    const at = Math.max(0, ms);
    const minutes = Math.floor(at / 60_000);
    const seconds = Math.floor((at % 60_000) / 1_000);
    const centis = Math.floor((at % 1_000) / 10);
    const pad = (value: number, width: number): string =>
        String(value).padStart(width, '0');
    return `[${pad(minutes, 2)}:${pad(seconds, 2)}:${pad(centis, 2)}]`;
}

/** `$XXXX`: a hex code point, which is how these files escape a bracket. */
function readEscape(
    content: string,
    index: number,
): { text: string; next: number } | null {
    // The spec spells the escape with four digits. Reading a greedy run of up
    // to six turned `$0028and` into U+028A at the cost of the following letter.
    const body = content.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(body)) {
        return null;
    }
    const code = Number.parseInt(body, 16);
    const text = String.fromCodePoint(code);
    if (LINE_BREAKS.has(text) || text === '\u001a') {
        // A break would split the line, and 0x1A is this format's placeholder:
        // neither can live inside a text cell.
        return null;
    }
    return { text, next: index + 5 };
}

/**
 * Splits one line of a time-tagged file into chunks. A tag opens a chunk; text
 * runs until the next tag. A tag at the end with nothing after it is the line
 * end. Brackets that are not tags stay literal text.
 */
export function scanTags(content: string, at: string): ScannedLine {
    const losses = newLosses();
    const chunks: TagChunk[] = [];
    let time: number | null = null;
    let checks = 0;
    let text = '';
    let index = 0;
    let notedWordTiming = false;

    const flush = (): void => {
        if (time !== null || checks !== 0 || text !== '') {
            chunks.push({ time, text, checks });
        }
        time = null;
        checks = 0;
        text = '';
    };

    while (index < content.length) {
        const value = content[index]!;
        if (value === '[') {
            const close = content.indexOf(']', index);
            if (close !== -1) {
                const inside = content.slice(index + 1, close);
                const tag = parseTagContent(inside);
                if (tag !== null) {
                    flush();
                    time = tag.time;
                    checks = tag.checks;
                    index = close + 1;
                    continue;
                }
                if (/^\d/.test(inside) || inside.includes('|')) {
                    losses.add(
                        at,
                        'tag-unrecognized',
                        `kept "${inside}" as text: not a tag`,
                    );
                }
            }
        }
        if (value === '<') {
            const close = content.indexOf('>', index + 1);
            if (close !== -1 && close - index <= 12) {
                const inside = content.slice(index + 1, close);
                if (!notedWordTiming && WORD_TAG.test(inside)) {
                    // Enhanced LRC puts a word's start in angle brackets. The
                    // model times cells, not words, so the spelling stays as
                    // text; report the unsupported construct once per line.
                    notedWordTiming = true;
                    losses.add(
                        at,
                        'unsupported-construct',
                        `kept "<${inside}>" as text: per-word A2 timing has no cell model`,
                    );
                }
            }
        }
        if (value === '$') {
            const escaped = readEscape(content, index);
            if (escaped !== null) {
                text += escaped.text;
                index = escaped.next;
                continue;
            }
        }
        if (value === '\u001a') {
            losses.add(
                at,
                'unsupported-construct',
                'a 0x1A placeholder column was dropped: the model has no placeholder cell',
            );
            index += 1;
            continue;
        }
        text += value;
        index += 1;
    }

    if ((time !== null || checks !== 0) && text === '') {
        if (checks !== 0) {
            losses.add(
                at,
                'tag-unrecognized',
                `dropped a trailing check count (${checks}) that has no text to belong to`,
            );
        }
        return { chunks, end: time, losses: losses.losses };
    }
    flush();
    return { chunks, end: null, losses: losses.losses };
}
