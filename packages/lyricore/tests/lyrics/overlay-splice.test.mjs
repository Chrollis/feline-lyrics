import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    NO_OVERLAY,
    joinOverlay,
    splitOverlay as splitOverlayAll,
    spliceOverlay as spliceOverlayAll,
} from '../../src/main/lyrics/overlay.js';

// The three group-keyed spaces are empty in every case below, so one empty
// group map serves them all; the wrappers keep the call sites about the one
// thing each test is checking.
const GROUPS = {};

function spliceOverlay(overlay, removed, inserted) {
    return spliceOverlayAll(overlay, GROUPS, removed, inserted);
}

function splitOverlay(overlay, at) {
    return splitOverlayAll(overlay, at, []);
}

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

function overlay(styles = [], inserted = []) {
    return { styles, inserted, blocks: [], runStyles: [], annotations: [] };
}

// The seven rows of the survival matrix in 10-overlay-spec.md section 4, on a
// line whose body is four cells: one painted run over the first two, one marker
// sitting on the boundary between them and the rest.
describe('splicing one edit into an overlay', () => {
    const before = overlay([style(0, 2)], [marker(2)]);

    it('shifts a run and a marker when cells are typed before them', () => {
        const after = spliceOverlay(before, [0, 0], 1);
        assert.deepEqual(after.styles, [style(1, 2)]);
        assert.deepEqual(after.inserted, [marker(3)]);
    });

    it('grows paint typed at its end without moving the marker there', () => {
        const after = spliceOverlay(before, [2, 2], 1);
        assert.deepEqual(after.styles, [style(0, 3)]);
        assert.deepEqual(after.inserted, [marker(3)]);
    });

    it('grows paint typed inside it', () => {
        const after = spliceOverlay(before, [1, 1], 1);
        assert.deepEqual(after.styles, [style(0, 3)]);
        assert.deepEqual(after.inserted, [marker(3)]);
    });

    it('drops paint a deletion covers and keeps the marker on the edge', () => {
        const after = spliceOverlay(before, [0, 2], 0);
        assert.deepEqual(after.styles, []);
        assert.deepEqual(after.inserted, [marker(0)]);
    });

    it('keeps the left part when the hole is at the right end', () => {
        const after = spliceOverlay(before, [1, 2], 0);
        assert.deepEqual(after.styles, [style(0, 1)]);
        assert.deepEqual(after.inserted, [marker(1)]);
    });

    it('re-anchors when the hole is at the left end', () => {
        const after = spliceOverlay(before, [0, 1], 0);
        assert.deepEqual(after.styles, [style(0, 1)]);
        assert.deepEqual(after.inserted, [marker(1)]);
    });

    it('drops a marker the deletion covers', () => {
        const after = spliceOverlay(before, [1, 3], 0);
        assert.deepEqual(after.styles, [style(0, 1)]);
        assert.deepEqual(after.inserted, []);
    });

    it('returns the same overlay when the edit touches nothing', () => {
        assert.equal(
            spliceOverlay(before, [5, 5], 0),
            before,
            'an edit past every span keeps the value identical',
        );
    });

    it('does not widen an anchor typed at its own end', () => {
        // The inserted layer keeps the `none` bias: an anchor names characters,
        // so cells typed after it are not part of it.
        const anchors = overlay([], [image(2, 2)]);
        assert.equal(spliceOverlay(anchors, [4, 4], 1), anchors);
    });
});

// The dry-run finding A1: an object clamped to width zero by one deletion must
// not be read as a marker by the next one. The rule keys on `content`, and this
// is the pair of edits that proves it.
describe('a content object survives what a marker does not', () => {
    it('clamps a covered image to the edit point and keeps it there', () => {
        const once = spliceOverlay(overlay([], [image(2, 2)]), [2, 4], 0);
        assert.equal(once.inserted.length, 1);
        assert.deepEqual(once.inserted[0].anchor, { offset: 2, length: 0 });

        const twice = spliceOverlay(once, [1, 3], 0);
        assert.equal(twice.inserted.length, 1, 'the image is not a marker');
        assert.equal(twice.inserted[0].id, 'img');
        assert.deepEqual(twice.inserted[0].anchor, { offset: 1, length: 0 });
    });

    it('lets the same two edits kill a marker', () => {
        const once = spliceOverlay(overlay([], [marker(2)]), [2, 4], 0);
        assert.deepEqual(once.inserted, [marker(2)]);
        assert.deepEqual(spliceOverlay(once, [1, 3], 0).inserted, []);
    });
});

describe('splitting a line splits its overlay', () => {
    it('cuts a run that straddles the cut in two', () => {
        const [left, right] = splitOverlay(overlay([style(0, 4)]), 2);
        assert.deepEqual(left.styles, [style(0, 2)]);
        assert.deepEqual(right.styles, [style(0, 2)]);
    });

    it('gives the left half nothing when the cut is at its first cell', () => {
        const [left, right] = splitOverlay(overlay([style(0, 4)]), 0);
        assert.deepEqual(left.styles, []);
        assert.deepEqual(right.styles, [style(0, 4)]);
    });

    it('cuts an uneven run by each side, not by the same number', () => {
        // A symmetric cut cannot tell `at - offset` from `end - at`.
        const [left, right] = splitOverlay(overlay([style(1, 3)]), 2);
        assert.deepEqual(left.styles, [style(1, 1)]);
        assert.deepEqual(right.styles, [style(0, 2)]);
    });

    it('sends a marker sitting on the cut to the right half', () => {
        const [left, right] = splitOverlay(overlay([], [marker(2)]), 2);
        assert.deepEqual(left.inserted, []);
        assert.deepEqual(right.inserted, [marker(0)]);
    });

    it('clips a straddling anchor to the half it starts on', () => {
        const [left, right] = splitOverlay(overlay([], [image(1, 2)]), 2);
        assert.equal(left.inserted.length, 1);
        assert.deepEqual(left.inserted[0].anchor, { offset: 1, length: 1 });
        assert.deepEqual(right.inserted, []);
    });
});

describe('joining two lines joins their overlays', () => {
    it('merges two runs of one style across the seam', () => {
        const joined = joinOverlay(
            overlay([style(1, 2)]),
            overlay([style(0, 1)]),
            3,
        );
        assert.deepEqual(joined.styles, [style(1, 3)]);
    });

    it('keeps both markers on the seam, head first', () => {
        const joined = joinOverlay(
            overlay([], [marker(3, 'head')]),
            overlay([], [marker(0, 'tail')]),
            3,
        );
        assert.deepEqual(
            joined.inserted.map((object) => object.id),
            ['head', 'tail'],
        );
        assert.deepEqual(
            joined.inserted.map((object) => object.anchor.offset),
            [3, 3],
        );
    });

    it('joins two empty overlays into the shared empty one', () => {
        assert.equal(joinOverlay(NO_OVERLAY, NO_OVERLAY, 0), NO_OVERLAY);
    });

    it('shifts a tail anchor by its own width, not as a marker', () => {
        const joined = joinOverlay(overlay(), overlay([], [image(0, 2)]), 3);
        assert.deepEqual(joined.inserted[0].anchor, { offset: 3, length: 2 });
    });

    it('merges the seam after shifting the tail, not before', () => {
        const joined = joinOverlay(
            overlay([style(0, 2, 'A')]),
            overlay([style(0, 2, 'A'), style(2, 2, 'B')]),
            2,
        );
        assert.deepEqual(joined.styles, [style(0, 4, 'A'), style(4, 2, 'B')]);
    });
});
