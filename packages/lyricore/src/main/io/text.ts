import { newLosses, type Loss, type LossCollector } from './loss.js';

/** Encodings a lyric file may arrive in. */
export type LyricEncoding =
    | 'utf-8'
    | 'utf-16le'
    | 'utf-16be'
    | 'shift_jis'
    | 'euc-jp'
    | 'iso-2022-jp'
    | 'gb18030'
    | 'big5';

export interface DecodedText {
    readonly text: string;
    readonly encoding: LyricEncoding;
    readonly losses: readonly Loss[];
}

export interface TextLine {
    /** The line without its break. */
    readonly content: string;
    /** The break that ended it, or '' for the last line of a file. */
    readonly break: '\n' | '\r\n' | '\r' | '\u2028' | '\u2029' | '';
}

const BOMS: readonly (readonly [readonly number[], LyricEncoding])[] = [
    [[0xef, 0xbb, 0xbf], 'utf-8'],
    [[0xff, 0xfe], 'utf-16le'],
    [[0xfe, 0xff], 'utf-16be'],
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    if (bytes.length < prefix.length) {
        return false;
    }
    return prefix.every((value, at) => bytes[at] === value);
}

function decodeStrict(bytes: Uint8Array, encoding: string): string | null {
    try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

function hasEscape(bytes: Uint8Array): boolean {
    return bytes.includes(0x1b);
}

/**
 * How plausible a decode looks as lyric text. Code pages overlap in their byte
 * ranges, so "did not throw" is not enough to choose between them: a Chinese
 * file usually decodes as Shift_JIS too, just into the wrong characters.
 */
function textScore(text: string): number {
    let score = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code === 0x0a || code === 0x0d || code === 0x09) {
            score += 1;
        } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
            score -= 40;
        } else if (code < 0x7f) {
            score += 1;
        } else if (code >= 0x3040 && code <= 0x30ff) {
            score += 3;
        } else if (code >= 0x4e00 && code <= 0x9fff) {
            score += 2;
        } else if (code >= 0xac00 && code <= 0xd7af) {
            score += 2;
        } else if (code >= 0x3000 && code <= 0x303f) {
            score += 1;
        } else if (code >= 0xff01 && code <= 0xff60) {
            score += 1;
        } else if (code >= 0xe000 && code <= 0xf8ff) {
            score -= 6;
        } else if (code === 0xfffd) {
            score -= 40;
        } else if (code > 0xffff) {
            score -= 2;
        }
    }
    return score;
}

/**
 * Bytes that suit one code page better than another. Shift_JIS text spends its
 * lead bytes in `81-9F` and `E0-EF`; GBK and Big5 text spends them in `A1-FE`.
 * Counting that costs one pass and breaks the ties the text score leaves.
 */
function structureScore(bytes: Uint8Array, encoding: LyricEncoding): number {
    let score = 0;
    for (const byte of bytes) {
        if (encoding === 'shift_jis') {
            if (
                (byte >= 0x81 && byte <= 0x9f) ||
                (byte >= 0xe0 && byte <= 0xef)
            ) {
                score += 1;
            }
        } else if (
            encoding === 'gb18030' ||
            encoding === 'big5' ||
            encoding === 'euc-jp'
        ) {
            if (byte >= 0xa1 && byte <= 0xfe) {
                score += 1;
            }
        }
    }
    return score;
}

/** The order to try them in: escape-based first when the bytes say so. */
function decodeOrder(bytes: Uint8Array): readonly LyricEncoding[] {
    const escape = hasEscape(bytes);
    const order: LyricEncoding[] = ['utf-8'];
    if (escape) {
        order.push('iso-2022-jp');
    }
    order.push('shift_jis', 'euc-jp', 'gb18030', 'big5');
    if (!escape) {
        order.push('iso-2022-jp');
    }
    return order;
}

/**
 * Turns raw bytes into text: a BOM wins, then every code page that decodes
 * cleanly is scored for plausibility and the best one is taken. Ties go to the
 * earlier candidate, so ASCII stays UTF-8.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
    const losses = newLosses();
    for (const [prefix, encoding] of BOMS) {
        if (startsWith(bytes, prefix)) {
            const body = bytes.subarray(prefix.length);
            return {
                text: new TextDecoder(encoding).decode(body),
                encoding,
                losses: losses.losses,
            };
        }
    }
    let best: { encoding: LyricEncoding; text: string } | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const encoding of decodeOrder(bytes)) {
        const text = decodeStrict(bytes, encoding);
        if (text === null) {
            continue;
        }
        const score = textScore(text) + structureScore(bytes, encoding);
        if (score > bestScore) {
            best = { encoding, text };
            bestScore = score;
        }
    }
    if (best !== null) {
        return {
            text: best.text,
            encoding: best.encoding,
            losses: losses.losses,
        };
    }
    losses.add(
        'file',
        'source-ignored',
        'no encoding decoded the bytes cleanly; utf-8 with replacements',
    );
    return {
        text: new TextDecoder('utf-8').decode(bytes),
        encoding: 'utf-8',
        losses: losses.losses,
    };
}

/** Splits text into lines, keeping the break that ended each one. */
export function splitLines(text: string): TextLine[] {
    const lines: TextLine[] = [];
    let start = 0;
    for (let at = 0; at < text.length; at += 1) {
        const value = text[at];
        if (value === '\r') {
            const wide = text[at + 1] === '\n';
            lines.push({
                content: text.slice(start, at),
                break: wide ? '\r\n' : '\r',
            });
            at += wide ? 1 : 0;
            start = at + 1;
        } else if (value === '\n') {
            lines.push({ content: text.slice(start, at), break: '\n' });
            start = at + 1;
        } else if (value === '\u2028' || value === '\u2029') {
            // The model treats these as line breaks, so they end lines here too.
            lines.push({ content: text.slice(start, at), break: value });
            start = at + 1;
        }
    }
    if (start < text.length) {
        lines.push({ content: text.slice(start), break: '' });
    }
    return lines;
}

/** The inverse of {@link splitLines}. */
export function joinLines(lines: readonly TextLine[]): string {
    return lines.map((line) => line.content + line.break).join('');
}

/**
 * Every line of a document ends with a break, because the break is one of the
 * line's cells. Text whose last line has none is given one and reported.
 */
export function ensureTrailingBreak(
    text: string,
    at: string,
    losses: LossCollector,
): string {
    const last = text.at(-1);
    if (
        text === '' ||
        last === '\n' ||
        last === '\r' ||
        last === '\u2028' ||
        last === '\u2029'
    ) {
        return text;
    }
    losses.add(
        at,
        'source-ignored',
        'the last line had no line break; one was added',
    );
    return `${text}\n`;
}

/** Encodings we can write. Node decodes every legacy code page but encodes none. */
export type WritableEncoding = 'utf-8' | 'utf-16le';

/**
 * Export is UTF-8 (optionally with a BOM) because Node has no encoder for the
 * legacy code pages; `utf-16le` is offered since it needs no lookup table and
 * always carries its BOM.
 */
export function encodeText(
    text: string,
    encoding: WritableEncoding = 'utf-8',
    bom = false,
): Uint8Array {
    if (encoding === 'utf-16le') {
        const bytes = new Uint8Array(2 + text.length * 2);
        bytes[0] = 0xff;
        bytes[1] = 0xfe;
        for (let at = 0; at < text.length; at += 1) {
            const unit = text.charCodeAt(at);
            bytes[2 + at * 2] = unit & 0xff;
            bytes[3 + at * 2] = unit >> 8;
        }
        return bytes;
    }
    const body = new TextEncoder().encode(text);
    if (!bom) {
        return body;
    }
    const marked = new Uint8Array(body.length + 3);
    marked.set([0xef, 0xbb, 0xbf]);
    marked.set(body, 3);
    return marked;
}
