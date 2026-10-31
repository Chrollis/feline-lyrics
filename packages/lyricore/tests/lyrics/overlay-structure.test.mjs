import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editLineText } from '../../src/main/lyrics/interpolate.js';
import {
    overlayOf,
    textToLyricsLine,
    withOverlay,
} from '../../src/main/lyrics/line.js';
import { mergeLines, splitLine } from '../../src/main/lyrics/structure.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';

function style(offset, length, styleId = 'A') {
    return { offset, length, styleId };
}

function marker(offset, id = 'br') {
    return {
        id,
        kind: 'soft-break',
        anchor: { offset, length: 0 },
        content: null,
    };
}

function image(offset, length, id = 'img') {
    return {
        id,
        kind: 'image',
        anchor: { offset, length },
        content: { type: 'image', src: 'a.png' },
    };
}

function painted(text, styles = [], inserted = []) {
    return withOverlay(textToLyricsLine(text), { styles, inserted });
}

function documentOf(...lines) {
    return { meta: emptyMeta(), lines };
}

describe('a text edit carries the overlay along', () => {
    it('shifts a run when characters are typed before it', () => {
        const before = documentOf(painted('abcd\n', [style(1, 2)]));
        const after = editLineText(before, 0, [0, 0], 'X', null);
        assert.deepEqual(overlayOf(after.lines[0]).styles, [style(2, 2)]);
    });

    it('keeps the paint on the cell a combining mark fused into', () => {
        // The keystroke does not add a cell: it merges two into one, which is
        // the case no caller can see and the reason the library owns the splice.
        const before = documentOf(painted('かa\n', [style(1, 1)]));
        const after = editLineText(before, 0, [1, 1], '\u3099', null);
        assert.equal(after.lines[0].baseStream.cells.length, 3);
        assert.deepEqual(overlayOf(after.lines[0]).styles, [style(1, 1)]);
    });

    it('moves a marker when a combining mark fuses two cells', () => {
        // Both marker positions are legal, so the assert cannot rescue this one:
        // the only thing that puts the marker at 2 is the fold's own splice.
        const before = documentOf(painted('かa\n', [], [marker(2)]));
        const after = editLineText(before, 0, [1, 1], '\u3099', null);
        assert.equal(after.lines[0].baseStream.cells.length, 3);
        assert.deepEqual(overlayOf(after.lines[0]).inserted[0].anchor, {
            offset: 2,
            length: 0,
        });
    });
});

describe('splitting a line splits its overlay', () => {
    it('cuts a painted run at the cut', () => {
        const [left, right] = splitLine(painted('abcd\n', [style(0, 4)]), 2);
        assert.deepEqual(overlayOf(left).styles, [style(0, 2)]);
        assert.deepEqual(overlayOf(right).styles, [style(0, 2)]);
    });

    it('sends a marker on the cut to the right half', () => {
        const [left, right] = splitLine(painted('abcd\n', [], [marker(2)]), 2);
        assert.deepEqual(overlayOf(left).inserted, []);
        assert.deepEqual(overlayOf(right).inserted, [marker(0)]);
    });

    it('clips a straddling anchor by its start, not by the cut alone', () => {
        const [left, right] = splitLine(
            painted('abcd\n', [], [image(1, 3)]),
            3,
        );
        assert.deepEqual(overlayOf(left).inserted[0].anchor, {
            offset: 1,
            length: 2,
        });
        assert.deepEqual(overlayOf(right).inserted, []);
    });
});

describe('merging two lines merges their overlays', () => {
    it('joins two runs of one style across the seam', () => {
        const merged = mergeLines(
            painted('ab\n', [style(1, 1)]),
            painted('cd\n', [style(0, 1)]),
        );
        assert.deepEqual(overlayOf(merged).styles, [style(1, 2)]);
    });

    it('keeps the two sides apart when their styles differ', () => {
        const merged = mergeLines(
            painted('ab\n', [style(0, 1, 'A')]),
            painted('cd\n', [style(0, 1, 'B')]),
        );
        assert.deepEqual(overlayOf(merged).styles, [
            style(0, 1, 'A'),
            style(2, 1, 'B'),
        ]);
    });

    it('keeps both seam objects, head first, and shifts the tail', () => {
        const merged = mergeLines(
            painted('ab\n', [], [marker(2, 'head')]),
            painted('cd\n', [], [marker(1, 'tail')]),
        );
        const inserted = overlayOf(merged).inserted;
        assert.deepEqual(
            inserted.map((object) => object.id),
            ['head', 'tail'],
        );
        assert.deepEqual(
            inserted.map((object) => object.anchor.offset),
            [2, 3],
        );
    });
});
