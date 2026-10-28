import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    isValidCheckPoint,
    isValidSegPiece,
    isValidSegRun,
    joinPieces,
} from '../../src/main/lyrics/seg-run.js';

function tap(time, type = 'KeyDown') {
    return { time, type };
}

function piece(text, check = null) {
    return { check, text: textToStream(text) };
}

function run(offset, length, pieces = []) {
    return { offset, length, pieces };
}

describe('seg run', () => {
    it('does not tie the piece count to the covered cell count', () => {
        // 東京: two cells, four mora pieces.
        assert.equal(
            isValidSegRun(
                run(0, 2, [
                    piece('と'),
                    piece('う'),
                    piece('きょ'),
                    piece('う'),
                ]),
            ),
            true,
        );
        // 思: one cell, two mora pieces.
        assert.equal(
            isValidSegRun(run(0, 1, [piece('お'), piece('も')])),
            true,
        );
        // business: seven cells, one piece.
        assert.equal(isValidSegRun(run(0, 7, [piece('business')])), true);
        assert.equal(isValidSegRun(run(0, 3, [])), true);
        console.log('pieces are syllables, not cells');
    });

    it('lets each piece carry its own check', () => {
        assert.equal(
            isValidSegRun(run(0, 2, [piece('と', tap(1_000)), piece('う')])),
            true,
        );
        assert.equal(
            isValidSegRun(
                run(0, 2, [
                    piece('と', tap(1_000)),
                    piece('う', tap(1_200, 'KeyUp')),
                ]),
            ),
            true,
        );
        console.log('a piece owns at most one check and may own none');
    });

    it('rejects a run or a piece that cannot describe cells', () => {
        assert.equal(isValidSegRun(run(0, 0, [])), false);
        assert.equal(isValidSegRun(run(0, -1, [])), false);
        assert.equal(isValidSegRun(run(0, 1.5, [])), false);
        assert.equal(isValidSegRun(run(-1, 2, [])), false);
        assert.equal(isValidSegRun(run(0, 2, [piece('a\nb')])), false);
        assert.equal(isValidSegPiece(piece('a', tap(1.5))), false);
        assert.equal(
            isValidSegPiece(piece('a', { time: 0, type: 'tap' })),
            false,
        );
        console.log('length, offset, piece text and check are all checked');
    });

    it('validates a check point on its own', () => {
        assert.equal(isValidCheckPoint(tap(0)), true);
        assert.equal(isValidCheckPoint(tap(1.5)), false);
        assert.equal(isValidCheckPoint({ time: 0, type: 'tap' }), false);
        console.log('a check point is a time plus one of two kinds');
    });

    it('joins every piece into the displayed annotation', () => {
        assert.equal(
            joinPieces(run(0, 2, [piece('とう'), piece('きょう')])),
            'とうきょう',
        );
        assert.equal(joinPieces(run(0, 3, [])), '');
        console.log('the displayed annotation is the pieces joined in order');
    });
});
