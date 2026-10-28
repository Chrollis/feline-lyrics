import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { textToStream } from '../../src/main/lyrics/char.js';
import { joinPieces } from '../../src/main/lyrics/seg-run.js';
import { textToLyricsLine } from '../../src/main/lyrics/line.js';
import { lyricsToText, textToLyrics } from '../../src/main/lyrics/lyrics.js';
import {
    insertLine,
    mergeLines,
    removeLine,
    splitLine,
} from '../../src/main/lyrics/structure.js';

function empty() {
    return textToStream('');
}

function piece(chars, check = null) {
    return { check, text: textToStream(chars) };
}

function run(offset, length, pieces) {
    return { offset, length, pieces };
}

function terminal(offset, check = null) {
    return run(offset, 1, [{ check, text: empty() }]);
}

function tap(time) {
    return { time, type: 'KeyDown' };
}

function lineOf(text, groups = {}) {
    return { ...textToLyricsLine(text), groups };
}

function textOf(line) {
    return line.baseStream.cells.map((cell) => cell.text).join('');
}

function ruby(line) {
    return line.groups.ruby;
}

function codes(callback) {
    try {
        callback();
    } catch (error) {
        return error.code;
    }
    return null;
}

describe('splitting a line', () => {
    it('gives the left half a new break and the right the original one', () => {
        const line = lineOf('あいう\n', {
            ruby: [
                run(0, 2, [piece('あ'), piece('い')]),
                run(2, 1, [piece('う')]),
                terminal(3, tap(3_000)),
            ],
        });
        const [left, right] = splitLine(line, 2);

        assert.equal(textOf(left), 'あい\n');
        assert.equal(textOf(right), 'う\n');
        assert.equal(left.baseStream.cells.at(-1).span, null);
        assert.equal(
            right.baseStream.cells.at(-1),
            line.baseStream.cells.at(-1),
        );
        assert.equal(ruby(left).at(-1).offset, 2);
        assert.equal(ruby(left).at(-1).pieces[0].check, null);
        assert.equal(ruby(right)[0].offset, 0);
        assert.equal(ruby(right).at(-1).offset, 1);
        assert.equal(ruby(right).at(-1).pieces[0].check.time, 3_000);
    });

    it('cuts a straddling run by character density', () => {
        const line = lineOf('abcd\n', {
            ruby: [run(0, 4, [piece('あいうえ')]), terminal(4)],
        });
        const [left, right] = splitLine(line, 2);

        assert.equal(joinPieces(ruby(left)[0]), 'あい');
        assert.equal(joinPieces(ruby(right)[0]), 'うえ');
        assert.equal(ruby(left)[0].length, 2);
        assert.equal(ruby(right)[0].length, 2);
    });

    it('keeps a cut check on the left and clears the right head', () => {
        const line = lineOf('ab\n', {
            ruby: [
                run(0, 2, [piece('とう', tap(1_000))]),
                terminal(2, tap(2_000)),
            ],
        });
        const [left, right] = splitLine(line, 1);

        assert.equal(joinPieces(ruby(left)[0]), 'と');
        assert.equal(ruby(left)[0].pieces[0].check.time, 1_000);
        assert.equal(joinPieces(ruby(right)[0]), 'う');
        assert.equal(ruby(right)[0].pieces[0].check, null);
    });

    it('accepts both ends and rejects a cut outside the line', () => {
        const line = lineOf('あい\n', {
            ruby: [run(0, 2, [piece('あい')]), terminal(2)],
        });
        const [blank, whole] = splitLine(line, 0);
        assert.equal(textOf(blank), '\n');
        assert.equal(textOf(whole), 'あい\n');
        assert.equal(
            codes(() => splitLine(line, 3)),
            'invalid-cell-index',
        );
        assert.equal(
            codes(() => splitLine(line, 1.5)),
            'invalid-cell-index',
        );
    });

    it('refuses a line whose groups have no terminal run', () => {
        const line = lineOf('あ\n', { ruby: [run(0, 1, [piece('あ')])] });
        assert.equal(
            codes(() => splitLine(line, 0)),
            'invalid-lyrics-line',
        );
    });
});

describe('merging two lines', () => {
    it('drops the first break and keeps the second one', () => {
        const first = lineOf('あ\n', { ruby: [terminal(1, tap(2_000))] });
        const second = lineOf('い\n', {
            ruby: [run(0, 1, [piece('い')]), terminal(1, tap(3_000))],
        });
        const merged = mergeLines(first, second);

        assert.equal(textOf(merged), 'あい\n');
        assert.equal(ruby(merged).length, 2);
        assert.equal(ruby(merged)[0].offset, 1);
        assert.equal(ruby(merged)[1].offset, 2);
        assert.equal(ruby(merged)[1].pieces[0].check.time, 3_000);
        assert.equal(
            ruby(merged).some((entry) => entry.pieces[0].check?.time === 2_000),
            false,
        );
    });

    it('gives a group that only the first line had a fresh terminal', () => {
        const first = lineOf('あ\n', {
            ruby: [run(0, 1, [piece('あ')]), terminal(1)],
        });
        const second = lineOf('い\n', {});
        const merged = mergeLines(first, second);

        assert.equal(ruby(merged).at(-1).offset, 2);
        assert.equal(ruby(merged).at(-1).pieces[0].check, null);
    });

    it('refuses a seam that joins into one cluster', () => {
        const first = lineOf('か\n', {});
        const second = lineOf('\u3099あ\n', {});
        assert.equal(
            codes(() => mergeLines(first, second)),
            'invalid-char-cell',
        );
    });
});

describe('inserting and removing lines', () => {
    it('inserts a line and keeps the order', () => {
        const lyrics = textToLyrics('あ\nい\n');
        const inserted = insertLine(lyrics, 1, textToLyricsLine('う\n'));

        assert.equal(lyricsToText(inserted), 'あ\nう\nい\n');
        assert.equal(lyrics.lines.length, 2);
        assert.equal(
            codes(() => insertLine(lyrics, 3, textToLyricsLine('う\n'))),
            'invalid-line-index',
        );
    });

    it('removes a line and rejects an index past the end', () => {
        const lyrics = textToLyrics('あ\nい\n');
        const removed = removeLine(lyrics, 0);

        assert.equal(lyricsToText(removed), 'い\n');
        assert.equal(
            codes(() => removeLine(lyrics, 2)),
            'invalid-line-index',
        );
    });

    it('refuses to insert a line that is not one', () => {
        const lyrics = textToLyrics('あ\n');
        assert.equal(
            codes(() => insertLine(lyrics, 0, textToLyricsLine('あい'))),
            'invalid-lyrics-line',
        );
    });
});

describe('seams between timed lines', () => {
    function timed(text, start, duration) {
        const line = textToLyricsLine(text);
        return {
            ...line,
            baseStream: {
                cells: line.baseStream.cells.map((cell) => ({
                    text: cell.text,
                    span: { start, duration },
                })),
            },
        };
    }

    function docWith(line) {
        return { meta: textToLyrics('a\n').meta, lines: [line] };
    }

    it('re-times the break of the line before an inserted one', () => {
        const grown = insertLine(
            docWith(timed('a\n', 1_000, 0)),
            1,
            timed('b\n', 2_000, 0),
        );
        assert.deepEqual(grown.lines[0].baseStream.cells[1].span, {
            start: 1_000,
            duration: 1_000,
        });
    });

    it('refuses a seam it cannot represent', () => {
        assert.equal(
            codes(() =>
                insertLine(
                    docWith(timed('a\n', -1, 0)),
                    1,
                    timed('b\n', 2_147_483_647, 0),
                ),
            ),
            'invalid-time',
        );
    });
});
