import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    fillFromCheck,
    recordCheck,
    refillAll,
} from '../../src/main/lyrics/interpolate.js';
import { textToLyricsLine } from '../../src/main/lyrics/line.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';
import { TIME_MAX } from '../../src/main/lyrics/time.js';

function tap(time) {
    return { time, type: 'KeyDown' };
}

/** `明\n` with a terminal ruby run: the smallest document that can be tagged. */
function line(text) {
    const base = textToLyricsLine(text);
    const count = base.baseStream.cells.length;
    return {
        ...base,
        groups: {
            ruby: [
                {
                    offset: count - 1,
                    length: 1,
                    pieces: [{ check: null, text: { cells: [] } }],
                },
            ],
        },
    };
}

function doc(lines) {
    return { meta: emptyMeta(), lines };
}

const TERMINAL = { group: 'ruby', runIndex: 0, pieceIndex: 0 };

describe('the tagging contract', () => {
    it('does not mutate the document it is given', () => {
        const before = doc([line('明\n')]);
        const snapshot = JSON.stringify(before);
        const after = recordCheck(
            before,
            { ...TERMINAL, lineIndex: 0 },
            tap(1_000),
        );
        assert.equal(JSON.stringify(before), snapshot);
        assert.notEqual(after, before);
    });

    it('returns the same document when a fill changes nothing', () => {
        const tagged = recordCheck(
            doc([line('明\n')]),
            { ...TERMINAL, lineIndex: 0 },
            tap(1_000),
        );
        assert.equal(
            fillFromCheck(tagged, { ...TERMINAL, lineIndex: 0 }, 500),
            tagged,
        );
        assert.equal(refillAll(tagged, 500), tagged);
    });

    it('clamps the terminal tail to the end of the time range', () => {
        const early = recordCheck(
            doc([line('明\n')]),
            { ...TERMINAL, lineIndex: 0 },
            tap(TIME_MAX - 100),
        );
        assert.deepEqual(early.lines[0].baseStream.cells[1].span, {
            start: TIME_MAX - 100,
            duration: 100,
        });

        const late = recordCheck(
            doc([line('明\n')]),
            { ...TERMINAL, lineIndex: 0 },
            tap(TIME_MAX),
        );
        assert.deepEqual(late.lines[0].baseStream.cells[1].span, {
            start: TIME_MAX,
            duration: 0,
        });
    });

    it('refills every line, not just the first', () => {
        const two = recordCheck(
            doc([line('明\n'), line('日\n')]),
            { ...TERMINAL, lineIndex: 1 },
            tap(2_000),
        );
        const filled = refillAll(two, 500);
        assert.deepEqual(filled.lines[1].baseStream.cells[1].span, {
            start: 2_000,
            duration: 500,
        });
    });
});
