import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    assertLyricsLine,
    isValidLyricsLine,
    lyricsLineToText,
    runAt,
    spliceGroups,
    spliceLine,
    textToLyricsLine,
} from '../../src/main/lyrics/line.js';

function cell(text) {
    return { text, span: null };
}

function piece(text) {
    return { check: null, text: textToStream(text) };
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
        overlay: {
            styles: [],
            inserted: [],
            blocks: [],
            runStyles: [],
            annotations: [],
        },
    };
}

function run(offset, length, pieces = []) {
    return { offset, length, pieces: pieces.map(piece) };
}

describe('lyrics line', () => {
    it('is text plus named groups, with no time of its own', () => {
        const created = textToLyricsLine('東京は\n');
        assert.equal(lyricsLineToText(created), '東京は\n');
        assert.deepEqual(created.groups, {});
        assert.equal(isValidLyricsLine(created), true);
        console.log('a line is a base stream plus groups keyed by name');
    });

    it('rejects a base stream that is not exactly one line', () => {
        assert.equal(isValidLyricsLine(line('東京は')), false);
        assert.equal(isValidLyricsLine(line('東京は\n京都\n')), false);
        assert.throws(
            () => assertLyricsLine(line('東京は')),
            (error) => error.code === 'invalid-lyrics-line',
        );
        console.log('a line ends with exactly one line break cell');
    });

    it('lets a run cover cells without matching the piece count', () => {
        const covered = line('東京は\n', {
            ruby: [run(0, 2, ['と', 'う', 'きょ', 'う'])],
        });
        assert.equal(isValidLyricsLine(covered), true);
        const touchingTheBreak = line('東京は\n', {
            ruby: [run(2, 1, ['は'])],
        });
        assert.equal(isValidLyricsLine(touchingTheBreak), true);
        console.log('a run is a cell range; its pieces are syllables');
    });

    it('requires every group to end with a terminal run', () => {
        const ragged = {
            baseStream: textToStream('東京は\n'),
            groups: { ruby: [run(0, 3, ['とう', 'きょう', 'は'])] },
        };
        assert.equal(isValidLyricsLine(ragged), false);
        assert.throws(
            () => assertLyricsLine(ragged),
            (error) => {
                return (
                    error instanceof Error &&
                    error.code === 'invalid-lyrics-line'
                );
            },
        );
        const complete = {
            baseStream: textToStream('東京は\n'),
            groups: {
                ruby: [
                    run(0, 3, ['とう', 'きょう', 'は']),
                    { offset: 3, length: 1, pieces: [piece('')] },
                ],
            },
        };
        assert.equal(isValidLyricsLine(complete), true);
    });

    it('keeps the runs of one group ordered and disjoint', () => {
        assert.equal(
            isValidLyricsLine(
                line('東京は\n', { ruby: [run(0, 2), run(2, 1)] }),
            ),
            true,
        );
        assert.equal(
            isValidLyricsLine(
                line('東京は\n', { ruby: [run(0, 2), run(1, 1)] }),
            ),
            false,
        );
        assert.equal(
            isValidLyricsLine(
                line('東京は\n', { ruby: [run(2, 1), run(0, 2)] }),
            ),
            false,
        );
        assert.equal(
            isValidLyricsLine(line('東京は\n', { ruby: [run(2, 3)] })),
            false,
        );
        console.log(
            'runs ascend, never overlap and stay inside the base stream',
        );
    });

    it('finds the run covering a cell', () => {
        const ruby = run(0, 2, ['と', 'う']);
        const covered = line('東京は\n', { ruby: [ruby] });
        assert.equal(runAt(covered, 'ruby', 0), ruby);
        assert.equal(runAt(covered, 'ruby', 1), ruby);
        assert.equal(runAt(covered, 'ruby', 2), null);
        assert.equal(runAt(covered, 'ruby', -1), null);
        assert.equal(runAt(covered, 'ruby', 0.5), null);
        assert.equal(runAt(covered, 'romaji', 0), null);
        console.log('runAt answers which run covers a base cell');
    });

    it('grows a run when cells are inserted inside it', () => {
        const ruby = run(0, 3, ['とう', 'きょう', 'は']);
        const spliced = spliceGroups({ ruby: [ruby] }, [1, 1], 1);
        assert.deepEqual(
            spliced.ruby.map((kept) => kept.length),
            [4],
        );
        assert.equal(spliced.ruby[0].pieces, ruby.pieces);
        assert.equal(spliced.ruby[0].offset, 0);
        console.log('an insertion inside a run grows it and keeps its pieces');
    });

    it('claims nothing for cells inserted on a run boundary', () => {
        const ruby = run(0, 3, ['とう']);
        assert.deepEqual(
            spliceGroups({ ruby: [ruby] }, [3, 3], 2).ruby.map((kept) => [
                kept.offset,
                kept.length,
            ]),
            [[0, 3]],
        );
        assert.deepEqual(
            spliceGroups({ ruby: [ruby] }, [0, 0], 2).ruby.map((kept) => [
                kept.offset,
                kept.length,
            ]),
            [[2, 3]],
        );
        console.log(
            'a new cell on a boundary joins no run; the run shifts right',
        );
    });

    it('shrinks a run when cells are removed and drops it when none is left', () => {
        const ruby = run(0, 3, ['とう', 'きょう', 'は']);
        const shrunk = spliceGroups({ ruby: [ruby] }, [0, 1], 0);
        assert.deepEqual(
            shrunk.ruby.map((kept) => [kept.offset, kept.length]),
            [[0, 2]],
        );
        assert.equal(shrunk.ruby[0].pieces, ruby.pieces);
        const dropped = spliceGroups(
            { ruby: [run(1, 2, ['a', 'b'])] },
            [1, 3],
            0,
        );
        assert.deepEqual(dropped, {});
        console.log('removal shortens runs and empties groups disappear');
    });

    it('keeps a run whole when the edit lands inside it', () => {
        const ruby = run(0, 3, ['とう', 'きょう', 'は']);
        const replaced = spliceGroups({ ruby: [ruby] }, [1, 2], 1);
        assert.deepEqual(
            replaced.ruby.map((kept) => [kept.offset, kept.length]),
            [[0, 3]],
        );
        assert.equal(replaced.ruby[0].pieces, ruby.pieces);
        console.log('a replacement inside a run leaves the run whole');
    });

    it('keeps only the right part of a run whose start is replaced', () => {
        const ruby = run(0, 3, ['とう', 'きょう', 'は']);
        const replaced = spliceGroups({ ruby: [ruby] }, [0, 2], 2);
        assert.deepEqual(
            replaced.ruby.map((kept) => [kept.offset, kept.length]),
            [[2, 1]],
        );
        console.log('a replacement over a run start keeps the right part');
    });

    it('splices cells and groups together', () => {
        const ruby = run(0, 3, ['とう', 'きょう', 'は']);
        const original = line('東京は\n', { ruby: [ruby] });
        const spliced = spliceLine(original, [1, 1], [cell('畿')]);
        assert.equal(lyricsLineToText(spliced), '東畿京は\n');
        assert.deepEqual(
            spliced.groups.ruby.map((kept) => [kept.offset, kept.length]),
            [
                [0, 4],
                [4, 1],
            ],
        );
        assert.equal(spliced.groups.ruby[0].pieces, ruby.pieces);
        assert.equal(isValidLyricsLine(spliced), true);
        console.log('spliceLine moves the cells and the groups in one step');
    });
});
