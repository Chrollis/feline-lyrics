import type { CharCell, CharStream } from './char.js';
import { isLineBreakCell, textToStream } from './char.js';
import { LyricoreError } from '../errors.js';
import type { LyricsLine } from './line.js';
import { isValidLyricsLine, lyricsLineToText } from './line.js';
import type { LyricsMeta } from './meta.js';
import { emptyMeta, isSameMeta, isValidMeta } from './meta.js';

export interface Lyrics {
    readonly meta: LyricsMeta;
    readonly lines: readonly LyricsLine[];
}

function lineFromCells(cells: readonly CharCell[]): LyricsLine {
    const baseStream: CharStream = { cells };
    return { baseStream, groups: {} };
}

export function textToLyrics(
    text: string,
    meta: LyricsMeta = emptyMeta(),
): Lyrics {
    const cells = textToStream(text).cells;
    const lines: LyricsLine[] = [];
    let start = 0;
    for (let index = 0; index < cells.length; index += 1) {
        if (isLineBreakCell(cells[index])) {
            lines.push(lineFromCells(cells.slice(start, index + 1)));
            start = index + 1;
        }
    }
    if (start < cells.length) {
        throw new LyricoreError(
            'invalid-lyrics-line',
            'the text does not end with a line break',
        );
    }
    return { meta, lines };
}

export function lyricsToText(lyrics: Lyrics): string {
    return lyrics.lines.map((line) => lyricsLineToText(line)).join('');
}

function sameMeta(left: LyricsMeta, right: LyricsMeta): boolean {
    return isSameMeta(left, right);
}

// `patch` comes from an editor, so a key holding undefined must fall back to
// the value already there instead of blanking it out.
function isSoundMeta(meta: unknown): meta is LyricsMeta {
    if (typeof meta !== 'object' || meta === null) {
        return false;
    }
    const extra: unknown = (meta as { extra?: unknown }).extra;
    if (typeof extra !== 'object' || extra === null) {
        return false;
    }
    return isValidMeta(meta as LyricsMeta);
}

/** The lyrics with part of the metadata replaced. */
export function withMeta(lyrics: Lyrics, patch: Partial<LyricsMeta>): Lyrics {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
            clean[key] = value;
        }
    }
    const meta = { ...lyrics.meta, ...clean } as unknown;
    if (!isSoundMeta(meta)) {
        throw new LyricoreError(
            'invalid-lyrics-meta',
            'the metadata is invalid',
        );
    }
    if (sameMeta(lyrics.meta, meta)) {
        return lyrics;
    }
    return { ...lyrics, meta };
}

export function isValidLyrics(lyrics: Lyrics): boolean {
    if (!isValidMeta(lyrics.meta)) {
        return false;
    }
    return lyrics.lines.every((line) => isValidLyricsLine(line));
}

export function assertLyrics(lyrics: Lyrics): void {
    if (!isValidMeta(lyrics.meta)) {
        throw new LyricoreError(
            'invalid-lyrics-meta',
            'the metadata is invalid',
        );
    }
    const index = lyrics.lines.findIndex((line) => !isValidLyricsLine(line));
    if (index === -1) {
        return;
    }
    throw new LyricoreError('invalid-lyrics-line', `line ${index} is invalid`, {
        expected: 'a valid lyrics line',
        actual: `line ${index}`,
    });
}
