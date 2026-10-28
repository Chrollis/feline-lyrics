import { LyricoreError } from '../errors.js';
import { isValidSpan, type TimeSpan } from './time.js';

/** One wipe unit: the text of a single grapheme cluster and its time span. */
export interface CharCell {
    readonly text: string;
    readonly span: TimeSpan | null;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function isValidCell(cell: CharCell): boolean {
    return cell.span === null || isValidSpan(cell.span);
}

export function isGraphemeCluster(text: string): boolean {
    return [...GRAPHEMES.segment(text)].length === 1;
}

export function assertGraphemeCluster(text: string): void {
    if (!isGraphemeCluster(text)) {
        throw new LyricoreError(
            'invalid-char-cell',
            `char cell text must be one grapheme cluster, got ${JSON.stringify(text)}`,
            {
                expected: 'one grapheme cluster',
                actual: `${[...GRAPHEMES.segment(text)].length} cluster(s)`,
            },
        );
    }
}

export interface CharStream {
    readonly cells: readonly CharCell[];
}

export const LINE_BREAKS: ReadonlySet<string> = new Set([
    '\n',
    '\r\n',
    '\r',
    '\u2028',
    '\u2029',
]);

export function isLineBreakCell(cell: CharCell): boolean {
    return LINE_BREAKS.has(cell.text);
}

export function textToStream(text: string): CharStream {
    const cells = [...GRAPHEMES.segment(text)].map((segment): CharCell => ({
        text: segment.segment,
        span: null,
    }));
    return { cells };
}

export function streamToText(stream: CharStream): string {
    return stream.cells.map((cell) => cell.text).join('');
}

export function isLineStream(stream: CharStream): boolean {
    const cells = stream.cells;
    const last = cells.at(-1);
    if (last === undefined || !isLineBreakCell(last)) {
        return false;
    }
    for (let index = 0; index < cells.length - 1; index += 1) {
        if (isLineBreakCell(cells[index])) {
            return false;
        }
    }
    return true;
}

export function isSegStream(stream: CharStream): boolean {
    return stream.cells.every((cell) => !isLineBreakCell(cell));
}
