import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    isValidLyricsLine,
    overlayOf,
    spliceLine,
    textToLyricsLine,
    withAnnotations,
    withBlocks,
    withGroup,
    withInserted,
    withRunStyles,
} from '../../src/main/lyrics/line.js';
import { textToLyrics } from '../../src/main/lyrics/lyrics.js';
import { terminalRun } from '../../src/main/lyrics/seg-run.js';
import {
    defaultContent,
    mergeContent,
} from '../../src/main/lyrics/stylecontent.js';
import { emptyStyleBook, withStyle } from '../../src/main/lyrics/stylebook.js';
import { mergeLines, splitLine } from '../../src/main/lyrics/structure.js';
import {
    lyricsToProjectJson,
    readProjectJson,
} from '../../src/main/project/json.js';

// A body of two cells with one ruby run over both, terminal run on the break.
function rubyLine(text = 'ab\n', reading = 'あい') {
    const base = textToLyricsLine(text);
    const run = {
        offset: 0,
        length: 2,
        pieces: [{ check: null, text: textToStream(reading) }],
    };
    return withGroup(base, 'ruby', [run, terminalRun(2)]);
}

const marker = (offset, id = 'br1') => ({
    id,
    kind: 'soft-break',
    anchor: { offset, length: 0 },
    content: null,
});

describe('the content the built-in default fills in', () => {
    // A default that nobody asserts is a default two implementations can
    // disagree about, and the whole point of a total resolution is that the
    // renderer never has to guess.
    it('states every value instead of leaving it to the reader', () => {
        const content = defaultContent('character');
        assert.equal(content.sizePx, 48);
        assert.equal(content.weight, 400);
        assert.equal(content.italic, false);
        assert.equal(content.letterSpacingPx, 0);
        assert.equal(content.baselineShiftPx, 0);
        assert.deepEqual(content.outlines, []);
        assert.equal(content.shadow, null);
        assert.deepEqual(content.fill, {
            normal: { kind: 'solid', color: '#ffffff' },
        });
        assert.deepEqual(content.wipe, {
            direction: 'none',
            transition: 'linear',
            featherPx: 0,
        });
    });

    it('lets a definition remove a decoration the parent has', () => {
        const parent = {
            outlines: [
                {
                    fill: { normal: { kind: 'solid', color: '#000000' } },
                    widthPx: 2,
                    blurPx: 0,
                },
            ],
        };
        assert.equal(mergeContent(parent, {}).outlines.length, 1);
        assert.deepEqual(mergeContent(parent, { outlines: [] }).outlines, []);
    });
});

describe('a split that carries block styles', () => {
    it('sends a break at the cut to the right half', () => {
        const line = withBlocks(
            withInserted(textToLyricsLine('abcd\n'), [marker(2)]),
            [
                { from: null, styleId: 'p' },
                { from: 'br1', styleId: 'q' },
            ],
        );
        const [left, right] = splitLine(line, 2);
        assert.deepEqual(overlayOf(left).blocks, [
            { from: null, styleId: 'p' },
        ]);
        // The break itself travels with the right half, and the style that
        // starts a block at the break travels with the break.
        assert.deepEqual(overlayOf(right).blocks, [
            { from: 'br1', styleId: 'q' },
        ]);
    });

    it('copies the style of the block the cut lands in, not the last one', () => {
        const line = withBlocks(
            withInserted(textToLyricsLine('abcdef\n'), [
                marker(2, 'b1'),
                marker(4, 'b2'),
            ]),
            [
                { from: null, styleId: 's0' },
                { from: 'b1', styleId: 's1' },
                { from: 'b2', styleId: 's2' },
            ],
        );
        const [, right] = splitLine(line, 3);
        // The cut is inside the block that starts at b1, so that block's style
        // is what the right half's first block continues.
        assert.deepEqual(overlayOf(right).blocks, [
            { from: null, styleId: 's1' },
            { from: 'b2', styleId: 's2' },
        ]);
    });
});

describe('a group editor that rewrites the groups', () => {
    it('drops the paint the removed group owned', () => {
        const line = withAnnotations(
            withRunStyles(rubyLine(), [
                { group: 'ruby', offset: 0, styleId: 'r' },
            ]),
            [
                {
                    group: 'ruby',
                    runOffset: 0,
                    offset: 0,
                    length: 2,
                    styleId: 'c',
                },
            ],
        );
        const bare = withGroup(line, 'ruby', null);
        assert.deepEqual(overlayOf(bare).runStyles, []);
        assert.deepEqual(overlayOf(bare).annotations, []);
        assert.equal(isValidLyricsLine(bare), true);
    });
});

describe('a merge keeps a block keyed on a real break', () => {
    it('only merges the tail entry that has no break of its own', () => {
        const head = withBlocks(textToLyricsLine('ab\n'), [
            { from: null, styleId: 'h' },
        ]);
        const tail = withBlocks(
            withInserted(textToLyricsLine('cdef\n'), [marker(1, 't1')]),
            [{ from: 't1', styleId: 't' }],
        );
        const merged = mergeLines(head, tail);
        assert.deepEqual(overlayOf(merged).blocks, [
            { from: null, styleId: 'h' },
            { from: 't1', styleId: 't' },
        ]);
    });
});

describe('a merge that lands on a run start', () => {
    it('drops a head run style that the junction would make ambiguous', () => {
        const head = withRunStyles(rubyLine(), [
            { group: 'ruby', offset: 2, styleId: 'r' },
        ]);
        const tail = rubyLine();
        const merged = mergeLines(head, tail);
        // After the merge a run does start at the junction (the tail's first),
        // so keeping the head's entry would silently repaint the tail instead
        // of dropping the entry the head owned.
        assert.deepEqual(overlayOf(merged).runStyles, []);
    });
});

describe('an annotation whose run went away', () => {
    it('dies with the run instead of surviving on a cell number', () => {
        const line = withAnnotations(rubyLine(), [
            { group: 'ruby', runOffset: 0, offset: 0, length: 2, styleId: 'c' },
        ]);
        const shorter = spliceLine(line, [0, 2], []);
        // A cell edit removes cells, not characters: the reading the annotation
        // paints is still there, but the run that owned it is not, so the entry
        // has nothing left to name.
        assert.deepEqual(overlayOf(shorter).annotations, []);
    });
});

describe('the project document reports every layer as an orphan', () => {
    it('does not stop at the cell runs', () => {
        const lyrics = textToLyrics('ab\n');
        const painted = {
            ...lyrics,
            lines: [
                withBlocks(lyrics.lines[0], [{ from: null, styleId: 'nope' }]),
            ],
        };
        const read = readProjectJson(lyricsToProjectJson(painted));
        assert.deepEqual(read.issues, [
            { code: 'style-orphan', styleId: 'nope' },
        ]);
    });

    it('writes the content of a definition with sorted keys', () => {
        const book = withStyle(emptyStyleBook(), 'chorus', {
            basedOn: null,
            content: {
                sizePx: 72,
                fill: { normal: { kind: 'solid', color: '#ffcc00' } },
            },
        });
        const lyrics = { ...textToLyrics('ab\n'), styleBook: book };
        const text = lyricsToProjectJson(lyrics);
        assert.ok(
            text.indexOf('"fill"') < text.indexOf('"sizePx"'),
            'the writer sorts content keys',
        );
    });
});
