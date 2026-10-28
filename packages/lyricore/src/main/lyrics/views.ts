import type { TimeSpan } from './time.js';
import type { CheckSlot, LyricsLine } from './line.js';
import type { SegRun } from './seg-run.js';

function runsOf(
    line: LyricsLine,
    group: string,
): readonly SegRun[] | undefined {
    return Object.hasOwn(line.groups, group) ? line.groups[group] : undefined;
}

/**
 * When a piece starts: its own check when it was tapped, otherwise the start of
 * its first character, which the piece chain derived. A piece with neither (an
 * empty reading nobody tapped) has no start.
 */
export function pieceStart(line: LyricsLine, slot: CheckSlot): number | null {
    const runs = runsOf(line, slot.group);
    const run = runs === undefined ? undefined : runs[slot.runIndex];
    const piece = run === undefined ? undefined : run.pieces[slot.pieceIndex];
    if (piece === undefined) {
        return null;
    }
    if (piece.check !== null) {
        return piece.check.time;
    }
    const first = piece.text.cells[0];
    return first === undefined || first.span === null ? null : first.span.start;
}

/** When a run starts: the start of its first piece that has one, else null. */
export function runStart(
    line: LyricsLine,
    group: string,
    runIndex: number,
): number | null {
    const runs = runsOf(line, group);
    const run = runs === undefined ? undefined : runs[runIndex];
    if (run === undefined) {
        return null;
    }
    for (let index = 0; index < run.pieces.length; index += 1) {
        const start = pieceStart(line, {
            group,
            runIndex,
            pieceIndex: index,
        });
        if (start !== null) {
            return start;
        }
    }
    return null;
}

/** The stretch of a line that carries a time: the first timed cell to the last one's end. */
export function lineSpan(line: LyricsLine): TimeSpan | null {
    const cells = line.baseStream.cells;
    const first = cells.find((cell) => cell.span !== null);
    if (first === undefined || first.span === null) {
        return null;
    }
    let end = first.span.start;
    for (const cell of cells) {
        if (cell.span !== null) {
            end = Math.max(end, cell.span.start + cell.span.duration);
        }
    }
    return { start: first.span.start, duration: end - first.span.start };
}
