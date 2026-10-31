import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    clearCheck,
    editLineText,
    recordCheck,
    refillAll,
    refillGroup,
} from '../../src/main/lyrics/interpolate.js';
import { runAt, withCheck } from '../../src/main/lyrics/line.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';

function tap(time, type = 'KeyDown') {
    return { time, type };
}

function piece(text, check = null) {
    return { check, text: textToStream(text) };
}

function run(offset, length, pieces = []) {
    return { offset, length, pieces };
}

function line(text, groups = {}) {
    const baseStream = textToStream(text);
    const last = baseStream.cells.length - 1;
    const complete = {};
    for (const [name, runs] of Object.entries(groups)) {
        const tail = runs[runs.length - 1];
        complete[name] =
            tail !== undefined && tail.offset === last && tail.length === 1
                ? runs
                : [...runs, { offset: last, length: 1, pieces: [piece('')] }];
    }
    return {
        baseStream,
        groups: complete,
        overlay: { styles: [], inserted: [] },
    };
}

function spans(lines) {
    return lines.map((entry) =>
        entry.baseStream.cells.map((cell) =>
            cell.span === null ? null : [cell.span.start, cell.span.duration],
        ),
    );
}

function checkOf(lines, lineIndex, group, runIndex, pieceIndex) {
    return lines[lineIndex].groups[group][runIndex].pieces[pieceIndex].check;
}

/** "あいう\n" with a ruby run over あい, one over う, and the terminal run. */
function three() {
    return line('あいう\n', {
        ruby: [
            run(0, 2, [piece('とう')]),
            run(2, 1, [piece('う')]),
            run(3, 1, [piece('')]),
        ],
    });
}

const AT_RUN0 = { lineIndex: 0, group: 'ruby', runIndex: 0, pieceIndex: 0 };
const AT_RUN1 = { lineIndex: 0, group: 'ruby', runIndex: 1, pieceIndex: 0 };
const AT_END = { lineIndex: 0, group: 'ruby', runIndex: 2, pieceIndex: 0 };

describe('tagging operations', () => {
    it('writes a check on the piece that was addressed', () => {
        const before = three();
        const after = withCheck(
            before,
            { group: 'ruby', runIndex: 1, pieceIndex: 0 },
            tap(2_000),
        );
        assert.deepEqual(checkOf([after], 0, 'ruby', 1, 0), tap(2_000));
        assert.equal(checkOf([after], 0, 'ruby', 0, 0), null);
        assert.equal(after.baseStream.cells[0].span, null);
    });

    it('leaves the line alone when the slot does not resolve', () => {
        const before = three();
        const same = withCheck(
            before,
            { group: 'ruby', runIndex: 9, pieceIndex: 0 },
            tap(1_000),
        );
        assert.equal(same, before);
        assert.equal(
            withCheck(
                before,
                { group: 'nope', runIndex: 0, pieceIndex: 0 },
                tap(1),
            ),
            before,
        );
    });

    it('records a tap and fills what it closes in one step', () => {
        let lyrics = { lines: [three()] };
        lyrics = recordCheck(lyrics, AT_RUN0, tap(1_000));
        assert.deepEqual(spans(lyrics.lines)[0], [null, null, null, null]);

        lyrics = recordCheck(lyrics, AT_RUN1, tap(2_000));
        assert.deepEqual(spans(lyrics.lines)[0], [
            [1_000, 500],
            [1_500, 500],
            null,
            null,
        ]);

        lyrics = recordCheck(lyrics, AT_END, tap(3_000));
        assert.deepEqual(spans(lyrics.lines)[0], [
            [1_000, 500],
            [1_500, 500],
            [2_000, 1_000],
            [3_000, 500],
        ]);
        assert.deepEqual(checkOf(lyrics.lines, 0, 'ruby', 2, 0), tap(3_000));
    });

    it('a check inside a run moves the pieces but no cell', () => {
        const marked = line('あい\n', {
            ruby: [run(0, 2, [piece('あ', tap(1_000)), piece('い')])],
        });
        const lyrics = recordCheck(
            { lines: [marked] },
            { lineIndex: 0, group: 'ruby', runIndex: 0, pieceIndex: 1 },
            tap(1_500),
        );
        assert.deepEqual(spans(lyrics.lines)[0], [null, null, null]);
        const pieces = lyrics.lines[0].groups.ruby[0].pieces;
        assert.deepEqual(
            pieces.map((entry) =>
                entry.text.cells.map((cell) =>
                    cell.span === null
                        ? null
                        : [cell.span.start, cell.span.duration],
                ),
            ),
            [[[1_000, 500]], [null]],
        );
    });

    it('clears a check without touching the times it produced', () => {
        let lyrics = { lines: [three()] };
        lyrics = recordCheck(lyrics, AT_RUN0, tap(1_000));
        lyrics = recordCheck(lyrics, AT_RUN1, tap(2_000));
        const filled = spans(lyrics.lines);

        const cleared = clearCheck(lyrics, AT_RUN1);
        assert.equal(checkOf([cleared.lines[0]], 0, 'ruby', 1, 0), null);
        assert.deepEqual(spans(cleared.lines), filled);
        assert.equal(clearCheck(cleared, AT_RUN1), cleared);
    });

    it('rebuilds a group into the state tapping it top to bottom leaves', () => {
        let tapped = { lines: [three()] };
        tapped = recordCheck(tapped, AT_RUN0, tap(1_000));
        tapped = recordCheck(tapped, AT_RUN1, tap(2_000));
        tapped = recordCheck(tapped, AT_END, tap(3_000));

        let marked = three();
        marked = withCheck(
            marked,
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            tap(1_000),
        );
        marked = withCheck(
            marked,
            { group: 'ruby', runIndex: 1, pieceIndex: 0 },
            tap(2_000),
        );
        marked = withCheck(
            marked,
            { group: 'ruby', runIndex: 2, pieceIndex: 0 },
            tap(3_000),
        );

        const rebuilt = refillGroup({ lines: [marked] }, 0, 'ruby');
        assert.deepEqual(spans(rebuilt.lines), spans(tapped.lines));
        assert.deepEqual(
            rebuilt.lines[0].groups.ruby.map((entry) =>
                entry.pieces.map((entry2) => entry2.check),
            ),
            tapped.lines[0].groups.ruby.map((entry) =>
                entry.pieces.map((entry2) => entry2.check),
            ),
        );
    });

    it('re-spans the stretch a new character lands in', () => {
        let lyrics = { lines: [three()] };
        lyrics = recordCheck(lyrics, AT_RUN0, tap(1_000));
        lyrics = recordCheck(lyrics, AT_RUN1, tap(2_000));
        lyrics = recordCheck(lyrics, AT_END, tap(3_000));

        const edited = editLineText(lyrics, 0, [1, 1], 'X', 'ruby');
        assert.equal(edited.lines[0].baseStream.cells.length, 5);
        assert.deepEqual(spans(edited.lines), [
            [
                [1_000, 334],
                [1_334, 333],
                [1_667, 333],
                [2_000, 1_000],
                [3_000, 500],
            ],
        ]);
        assert.equal(edited.lines[0].groups.ruby[0].length, 3);
    });

    it('leaves a character inserted before the first anchor without time', () => {
        const marked = line('あい\n', {
            ruby: [run(1, 1, [piece('い', tap(1_000))])],
        });
        const edited = editLineText(
            { lines: [marked] },
            0,
            [0, 0],
            'X',
            'ruby',
        );
        assert.deepEqual(spans(edited.lines)[0], [null, null, null, null]);
    });

    it('splices the text without rebuilding when no group drives it', () => {
        let lyrics = { lines: [three()] };
        lyrics = recordCheck(lyrics, AT_RUN0, tap(1_000));
        lyrics = recordCheck(lyrics, AT_RUN1, tap(2_000));

        const edited = editLineText(lyrics, 0, [1, 1], 'X', null);
        assert.equal(edited.lines[0].baseStream.cells.length, 5);
        assert.deepEqual(spans(edited.lines)[0], [
            [1_000, 500],
            null,
            [1_500, 500],
            null,
            null,
        ]);
        assert.deepEqual(
            edited.lines[0].groups.ruby.map((entry) => [
                entry.offset,
                entry.length,
            ]),
            [
                [0, 3],
                [3, 1],
                [4, 1],
            ],
        );
    });
});

describe('the entry points', () => {
    it('stores a check by value, so the caller cannot rewrite history', () => {
        const check = tap(2_000);
        const after = withCheck(
            three(),
            { group: 'ruby', runIndex: 1, pieceIndex: 0 },
            check,
        );
        check.time = 9_999;
        assert.deepEqual(checkOf([after], 0, 'ruby', 1, 0), tap(2_000));
    });

    it('treats an equal check as the same record', () => {
        const recorded = withCheck(
            three(),
            { group: 'ruby', runIndex: 1, pieceIndex: 0 },
            tap(2_000),
        );
        const again = withCheck(
            recorded,
            { group: 'ruby', runIndex: 1, pieceIndex: 0 },
            tap(2_000),
        );
        assert.equal(again, recorded);
    });

    it('rejects a check that is not a whole time and a known type', () => {
        const bad = [
            { time: 1.5, type: 'KeyDown' },
            { time: 1_000 },
            { time: 1_000, type: 'Tap' },
        ];
        for (const entry of bad) {
            assert.throws(
                () =>
                    withCheck(
                        three(),
                        { group: 'ruby', runIndex: 1, pieceIndex: 0 },
                        entry,
                    ),
                (error) => error.code === 'invalid-check',
            );
        }
    });

    it('never reads a group through the prototype', () => {
        const lyrics = { lines: [three()] };
        for (const name of ['constructor', 'hasOwnProperty', 'toString']) {
            assert.equal(refillGroup(lyrics, 0, name), lyrics);
            assert.doesNotThrow(() =>
                editLineText(lyrics, 0, [0, 1], 'あ', name),
            );
        }
        assert.equal(runAt(lyrics.lines[0], 'constructor', 0), null);
    });

    it('rejects a splice range that leaves the line', () => {
        const lyrics = { lines: [three()] };
        for (const removed of [
            [2, 1],
            [-1, 0],
            [0, 99],
            [0.5, 1],
        ]) {
            assert.throws(
                () => editLineText(lyrics, 0, removed, 'X', null),
                (error) => error.code === 'invalid-edit',
            );
        }
    });

    it('rejects an edit past the body instead of corrupting the line', () => {
        // The break cell is not part of the body, so `spliceLine` refuses the
        // range rather than producing a stream that is no longer a line. This
        // used to fail later, as `invalid-lyrics-line`, from the assert.
        const lyrics = { lines: [three()] };
        assert.throws(
            () => editLineText(lyrics, 0, [4, 4], 'X', null),
            (error) => error.code === 'invalid-edit',
        );
    });

    it('validates the tail once per entry point', () => {
        const lyrics = { lines: [three()] };
        for (const tail of [0, -1, 1.5]) {
            const throws = (error) => error.code === 'invalid-time';
            assert.throws(
                () => recordCheck(lyrics, AT_RUN0, tap(1_000), tail),
                throws,
            );
            assert.throws(() => refillGroup(lyrics, 0, 'ruby', tail), throws);
            assert.throws(
                () => editLineText(lyrics, 0, [0, 1], 'あ', 'ruby', tail),
                throws,
            );
        }
    });

    it('leaves the document alone for a line past the end', () => {
        const lyrics = { lines: [three()] };
        const stale = { ...AT_RUN0, lineIndex: 5 };
        assert.equal(recordCheck(lyrics, stale, tap(1_000)), lyrics);
        assert.equal(clearCheck(lyrics, stale), lyrics);
        assert.equal(refillGroup(lyrics, 5, 'ruby'), lyrics);
        assert.equal(editLineText(lyrics, 5, [0, 1], 'X', 'ruby'), lyrics);
    });

    it('keeps an edit that changes nothing as the same document', () => {
        const lyrics = { lines: [three()] };
        assert.equal(editLineText(lyrics, 0, [1, 1], '', 'ruby'), lyrics);
        assert.equal(editLineText(lyrics, 0, [1, 1], '', null), lyrics);
    });

    it('carries the tail through both entry points', () => {
        const tapped = recordCheck(
            { lines: [three()] },
            AT_END,
            tap(3_000),
            200,
        );
        assert.deepEqual(spans(tapped.lines)[0][3], [3_000, 200]);

        const marked = withCheck(
            three(),
            { group: 'ruby', runIndex: 2, pieceIndex: 0 },
            tap(3_000),
        );
        const refilled = refillGroup({ lines: [marked] }, 0, 'ruby', 200);
        assert.deepEqual(spans(refilled.lines)[0][3], [3_000, 200]);
    });

    it('replays onto what is there and clears nothing', () => {
        let lyrics = { lines: [three()] };
        lyrics = recordCheck(lyrics, AT_RUN0, tap(1_000));
        lyrics = recordCheck(lyrics, AT_RUN1, tap(2_000));
        const filled = spans(lyrics.lines);
        const cleared = clearCheck(lyrics, AT_RUN0);
        assert.deepEqual(spans(refillGroup(cleared, 0, 'ruby').lines), filled);
    });
});

describe('a keystroke that fuses with a neighbour', () => {
    function cellsOf(lyrics) {
        return lyrics.lines[0].baseStream.cells.map((cell) => cell.text);
    }

    it('merges a combining mark into the cell it belongs to', () => {
        const lyrics = editLineText(
            { meta: emptyMeta(), lines: [line('ax\n')] },
            0,
            [1, 1],
            '\u0301',
        );
        assert.deepEqual(cellsOf(lyrics), ['a\u0301', 'x', '\n']);
    });

    it('merges a carriage return into the break cell it forms', () => {
        const lyrics = editLineText(
            { meta: emptyMeta(), lines: [line('ab\n')] },
            0,
            [2, 2],
            '\r',
        );
        assert.deepEqual(cellsOf(lyrics), ['a', 'b', '\r\n']);
    });
});

describe('refilling a whole document', () => {
    it('replays every group of every line from its checks', () => {
        let tapped = {
            meta: emptyMeta(),
            lines: [
                line('あいう\n', {
                    ruby: [
                        run(0, 2, [piece('とう')]),
                        run(2, 1, [piece('う')]),
                        run(3, 1, [piece('')]),
                    ],
                }),
            ],
        };
        tapped = recordCheck(
            tapped,
            { lineIndex: 0, group: 'ruby', runIndex: 0, pieceIndex: 0 },
            tap(1_000),
        );
        tapped = recordCheck(
            tapped,
            { lineIndex: 0, group: 'ruby', runIndex: 1, pieceIndex: 0 },
            tap(2_000),
        );

        assert.deepEqual(spans(refillAll(tapped).lines), spans(tapped.lines));
    });

    it('is idempotent', () => {
        let tapped = {
            meta: emptyMeta(),
            lines: [
                line('あいう\n', {
                    ruby: [
                        run(0, 2, [piece('とう')]),
                        run(2, 1, [piece('う')]),
                        run(3, 1, [piece('')]),
                    ],
                }),
            ],
        };
        tapped = recordCheck(
            tapped,
            { lineIndex: 0, group: 'ruby', runIndex: 0, pieceIndex: 0 },
            tap(1_000),
        );

        const once = refillAll(tapped);
        assert.deepEqual(spans(refillAll(once).lines), spans(once.lines));
    });

    it('rejects a tail that is not a positive time', () => {
        assert.throws(
            () => refillAll({ meta: emptyMeta(), lines: [line('ab\n')] }, 0),
            (error) => error.code === 'invalid-time',
        );
    });
});
