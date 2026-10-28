import { isSegStream, streamToText, type CharStream } from './char.js';
import { isTime } from './time.js';

export type CheckType = 'KeyDown' | 'KeyUp';

/** A tap recorded while tagging: when a piece starts, and which key it came from. */
export interface CheckPoint {
    readonly time: number;
    readonly type: CheckType;
}

/** One annotation piece: the check that starts it and the text it carries. */
export interface SegPiece {
    readonly check: CheckPoint | null;
    readonly text: CharStream;
}

/** One annotation run over base cells [offset, offset + length); the piece count is unrelated to length. */
export interface SegRun {
    readonly offset: number;
    readonly length: number;
    readonly pieces: readonly SegPiece[];
}

export function isValidCheckPoint(check: CheckPoint): boolean {
    if (!isTime(check.time)) {
        return false;
    }
    return check.type === 'KeyDown' || check.type === 'KeyUp';
}

export function isValidSegPiece(piece: SegPiece): boolean {
    if (!isSegStream(piece.text)) {
        return false;
    }
    return piece.check === null || isValidCheckPoint(piece.check);
}

export function isValidSegRun(run: SegRun): boolean {
    if (!Number.isInteger(run.offset) || run.offset < 0) {
        return false;
    }
    if (!Number.isInteger(run.length) || run.length < 1) {
        return false;
    }
    return run.pieces.every((piece) => isValidSegPiece(piece));
}

/** The annotation of a run as it is displayed: every piece joined in order. */
export function joinPieces(run: SegRun): string {
    return run.pieces.map((piece) => streamToText(piece.text)).join('');
}

/** A fresh terminal run: the break cell of a line, carrying no reading. */
export function terminalRun(offset: number): SegRun {
    return {
        offset,
        length: 1,
        pieces: [{ check: null, text: { cells: [] } }],
    };
}

/** Whether a run is the terminal of a line whose break cell sits at `offset`. */
export function isTerminalRun(run: SegRun, offset: number): boolean {
    if (run.offset !== offset || run.length !== 1) {
        return false;
    }
    if (run.pieces.length !== 1) {
        return false;
    }
    return run.pieces[0].text.cells.length === 0;
}
