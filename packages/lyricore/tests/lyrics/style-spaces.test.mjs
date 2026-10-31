import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    overlayOf,
    spliceLine,
    textToLyricsLine,
    withAnnotations,
    withBlocks,
    withGroup,
    withInserted,
    withPieceText,
    withRunStyles,
    withStyles,
} from '../../src/main/lyrics/line.js';
import {
    assertLyrics,
    styleUseProblem,
    textToLyrics,
} from '../../src/main/lyrics/lyrics.js';
import { terminalRun } from '../../src/main/lyrics/seg-run.js';
import { emptyStyleBook, withStyle } from '../../src/main/lyrics/stylebook.js';
import { mergeLines, splitLine } from '../../src/main/lyrics/structure.js';

// Two body cells, one ruby run over both, and the terminal run on the break.
function rubyLine(text = 'ab\n') {
    const base = textToLyricsLine(text);
    const run = {
        offset: 0,
        length: 2,
        pieces: [{ check: null, text: textToStream('あい') }],
    };
    return withGroup(base, 'ruby', [run, terminalRun(2)]);
}

const runPoint = (offset = 0, styleId = 'r') => ({
    group: 'ruby',
    offset,
    styleId,
});

const textRun = (offset, length, styleId = 'c') => ({
    group: 'ruby',
    runOffset: 0,
    offset,
    length,
    styleId,
});

const blockRun = (from, styleId = 'p') => ({ from, styleId });

const marker = (offset, id = 'br1') => ({
    id,
    kind: 'soft-break',
    anchor: { offset, length: 0 },
    content: null,
});

const cell = (text) => ({ text, span: null });

describe('the group-keyed spaces', () => {
    it('keeps a run point on the run it names', () => {
        const line = withRunStyles(rubyLine(), [runPoint()]);
        assert.deepEqual(overlayOf(line).runStyles, [runPoint()]);
        assert.equal(overlayOf(line).annotations.length, 0);
    });

    it('returns the line itself when the list is the same', () => {
        const list = [runPoint()];
        const line = withRunStyles(rubyLine(), list);
        assert.equal(withRunStyles(line, list), line);
    });

    it('refuses a run point that does not name a run start', () => {
        assert.throws(
            () => withRunStyles(rubyLine(), [runPoint(1)]),
            /is not the first cell of a run/,
        );
    });

    it('refuses a run point for a group the line does not have', () => {
        assert.throws(
            () =>
                withRunStyles(rubyLine(), [
                    { group: 'word', offset: 0, styleId: 'r' },
                ]),
            /names no group on this line/,
        );
    });

    it('keeps an annotation over the characters of its run', () => {
        const line = withAnnotations(rubyLine(), [textRun(0, 2)]);
        assert.deepEqual(overlayOf(line).annotations, [textRun(0, 2)]);
    });

    it('refuses an annotation past the text of its run', () => {
        assert.throws(
            () => withAnnotations(rubyLine(), [textRun(1, 2)]),
            /runs past the 2 cells of the run/,
        );
    });

    it('keeps a block style keyed to a soft break on the line', () => {
        const line = withBlocks(withInserted(rubyLine(), [marker(1)]), [
            blockRun(null),
            blockRun('br1'),
        ]);
        assert.deepEqual(overlayOf(line).blocks, [
            blockRun(null),
            blockRun('br1'),
        ]);
    });

    it('refuses a block whose break is not on the line', () => {
        assert.throws(
            () => withBlocks(rubyLine(), [blockRun('nope')]),
            /names no soft break/,
        );
    });
});

describe('the group-keyed spaces under an edit', () => {
    it('carries a run point with the run when cells are typed before it', () => {
        const line = withRunStyles(rubyLine(), [runPoint()]);
        const after = spliceLine(line, [0, 0], [cell('x')]);
        assert.deepEqual(overlayOf(after).runStyles, [runPoint(1)]);
    });

    it('keeps the annotation with its run, not with the cells', () => {
        const line = withAnnotations(rubyLine(), [textRun(0, 2)]);
        const after = spliceLine(line, [0, 0], [cell('x')]);
        assert.deepEqual(overlayOf(after).annotations, [
            { ...textRun(0, 2), runOffset: 1 },
        ]);
    });

    it('drops both when the cells the run covered are deleted', () => {
        const line = withAnnotations(withRunStyles(rubyLine(), [runPoint()]), [
            textRun(0, 2),
        ]);
        const after = spliceLine(line, [0, 2], []);
        assert.deepEqual(overlayOf(after).runStyles, []);
        assert.deepEqual(overlayOf(after).annotations, []);
    });

    it('drops an annotation the shortened reading no longer holds', () => {
        const line = withAnnotations(rubyLine(), [textRun(0, 2)]);
        // Replacing the reading halves it from two cells to one, so the entry
        // that reached character 2 has nowhere to sit.
        const after = withPieceText(
            line,
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            'あ',
        );
        assert.deepEqual(overlayOf(after).annotations, []);
    });

    it('drops a block style when its break dies with the cell', () => {
        const line = withBlocks(withInserted(rubyLine(), [marker(1)]), [
            blockRun(null),
            blockRun('br1'),
        ]);
        const after = spliceLine(line, [0, 2], []);
        assert.deepEqual(overlayOf(after).inserted, []);
        assert.deepEqual(overlayOf(after).blocks, [blockRun(null)]);
    });
});

describe('splitting and joining the group-keyed spaces', () => {
    it('splits an annotation at the cut, one half each side', () => {
        const line = withAnnotations(rubyLine(), [textRun(0, 2)]);
        const [left, right] = splitLine(line, 1);
        assert.deepEqual(overlayOf(left).annotations, [textRun(0, 1)]);
        assert.deepEqual(overlayOf(right).annotations, [textRun(0, 1)]);
    });

    it('copies the run point onto the right half of a straddled run', () => {
        const line = withRunStyles(rubyLine(), [runPoint()]);
        const [left, right] = splitLine(line, 1);
        assert.deepEqual(overlayOf(left).runStyles, [runPoint(0)]);
        assert.deepEqual(overlayOf(right).runStyles, [runPoint(0)]);
    });

    it('shifts the tail run point by the junction on a merge', () => {
        const [left] = splitLine(withRunStyles(rubyLine(), [runPoint()]), 1);
        const [, right] = splitLine(withRunStyles(rubyLine(), [runPoint()]), 1);
        const merged = mergeLines(left, right);
        const points = overlayOf(merged).runStyles;
        assert.deepEqual(points.at(-1), runPoint(1));
    });

    it('shifts the tail annotation by the junction on a merge', () => {
        const [left] = splitLine(
            withAnnotations(rubyLine(), [textRun(0, 2)]),
            1,
        );
        const [, right] = splitLine(
            withAnnotations(rubyLine(), [textRun(0, 2)]),
            1,
        );
        const merged = mergeLines(left, right);
        assert.equal(overlayOf(merged).annotations.length, 2);
        assert.equal(overlayOf(merged).annotations.at(-1).runOffset, 1);
    });
});

describe('a style used on the wrong layer', () => {
    const book = withStyle(emptyStyleBook(), 'layout', {
        basedOn: null,
        space: 'run',
        content: { align: 'center' },
    });

    it('is reported once the document is checked', () => {
        const line = withStyles(textToLyricsLine('ab\n'), [
            { offset: 0, length: 1, styleId: 'layout' },
        ]);
        const lyrics = {
            ...textToLyrics('ab\n'),
            lines: [line],
            styleBook: book,
        };
        const problem = styleUseProblem(book, line);
        assert.equal(problem.code, 'invalid-cell-style');
        assert.match(
            problem.message,
            /run style "layout" on the character layer/,
        );
        assert.throws(() => assertLyrics(lyrics), /on the character layer/);
    });

    it('says nothing when the definition matches the layer', () => {
        const line = withStyles(textToLyricsLine('ab\n'), [
            { offset: 0, length: 1, styleId: 'layout' },
        ]);
        const paragraph = withStyle(emptyStyleBook(), 'layout', {
            basedOn: null,
            space: 'character',
            content: {},
        });
        assert.equal(styleUseProblem(paragraph, line), null);
    });
});
