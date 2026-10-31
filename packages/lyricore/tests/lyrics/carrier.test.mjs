import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    emptyLyricsLine,
    overlayOf,
    spliceLine,
    textToLyricsLine,
    withCheck,
    withGroup,
    withOverlay as withOverlayAll,
} from '../../src/main/lyrics/line.js';
import { textToLyrics } from '../../src/main/lyrics/lyrics.js';
import { NO_OVERLAY } from '../../src/main/lyrics/overlay.js';
import { mergeLines, splitLine } from '../../src/main/lyrics/structure.js';

// These cases paint cells and place objects; the three group-keyed spaces stay
// empty. The arrays are shared so the identity fast path can still see "the
// same overlay" across two calls.
const NONE = [];

function withOverlay(line, partial) {
    return withOverlayAll(line, {
        blocks: NONE,
        runStyles: NONE,
        annotations: NONE,
        ...partial,
    });
}

function style(offset, length, styleId = 'hl') {
    return { offset, length, styleId };
}

describe('the overlay carrier', () => {
    it('gives every constructed line an empty overlay', () => {
        assert.equal(textToLyricsLine('あい\n').overlay, NO_OVERLAY);
        assert.equal(
            emptyLyricsLine({ cells: [] }).overlay,
            NO_OVERLAY,
            'the empty stream shares the frozen empty overlay',
        );
    });

    it('reads a line built before the field existed as unstyled', () => {
        const bare = { baseStream: { cells: [] }, groups: {} };
        assert.equal(overlayOf(bare), NO_OVERLAY);
    });

    it('returns the line itself when the overlay is unchanged', () => {
        const line = textToLyricsLine('あい\n');
        assert.equal(withOverlay(line, NO_OVERLAY), line);
        const styles = [style(0, 1)];
        const inserted = [];
        const styled = withOverlay(line, { styles, inserted });
        // Identity, not structure: the same arrays are what makes it a no-op.
        assert.equal(withOverlay(styled, { styles, inserted }), styled);
    });

    it('writes an overlay that fits the body', () => {
        // 'あい\n' has three cells, so the body is cells 0 and 1.
        const styled = withOverlay(textToLyricsLine('あい\n'), {
            styles: [style(1, 1)],
            inserted: [],
        });
        assert.deepEqual(styled.overlay.styles, [style(1, 1)]);
    });

    it('rejects a style run that reaches the break cell', () => {
        const line = textToLyricsLine('あい\n');
        assert.throws(
            () => withOverlay(line, { styles: [style(2, 1)], inserted: [] }),
            (error) => error.code === 'invalid-cell-style',
        );
        assert.throws(
            () => withOverlay(line, { styles: [style(0, 3)], inserted: [] }),
            (error) => error.code === 'invalid-cell-style',
        );
    });

    it('rejects an inserted object anchored past the body', () => {
        const line = textToLyricsLine('あい\n');
        assert.throws(
            () =>
                withOverlay(line, {
                    styles: [],
                    inserted: [
                        {
                            id: 'br1',
                            kind: 'soft-break',
                            anchor: { offset: 3, length: 0 },
                            content: null,
                        },
                    ],
                }),
            (error) => error.code === 'invalid-inserted-object',
        );
    });
});

// The carrier is only half the story: every edit path rebuilds a line, and each
// of them can drop the overlay without any other test noticing. These edit a
// STYLED line and look at what survived.
describe('the overlay survives an edit', () => {
    const UNSET = NO_OVERLAY.inserted;

    function piece(text) {
        return { check: null, text: textToStream(text) };
    }

    function run(offset, length, texts) {
        return { offset, length, pieces: texts.map(piece) };
    }

    function terminal(offset) {
        return { offset, length: 1, pieces: [piece('')] };
    }

    // A group has to end with a terminal run on the break cell.
    function twoCellGroup() {
        return [run(0, 2, ['あ', 'い']), terminal(2)];
    }

    function cell(text) {
        return { text, span: null };
    }

    function styled(text, styles) {
        return withOverlay(textToLyricsLine(text), { styles, inserted: UNSET });
    }

    it('gives each built line its own group map', () => {
        const left = emptyLyricsLine({ cells: [] });
        const right = emptyLyricsLine({ cells: [] });
        assert.notEqual(left.groups, right.groups);
    });

    it('keeps the groups when only the overlay changes', () => {
        const original = withGroup(
            textToLyricsLine('あい\n'),
            'ruby',
            twoCellGroup(),
        );
        const painted = withOverlay(original, {
            styles: [style(0, 1)],
            inserted: UNSET,
        });
        assert.notEqual(painted, original);
        assert.deepEqual(Object.keys(painted.groups), ['ruby']);
    });

    it('keeps the overlay when a group is removed', () => {
        const ran = withGroup(
            styled('あい\n', [style(0, 1)]),
            'ruby',
            twoCellGroup(),
        );
        const removed = withGroup(ran, 'ruby', null);
        assert.deepEqual(overlayOf(removed).styles, [style(0, 1)]);
    });

    it('keeps the overlay when a check is stored', () => {
        const ran = withGroup(
            styled('あい\n', [style(0, 1)]),
            'ruby',
            twoCellGroup(),
        );
        const tapped = withCheck(
            ran,
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            { time: 10, type: 'KeyDown' },
        );
        assert.deepEqual(overlayOf(tapped).styles, [style(0, 1)]);
    });

    it('keeps the overlay when a group is replaced', () => {
        const ran = withGroup(
            styled('あい\n', [style(0, 1)]),
            'ruby',
            twoCellGroup(),
        );
        const replaced = withGroup(ran, 'ruby', [
            run(0, 2, ['か', 'き']),
            terminal(2),
        ]);
        assert.deepEqual(overlayOf(replaced).styles, [style(0, 1)]);
    });

    it('does not treat one matching layer as an unchanged overlay', () => {
        const before = styled('あい\n', [style(0, 1)]);
        const after = withOverlay(before, {
            styles: [style(1, 1)],
            inserted: UNSET,
        });
        assert.notEqual(after, before);
        assert.deepEqual(after.overlay.styles, [style(1, 1)]);
    });

    it('moves the styles with the cells it splices', () => {
        const before = styled('あいう\n', [style(1, 2)]);
        const after = spliceLine(before, [0, 0], [cell('え')]);
        assert.deepEqual(
            overlayOf(after).styles.map((span) => [span.offset, span.length]),
            [[2, 2]],
        );
    });

    it('splits the styles with the line', () => {
        const [left, right] = splitLine(styled('あい\n', [style(0, 2)]), 1);
        assert.deepEqual(overlayOf(left).styles, [style(0, 1)]);
        assert.deepEqual(overlayOf(right).styles, [style(0, 1)]);
    });

    it('moves the styles of the second line to the seam', () => {
        const merged = mergeLines(
            textToLyricsLine('あ\n'),
            styled('い\n', [style(0, 1)]),
        );
        assert.deepEqual(overlayOf(merged).styles, [style(1, 1)]);
    });

    it('gives every line of a parsed text the empty overlay', () => {
        assert.equal(textToLyrics('あい\n').lines[0].overlay, NO_OVERLAY);
    });
});
