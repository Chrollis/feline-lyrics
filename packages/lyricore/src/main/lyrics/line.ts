import { LyricoreError } from '../errors.js';
import {
    isLineStream,
    isValidCell,
    streamToText,
    textToStream,
    type CharCell,
    type CharStream,
} from './char.js';
import {
    isTerminalRun,
    isValidCheckPoint,
    isValidSegPiece,
    isValidSegRun,
    type CheckPoint,
    type SegPiece,
    type SegRun,
} from './seg-run.js';
import {
    NO_OVERLAY,
    assertOverlay,
    spliceOverlay,
    spliceSpan,
    type LineOverlay,
} from './overlay.js';

export interface LyricsLine {
    readonly baseStream: CharStream;
    readonly groups: Record<string, readonly SegRun[]>;
    // The overlay travels with the line but is not part of the lyric: no rule
    // in this file reads it, and the frozen export does not write it.
    readonly overlay: LineOverlay;
}

/** One piece of one run of one group: where a check is recorded. */
export interface CheckSlot {
    readonly group: string;
    readonly runIndex: number;
    readonly pieceIndex: number;
}

/** A line with no groups and no overlay: the shape every constructor starts from. */
export function emptyLyricsLine(baseStream: CharStream): LyricsLine {
    return { baseStream, groups: {}, overlay: NO_OVERLAY };
}

export function textToLyricsLine(text: string): LyricsLine {
    return emptyLyricsLine(textToStream(text));
}

/**
 * The overlay of a line, for callers OUTSIDE the model.
 *
 * Inside the model the field is read directly: it is required, so no tolerance
 * belongs on the normal path, and a fixture that forgot it must fail loudly
 * rather than be repaired here. This helper exists for a boundary that owns
 * lines it did not build - the project reader, an app holding older JSON - so
 * the repair, when there is one, is performed at the door that knows why.
 */
export function overlayOf(line: LyricsLine): LineOverlay {
    return line.overlay ?? NO_OVERLAY;
}

/** The parts of a line a rebuild may replace; an absent part is kept as it is. */
export interface LinePatch {
    readonly baseStream?: CharStream;
    readonly groups?: Record<string, readonly SegRun[]>;
    readonly overlay?: LineOverlay;
}

/**
 * The one place a line is rebuilt from another line.
 *
 * Every mutation of a line goes through here so that a field added later is
 * added once, not once per call site. `null` is not a value a patch can carry:
 * clearing the overlay is `{ overlay: NO_OVERLAY }`.
 */
export function rebuild(line: LyricsLine, patch: LinePatch): LyricsLine {
    return {
        baseStream: patch.baseStream ?? line.baseStream,
        groups: patch.groups ?? line.groups,
        // `overlayOf`, not the raw field: a line built by hand (an untyped
        // fixture, a caller passing `{ baseStream, groups }`) would otherwise
        // come out with `overlay: undefined` and fail somewhere far away.
        overlay: patch.overlay ?? overlayOf(line),
    };
}

export function lyricsLineToText(line: LyricsLine): string {
    return streamToText(line.baseStream);
}

function groupProblem(
    name: string,
    runs: readonly SegRun[],
    cellCount: number,
): string | null {
    let previousEnd = 0;
    for (const [index, run] of runs.entries()) {
        if (!isValidSegRun(run)) {
            return `group '${name}' run ${index} is not a valid seg run`;
        }
        if (run.offset < previousEnd) {
            return `group '${name}' runs must be ordered and not overlap`;
        }
        if (run.offset + run.length > cellCount) {
            return `group '${name}' run ${index} exceeds the base stream`;
        }
        previousEnd = run.offset + run.length;
    }
    return terminalProblem(name, runs, cellCount);
}

function terminalProblem(
    name: string,
    runs: readonly SegRun[],
    cellCount: number,
): string | null {
    const last = runs[runs.length - 1];
    if (last === undefined) {
        return `group '${name}' has no runs`;
    }
    if (!isTerminalRun(last, cellCount - 1)) {
        return `group '${name}' does not end with a terminal run`;
    }
    return null;
}

function streamProblem(stream: CharStream): string | null {
    for (const cell of stream.cells) {
        if (!isValidCell(cell)) {
            return `cell ${JSON.stringify(cell.text)} does not hold a valid span`;
        }
    }
    const text = streamToText(stream);
    const regrouped = textToStream(text);
    if (regrouped.cells.length !== stream.cells.length) {
        return `the cells of ${JSON.stringify(text)} are not the clusters of that text`;
    }
    for (let index = 0; index < stream.cells.length; index += 1) {
        if (regrouped.cells[index].text !== stream.cells[index].text) {
            return `cell ${index} of ${JSON.stringify(text)} is not one grapheme cluster`;
        }
    }
    return null;
}

function lyricsLineProblem(line: LyricsLine): string | null {
    if (!isLineStream(line.baseStream)) {
        return 'base stream is not a line stream';
    }
    const baseProblem = streamProblem(line.baseStream);
    if (baseProblem !== null) {
        return baseProblem;
    }
    const cellCount = line.baseStream.cells.length;
    for (const [name, runs] of Object.entries(line.groups)) {
        const problem = groupProblem(name, runs, cellCount);
        if (problem !== null) {
            return problem;
        }
        for (const run of runs) {
            for (const piece of run.pieces) {
                const pieceProblem = streamProblem(piece.text);
                if (pieceProblem !== null) {
                    return `${name} run ${runs.indexOf(run)}: ${pieceProblem}`;
                }
            }
        }
    }
    return null;
}

export function isValidLyricsLine(line: LyricsLine): boolean {
    return lyricsLineProblem(line) === null;
}

export function assertLyricsLine(line: LyricsLine): void {
    const problem = lyricsLineProblem(line);
    if (problem !== null) {
        throw new LyricoreError('invalid-lyrics-line', problem);
    }
}

// Every group of a line ends with the run that owns the break cell: keeping
// that shape is what lets R4 time a line end without guessing. The same rule
// is part of `isValidLyricsLine` through `groupProblem`.
export function assertTerminalRuns(line: LyricsLine): void {
    const count = line.baseStream.cells.length;
    for (const [name, runs] of Object.entries(line.groups)) {
        const problem = terminalProblem(name, runs, count);
        if (problem !== null) {
            throw new LyricoreError('invalid-lyrics-line', problem);
        }
    }
}

export function runAt(
    line: LyricsLine,
    name: string,
    index: number,
): SegRun | null {
    const runs: readonly SegRun[] | undefined = Object.hasOwn(line.groups, name)
        ? line.groups[name]
        : undefined;
    if (runs === undefined || !Number.isInteger(index) || index < 0) {
        return null;
    }
    return (
        runs.find(
            (run) => index >= run.offset && index < run.offset + run.length,
        ) ?? null
    );
}

// A group name is data, so it may collide with an Object.prototype member:
// assign it as an own property instead of through the prototype chain.
export function putGroup(
    target: Record<string, readonly SegRun[]>,
    name: string,
    runs: readonly SegRun[],
): void {
    Object.defineProperty(target, name, {
        value: runs,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

// A run keeps every piece across an edit: it survives on whichever side of the
// edit point still has cells, and a group left without runs is dropped.
export function spliceGroups(
    groups: Record<string, readonly SegRun[]>,
    removed: readonly [number, number],
    inserted: number,
): Record<string, readonly SegRun[]> {
    const spliced: Record<string, readonly SegRun[]> = {};
    for (const [name, runs] of Object.entries(groups)) {
        const next: SegRun[] = [];
        for (const run of runs) {
            // A run claims no cell on a boundary: the inserted cells belong to
            // no existing piece, which is why the affinity here is 'none'.
            const kept = spliceSpan(run, removed, inserted, 'none');
            if (kept !== null) {
                next.push(kept);
            }
        }
        if (next.length > 0) {
            putGroup(spliced, name, next);
        }
    }
    return spliced;
}

export function spliceLine(
    line: LyricsLine,
    removed: readonly [number, number],
    insertedCells: readonly CharCell[],
): LyricsLine {
    const [removedStart, removedEnd] = removed;
    const count = line.baseStream.cells.length;
    // The overlay tables are defined on the body only (`0 .. cells.length - 1`),
    // so an edit may not swallow the break cell: the result would not be a line
    // stream, and the overlay would be asserted against a body of -1. Callers
    // that need to drop a break build the cell list themselves.
    if (
        !Number.isInteger(removedStart) ||
        !Number.isInteger(removedEnd) ||
        removedStart < 0 ||
        removedEnd < removedStart ||
        removedEnd > count - 1
    ) {
        throw new LyricoreError(
            'invalid-edit',
            `cannot replace cells [${removedStart}, ${removedEnd}) of a line with ${count - 1} body cells`,
        );
    }
    const cells = [
        ...line.baseStream.cells.slice(0, removedStart),
        ...insertedCells,
        ...line.baseStream.cells.slice(removedEnd),
    ];
    const overlay = spliceOverlay(
        overlayOf(line),
        removed,
        insertedCells.length,
    );
    assertOverlay(overlay, cells.length - 1);
    return rebuild(line, {
        baseStream: { cells },
        groups: spliceGroups(line.groups, removed, insertedCells.length),
        overlay,
    });
}

/**
 * The line with one piece's check replaced. A slot that does not resolve leaves
 * the line untouched, so a stale target cannot record a tap on a piece the
 * caller did not mean. Cell spans are never touched.
 */
function sameCheck(a: CheckPoint | null, b: CheckPoint | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.time === b.time && a.type === b.type;
}

export function withCheck(
    line: LyricsLine,
    slot: CheckSlot,
    check: CheckPoint | null,
): LyricsLine {
    if (check !== null && !isValidCheckPoint(check)) {
        throw new LyricoreError('invalid-check', 'not a check point', {
            expected: 'a whole millisecond and a known type',
        });
    }
    const runs = Object.hasOwn(line.groups, slot.group)
        ? line.groups[slot.group]
        : undefined;
    const run = runs === undefined ? undefined : runs[slot.runIndex];
    const piece = run === undefined ? undefined : run.pieces[slot.pieceIndex];
    if (runs === undefined || run === undefined || piece === undefined) {
        return line;
    }
    if (sameCheck(piece.check, check)) {
        return line;
    }
    const stored: CheckPoint | null =
        check === null ? null : { time: check.time, type: check.type };
    const pieces = run.pieces.slice();
    pieces[slot.pieceIndex] = { check: stored, text: piece.text };
    const nextRuns = runs.slice();
    nextRuns[slot.runIndex] = { ...run, pieces };
    return rebuild(line, {
        groups: { ...line.groups, [slot.group]: nextRuns },
    });
}

function runsOf(
    line: LyricsLine,
    group: string,
): readonly SegRun[] | undefined {
    return Object.hasOwn(line.groups, group) ? line.groups[group] : undefined;
}

// A group that loses its last run is dropped, the way an edit drops it, so a
// line never carries an empty group that no operation could put back.
function withRuns(
    line: LyricsLine,
    group: string,
    runs: readonly SegRun[],
): LyricsLine {
    const groups: Record<string, readonly SegRun[]> = { ...line.groups };
    if (runs.length === 0) {
        delete groups[group];
    } else {
        putGroup(groups, group, runs);
    }
    return rebuild(line, { groups });
}

function assertAnnotationLine(line: LyricsLine): LyricsLine {
    assertLyricsLine(line);
    assertTerminalRuns(line);
    return line;
}

/**
 * The line with one piece replaced, appended (`pieceIndex === piece count`) or
 * removed (`piece === null`). A slot that does not resolve leaves the line
 * untouched; a result that breaks the line invariants is rejected.
 */
export function withPiece(
    line: LyricsLine,
    slot: CheckSlot,
    piece: SegPiece | null,
): LyricsLine {
    if (piece !== null && !isValidSegPiece(piece)) {
        throw new LyricoreError(
            'invalid-seg-piece',
            'not an annotation piece',
            {
                expected: 'a piece whose text holds no line break',
            },
        );
    }
    const runs = runsOf(line, slot.group);
    const run = runs === undefined ? undefined : runs[slot.runIndex];
    if (runs === undefined || run === undefined) {
        return line;
    }
    const count = run.pieces.length;
    if (
        !Number.isInteger(slot.pieceIndex) ||
        slot.pieceIndex < 0 ||
        slot.pieceIndex > count
    ) {
        return line;
    }
    if (piece === null && slot.pieceIndex === count) {
        return line;
    }
    const pieces = run.pieces.slice();
    if (piece === null) {
        pieces.splice(slot.pieceIndex, 1);
    } else {
        pieces[slot.pieceIndex] = piece;
    }
    const nextRuns = runs.slice();
    nextRuns[slot.runIndex] = { ...run, pieces };
    return assertAnnotationLine(withRuns(line, slot.group, nextRuns));
}

/** The line with one piece's text replaced; the check the piece carries is kept. */
export function withPieceText(
    line: LyricsLine,
    slot: CheckSlot,
    text: string,
): LyricsLine {
    const runs = runsOf(line, slot.group);
    const run = runs === undefined ? undefined : runs[slot.runIndex];
    const piece = run === undefined ? undefined : run.pieces[slot.pieceIndex];
    if (piece === undefined) {
        return line;
    }
    if (streamToText(piece.text) === text) {
        return line;
    }
    return withPiece(line, slot, {
        check: piece.check,
        text: textToStream(text),
    });
}

/**
 * The line with one run replaced, appended (`runIndex === run count`) or
 * removed (`run === null`). Runs must stay sorted and disjoint, so an
 * overlapping run is rejected rather than silently reordered.
 */
export function withRun(
    line: LyricsLine,
    group: string,
    runIndex: number,
    run: SegRun | null,
): LyricsLine {
    if (run !== null && !isValidSegRun(run)) {
        throw new LyricoreError('invalid-seg-run', 'not an annotation run', {
            expected: 'a run over at least one cell whose pieces are valid',
        });
    }
    const runs = runsOf(line, group);
    if (
        runs === undefined ||
        !Number.isInteger(runIndex) ||
        runIndex < 0 ||
        runIndex > runs.length
    ) {
        return line;
    }
    if (run === null && runIndex === runs.length) {
        return line;
    }
    const nextRuns = runs.slice();
    if (run === null) {
        nextRuns.splice(runIndex, 1);
    } else {
        nextRuns[runIndex] = run;
    }
    return assertAnnotationLine(withRuns(line, group, nextRuns));
}

/** The line with one annotation group added, replaced or removed (`runs === null`). */
export function withGroup(
    line: LyricsLine,
    name: string,
    runs: readonly SegRun[] | null,
): LyricsLine {
    if (runs === null) {
        if (!Object.hasOwn(line.groups, name)) {
            return line;
        }
        const groups: Record<string, readonly SegRun[]> = { ...line.groups };
        delete groups[name];
        return rebuild(line, { groups });
    }
    if (!runs.every((run) => isValidSegRun(run))) {
        throw new LyricoreError('invalid-seg-run', 'not an annotation run', {
            expected: 'a run over at least one cell whose pieces are valid',
        });
    }
    return assertAnnotationLine(withRuns(line, name, runs));
}

/**
 * The line with its overlay replaced.
 *
 * The only way in, so a style run or an inserted object that does not fit the
 * line cannot be written: the overlay is checked against the body here and
 * nowhere else on the edit path. The two layers are compared by identity, so a
 * call that changes nothing returns the line itself.
 */
export function withOverlay(
    line: LyricsLine,
    overlay: LineOverlay,
): LyricsLine {
    assertOverlay(overlay, line.baseStream.cells.length - 1);
    // The tolerance read, not the raw field: a line built by hand has no
    // `overlay` key, and the fast path must not throw on it.
    const current = overlayOf(line);
    if (
        current.styles === overlay.styles &&
        current.inserted === overlay.inserted
    ) {
        return line;
    }
    return rebuild(line, { overlay });
}
