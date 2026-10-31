import { LyricoreError } from '../errors.js';
import { streamToText, textToStream, type CharCell } from './char.js';
import { alignPreviousEnd } from './interpolate.js';
import {
    assertLyricsLine,
    assertTerminalRuns,
    emptyLyricsLine,
    lookupRuns,
    overlayContextOf,
    overlayOf,
    putGroup,
    rebuild,
    type LyricsLine,
} from './line.js';
import {
    assertOverlay,
    joinOverlay,
    splitOverlay,
    type RunCut,
} from './overlay.js';
import type { Lyrics } from './lyrics.js';
import {
    isTerminalRun,
    terminalRun,
    type SegPiece,
    type SegRun,
} from './seg-run.js';

function emptyPiece(): SegPiece {
    return { check: null, text: { cells: [] } };
}

/**
 * The runs a line owns under `name`, never a value inherited from the
 * prototype chain: group names are data, and one spelled `constructor` is
 * legal in a document.
 */
function ownGroup(
    groups: Readonly<Record<string, readonly SegRun[]>>,
    name: string,
): readonly SegRun[] {
    return Object.hasOwn(groups, name) ? (groups[name] ?? []) : [];
}

function requireCellIndex(value: number, high: number): void {
    if (!Number.isInteger(value) || value < 0 || value > high) {
        throw new LyricoreError(
            'invalid-cell-index',
            `${value} is not a cut inside a line of ${high + 1} cells`,
        );
    }
}

function requireLineIndex(value: number, high: number): void {
    if (!Number.isInteger(value) || value < 0 || value > high) {
        throw new LyricoreError(
            'invalid-line-index',
            `${value} is not a line index in [0, ${high}]`,
        );
    }
}

// Pieces are cut by character density, not by count: a run of 8 cells may hold
// one piece, so a count cut would leave one half without a reading.
function cutPieces(
    pieces: readonly SegPiece[],
    leftCells: number,
    totalCells: number,
): readonly [readonly SegPiece[], readonly SegPiece[]] {
    let chars = 0;
    for (const piece of pieces) {
        chars += piece.text.cells.length;
    }
    const cut = Math.round((chars * leftCells) / totalCells);
    const left: SegPiece[] = [];
    const right: SegPiece[] = [];
    let used = 0;
    let split = false;
    for (const piece of pieces) {
        if (split) {
            right.push(piece);
            continue;
        }
        const width = piece.text.cells.length;
        if (used + width <= cut) {
            left.push(piece);
            used += width;
            continue;
        }
        const room = cut - used;
        if (room > 0) {
            left.push({
                check: piece.check,
                text: { cells: piece.text.cells.slice(0, room) },
            });
            right.push({
                check: null,
                text: { cells: piece.text.cells.slice(room) },
            });
        } else {
            right.push(piece);
        }
        split = true;
        used = cut;
    }
    if (left.length === 0) {
        left.push(emptyPiece());
    }
    if (right.length === 0) {
        right.push(emptyPiece());
    }
    return [left, right];
}

function splitGroups(
    groups: Record<string, readonly SegRun[]>,
    at: number,
): readonly [
    Record<string, readonly SegRun[]>,
    Record<string, readonly SegRun[]>,
    readonly RunCut[],
] {
    const head: Record<string, readonly SegRun[]> = {};
    const tail: Record<string, readonly SegRun[]> = {};
    const cuts: RunCut[] = [];
    for (const [name, runs] of Object.entries(groups)) {
        const left: SegRun[] = [];
        const right: SegRun[] = [];
        for (const run of runs) {
            const start = run.offset;
            const end = run.offset + run.length;
            if (end <= at) {
                left.push(run);
                continue;
            }
            if (start >= at) {
                right.push({ ...run, offset: start - at });
                continue;
            }
            const [leftPieces, rightPieces] = cutPieces(
                run.pieces,
                at - start,
                run.length,
            );
            left.push({
                offset: start,
                length: at - start,
                pieces: leftPieces,
            });
            right.push({ offset: 0, length: end - at, pieces: rightPieces });
            // The character counts describe the two halves AS BUILT, so the
            // annotation split can never disagree with `cutPieces`.
            const textLength = textCells(leftPieces);
            cuts.push({
                group: name,
                runOffset: start,
                textLength,
                chars: textLength + textCells(rightPieces),
            });
        }
        left.push(terminalRun(at));
        putGroup(head, name, left);
        putGroup(tail, name, right);
    }
    return [head, tail, cuts];
}

function textCells(pieces: readonly SegPiece[]): number {
    let total = 0;
    for (const piece of pieces) {
        total += piece.text.cells.length;
    }
    return total;
}

/**
 * Cut one line in two before the cell at `at`.
 *
 * The left half gets a new, untimed break cell; the right half keeps the
 * original break cell, and with it the recorded line end.
 */
export function splitLine(
    line: LyricsLine,
    at: number,
): readonly [LyricsLine, LyricsLine] {
    assertLyricsLine(line);
    assertTerminalRuns(line);
    const cells = line.baseStream.cells;
    requireCellIndex(at, cells.length - 1);
    const breakCell = cells[cells.length - 1];
    const leftCells: CharCell[] = cells.slice(0, at);
    leftCells.push({ text: breakCell.text, span: null });
    const [leftGroups, rightGroups, cuts] = splitGroups(line.groups, at);
    const [leftOverlay, rightOverlay] = splitOverlay(overlayOf(line), at, cuts);
    assertOverlay(leftOverlay, {
        body: leftCells.length - 1,
        runsOf: lookupRuns(leftGroups),
    });
    assertOverlay(rightOverlay, {
        body: cells.length - at - 1,
        runsOf: lookupRuns(rightGroups),
    });
    const left: LyricsLine = rebuild(line, {
        baseStream: { cells: leftCells },
        groups: leftGroups,
        overlay: leftOverlay,
    });
    const right: LyricsLine = rebuild(line, {
        baseStream: { cells: cells.slice(at) },
        groups: rightGroups,
        overlay: rightOverlay,
    });
    assertLyricsLine(left);
    assertTerminalRuns(left);
    assertLyricsLine(right);
    assertTerminalRuns(right);
    return [left, right];
}

function requireJoinableSeam(head: LyricsLine, tail: LyricsLine): void {
    const cells = head.baseStream.cells;
    const next = tail.baseStream.cells;
    if (cells.length < 2 || next.length === 0) {
        return;
    }
    const joined = textToStream(
        streamToText({ cells: [cells[cells.length - 2]] }) + next[0].text,
    );
    if (joined.cells.length !== 2) {
        throw new LyricoreError(
            'invalid-char-cell',
            'the last cell and the first cell of the next line form one cluster',
        );
    }
}

/**
 * Join two lines into one.
 *
 * The break cell of `first` disappears; the break cell of `second` becomes the
 * break of the result, so the recorded line end stays where the text ends.
 */
export function mergeLines(first: LyricsLine, second: LyricsLine): LyricsLine {
    assertLyricsLine(first);
    assertTerminalRuns(first);
    assertLyricsLine(second);
    assertTerminalRuns(second);
    requireJoinableSeam(first, second);
    const junction = first.baseStream.cells.length - 1;
    // Built by slicing, not by splicing the break cell out: `spliceLine` refuses
    // to remove a break (its overlay tables only cover the body), and the value
    // here is the same either way.
    const cells = [
        ...first.baseStream.cells.slice(0, junction),
        ...second.baseStream.cells,
    ];
    const total = cells.length;
    const groups: Record<string, SegRun[]> = {};
    for (const name of new Set([
        ...Object.keys(first.groups),
        ...Object.keys(second.groups),
    ])) {
        const runs: SegRun[] = [];
        for (const run of ownGroup(first.groups, name)) {
            if (!isTerminalRun(run, junction)) {
                runs.push(run);
            }
        }
        for (const run of ownGroup(second.groups, name)) {
            runs.push({ ...run, offset: run.offset + junction });
        }
        const last = runs[runs.length - 1];
        if (last === undefined || last.offset + last.length !== total) {
            runs.push(terminalRun(total - 1));
        }
        putGroup(groups, name, runs);
    }
    // No seam splice is needed: `junction` is the break cell, and a sound
    // overlay never reaches it (`offset + length <= cells.length - 1`), so
    // splicing `[junction, junction + 1]` out of `first` is the identity. An
    // unsound overlay is not repaired here either - the assert below is what
    // refuses it, which is the outcome we want.
    // Two lines that each hold an object with the same id would produce a
    // document `assertLyrics` refuses later, pointing at a line index that no
    // longer means anything. Refuse it at the join instead.
    const headIds = new Set(
        overlayOf(first).inserted.map((object) => object.id),
    );
    for (const object of overlayOf(second).inserted) {
        if (headIds.has(object.id)) {
            throw new LyricoreError(
                'invalid-inserted-object',
                `inserted object id "${object.id}" is on both lines being joined`,
                {
                    expected: 'an inserted object id unique in the document',
                    actual: object.id,
                },
            );
        }
    }
    const overlay = joinOverlay(overlayOf(first), overlayOf(second), junction);
    assertOverlay(overlay, {
        body: cells.length - 1,
        runsOf: lookupRuns(groups),
    });
    const merged: LyricsLine = rebuild(emptyLyricsLine({ cells }), {
        groups,
        overlay,
    });
    assertLyricsLine(merged);
    assertTerminalRuns(merged);
    return merged;
}

// Nothing outside the neighbourhood changed, so only those lines are rechecked:
// a whole document assert would cost a pass over every line on every insert.
function assertAround(lyrics: Lyrics, index: number): void {
    const low = Math.max(0, index - 1);
    const high = Math.min(lyrics.lines.length - 1, index + 1);
    for (let at = low; at <= high; at += 1) {
        assertLyricsLine(lyrics.lines[at]);
        assertTerminalRuns(lyrics.lines[at]);
    }
}

/** Insert a line that already satisfies the line invariants. */
export function insertLine(
    lyrics: Lyrics,
    index: number,
    line: LyricsLine,
): Lyrics {
    requireLineIndex(index, lyrics.lines.length);
    assertLyricsLine(line);
    assertTerminalRuns(line);
    // A caller may hand over a line it built itself, so the carrier is
    // normalised here rather than trusted: the document must not gain a line
    // that `overlayOf` has to invent an overlay for.
    const overlay = overlayOf(line);
    assertOverlay(overlay, overlayContextOf(line));
    const carried = rebuild(emptyLyricsLine(line.baseStream), {
        groups: line.groups,
        overlay,
    });
    const lines = lyrics.lines.slice();
    lines.splice(index, 0, carried);
    const inserted = { ...lyrics, lines };
    const result = alignPreviousEnd(
        alignPreviousEnd(inserted, index),
        index + 1,
    );
    assertAround(result, index);
    return result;
}

export function removeLine(lyrics: Lyrics, index: number): Lyrics {
    requireLineIndex(index, lyrics.lines.length - 1);
    const lines = lyrics.lines.filter((_, at) => at !== index);
    const removed = { ...lyrics, lines };
    const result = alignPreviousEnd(removed, index);
    assertAround(result, index);
    return result;
}
