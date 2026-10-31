import type { CharCell, CharStream } from './char.js';
import { isLineBreakCell, textToStream } from './char.js';
import { LyricoreError } from '../errors.js';
import type { LyricsLine } from './line.js';
import {
    emptyLyricsLine,
    isValidLyricsLine,
    lyricsLineToText,
    overlayOf,
} from './line.js';
import type { OverlayProblem } from './overlay.js';
import { overlayProblem } from './overlay.js';
import type { LyricsMeta } from './meta.js';
import { emptyMeta, isSameMeta, isValidMeta } from './meta.js';
import type { StyleBook } from './stylebook.js';
import { emptyStyleBook } from './stylebook.js';

/**
 * Where the encapsulation lives for a document, not just for a line.
 *
 * `styleBook` is the named style table the overlay's `styleId`s point into, and
 * `animations` is the layer above both: stored, carried and never interpreted
 * by this package. Neither is part of the frozen lyrics export - they belong to
 * the project document, which is the only thing that knows about them.
 */
export interface Lyrics {
    readonly meta: LyricsMeta;
    readonly lines: readonly LyricsLine[];
    readonly styleBook: StyleBook;
    readonly animations: readonly unknown[];
}

/** The empty animation layer. One frozen value, so `===` works. */
export const NO_ANIMATIONS: readonly unknown[] = Object.freeze([]);

/**
 * A document with no style book and no animations.
 *
 * Every reader that only knows about lyrics goes through here, so the two
 * extra layers have one place to be born and cannot be forgotten at a call
 * site: an imported `.lrc` legitimately has neither.
 */
export function lyricsOf(
    meta: LyricsMeta,
    lines: readonly LyricsLine[],
): Lyrics {
    return {
        meta,
        lines,
        styleBook: emptyStyleBook(),
        animations: NO_ANIMATIONS,
    };
}

function lineFromCells(cells: readonly CharCell[]): LyricsLine {
    const baseStream: CharStream = { cells };
    return emptyLyricsLine(baseStream);
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
    return {
        meta,
        lines,
        styleBook: emptyStyleBook(),
        animations: NO_ANIMATIONS,
    };
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

/**
 * The first inserted object id that appears twice, or null.
 *
 * Uniqueness is a property of the document, not of a line: an animation targets
 * an object by id, so two objects sharing one id make the target ambiguous.
 * This is the one overlay rule that cannot be checked a line at a time, which
 * is why it lives here instead of in `overlayProblem`.
 */
function duplicateInsertedId(
    lyrics: Lyrics,
): { lineIndex: number; id: string } | null {
    const seen = new Set<string>();
    for (let lineIndex = 0; lineIndex < lyrics.lines.length; lineIndex += 1) {
        const inserted: unknown = overlayOf(lyrics.lines[lineIndex]).inserted;
        // A document read from JSON can hold anything here, and this function
        // is the one reader that must never throw: the guard mirrors the one
        // `overlayProblem` already carries.
        if (!Array.isArray(inserted)) {
            continue;
        }
        for (const object of inserted) {
            const id: unknown = (object as { id?: unknown } | null)?.id;
            if (typeof id !== 'string') {
                continue;
            }
            if (seen.has(id)) {
                return { lineIndex, id };
            }
            seen.add(id);
        }
    }
    return null;
}

/**
 * The first line whose overlay is out of the body, or null.
 *
 * `lyricsLineProblem` stays blind to the overlay on purpose (it answers "is this
 * a lyric line", and folding the overlay in would make `isValidLyricsLine`
 * throw on hand-built fixtures). The document validator is the other half: a
 * document reaching `assertLyrics` - the project reader included - must not
 * carry an overlay its line cannot support.
 */
function firstOverlayProblem(
    lyrics: Lyrics,
): { lineIndex: number; problem: OverlayProblem } | null {
    for (let lineIndex = 0; lineIndex < lyrics.lines.length; lineIndex += 1) {
        const line = lyrics.lines[lineIndex];
        const problem = overlayProblem(
            overlayOf(line),
            line.baseStream.cells.length - 1,
        );
        if (problem !== null) {
            return { lineIndex, problem };
        }
    }
    return null;
}

export function isValidLyrics(lyrics: Lyrics): boolean {
    if (!isValidMeta(lyrics.meta)) {
        return false;
    }
    if (!lyrics.lines.every((line) => isValidLyricsLine(line))) {
        return false;
    }
    if (firstOverlayProblem(lyrics) !== null) {
        return false;
    }
    return duplicateInsertedId(lyrics) === null;
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
        const bad = firstOverlayProblem(lyrics);
        if (bad !== null) {
            throw new LyricoreError(
                bad.problem.code,
                `line ${bad.lineIndex}: ${bad.problem.message}`,
                {
                    expected: 'an overlay inside the line body',
                    actual: bad.problem.code,
                },
            );
        }
        const duplicate = duplicateInsertedId(lyrics);
        if (duplicate === null) {
            return;
        }
        throw new LyricoreError(
            'invalid-inserted-object',
            `inserted object id "${duplicate.id}" appears twice, last on line ${duplicate.lineIndex}`,
            {
                expected: 'an inserted object id unique in the document',
                actual: duplicate.id,
            },
        );
    }
    throw new LyricoreError('invalid-lyrics-line', `line ${index} is invalid`, {
        expected: 'a valid lyrics line',
        actual: `line ${index}`,
    });
}
