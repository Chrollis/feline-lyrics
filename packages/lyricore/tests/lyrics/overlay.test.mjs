import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LyricoreError } from '../../src/main/errors.js';
import {
    EMPTY_INSERTED_OBJECTS,
    EMPTY_STYLE_RUNS,
    NO_OVERLAY,
    assertOverlay,
    mergeAdjacentStyleRuns,
    overlayProblem,
    spliceInserted,
    spliceSpan,
    spliceStyleRuns,
    styleRunProblem,
    insertedObjectProblem,
} from '../../src/main/lyrics/overlay.js';

const BODY = 5;

function style(offset, length, styleId = 'a') {
    return { offset, length, styleId };
}

function marker(offset, id = 'm', kind = 'soft-break') {
    return { id, kind, anchor: { offset, length: 0 }, content: null };
}

function image(offset, length) {
    return {
        id: `i${offset}`,
        kind: 'image',
        anchor: { offset, length },
        content: { type: 'image', src: 'cover.png' },
    };
}

// The predicates return a defect or null; the assertions care about the wording.
function text(defect) {
    return defect === null ? null : `${defect.field}: ${defect.detail}`;
}

describe('spliceSpan', () => {
    it('leaves a span untouched and keeps its identity', () => {
        const span = style(0, 2);
        assert.equal(spliceSpan(span, [3, 3], 1, 'none'), span);
        assert.equal(spliceSpan(span, [2, 4], 0, 'none'), span);
        assert.equal(spliceSpan(span, [3, 4], 0, 'none'), span);
    });

    it('claims nothing on a boundary at bias none and grows at bias left', () => {
        const span = style(1, 2);
        assert.deepEqual(spliceSpan(span, [3, 3], 2, 'none'), style(1, 2));
        assert.deepEqual(spliceSpan(span, [3, 3], 2, 'left'), style(1, 4));
        // An insertion at or before the start shifts under either bias.
        assert.deepEqual(spliceSpan(span, [1, 1], 2, 'none'), style(3, 2));
        assert.deepEqual(spliceSpan(span, [1, 1], 2, 'left'), style(3, 2));
        assert.deepEqual(spliceSpan(span, [0, 0], 2, 'none'), style(3, 2));
    });

    it('grows over an insertion strictly inside at either bias', () => {
        assert.deepEqual(
            spliceSpan(style(0, 3), [1, 1], 2, 'none'),
            style(0, 5),
        );
        assert.deepEqual(
            spliceSpan(style(0, 3), [1, 1], 2, 'left'),
            style(0, 5),
        );
    });

    it('survives a hole strictly inside with a changed width', () => {
        assert.deepEqual(
            spliceSpan(style(1, 4), [2, 3], 1, 'none'),
            style(1, 4),
        );
        assert.deepEqual(
            spliceSpan(style(1, 4), [2, 4], 1, 'none'),
            style(1, 3),
        );
        assert.deepEqual(
            spliceSpan(style(1, 4), [2, 3], 2, 'none'),
            style(1, 5),
        );
    });

    it('keeps the left or the right fragment on a one-sided bite', () => {
        assert.deepEqual(
            spliceSpan(style(1, 4), [0, 3], 0, 'none'),
            style(0, 2),
        );
        assert.deepEqual(
            spliceSpan(style(1, 4), [3, 6], 0, 'none'),
            style(1, 2),
        );
    });

    it('returns null only when the edit covered the whole span', () => {
        assert.equal(spliceSpan(style(2, 2), [1, 5], 0, 'none'), null);
        assert.equal(spliceSpan(style(2, 2), [2, 4], 0, 'none'), null);
        assert.equal(spliceSpan(style(2, 2), [2, 4], 1, 'none'), null);
        // A same-size replacement still covers: delta 0 must not mean "keep".
        assert.equal(spliceSpan(style(1, 2), [0, 4], 4, 'none'), null);
    });

    it('does not treat a zero-width span as a range', () => {
        const point = { offset: 3, length: 0 };
        assert.deepEqual(spliceSpan(point, [1, 2], 0, 'none'), {
            offset: 2,
            length: 0,
        });
        assert.deepEqual(spliceSpan(point, [3, 3], 1, 'none'), {
            offset: 4,
            length: 0,
        });
        assert.deepEqual(spliceSpan(point, [4, 4], 1, 'none'), point);
        assert.deepEqual(spliceSpan(point, [2, 3], 0, 'none'), {
            offset: 2,
            length: 0,
        });
        assert.deepEqual(spliceSpan(point, [0, 1], 0, 'none'), {
            offset: 2,
            length: 0,
        });
    });
});

describe('spliceStyleRuns', () => {
    it('grows a style over an insertion at its end', () => {
        assert.deepEqual(spliceStyleRuns([style(0, 2)], [2, 2], 1), [
            style(0, 3),
        ]);
        assert.deepEqual(spliceStyleRuns([style(0, 2)], [1, 1], 1), [
            style(0, 3),
        ]);
        assert.deepEqual(spliceStyleRuns([style(1, 2)], [3, 3], 2), [
            style(1, 4),
        ]);
    });

    it('drops a style the edit covered completely', () => {
        assert.deepEqual(spliceStyleRuns([style(1, 2)], [0, 4], 0), []);
        assert.deepEqual(spliceStyleRuns([style(1, 2)], [0, 4], 4), []);
    });

    it('keeps a hole inside one run as one run', () => {
        assert.deepEqual(spliceStyleRuns([style(0, 4)], [1, 3], 1), [
            style(0, 3),
        ]);
    });

    it('merges two runs of one styleId that a deletion brought together', () => {
        const runs = [style(0, 1, 'bold'), style(2, 1, 'bold')];
        assert.deepEqual(spliceStyleRuns(runs, [1, 2], 0), [
            style(0, 2, 'bold'),
        ]);
    });

    it('does not merge runs of different styleId', () => {
        const runs = [style(0, 1, 'bold'), style(2, 1, 'italic')];
        assert.deepEqual(spliceStyleRuns(runs, [1, 2], 0), [
            style(0, 1, 'bold'),
            style(1, 1, 'italic'),
        ]);
    });

    it('does not merge two runs of one styleId across a surviving gap', () => {
        const runs = [style(0, 1, 'a'), style(3, 1, 'a')];
        assert.deepEqual(spliceStyleRuns(runs, [1, 2], 0), [
            style(0, 1, 'a'),
            style(2, 1, 'a'),
        ]);
    });
});

describe('mergeAdjacentStyleRuns', () => {
    it('joins touching runs of one styleId and leaves a gap alone', () => {
        assert.deepEqual(
            mergeAdjacentStyleRuns([style(0, 1, 'a'), style(1, 2, 'a')]),
            [style(0, 3, 'a')],
        );
        assert.deepEqual(
            mergeAdjacentStyleRuns([style(0, 1, 'a'), style(2, 1, 'a')]),
            [style(0, 1, 'a'), style(2, 1, 'a')],
        );
        assert.deepEqual(
            mergeAdjacentStyleRuns([style(0, 1, 'a'), style(1, 1, 'b')]),
            [style(0, 1, 'a'), style(1, 1, 'b')],
        );
    });
});

describe('spliceInserted', () => {
    it('drops a marker the edit covered', () => {
        assert.deepEqual(spliceInserted([marker(3)], [2, 4], 0), []);
        assert.deepEqual(spliceInserted([marker(2)], [1, 3], 2), []);
    });

    it('shifts a marker an insertion pushed right', () => {
        assert.deepEqual(spliceInserted([marker(2)], [1, 1], 2), [marker(4)]);
        assert.deepEqual(spliceInserted([marker(2)], [2, 2], 2), [marker(4)]);
        assert.deepEqual(spliceInserted([marker(3)], [4, 4], 2), [marker(3)]);
        assert.deepEqual(spliceInserted([marker(3)], [3, 4], 1), [marker(3)]);
    });

    it('does not swallow cells at an anchor end', () => {
        assert.deepEqual(spliceInserted([image(1, 2)], [3, 3], 2)[0].anchor, {
            offset: 1,
            length: 2,
        });
        // The contrast with a style, which does grow there.
        assert.deepEqual(spliceStyleRuns([style(1, 2)], [3, 3], 2), [
            style(1, 4),
        ]);
    });

    it('keeps a content object and clamps it to the deletion point', () => {
        assert.deepEqual(spliceInserted([image(2, 2)], [2, 4], 0)[0].anchor, {
            offset: 2,
            length: 0,
        });
    });

    it('clamps to the deletion point plus what replaced it', () => {
        assert.deepEqual(spliceInserted([image(1, 2)], [1, 3], 2)[0].anchor, {
            offset: 3,
            length: 0,
        });
        assert.deepEqual(spliceInserted([image(1, 2)], [0, 2], 1)[0].anchor, {
            offset: 1,
            length: 1,
        });
    });

    it('keeps an already clamped content object, with its content, on the next edit', () => {
        const once = spliceInserted([image(2, 2)], [2, 4], 0);
        assert.deepEqual(
            once.map((object) => object.anchor),
            [{ offset: 2, length: 0 }],
        );
        const twice = spliceInserted(once, [1, 3], 0);
        assert.equal(twice.length, 1);
        assert.deepEqual(twice[0].anchor, { offset: 1, length: 0 });
        assert.deepEqual(twice[0].content, image(2, 2).content);
        assert.equal(twice[0].id, 'i2');
    });

    it('shrinks a content object with a hole inside it and keeps its content', () => {
        const shrunk = spliceInserted([image(1, 4)], [2, 4], 1);
        assert.deepEqual(shrunk[0].anchor, { offset: 1, length: 3 });
        assert.deepEqual(shrunk[0].content, image(1, 4).content);
    });

    it('keeps objects in written order and never adds one', () => {
        const kept = spliceInserted([marker(1), image(3, 1)], [0, 1], 0);
        assert.deepEqual(
            kept.map((object) => object.anchor),
            [
                { offset: 0, length: 0 },
                { offset: 2, length: 1 },
            ],
        );
    });
});

describe('overlay validation', () => {
    it('accepts the empty overlay', () => {
        assert.equal(NO_OVERLAY.styles, EMPTY_STYLE_RUNS);
        assert.equal(NO_OVERLAY.inserted, EMPTY_INSERTED_OBJECTS);
        assert.equal(overlayProblem(NO_OVERLAY, BODY), null);
        assert.equal(overlayProblem(NO_OVERLAY, 0), null);
        assertOverlay(NO_OVERLAY, BODY);
    });

    it('accepts a style that reaches the last body cell', () => {
        assert.equal(styleRunProblem(style(0, BODY), BODY), null);
        assert.equal(styleRunProblem(style(4, 1), BODY), null);
    });

    it('accepts two touching runs of one styleId', () => {
        const touching = {
            ...NO_OVERLAY,
            styles: [style(0, 1, 'x'), style(1, 1, 'x')],
        };
        assert.equal(overlayProblem(touching, BODY), null);
    });

    it('rejects a style that covers the line break', () => {
        const problem = overlayProblem(
            { ...NO_OVERLAY, styles: [style(4, 2)] },
            BODY,
        );
        assert.equal(problem.code, 'invalid-style-run');
        assert.match(problem.message, /line break/);
    });

    it('rejects unsorted or overlapping runs', () => {
        const problem = overlayProblem(
            { ...NO_OVERLAY, styles: [style(0, 3), style(2, 1)] },
            BODY,
        );
        assert.equal(problem.code, 'invalid-style-run');
        assert.match(problem.message, /overlaps/);
    });

    it('rejects a run with no styleId', () => {
        assert.match(
            text(styleRunProblem({ offset: 0, length: 1, styleId: '' }, BODY)),
            /styleId/,
        );
    });

    it('reports a full path in the message', () => {
        assert.equal(
            overlayProblem({ ...NO_OVERLAY, styles: [style(4, 2)] }, BODY)
                .message,
            'overlay.styles[0]: covers the line break: the body is 5 cells long',
        );
        assert.equal(
            overlayProblem(
                { ...NO_OVERLAY, inserted: [marker(BODY + 1)] },
                BODY,
            ).message,
            'overlay.inserted[0].anchor.offset: sits after the end of a body that is 5 cells long',
        );
    });

    it('rejects a layer that is not an array', () => {
        assert.equal(
            overlayProblem({ styles: {}, inserted: [] }, BODY).message,
            'overlay.styles: is not an array',
        );
        assert.equal(
            overlayProblem({ styles: [], inserted: null }, BODY).message,
            'overlay.inserted: is not an array',
        );
    });

    it('accepts a marker at both edges of the body', () => {
        assert.equal(insertedObjectProblem(marker(0), BODY), null);
        assert.equal(insertedObjectProblem(marker(BODY), BODY), null);
        assert.equal(
            overlayProblem(
                {
                    ...NO_OVERLAY,
                    inserted: [marker(0, 'm0'), marker(BODY, 'm1')],
                },
                BODY,
            ),
            null,
        );
    });

    it('rejects a marker past the end of the body', () => {
        assert.match(
            text(insertedObjectProblem(marker(BODY + 1), BODY)),
            /after the end/,
        );
    });

    it('rejects a width-bearing anchor that runs past the body', () => {
        assert.match(
            text(insertedObjectProblem(image(4, 2), BODY)),
            /outside the body/,
        );
        assert.equal(insertedObjectProblem(image(3, 2), BODY), null);
    });

    it('rejects an id outside the grammar', () => {
        assert.match(
            text(
                insertedObjectProblem({ ...marker(1), id: 'no spaces' }, BODY),
            ),
            /does not match/,
        );
    });

    it('rejects null content on a width-bearing anchor', () => {
        assert.match(
            text(
                insertedObjectProblem(
                    { ...marker(1), anchor: { offset: 1, length: 2 } },
                    BODY,
                ),
            ),
            /is null but the anchor is not zero width/,
        );
    });

    it('rejects a known kind whose content is missing or of the wrong type', () => {
        assert.match(
            text(insertedObjectProblem({ ...marker(1), kind: 'text' }, BODY)),
            /text content/,
        );
        assert.match(
            text(insertedObjectProblem({ ...marker(1), kind: 'image' }, BODY)),
            /image content/,
        );
        const mismatched = { ...image(1, 1), kind: 'text' };
        assert.match(
            text(insertedObjectProblem(mismatched, BODY)),
            /text content/,
        );
        const broke = { ...image(1, 1), kind: 'soft-break' };
        assert.match(text(insertedObjectProblem(broke, BODY)), /not null/);
    });

    it('leaves an unknown kind alone but still checks its content', () => {
        const badge = {
            id: 'b1',
            kind: 'badge',
            anchor: { offset: 1, length: 0 },
            content: { type: 'text', lines: ['NEW'] },
        };
        assert.equal(insertedObjectProblem(badge, BODY), null);
        const empty = { ...badge, content: { type: 'text', lines: [] } };
        assert.match(
            text(insertedObjectProblem(empty, BODY)),
            /non-empty array/,
        );
    });

    it('rejects malformed content for each member', () => {
        const base = {
            id: 'b1',
            kind: 'badge',
            anchor: { offset: 1, length: 0 },
        };
        assert.match(
            text(
                insertedObjectProblem(
                    { ...base, content: { type: 'text', lines: [1] } },
                    BODY,
                ),
            ),
            /strings/,
        );
        assert.match(
            text(
                insertedObjectProblem(
                    { ...base, content: { type: 'image', src: 1 } },
                    BODY,
                ),
            ),
            /src/,
        );
        assert.match(
            text(
                insertedObjectProblem(
                    { ...base, content: { type: 'image', src: 'a', scale: 0 } },
                    BODY,
                ),
            ),
            /scale/,
        );
        assert.equal(
            insertedObjectProblem(
                { ...base, content: { type: 'image', src: 'a', scale: null } },
                BODY,
            ),
            null,
        );
    });

    it('accepts a negative time start and rejects an inverted span', () => {
        assert.equal(
            insertedObjectProblem(
                { ...marker(1), time: { start: -500, duration: 900 } },
                BODY,
            ),
            null,
        );
        assert.match(
            text(
                insertedObjectProblem(
                    { ...marker(1), time: { start: 0, duration: -1 } },
                    BODY,
                ),
            ),
            /time/,
        );
    });

    it('rejects a decrease in anchor order but keeps ties', () => {
        const tied = {
            ...NO_OVERLAY,
            inserted: [marker(2, 'm0'), marker(2, 'm1')],
        };
        assert.equal(overlayProblem(tied, BODY), null);
        const unordered = {
            ...NO_OVERLAY,
            inserted: [marker(3, 'm0'), marker(2, 'm1')],
        };
        assert.equal(
            overlayProblem(unordered, BODY).code,
            'invalid-inserted-object',
        );
    });

    it('throws a LyricoreError with the layer code', () => {
        assert.throws(
            () => assertOverlay({ ...NO_OVERLAY, styles: [style(4, 2)] }, BODY),
            (error) =>
                error instanceof LyricoreError &&
                error.code === 'invalid-style-run',
        );
        assert.throws(
            () =>
                assertOverlay(
                    { ...NO_OVERLAY, inserted: [marker(BODY + 1)] },
                    BODY,
                ),
            (error) =>
                error instanceof LyricoreError &&
                error.code === 'invalid-inserted-object',
        );
    });
});
