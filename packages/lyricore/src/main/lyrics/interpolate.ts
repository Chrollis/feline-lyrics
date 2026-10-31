import { LyricoreError } from '../errors.js';
import type { CharCell } from './char.js';
import { textToStream } from './char.js';
import {
    assertLyricsLine,
    overlayOf,
    rebuild,
    spliceGroups,
    spliceLine,
    withCheck,
    type LyricsLine,
} from './line.js';
import { assertOverlay, spliceOverlay } from './overlay.js';
import type { Lyrics } from './lyrics.js';
import type { CheckPoint, SegPiece, SegRun } from './seg-run.js';
import { isTime, isValidSpan, TIME_MAX, type TimeSpan } from './time.js';

/** Length given to the cell that a line's last check starts. */
export const TAIL_MS = 500;

/** One tap, addressed by the piece it belongs to. */
export interface CheckTarget {
    readonly lineIndex: number;
    readonly group: string;
    readonly runIndex: number;
    readonly pieceIndex: number;
}

/**
 * Boundaries of `count` cells covering [from, to]. The remainder goes to the
 * earliest cells, so boundaries stay monotonic and the sum is exact.
 */
function boundaryStarts(from: number, to: number, count: number): number[] {
    const starts: number[] = [];
    const total = to - from;
    if (count <= 0 || total <= 0) {
        for (let index = 0; index <= count; index += 1) {
            starts.push(from);
        }
        return starts;
    }
    const base = Math.floor(total / count);
    const extra = total - base * count;
    let cursor = from;
    for (let index = 0; index < count; index += 1) {
        starts.push(cursor);
        cursor += base + (index < extra ? 1 : 0);
    }
    starts.push(to);
    return starts;
}

/** The same cell when its span is unchanged, so repeating a fill reuses it. */
function withSpan(cell: CharCell, start: number, end: number): CharCell {
    const span: TimeSpan = { start, duration: end - start };
    if (!isValidSpan(span)) {
        throw new LyricoreError(
            'invalid-time',
            'filling a cell produced a span outside the int32 millisecond range',
            {
                expected:
                    'an int32 start and a duration that ends inside int32',
                actual: `start ${start}, duration ${span.duration}`,
            },
        );
    }
    const current = cell.span;
    if (
        current !== null &&
        current.start === span.start &&
        current.duration === span.duration
    ) {
        return cell;
    }
    return { text: cell.text, span };
}

/** A stream whose cells take consecutive boundaries. */
function spanCells(
    cells: readonly CharCell[],
    bounds: readonly number[],
): readonly CharCell[] {
    let changed = false;
    const next = cells.slice();
    for (let index = 0; index < cells.length; index += 1) {
        const filled = withSpan(cells[index], bounds[index], bounds[index + 1]);
        if (filled !== cells[index]) {
            next[index] = filled;
            changed = true;
        }
    }
    return changed ? next : cells;
}

/** A subrange of cells that takes consecutive boundaries. */
function spanRange(
    cells: readonly CharCell[],
    offset: number,
    bounds: readonly number[],
): readonly CharCell[] {
    let changed = false;
    const next = cells.slice();
    for (let index = 0; index < bounds.length - 1; index += 1) {
        const at = offset + index;
        const filled = withSpan(cells[at], bounds[index], bounds[index + 1]);
        if (filled !== cells[at]) {
            next[at] = filled;
            changed = true;
        }
    }
    return changed ? next : cells;
}

interface PieceRef {
    readonly runIndex: number;
    readonly pieceIndex: number;
    readonly piece: SegPiece;
}

function piecesOf(runs: readonly SegRun[]): PieceRef[] {
    const flat: PieceRef[] = [];
    for (const [runIndex, run] of runs.entries()) {
        for (const [pieceIndex, piece] of run.pieces.entries()) {
            flat.push({ runIndex, pieceIndex, piece });
        }
    }
    return flat;
}

function cellCount(pieces: readonly PieceRef[]): number {
    let count = 0;
    for (const ref of pieces) {
        count += ref.piece.text.cells.length;
    }
    return count;
}

/** Every listed piece takes its share of the same boundary sequence. */
function spanPieces(
    runs: readonly SegRun[],
    pieces: readonly PieceRef[],
    bounds: readonly number[],
): readonly SegRun[] {
    const rebuilt = new Map<number, SegPiece[]>();
    let cursor = 0;
    let changed = false;
    for (const ref of pieces) {
        const run = runs[ref.runIndex];
        const text = ref.piece.text;
        const size = text.cells.length;
        const filled = spanCells(
            text.cells,
            bounds.slice(cursor, cursor + size + 1),
        );
        if (filled !== text.cells) {
            const next = rebuilt.get(ref.runIndex) ?? run.pieces.slice();
            next[ref.pieceIndex] = {
                check: ref.piece.check,
                text: { cells: filled },
            };
            rebuilt.set(ref.runIndex, next);
            changed = true;
        }
        cursor += size;
    }
    if (!changed) {
        return runs;
    }
    return runs.map((run, index) => {
        const next = rebuilt.get(index);
        return next === undefined ? run : { ...run, pieces: next };
    });
}

/** One run whose pieces cover [from, to) by character count. */
function spanRun(run: SegRun, from: number, to: number): SegRun {
    const size = cellCount(piecesOf([run]));
    if (size === 0 || to <= from) {
        return run;
    }
    const bounds = boundaryStarts(from, to, size);
    const filled = spanPieces([run], piecesOf([run]), bounds)[0];
    return filled === undefined ? run : filled;
}

function overlaps(run: SegRun, start: number, end: number): boolean {
    return run.offset < end && run.offset + run.length > start;
}

/**
 * End of the cell a line's last check starts: the tail length, cut short by the
 * next line as soon as that line has a time of its own.
 */
function terminalEnd(
    lyrics: Lyrics,
    lineIndex: number,
    start: number,
    tailMs: number,
): number {
    const next = lyrics.lines[lineIndex + 1];
    const first = next === undefined ? undefined : next.baseStream.cells[0];
    const nextStart =
        first === undefined || first.span === null ? null : first.span.start;
    const end =
        nextStart !== null && nextStart >= start ? nextStart : start + tailMs;
    return Math.min(end, TIME_MAX);
}

/**
 * Fill spans from one recorded check: the cell chain (R1) when the check starts
 * a run, the piece chain (R2) always, the line's last cell (R4) for the
 * terminal run, other groups of the line (R6), and the previous line's last
 * cell (R5). A check with no earlier anchor fills nothing.
 */
export function fillFromCheck(
    lyrics: Lyrics,
    target: CheckTarget,
    tailMs = TAIL_MS,
): Lyrics {
    if (!Number.isInteger(tailMs) || tailMs <= 0) {
        throw new LyricoreError(
            'invalid-time',
            'the tail length must be a positive whole number of milliseconds',
            { expected: 'a positive integer', actual: String(tailMs) },
        );
    }
    const line = lyrics.lines[target.lineIndex];
    if (line === undefined) {
        return lyrics;
    }
    const runs = line.groups[target.group];
    if (runs === undefined) {
        return lyrics;
    }
    const run = runs[target.runIndex];
    if (run === undefined) {
        return lyrics;
    }
    const piece = run.pieces[target.pieceIndex];
    if (
        piece === undefined ||
        piece.check === null ||
        piece.check === undefined
    ) {
        return lyrics;
    }
    const check = piece.check;
    assertLyricsLine(line);

    let cells: readonly CharCell[] = line.baseStream.cells;
    let groups: Record<string, readonly SegRun[]> = line.groups;
    let changedStart = -1;
    let changedEnd = -1;

    // R1: the cell chain is anchored by run starts only.
    if (target.pieceIndex === 0) {
        let anchor: SegRun | null = null;
        let anchorTime: number | null = null;
        for (let index = target.runIndex - 1; index >= 0; index -= 1) {
            const first = runs[index].pieces[0];
            const firstCheck = first === undefined ? null : first.check;
            if (firstCheck !== null && firstCheck !== undefined) {
                anchor = runs[index];
                anchorTime = firstCheck.time;
                break;
            }
        }
        if (
            anchor !== null &&
            anchorTime !== null &&
            anchor.offset < run.offset &&
            check.time >= anchorTime
        ) {
            const count = run.offset - anchor.offset;
            cells = spanRange(
                cells,
                anchor.offset,
                boundaryStarts(anchorTime, check.time, count),
            );
            changedStart = anchor.offset;
            changedEnd = run.offset;
        }
    }

    // R4: the terminal run owns the line's last cell until the next line starts.
    const isTerminal =
        target.runIndex === runs.length - 1 &&
        run.length === 1 &&
        run.offset === cells.length - 1;
    if (isTerminal) {
        cells = spanRange(cells, run.offset, [
            check.time,
            terminalEnd(lyrics, target.lineIndex, check.time, tailMs),
        ]);
        changedStart =
            changedStart < 0 ? run.offset : Math.min(changedStart, run.offset);
        changedEnd = Math.max(changedEnd, run.offset + 1);
    }

    // R2: the piece chain is anchored by any check.
    const flat = piecesOf(runs);
    let targetFlat = 0;
    for (let index = 0; index < target.runIndex; index += 1) {
        targetFlat += runs[index].pieces.length;
    }
    targetFlat += target.pieceIndex;
    let anchorFlat = -1;
    let anchorCheck: CheckPoint | null = null;
    for (let index = targetFlat - 1; index >= 0; index -= 1) {
        const candidate = flat[index].piece.check;
        if (candidate !== null && candidate !== undefined) {
            anchorFlat = index;
            anchorCheck = candidate;
            break;
        }
    }
    if (
        anchorFlat >= 0 &&
        anchorCheck !== null &&
        check.time >= anchorCheck.time
    ) {
        const filling = flat.slice(anchorFlat, targetFlat);
        const size = cellCount(filling);
        if (size > 0) {
            const bounds = boundaryStarts(anchorCheck.time, check.time, size);
            const filled = spanPieces(runs, filling, bounds);
            if (filled !== runs) {
                groups = { ...groups, [target.group]: filled };
            }
        }
    }

    // R6: cells that changed push into the other groups of the same line.
    if (changedStart >= 0 && changedEnd > changedStart) {
        const baseCells = cells;
        let pushed: Record<string, readonly SegRun[]> | null = null;
        for (const [name, otherRuns] of Object.entries(groups)) {
            if (name === target.group) {
                continue;
            }
            let touched = false;
            const nextRuns = otherRuns.map((other) => {
                if (
                    !overlaps(other, changedStart, changedEnd) ||
                    other.offset + other.length >= baseCells.length
                ) {
                    return other;
                }
                const left = baseCells[other.offset].span;
                const right = baseCells[other.offset + other.length].span;
                if (left === null || right === null) {
                    return other;
                }
                const filled = spanRun(other, left.start, right.start);
                if (filled !== other) {
                    touched = true;
                }
                return filled;
            });
            if (touched) {
                pushed = { ...(pushed ?? groups), [name]: nextRuns };
            }
        }
        if (pushed !== null) {
            groups = pushed;
        }
    }

    // R5: a line that starts after the previous line rewrites its last cell.
    let previous: LyricsLine | null = null;
    if (changedStart === 0 && target.lineIndex > 0) {
        const first = cells[0].span;
        const before = lyrics.lines[target.lineIndex - 1];
        const lastIndex = before.baseStream.cells.length - 1;
        if (first !== null && lastIndex >= 0) {
            const lastCell = before.baseStream.cells[lastIndex];
            const lastSpan = lastCell.span;
            if (lastSpan !== null && first.start > lastSpan.start) {
                const fixed = before.baseStream.cells.slice();
                fixed[lastIndex] = withSpan(
                    lastCell,
                    lastSpan.start,
                    first.start,
                );
                previous = { ...before, baseStream: { cells: fixed } };
            }
        }
    }

    const sameCells = cells === line.baseStream.cells;
    const sameGroups = groups === line.groups;
    if (sameCells && sameGroups && previous === null) {
        return lyrics;
    }

    const lines = lyrics.lines.slice();
    if (!sameCells || !sameGroups) {
        lines[target.lineIndex] = rebuild(line, {
            baseStream: { cells },
            groups,
        });
    }
    if (previous !== null) {
        lines[target.lineIndex - 1] = previous;
    }
    return { ...lyrics, lines };
}

/** The lyrics with one line replaced, untouched when the index is stale. */
function withLine(
    lyrics: Lyrics,
    lineIndex: number,
    line: LyricsLine,
): Lyrics | null {
    const current = lyrics.lines[lineIndex];
    if (current === undefined || current === line) {
        return null;
    }
    const lines = lyrics.lines.slice();
    lines[lineIndex] = line;
    return { ...lyrics, lines };
}

/** The tail of a line's last cell: a positive, representable time. */
function requireTail(tailMs: number): void {
    if (!isTime(tailMs) || tailMs <= 0) {
        throw new LyricoreError(
            'invalid-time',
            'the tail of a line must be a positive time',
        );
    }
}

/**
 * Records one tap: writes the check and fills from it, in that order and in one
 * step, so the two can never fall out of sync. A slot that does not resolve
 * leaves the lyrics untouched.
 */
export function recordCheck(
    lyrics: Lyrics,
    target: CheckTarget,
    check: CheckPoint,
    tailMs = TAIL_MS,
): Lyrics {
    requireTail(tailMs);
    const line = lyrics.lines[target.lineIndex];
    if (line === undefined) {
        return lyrics;
    }
    const updated = withLine(
        lyrics,
        target.lineIndex,
        withCheck(line, target, check),
    );
    if (updated === null) {
        return lyrics;
    }
    return fillFromCheck(updated, target, tailMs);
}

/**
 * Clears the check of one piece. Times already filled stay where they are: a
 * cleared check means "not recorded", not "this part had no time".
 */
export function clearCheck(lyrics: Lyrics, target: CheckTarget): Lyrics {
    const line = lyrics.lines[target.lineIndex];
    if (line === undefined) {
        return lyrics;
    }
    const updated = withLine(
        lyrics,
        target.lineIndex,
        withCheck(line, target, null),
    );
    return updated === null ? lyrics : updated;
}

/**
 * Replays every recorded check of one group, in the order they sit in the line,
 * onto the spans the line already carries. Nothing is cleared: a check that was
 * removed leaves its stretch as it was, and a check whose anchor is missing or
 * later than itself fills nothing. This is how a text edit rebuilds the group
 * that drives the line; it is not the state a fresh row of taps would reach.
 */
export function refillGroup(
    lyrics: Lyrics,
    lineIndex: number,
    group: string,
    tailMs = TAIL_MS,
): Lyrics {
    requireTail(tailMs);
    const line = lyrics.lines[lineIndex];
    if (line === undefined || !Object.hasOwn(line.groups, group)) {
        return lyrics;
    }
    const runs = line.groups[group];
    if (runs === undefined) {
        return lyrics;
    }
    let next = lyrics;
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const pieces = runs[runIndex].pieces;
        for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
            if (pieces[pieceIndex].check === null) {
                continue;
            }
            next = fillFromCheck(
                next,
                { lineIndex, group, runIndex, pieceIndex },
                tailMs,
            );
        }
    }
    return next;
}

/**
 * Rebuilds the times of every group of every line from the checks it holds.
 *
 * Tapping calls this one group at a time; this is the whole-document version,
 * for checks that were edited outside the tagging calls (a hand-edited file, a
 * changed tail). It only replays what is there: a check that was removed leaves
 * the cells it used to fill alone.
 */
export function refillAll(lyrics: Lyrics, tailMs = TAIL_MS): Lyrics {
    requireTail(tailMs);
    let next = lyrics;
    for (const [lineIndex, line] of lyrics.lines.entries()) {
        for (const group of Object.keys(line.groups)) {
            next = refillGroup(next, lineIndex, group, tailMs);
        }
    }
    return next;
}

/**
 * Replaces a stretch of one line's text and rebuilds the timing of the group
 * that drives it. A run is an annotation over a cell range (a ruby guide over a
 * selection), not a slot per cell, so the pieces keep their text and only the
 * cells they cover change. Cells outside every anchored stretch stay as they
 * were, which is how a freshly inserted character starts with no time.
 */
export function editLineText(
    lyrics: Lyrics,
    lineIndex: number,
    removed: readonly [number, number],
    text: string,
    group: string | null,
    tailMs = TAIL_MS,
): Lyrics {
    const line = lyrics.lines[lineIndex];
    if (line === undefined) {
        return lyrics;
    }
    const [removedStart, removedEnd] = removed;
    const cellCount = line.baseStream.cells.length;
    const whole =
        Number.isInteger(removedStart) &&
        Number.isInteger(removedEnd) &&
        removedStart >= 0 &&
        removedStart <= removedEnd &&
        removedEnd <= cellCount;
    if (!whole) {
        throw new LyricoreError(
            'invalid-edit',
            'the removed range must be a whole stretch of this line',
        );
    }
    requireTail(tailMs);
    if (removedStart === removedEnd && text === '') {
        return lyrics;
    }
    const inserted = textToStream(text).cells;
    const folded = foldClusters(
        spliceLine(line, removed, inserted),
        removedStart,
        removedStart + inserted.length,
    );
    assertLyricsLine(folded);
    const replaced = withLine(lyrics, lineIndex, folded);
    if (replaced === null) {
        return lyrics;
    }
    return group === null
        ? replaced
        : refillGroup(replaced, lineIndex, group, tailMs);
}

// R5 on its own: the line before `lineIndex` ends where `lineIndex` starts.
// It only fires when both cells are timed and the order is right, so a line
// with no timing is left alone.
export function alignPreviousEnd(lyrics: Lyrics, lineIndex: number): Lyrics {
    if (
        !Number.isInteger(lineIndex) ||
        lineIndex <= 0 ||
        lineIndex >= lyrics.lines.length
    ) {
        return lyrics;
    }
    const before = lyrics.lines[lineIndex - 1];
    const start = lyrics.lines[lineIndex].baseStream.cells[0]?.span ?? null;
    const lastIndex = before.baseStream.cells.length - 1;
    if (start === null || lastIndex < 0) {
        return lyrics;
    }
    const lastCell = before.baseStream.cells[lastIndex];
    const lastSpan = lastCell.span;
    if (lastSpan === null || start.start <= lastSpan.start) {
        return lyrics;
    }
    const fixed = before.baseStream.cells.slice();
    fixed[lastIndex] = withSpan(lastCell, lastSpan.start, start.start);
    const lines = lyrics.lines.slice();
    lines[lineIndex - 1] = { ...before, baseStream: { cells: fixed } };
    return { ...lyrics, lines };
}

// A keystroke can land next to a cell it fuses with: a combining mark, a
// surrogate partner, a ZWJ joiner. Re-segment the seams around the edit so the
// cells stay one grapheme cluster each; a merged cell keeps the earlier span.
function foldClusters(
    line: LyricsLine,
    start: number,
    end: number,
): LyricsLine {
    let cells = line.baseStream.cells;
    let groups = line.groups;
    let overlay = overlayOf(line);
    let index = Math.max(0, start - 1);
    const stop = Math.min(cells.length - 1, end + 1);
    while (index < stop) {
        const left = cells[index];
        const right = cells[index + 1];
        if (right === undefined) {
            break;
        }
        const joined = textToStream(left.text + right.text);
        if (joined.cells.length !== 1) {
            index += 1;
            continue;
        }
        const next = cells.slice();
        next[index] = {
            text: joined.cells[0].text,
            span: left.span ?? right.span,
        };
        next.splice(index + 1, 1);
        cells = next;
        groups = spliceGroups(groups, [index + 1, index + 2], 0);
        overlay = spliceOverlay(overlay, [index + 1, index + 2], 0);
    }
    if (cells === line.baseStream.cells) {
        return line;
    }
    assertOverlay(overlay, cells.length - 1);
    return rebuild(line, { baseStream: { cells }, groups, overlay });
}
