// The overlay layer: style runs and inserted objects carried by one lyric line.
//
// This module is a leaf on purpose. It imports errors.ts and time.ts and nothing
// else - never line.ts, not even as a type. line.ts imports THIS module, so the
// reverse direction would be a cycle, and the rule is easier to check than an
// explanation of why the cycle is fine.
//
// Coordinates are cell indices on the line body, the same ones SegRun uses, so
// every splice here is the same algebra the deleted private splice run used for
// groups: one shared primitive, three personalities (see `spliceSpan` and the
// two collection splices below).

import { LyricoreError } from '../errors.js';
import { isValidSpan, type TimeSpan } from './time.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A range of cells on the line body: `offset` up to `offset + length`. */
export interface CellSpan {
    readonly offset: number;
    readonly length: number;
}

/** A style applied to a stretch of cells. No id: a style run is a pure range. */
export interface StyleRun extends CellSpan {
    readonly styleId: string;
}

export interface TextContent {
    readonly type: 'text';
    readonly lines: readonly string[];
    readonly styleId?: string;
}

export interface ImageContent {
    readonly type: 'image';
    readonly src: string;
    readonly wipedSrc?: string | null;
    readonly scale?: number | null;
}

/** Closed union: a new member is a change to the stored project format. */
export type InsertContent = TextContent | ImageContent;

/**
 * An object placed in the line: a display break, a badge, a still image.
 *
 * `anchor.length === 0` means the object sits between two cells and moves with
 * them. A wider anchor binds the object to that stretch of lyrics, so its
 * display time is the time of those cells unless `time` pins it explicitly.
 */
export interface InsertedObject {
    readonly id: string;
    readonly kind: string;
    readonly anchor: CellSpan;
    readonly content: InsertContent | null;
    readonly time?: TimeSpan;
}

/** The overlay of one line. An empty overlay is `NO_OVERLAY`. */
export interface LineOverlay {
    readonly styles: readonly StyleRun[];
    readonly inserted: readonly InsertedObject[];
}

// Shared frozen empties, so an unstyled line allocates nothing and two of them
// compare with `===` on the array.
export const EMPTY_STYLE_RUNS: readonly StyleRun[] = Object.freeze([]);

export const EMPTY_INSERTED_OBJECTS: readonly InsertedObject[] = Object.freeze(
    [],
);

export const NO_OVERLAY: LineOverlay = Object.freeze({
    styles: EMPTY_STYLE_RUNS,
    inserted: EMPTY_INSERTED_OBJECTS,
});

// ---------------------------------------------------------------------------
// The shared splice primitive
// ---------------------------------------------------------------------------

/**
 * Which side of an insertion a span claims.
 *
 * `none` is what a run does: a cell inserted exactly at a boundary belongs to
 * neither neighbour, so the span does not grow. `left` is what a style does: a
 * style is a paint region, and typing at the end of a painted word should keep
 * painting. The two differ in exactly one case - an insertion at `p === offset + length`.
 */
export type SpanBias = 'left' | 'none';

/**
 * Splice one cell span across one edit.
 *
 * `removed` is the half-open cell range the edit replaced and `inserted` is how
 * many cells replaced it, so `removed[0] === removed[1]` makes this an insertion
 * at that index. `delta` is derived here rather than passed in.
 *
 * Returns the same object when the span is untouched, a new span when it grows,
 * shrinks or shifts, and null when the edit covered the span completely. Null
 * means "the span is gone", not "delete it": a caller with durable content
 * re-anchors instead (see `spliceInserted`).
 */
export function spliceSpan<S extends CellSpan>(
    span: S,
    removed: readonly [number, number],
    inserted: number,
    bias: SpanBias,
): S | null {
    const [removedStart, removedEnd] = removed;
    const start = span.offset;
    const end = span.offset + span.length;

    if (removedStart === removedEnd) {
        // An insertion inside the span grows it; one on a boundary claims
        // nothing unless the bias says the left neighbour takes the cells.
        if (removedStart > start && removedStart < end) {
            return { ...span, length: span.length + inserted };
        }
        if (start >= removedStart) {
            return { ...span, offset: start + inserted };
        }
        if (bias === 'left' && removedStart === end) {
            return { ...span, length: span.length + inserted };
        }
        return span;
    }

    const delta = inserted - (removedEnd - removedStart);
    if (end <= removedStart) {
        return span;
    }
    if (start >= removedEnd) {
        return { ...span, offset: start + delta };
    }
    // The edit sits strictly inside the span: it survives whole and only
    // changes width, which is what retyping a character inside a word does.
    if (start < removedStart && removedEnd < end) {
        return { ...span, length: span.length + delta };
    }
    const leftLength = Math.min(end, removedStart) - start;
    if (leftLength > 0) {
        return { ...span, length: leftLength };
    }
    const rightLength = end - removedEnd;
    if (rightLength > 0) {
        return {
            ...span,
            offset: removedStart + inserted,
            length: rightLength,
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// The two collection splices
// ---------------------------------------------------------------------------

/**
 * Adjacent runs with one styleId are one run; the canonical form has no seams.
 *
 * Exported because the same merge is a post-condition of joining two half-lines
 * back together, and a second copy of these lines would be one more place to
 * forget it.
 */
export function mergeAdjacentStyleRuns(
    runs: readonly StyleRun[],
): readonly StyleRun[] {
    const merged: StyleRun[] = [];
    for (const run of runs) {
        const previous = merged[merged.length - 1];
        if (
            previous !== undefined &&
            previous.styleId === run.styleId &&
            previous.offset + previous.length === run.offset
        ) {
            merged[merged.length - 1] = {
                ...previous,
                length: previous.length + run.length,
            };
            continue;
        }
        merged.push(run);
    }
    return merged;
}

/**
 * Splice the style layer.
 *
 * A style is paint, so it has `left` bias: cells typed at the end of a painted
 * word are painted too. A style covered completely by a deletion is dropped - it
 * can be re-applied with one click, unlike an inserted object.
 *
 * The result is canonical: splicing can bring two runs with one styleId
 * together (delete the gap between them), and every caller would then have to
 * remember to merge, so the merge is a post-condition here.
 */
export function spliceStyleRuns(
    runs: readonly StyleRun[],
    removed: readonly [number, number],
    inserted: number,
): readonly StyleRun[] {
    const spliced: StyleRun[] = [];
    let changed = false;
    for (const run of runs) {
        const span = spliceSpan(run, removed, inserted, 'left');
        if (span === null) {
            changed = true;
            continue;
        }
        if (span !== run) {
            changed = true;
        }
        spliced.push(span);
    }
    // An unchanged splice returns the input array, so a no-op edit stays
    // reference-equal all the way up to the line.
    return changed ? mergeAdjacentStyleRuns(spliced) : runs;
}

/**
 * Splice the inserted layer.
 *
 * An anchor names specific cells, so it has `none` bias: it must not swallow
 * neighbours. What a covered anchor means is decided by `content`, never by the
 * width:
 *
 * - a marker (`content === null`) is dropped, because a break whose text is gone
 *   has nothing left to break;
 * - an object with content is never destroyed - deleting the word an image was
 *   attached to must not delete the image - so it clamps to the deletion point
 *   at width zero and survives.
 *
 * Keying that decision on the width instead of on `content` is a live bug: an
 * object clamped to width zero by one edit would be dropped as a marker by the
 * next one.
 */
export function spliceInserted(
    objects: readonly InsertedObject[],
    removed: readonly [number, number],
    inserted: number,
): readonly InsertedObject[] {
    const spliced: InsertedObject[] = [];
    let changed = false;
    for (const object of objects) {
        const span = spliceSpan(object.anchor, removed, inserted, 'none');
        if (span !== null) {
            if (span !== object.anchor) {
                changed = true;
            }
            spliced.push(
                span === object.anchor ? object : { ...object, anchor: span },
            );
            continue;
        }
        changed = true;
        if (object.content === null) {
            continue;
        }
        spliced.push({
            ...object,
            anchor: { offset: removed[0] + inserted, length: 0 },
        });
    }
    return changed ? spliced : objects;
}

// ---------------------------------------------------------------------------
// Whole-overlay edits
// ---------------------------------------------------------------------------

/**
 * The overlay after one cell edit.
 *
 * Both layers go through the same primitive with their own affinity - paint
 * takes the cells typed at its end, an anchor never does - and each keeps its
 * own survival rule: a covered run dies, a covered marker dies, a covered
 * object with content is re-anchored at the edit point at width zero.
 *
 * A splice that changes neither layer returns `overlay` itself, so an edit that
 * changes nothing stays a no-op all the way up to the line.
 */
export function spliceOverlay(
    overlay: LineOverlay,
    removed: readonly [number, number],
    inserted: number,
): LineOverlay {
    const styles = spliceStyleRuns(overlay.styles, removed, inserted);
    const objects = spliceInserted(overlay.inserted, removed, inserted);
    if (styles === overlay.styles && objects === overlay.inserted) {
        return overlay;
    }
    return { styles, inserted: objects };
}

/**
 * The two overlays of a line cut at `at`.
 *
 * `at` is the same cut `splitLine` takes: the left half owns cells `[0, at)`
 * and the right half owns `[at, cells.length)`. A run straddling the cut is cut
 * in two - a paint region has no identity to lose - because leaving it whole on
 * either side would paint cells that are no longer there.
 *
 * An inserted object follows its anchor START, and its anchor is clipped to the
 * left side when the cut falls inside it, so one id never lands on both halves.
 * A marker exactly at `at` goes right: the same `>=` convention `spliceSpan`
 * uses when an insertion shifts a span.
 */
export function splitOverlay(
    overlay: LineOverlay,
    at: number,
): readonly [LineOverlay, LineOverlay] {
    const leftStyles: StyleRun[] = [];
    const rightStyles: StyleRun[] = [];
    for (const run of overlay.styles) {
        const end = run.offset + run.length;
        if (end <= at) {
            leftStyles.push(run);
            continue;
        }
        if (run.offset >= at) {
            rightStyles.push({ ...run, offset: run.offset - at });
            continue;
        }
        leftStyles.push({ ...run, length: at - run.offset });
        rightStyles.push({ ...run, offset: 0, length: end - at });
    }

    const leftObjects: InsertedObject[] = [];
    const rightObjects: InsertedObject[] = [];
    for (const object of overlay.inserted) {
        const start = object.anchor.offset;
        if (start >= at) {
            rightObjects.push({
                ...object,
                anchor: { offset: start - at, length: object.anchor.length },
            });
            continue;
        }
        const kept = Math.min(object.anchor.length, at - start);
        leftObjects.push(
            kept === object.anchor.length
                ? object
                : { ...object, anchor: { offset: start, length: kept } },
        );
    }

    return [
        { styles: leftStyles, inserted: leftObjects },
        { styles: rightStyles, inserted: rightObjects },
    ];
}

/**
 * The overlay of two lines joined at `junction`.
 *
 * `junction` is the index `mergeLines` uses: `tail`'s cell 0 becomes cell
 * `junction` of the result. Both layers simply concatenate with that shift, and
 * the styles are then merged because the seam can bring two runs of one id
 * together - the canonical form forbids that pair.
 *
 * Inserted objects are NOT deduplicated: two markers landing on the seam is the
 * user's own cut, and the order is head first.
 */
export function joinOverlay(
    head: LineOverlay,
    tail: LineOverlay,
    junction: number,
): LineOverlay {
    if (
        head.styles.length === 0 &&
        tail.styles.length === 0 &&
        head.inserted.length === 0 &&
        tail.inserted.length === 0
    ) {
        return NO_OVERLAY;
    }
    const styles = mergeAdjacentStyleRuns([
        ...head.styles,
        ...tail.styles.map((run) => ({
            ...run,
            offset: run.offset + junction,
        })),
    ]);
    const inserted = [
        ...head.inserted,
        ...tail.inserted.map((object) => ({
            ...object,
            anchor: {
                offset: object.anchor.offset + junction,
                length: object.anchor.length,
            },
        })),
    ];
    return { styles, inserted };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type OverlayProblemCode =
    'invalid-style-run' | 'invalid-inserted-object';

export interface OverlayProblem {
    readonly code: OverlayProblemCode;
    readonly message: string;
}

/**
 * One defect: a path relative to the item, plus what is wrong there.
 *
 * The field is empty when the whole item is wrong rather than one of its keys.
 * Keeping the field separate is what lets the collection predicates build the
 * `overlay.styles[2].offset` paths the file reader reports, while each item
 * predicate stays a flat list of checks.
 */
export interface OverlayDefect {
    readonly field: string;
    readonly detail: string;
}

const INSERTED_ID = /^[A-Za-z0-9_-]{1,32}$/;

function insertContentProblem(content: InsertContent): OverlayDefect | null {
    if (content.type === 'text') {
        if (!Array.isArray(content.lines) || content.lines.length === 0) {
            return {
                field: 'content.lines',
                detail: 'needs a non-empty array of strings',
            };
        }
        if (!content.lines.every((line) => typeof line === 'string')) {
            return { field: 'content.lines', detail: 'must all be strings' };
        }
        if (
            content.styleId !== undefined &&
            typeof content.styleId !== 'string'
        ) {
            return {
                field: 'content.styleId',
                detail: 'must be a string when present',
            };
        }
        return null;
    }
    if (content.type === 'image') {
        if (typeof content.src !== 'string') {
            return { field: 'content.src', detail: 'must be a string' };
        }
        if (
            content.wipedSrc !== undefined &&
            content.wipedSrc !== null &&
            typeof content.wipedSrc !== 'string'
        ) {
            return {
                field: 'content.wipedSrc',
                detail: 'must be a string or null when present',
            };
        }
        if (content.scale === undefined || content.scale === null) {
            return null;
        }
        if (
            typeof content.scale !== 'number' ||
            !Number.isFinite(content.scale) ||
            content.scale <= 0
        ) {
            return {
                field: 'content.scale',
                detail: 'must be a positive finite number or null',
            };
        }
        return null;
    }
    // The type says `never` here; JSON does not, which is what this guards.
    return { field: 'content.type', detail: 'is not a known member' };
}

// `kind` is open, so only the pairs the model knows about can disagree. This runs
// for null content too: `text` and `image` REQUIRE their content, and a missing
// one is the same contradiction as a wrong one.
function pairingProblem(
    kind: string,
    content: InsertContent | null,
): OverlayDefect | null {
    const type = content === null ? null : content.type;
    if (kind === 'soft-break' && type !== null) {
        return { field: 'content', detail: 'is not null on a soft break' };
    }
    if (kind === 'text' && type !== 'text') {
        return {
            field: 'content',
            detail: 'is not text content, which kind text requires',
        };
    }
    if (kind === 'image' && type !== 'image') {
        return {
            field: 'content',
            detail: 'is not image content, which kind image requires',
        };
    }
    return null;
}

/**
 * One style run against one body length. `body` is `cells.length - 1`: a style
 * may never cover the line break, unlike a group which must end on it.
 *
 * Every check here is a row of the load-time table whose verdict is "reject"; a
 * check with no row there would be an invented rule.
 */
export function styleRunProblem(
    run: StyleRun,
    body: number,
): OverlayDefect | null {
    if (!Number.isInteger(run.offset) || run.offset < 0) {
        return { field: 'offset', detail: 'is not a non-negative integer' };
    }
    if (!Number.isInteger(run.length) || run.length < 1) {
        return { field: 'length', detail: 'is not a positive integer' };
    }
    if (typeof run.styleId !== 'string' || run.styleId === '') {
        return { field: 'styleId', detail: 'is not a non-empty string' };
    }
    if (run.offset + run.length > body) {
        return {
            field: '',
            detail: `covers the line break: the body is ${body} cells long`,
        };
    }
    return null;
}

/** One inserted object against one body length. See `styleRunProblem`. */
export function insertedObjectProblem(
    object: InsertedObject,
    body: number,
): OverlayDefect | null {
    if (typeof object.id !== 'string' || !INSERTED_ID.test(object.id)) {
        return {
            field: 'id',
            detail: 'does not match /^[A-Za-z0-9_-]{1,32}$/',
        };
    }
    if (typeof object.kind !== 'string' || object.kind === '') {
        return { field: 'kind', detail: 'is not a non-empty string' };
    }
    // A value read back from JSON can hold anything, and this predicate is how
    // a bad document is reported: it has to answer, not throw.
    const anchor: unknown = object.anchor;
    if (typeof anchor !== 'object' || anchor === null) {
        return { field: 'anchor', detail: 'is not a span' };
    }
    const { offset, length } = anchor as { offset?: unknown; length?: unknown };
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        return {
            field: 'anchor.offset',
            detail: 'is not a non-negative integer',
        };
    }
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
        return {
            field: 'anchor.length',
            detail: 'is not a non-negative integer',
        };
    }
    if (object.content === undefined) {
        return {
            field: 'content',
            detail: 'is missing: write null for a zero-width marker',
        };
    }
    if (object.content === null) {
        if (length !== 0) {
            return {
                field: 'content',
                detail: 'is null but the anchor is not zero width',
            };
        }
    } else {
        const contentProblem = insertContentProblem(object.content);
        if (contentProblem !== null) {
            return contentProblem;
        }
    }
    const pairing = pairingProblem(object.kind, object.content);
    if (pairing !== null) {
        return pairing;
    }
    if (object.time !== undefined && !isValidSpan(object.time)) {
        return { field: 'time', detail: 'is not a valid span' };
    }
    if (object.anchor.length === 0) {
        // Both edges are legal: deleting the first cell moves a marker to 0 and
        // splitting a line moves one to the new start.
        if (object.anchor.offset > body) {
            return {
                field: 'anchor.offset',
                detail: `sits after the end of a body that is ${body} cells long`,
            };
        }
        return null;
    }
    if (
        object.anchor.offset > body - 1 ||
        object.anchor.offset + object.anchor.length > body
    ) {
        return {
            field: 'anchor',
            detail: `is outside the body: the body is ${body} cells long`,
        };
    }
    return null;
}

function describe(path: string, defect: OverlayDefect): string {
    const where = defect.field === '' ? path : `${path}.${defect.field}`;
    return `${where}: ${defect.detail}`;
}

/**
 * The whole overlay against one body length. Returns null when it is valid.
 *
 * `body` is passed in rather than derived from a line, because this module may
 * not import line.ts - and because the same function then serves the line, the
 * project reader and the mutation paths without any of them handing over a line.
 */
export function overlayProblem(
    overlay: LineOverlay,
    body: number,
): OverlayProblem | null {
    // The type says these are arrays. A value read back from JSON can still lie,
    // and a raw TypeError out of this function would look like a caller bug
    // rather than a bad document.
    if (!Array.isArray(overlay.styles)) {
        return {
            code: 'invalid-style-run',
            message: 'overlay.styles: is not an array',
        };
    }
    if (!Array.isArray(overlay.inserted)) {
        return {
            code: 'invalid-inserted-object',
            message: 'overlay.inserted: is not an array',
        };
    }

    let previousEnd = 0;
    for (let index = 0; index < overlay.styles.length; index += 1) {
        const run = overlay.styles[index];
        const path = `overlay.styles[${index}]`;
        if (run === undefined) {
            return {
                code: 'invalid-style-run',
                message: `${path}: is missing`,
            };
        }
        const defect = styleRunProblem(run, body);
        if (defect !== null) {
            return {
                code: 'invalid-style-run',
                message: describe(path, defect),
            };
        }
        if (run.offset < previousEnd) {
            return {
                code: 'invalid-style-run',
                message: `${path}.offset: overlaps the run before it`,
            };
        }
        previousEnd = run.offset + run.length;
    }

    // Ties are legal and keep their written order, so this only rejects a
    // decrease.
    let previousOffset = 0;
    for (let index = 0; index < overlay.inserted.length; index += 1) {
        const object = overlay.inserted[index];
        const path = `overlay.inserted[${index}]`;
        if (object === undefined) {
            return {
                code: 'invalid-inserted-object',
                message: `${path}: is missing`,
            };
        }
        const defect = insertedObjectProblem(object, body);
        if (defect !== null) {
            return {
                code: 'invalid-inserted-object',
                message: describe(path, defect),
            };
        }
        if (object.anchor.offset < previousOffset) {
            return {
                code: 'invalid-inserted-object',
                message: `${path}.anchor.offset: is before the object before it`,
            };
        }
        previousOffset = object.anchor.offset;
    }

    return null;
}

/**
 * Throw unless the overlay is valid.
 *
 * The offending path goes into the message rather than into `context`: the error
 * context only has `expected` and `actual`, and the file reader already carries
 * its own paths the same way.
 */
export function assertOverlay(overlay: LineOverlay, body: number): void {
    const problem = overlayProblem(overlay, body);
    if (problem === null) {
        return;
    }
    throw new LyricoreError(problem.code, problem.message, {
        expected: 'a valid overlay',
    });
}
