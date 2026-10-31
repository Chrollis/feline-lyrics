import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import { importLrc } from '../../src/main/io/lrc.js';
import { importTagText } from '../../src/main/io/tagtext.js';
import {
    fillFromCheck,
    recordCheck,
    TAIL_MS,
} from '../../src/main/lyrics/interpolate.js';

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

function spans(stream) {
    return stream.cells.map((cell) =>
        cell.span === null ? null : [cell.span.start, cell.span.duration],
    );
}

function fill(lines, target) {
    return fillFromCheck({ lines }, target);
}

describe('interpolation', () => {
    it('fills the cells between two run starts', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('とう', tap(1_000))]),
                run(2, 1, [piece('', tap(2_000))]),
            ],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(spans(filled.lines[0].baseStream), [
            [1_000, 500],
            [1_500, 500],
            null,
            null,
        ]);
        assert.deepEqual(spans(filled.lines[0].groups.ruby[0].pieces[0].text), [
            [1_000, 500],
            [1_500, 500],
        ]);
        console.log('a run start fills the cells of the run before it');
    });

    it('writes nothing when no earlier check anchors it', () => {
        const base = line('東京は\n', {
            ruby: [run(0, 2, [piece('と', tap(1_000))])],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 0,
            pieceIndex: 0,
        });
        assert.deepEqual(filled, { lines: [base] });
        console.log('the first check of a group has nothing to fill back to');
    });

    it('keeps the cells still when a later piece is tapped', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('と', tap(1_000)), piece('う', tap(1_500))]),
            ],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 0,
            pieceIndex: 1,
        });
        assert.deepEqual(spans(filled.lines[0].baseStream), [
            null,
            null,
            null,
            null,
        ]);
        assert.deepEqual(spans(filled.lines[0].groups.ruby[0].pieces[0].text), [
            [1_000, 500],
        ]);
        console.log('only the pieces move when a piece inside a run is tapped');
    });

    it('owns the last cell of the line while the next line is untimed', () => {
        const base = line('ABCD\n', {
            ruby: [
                run(0, 4, [piece('', tap(1_000))]),
                run(4, 1, [piece('', tap(3_000))]),
            ],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(spans(filled.lines[0].baseStream), [
            [1_000, 500],
            [1_500, 500],
            [2_000, 500],
            [2_500, 500],
            [3_000, TAIL_MS],
        ]);
        console.log('the terminal run gives its own cell the tail length');
    });

    it('rewrites the previous line when a line starts late', () => {
        const first = line('AB\n', {
            ruby: [run(2, 1, [piece('', tap(1_000))])],
        });
        const second = line('CD\n', {
            ruby: [
                run(0, 1, [piece('', tap(2_000))]),
                run(1, 1, [piece('', tap(2_500))]),
            ],
        });
        const tagged = fill([first], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 0,
            pieceIndex: 0,
        });
        assert.deepEqual(spans(tagged.lines[0].baseStream), [
            null,
            null,
            [1_000, TAIL_MS],
        ]);
        const filled = fill([tagged.lines[0], second], {
            lineIndex: 1,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(spans(filled.lines[0].baseStream), [
            null,
            null,
            [1_000, 1_000],
        ]);
        console.log("a later line stretches the previous line's last cell");
    });

    it('pushes changed cells into the other groups of the line', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('', tap(1_000))]),
                run(2, 1, [piece('', tap(3_000))]),
            ],
            romaji: [run(0, 1, [piece('to')])],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(
            spans(filled.lines[0].groups.romaji[0].pieces[0].text),
            [
                [1_000, 500],
                [1_500, 500],
            ],
        );
        console.log('every group follows the cells that just changed');
    });

    it('fills a zero-length chain when two checks share an instant', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('', tap(2_000))]),
                run(2, 1, [piece('', tap(2_000))]),
            ],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        // Two events at the same instant make an empty interval, which every
        // layer below already supports. Refusing it left the cells unwritten,
        // and an exporter then dropped the whole line.
        assert.deepEqual(
            filled.lines[0].baseStream.cells.map((cell) => cell.span),
            [
                { start: 2_000, duration: 0 },
                { start: 2_000, duration: 0 },
                null,
                null,
            ],
        );
    });

    it('still fills nothing when the anchor is later', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('', tap(2_500))]),
                run(2, 1, [piece('', tap(2_000))]),
            ],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        // A backwards interval is contradictory data, not an empty one.
        assert.deepEqual(filled, { lines: [base] });
        console.log('a negative interval fills nothing');
    });

    it('skips a run whose far end has no span yet', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('', tap(1_000))]),
                run(2, 1, [piece('', tap(3_000))]),
            ],
            romaji: [run(1, 2, [piece('to')])],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(
            spans(filled.lines[0].groups.romaji[0].pieces[0].text),
            [null, null],
        );
        console.log('a run waits until both of its ends are timed');
    });

    it('rejects a tail that is not a positive whole time', () => {
        const base = line('A\n', {
            ruby: [run(1, 1, [piece('', tap(1_000))])],
        });
        const target = {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 0,
            pieceIndex: 0,
        };
        for (const tail of [0, -500, 0.5, Number.NaN]) {
            assert.throws(
                () => fillFromCheck({ lines: [base] }, target, tail),
                (error) => error.code === 'invalid-time',
            );
        }
        console.log('a tail has to be a positive whole number');
    });

    it('hands the last cell over once the next line is timed', () => {
        const first = line('AB\n', {
            ruby: [
                run(0, 2, [piece('', tap(1_000))]),
                run(2, 1, [piece('', tap(2_000))]),
            ],
        });
        const second = line('CD\n', {
            ruby: [
                run(0, 1, [piece('', tap(2_200))]),
                run(1, 1, [piece('', tap(2_600))]),
            ],
        });
        const one = fill([first, second], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        const two = fill(one.lines, {
            lineIndex: 1,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        const three = fill(two.lines, {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(spans(three.lines[0].baseStream), [
            [1_000, 500],
            [1_500, 500],
            [2_000, 200],
        ]);
        assert.deepEqual(spans(three.lines[1].baseStream), [
            [2_200, 400],
            null,
            null,
        ]);
        console.log('the tail stops where the next line begins');
    });

    it('returns the same document when nothing can be filled', () => {
        const base = line('東京は\n', {
            ruby: [run(0, 2, [piece('', tap(1_000))])],
        });
        const lyrics = { lines: [base] };
        const filled = fillFromCheck(lyrics, {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 0,
            pieceIndex: 0,
        });
        assert.equal(filled, lyrics);
        console.log('a tap with no anchor leaves the document untouched');
    });

    it('spreads a remainder over the earliest cells', () => {
        const base = line('abc\n', {
            ruby: [
                run(0, 3, [piece('', tap(1_000))]),
                run(3, 1, [piece('', tap(2_000))]),
            ],
        });
        const filled = fill([base], {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        });
        assert.deepEqual(spans(filled.lines[0].baseStream), [
            [1_000, 334],
            [1_334, 333],
            [1_667, 333],
            [2_000, TAIL_MS],
        ]);
        console.log('a remainder of one millisecond goes to the first cell');
    });

    it('refuses a line whose runs reach past its cells', () => {
        const base = line('ab\n', {
            ruby: [
                run(0, 1, [piece('x', tap(1_000))]),
                run(9, 1, [piece('y', tap(2_000))]),
            ],
        });
        assert.throws(
            () =>
                fillFromCheck(
                    { lines: [base] },
                    {
                        lineIndex: 0,
                        group: 'ruby',
                        runIndex: 1,
                        pieceIndex: 0,
                    },
                ),
            (error) => error.code === 'invalid-lyrics-line',
        );
        console.log('a broken line is reported, not dereferenced');
    });

    it('refuses a fill that would leave the int32 range', () => {
        const base = line('a\n', {
            ruby: [
                run(0, 1, [piece('x', tap(-2_000_000_000))]),
                run(1, 1, [piece('', tap(2_000_000_000))]),
            ],
        });
        assert.throws(
            () =>
                fillFromCheck(
                    { lines: [base] },
                    {
                        lineIndex: 0,
                        group: 'ruby',
                        runIndex: 1,
                        pieceIndex: 0,
                    },
                ),
            (error) => error.code === 'invalid-time',
        );
        console.log('an interpolated span outside int32 is refused');
    });

    it('repeats without changing anything', () => {
        const base = line('東京は\n', {
            ruby: [
                run(0, 2, [piece('とう', tap(1_000))]),
                run(2, 1, [piece('', tap(2_000))]),
            ],
        });
        const target = {
            lineIndex: 0,
            group: 'ruby',
            runIndex: 1,
            pieceIndex: 0,
        };
        const once = fill([base], target);
        const twice = fill(once.lines, target);
        assert.deepEqual(twice, once);
        console.log('filling again from the same check is a no-op');
    });
});

describe('a tap that disagrees with the cells already there', () => {
    function imported() {
        return importLrc(
            '[00:01:00]a[00:02:33]b[00:03:66]c[00:05:00]d[00:06:33]e\n',
        ).lyrics;
    }

    it('stops the cell in front of the start of the cell behind it', () => {
        const tapped = recordCheck(
            imported(),
            { lineIndex: 0, group: 'default', runIndex: 3, pieceIndex: 0 },
            tap(5_500),
        );
        // The tag at 5000 already placed the next cell. Before the cut the
        // third cell ended at 5500 and overlapped the fourth by 500 ms.
        assert.deepEqual(spans(tapped.lines[0].baseStream), [
            [1_000, 1_330],
            [2_330, 1_330],
            [3_660, 1_340],
            [5_000, 1_330],
            [6_330, 5_000],
            [11_330, 500],
        ]);
        assert.equal(
            tapped.lines[0].groups.default[3].pieces[0].check.time,
            5_500,
        );
        console.log('a tap never pushes a cell past the cell behind it');
    });

    it('keeps a tail that a tag already placed later', () => {
        const tapped = recordCheck(
            imported(),
            { lineIndex: 0, group: 'default', runIndex: 5, pieceIndex: 0 },
            tap(3_000),
        );
        assert.deepEqual(
            spans(tapped.lines[0].baseStream).at(-1),
            [11_330, 500],
        );
        console.log('a tail never runs backwards into the cell before it');
    });
});

describe('a fill that has to stop short of the cell it lands in', () => {
    function tagImported(source) {
        return importTagText(source).lyrics;
    }

    it('splits the stretch over the shortened range, not the full tap', () => {
        // The tapped run already starts at 3000, so a tap at 5000 cannot push
        // the cell in front of it past 3000. Two cells take [1000, 3000): 1000
        // each. Clamping the last bound after the fact left the second cell zero
        // long and sharing a start with the third.
        const tapped = recordCheck(
            tagImported('[00:01:00]ab[00:03:00]cd\n'),
            { lineIndex: 0, group: 'default', runIndex: 1, pieceIndex: 0 },
            tap(5_000),
        );
        assert.deepEqual(spans(tapped.lines[0].baseStream).slice(0, 2), [
            [1_000, 1_000],
            [2_000, 1_000],
        ]);
        console.log('a fill never collapses the cell in front of a tag');
    });

    it('still moves the cells when the tap lands past the recorded start', () => {
        // A tap at 9000 against a run that starts at 2000: the fill can only run
        // to 2000, but it has to run there instead of being dropped whole and
        // leaving a check no cell reflects.
        const tapped = recordCheck(
            tagImported('[00:01:00]ab[00:02:00]cd[00:02:20]e\n'),
            { lineIndex: 0, group: 'default', runIndex: 1, pieceIndex: 0 },
            tap(9_000),
        );
        assert.deepEqual(spans(tapped.lines[0].baseStream).slice(0, 2), [
            [1_000, 500],
            [1_500, 500],
        ]);
        console.log('a tap past a tag still fills the cells in front of it');
    });
});
