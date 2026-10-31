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
import type { SegRun } from './seg-run.js';

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

/**
 * A character style over one run's text.
 *
 * `runOffset` is the run's FIRST CELL, not a run index: an index would shift
 * under every splice, while a start cell moves with the run and dies with it.
 * `offset` and `length` count cells of that run's concatenated piece texts,
 * which is the only place a reading character lives.
 */
export interface AnnotationStyleRun {
    readonly group: string;
    readonly runOffset: number;
    readonly offset: number;
    readonly length: number;
    readonly styleId: string;
}

/** A layout style carried by one whole run: position, alignment, distance. */
export interface RunStyleRun {
    readonly group: string;
    /** The run's FIRST CELL in the line. */
    readonly offset: number;
    readonly styleId: string;
}

/** A layout style carried by one paragraph block. */
export interface BlockStyleRun {
    /** null = the line's first block. Otherwise the id of the soft break. */
    readonly from: string | null;
    readonly styleId: string;
}

/** The overlay of one line. An empty overlay is `NO_OVERLAY`. */
export interface LineOverlay {
    readonly styles: readonly StyleRun[];
    readonly inserted: readonly InsertedObject[];
    readonly blocks: readonly BlockStyleRun[];
    readonly runStyles: readonly RunStyleRun[];
    readonly annotations: readonly AnnotationStyleRun[];
}

// Shared frozen empties, so an unstyled line allocates nothing and two of them
// compare with `===` on the array.
export const EMPTY_STYLE_RUNS: readonly StyleRun[] = Object.freeze([]);

export const EMPTY_INSERTED_OBJECTS: readonly InsertedObject[] = Object.freeze(
    [],
);

export const EMPTY_BLOCK_STYLES: readonly BlockStyleRun[] = Object.freeze([]);

export const EMPTY_RUN_STYLES: readonly RunStyleRun[] = Object.freeze([]);

export const EMPTY_ANNOTATIONS: readonly AnnotationStyleRun[] = Object.freeze(
    [],
);

export const NO_OVERLAY: LineOverlay = Object.freeze({
    styles: EMPTY_STYLE_RUNS,
    inserted: EMPTY_INSERTED_OBJECTS,
    blocks: EMPTY_BLOCK_STYLES,
    runStyles: EMPTY_RUN_STYLES,
    annotations: EMPTY_ANNOTATIONS,
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
 * The run cut `splitLine` hands over.
 *
 * `textLength` is how many characters of the run stay on the left - the same cut
 * `cutPieces` takes on the run's text. `chars` is the run's whole text length, so
 * a caller can tell a fragment with text from one without: a run straddling the
 * cut at its very start leaves a right fragment that no style should land on.
 */
export interface RunCut {
    readonly group: string;
    readonly runOffset: number;
    readonly textLength: number;
    readonly chars: number;
}

/** Cells of a run's concatenated piece texts - the run's reading length. */
export function runTextCells(run: SegRun): number {
    let cells = 0;
    for (const piece of run.pieces) {
        cells += piece.text.cells.length;
    }
    return cells;
}

type GroupMap = Readonly<Record<string, readonly SegRun[]>>;

function groupAt(groups: GroupMap, group: string): readonly SegRun[] | null {
    if (!Object.hasOwn(groups, group)) {
        return null;
    }
    return groups[group] ?? null;
}

function runAt(groups: GroupMap, group: string, offset: number): SegRun | null {
    const runs = groupAt(groups, group);
    if (runs === null) {
        return null;
    }
    for (const run of runs) {
        if (run.offset === offset) {
            return run;
        }
    }
    return null;
}

/**
 * Where a run goes after one cell edit, or null when it does not survive.
 *
 * The same `spliceSpan` and the same bias the groups take, so an entry that
 * follows a run can never disagree with the run itself.
 */
function followRun(
    groups: GroupMap,
    group: string,
    offset: number,
    removed: readonly [number, number],
    inserted: number,
): SegRun | null {
    const run = runAt(groups, group, offset);
    if (run === null) {
        return null;
    }
    return spliceSpan(run, removed, inserted, 'none');
}

function spliceRunStyles(
    entries: readonly RunStyleRun[],
    groups: GroupMap,
    removed: readonly [number, number],
    inserted: number,
): readonly RunStyleRun[] {
    let changed = false;
    const next: RunStyleRun[] = [];
    for (const entry of entries) {
        const run = followRun(
            groups,
            entry.group,
            entry.offset,
            removed,
            inserted,
        );
        if (run === null) {
            changed = true;
            continue;
        }
        if (run.offset !== entry.offset) {
            changed = true;
            next.push({ ...entry, offset: run.offset });
            continue;
        }
        next.push(entry);
    }
    return changed ? next : entries;
}

/**
 * Annotations after one cell edit.
 *
 * A cell edit moves a run but never its text, so an annotation keeps its
 * character range and only follows its run. An entry whose run dies goes with
 * it - the run is the anchor, and there is nothing else to hold on to.
 */
function spliceAnnotations(
    entries: readonly AnnotationStyleRun[],
    groups: GroupMap,
    removed: readonly [number, number],
    inserted: number,
): readonly AnnotationStyleRun[] {
    let changed = false;
    const next: AnnotationStyleRun[] = [];
    for (const entry of entries) {
        const run = followRun(
            groups,
            entry.group,
            entry.runOffset,
            removed,
            inserted,
        );
        if (run === null) {
            changed = true;
            continue;
        }
        // The run survived, but the reading inside it may not: an entry that
        // reaches past the text that is left is dropped, never clamped, because
        // a clamped entry would paint cells the author did not choose.
        if (entry.offset + entry.length > runTextCells(run)) {
            changed = true;
            continue;
        }
        if (run.offset !== entry.runOffset) {
            changed = true;
            next.push({ ...entry, runOffset: run.offset });
            continue;
        }
        next.push(entry);
    }
    return changed ? next : entries;
}

/**
 * Annotations after one run's text changed.
 *
 * A text edit moves no cell, so the range stays where it was; what can change is
 * whether the run still holds it. An entry that reaches past the text that is
 * left is dropped, never clamped.
 */
export function retainAnnotationsFor(
    entries: readonly AnnotationStyleRun[],
    group: string,
    runOffset: number,
    cells: number,
): readonly AnnotationStyleRun[] {
    const kept = entries.filter(
        (entry) =>
            entry.group !== group ||
            entry.runOffset !== runOffset ||
            entry.offset + entry.length <= cells,
    );
    return kept.length === entries.length ? entries : kept;
}

/** Drop block styles whose break is gone: a block without its break is gone too. */
function keepLiveBlocks(
    entries: readonly BlockStyleRun[],
    inserted: readonly InsertedObject[],
): readonly BlockStyleRun[] {
    const live = new Set<string>();
    for (const object of inserted) {
        if (object.kind === 'soft-break') {
            live.add(object.id);
        }
    }
    const next = entries.filter(
        (entry) => entry.from === null || live.has(entry.from),
    );
    return next.length === entries.length ? entries : next;
}

/**
 * The overlay after one cell edit.
 *
 * `groups` is the line's groups BEFORE the edit, which is what `spliceLine`
 * still has in hand when it builds the overlay: the run each entry follows is
 * found there, not in the result. Every array keeps its own survival rule -
 * paint grows at its end, a covered run dies, a covered marker dies, a covered
 * object with content is re-anchored at the edit point at width zero, and the
 * three spaces that hang on a run follow it or die with it.
 *
 * A splice that changes no array returns `overlay` itself, so an edit that
 * changes nothing stays a no-op all the way up to the line.
 */
export function spliceOverlay(
    overlay: LineOverlay,
    groups: GroupMap,
    removed: readonly [number, number],
    inserted: number,
): LineOverlay {
    const styles = spliceStyleRuns(overlay.styles, removed, inserted);
    const objects = spliceInserted(overlay.inserted, removed, inserted);
    const runStyles = spliceRunStyles(
        overlay.runStyles,
        groups,
        removed,
        inserted,
    );
    const annotations = spliceAnnotations(
        overlay.annotations,
        groups,
        removed,
        inserted,
    );
    const blocks = keepLiveBlocks(overlay.blocks, objects);
    if (
        styles === overlay.styles &&
        objects === overlay.inserted &&
        runStyles === overlay.runStyles &&
        annotations === overlay.annotations &&
        blocks === overlay.blocks
    ) {
        return overlay;
    }
    return { styles, inserted: objects, blocks, runStyles, annotations };
}

function cutKey(group: string, runOffset: number): string {
    return `${JSON.stringify(group)}:${runOffset}`;
}

/**
 * The two overlays of a line cut at `at`.
 *
 * `at` is the same cut `splitLine` takes: the left half owns cells `[0, at)`
 * and the right half owns `[at, cells.length)`. `cuts` describes the runs that
 * straddle it, which is the only thing this function cannot see for itself: a
 * run's character cut lives in `cutPieces`, not in the overlay.
 *
 * Paint is cut in two - a region has no identity to lose. An inserted object
 * follows its anchor START. A run style is COPIED onto a straddled run's right
 * fragment, because the right half has a run too - unless that fragment has no
 * reading text left, in which case the style stays with the text. An annotation
 * follows its characters. A block style follows the block that holds its text,
 * and a cut strictly inside a styled block starts the right line's first block
 * with a copy of that style.
 */
export function splitOverlay(
    overlay: LineOverlay,
    at: number,
    cuts: readonly RunCut[],
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

    const cutOf = new Map<string, RunCut>();
    for (const cut of cuts) {
        cutOf.set(cutKey(cut.group, cut.runOffset), cut);
    }

    const leftRunStyles: RunStyleRun[] = [];
    const rightRunStyles: RunStyleRun[] = [];
    for (const entry of overlay.runStyles) {
        if (entry.offset >= at) {
            rightRunStyles.push({ ...entry, offset: entry.offset - at });
            continue;
        }
        leftRunStyles.push(entry);
        const cut = cutOf.get(cutKey(entry.group, entry.offset));
        if (
            cut !== undefined &&
            cut.textLength > 0 &&
            cut.chars > cut.textLength
        ) {
            rightRunStyles.push({ ...entry, offset: 0 });
        }
    }

    const leftAnnotations: AnnotationStyleRun[] = [];
    const rightAnnotations: AnnotationStyleRun[] = [];
    for (const entry of overlay.annotations) {
        if (entry.runOffset >= at) {
            rightAnnotations.push({
                ...entry,
                runOffset: entry.runOffset - at,
            });
            continue;
        }
        const cut = cutOf.get(cutKey(entry.group, entry.runOffset));
        if (cut === undefined) {
            leftAnnotations.push(entry);
            continue;
        }
        const end = entry.offset + entry.length;
        const leftEnd = Math.min(end, cut.textLength);
        if (leftEnd > entry.offset) {
            leftAnnotations.push({ ...entry, length: leftEnd - entry.offset });
        }
        if (end > cut.textLength) {
            const start =
                Math.max(entry.offset, cut.textLength) - cut.textLength;
            rightAnnotations.push({
                ...entry,
                runOffset: 0,
                offset: start,
                length: end - cut.textLength - start,
            });
        }
    }

    // A block starts at the first soft break and at each break after it.
    const starts: { from: string | null; offset: number }[] = [
        { from: null, offset: 0 },
    ];
    for (const object of overlay.inserted) {
        if (object.kind === 'soft-break') {
            starts.push({ from: object.id, offset: object.anchor.offset });
        }
    }

    const leftBlocks: BlockStyleRun[] = [];
    const rightBlocks: BlockStyleRun[] = [];
    for (const entry of overlay.blocks) {
        if (entry.from === null) {
            leftBlocks.push(entry);
            continue;
        }
        const start = starts.find((key) => key.from === entry.from);
        if (start === undefined || start.offset < at) {
            leftBlocks.push(entry);
            continue;
        }
        rightBlocks.push(entry);
    }
    const holder = starts[starts.length - 1];
    const inside =
        holder !== undefined &&
        holder.offset < at &&
        !starts.some((key) => key.offset === at);
    const styled = inside
        ? overlay.blocks.find((entry) => entry.from === holder.from)
        : undefined;
    if (styled !== undefined) {
        rightBlocks.unshift({ from: null, styleId: styled.styleId });
    }

    return [
        {
            styles: leftStyles,
            inserted: leftObjects,
            blocks: leftBlocks,
            runStyles: leftRunStyles,
            annotations: leftAnnotations,
        },
        {
            styles: rightStyles,
            inserted: rightObjects,
            blocks: rightBlocks,
            runStyles: rightRunStyles,
            annotations: rightAnnotations,
        },
    ];
}

/**
 * The overlay of two lines joined at `junction`.
 *
 * `junction` is the index `mergeLines` uses: `tail`'s cell 0 becomes cell
 * `junction` of the result. Paint and objects concatenate with that shift, and
 * the styles are merged because the seam can bring two runs of one id together.
 *
 * A head run style at `junction` names the head's TERMINAL run, which the merge
 * drops - so it is dropped here too, explicitly, because after the merge a run
 * does start at `junction` (the tail's first) and a filter would silently
 * re-target the entry instead of losing it. The tail's first block continues the
 * head's last one, so its style is dropped unless the head had no block at all.
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
        tail.inserted.length === 0 &&
        head.blocks.length === 0 &&
        tail.blocks.length === 0 &&
        head.runStyles.length === 0 &&
        tail.runStyles.length === 0 &&
        head.annotations.length === 0 &&
        tail.annotations.length === 0
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
    const runStyles = [
        ...head.runStyles.filter((entry) => entry.offset !== junction),
        ...tail.runStyles.map((entry) => ({
            ...entry,
            offset: entry.offset + junction,
        })),
    ];
    const annotations = [
        ...head.annotations,
        ...tail.annotations.map((entry) => ({
            ...entry,
            runOffset: entry.runOffset + junction,
        })),
    ];
    const tailBlocks = tail.blocks.filter(
        (entry, index) => index > 0 || head.blocks.length === 0,
    );
    const blocks = [...head.blocks, ...tailBlocks];
    return { styles, inserted, blocks, runStyles, annotations };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type OverlayProblemCode =
    | 'invalid-style-run'
    | 'invalid-inserted-object'
    | 'invalid-block-style'
    | 'invalid-run-style'
    | 'invalid-annotation-style';

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

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * What the overlay has to be checked against: a body length, and the runs of
 * the line the entries in the three run-keyed spaces name.
 *
 * The lookup is a function rather than a record because the caller may not want
 * to hand its groups out, and `null` means the group is not on this line at all.
 */
export interface OverlayContext {
    readonly body: number;
    readonly runsOf: (group: string) => readonly SegRun[] | null;
}

/**
 * The whole overlay against one line. Returns null when it is valid.
 *
 * The context is passed in rather than derived from a line, because this module
 * may not import line.ts - and because the same function then serves the line,
 * the project reader and the mutation paths without any of them handing over a
 * line. `body` and the run lookup are all a line can contribute.
 */
export function overlayProblem(
    overlay: LineOverlay,
    ctx: OverlayContext,
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
        const defect = styleRunProblem(run, ctx.body);
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
        const defect = insertedObjectProblem(object, ctx.body);
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

    // The three spaces that hang on a line's shape rather than on cell indices:
    // block styles key on a break id, the other two on a run's first cell.
    const blocks: readonly unknown[] = overlay.blocks;
    if (!Array.isArray(blocks)) {
        return {
            code: 'invalid-block-style',
            message: 'overlay.blocks: is not an array',
        };
    }
    const breakIds: string[] = [];
    for (const object of overlay.inserted) {
        if (object.kind === 'soft-break') {
            breakIds.push(object.id);
        }
    }
    // Every block of a line starts at the line's own beginning or at a break, in
    // that order: `null` first, then the breaks as `inserted` holds them.
    const keys: (string | null)[] = [null, ...breakIds];
    let keyIndex = -1;
    for (let index = 0; index < blocks.length; index += 1) {
        const path = `overlay.blocks[${index}]`;
        const entry = asRecord(blocks[index]);
        if (entry === null) {
            return {
                code: 'invalid-block-style',
                message: `${path}: is not an object`,
            };
        }
        const styleId = entry['styleId'];
        if (typeof styleId !== 'string' || styleId === '') {
            return {
                code: 'invalid-block-style',
                message: `${path}.styleId: is empty`,
            };
        }
        const from = entry['from'];
        if (from === undefined) {
            return {
                code: 'invalid-block-style',
                message: `${path}.from: is missing, and null is how a first block is written`,
            };
        }
        if (from !== null && typeof from !== 'string') {
            return {
                code: 'invalid-block-style',
                message: `${path}.from: is not null or a break id`,
            };
        }
        const at = keys.indexOf(from, keyIndex + 1);
        if (at <= keyIndex) {
            return {
                code: 'invalid-block-style',
                message:
                    typeof from === 'string' && !breakIds.includes(from)
                        ? `${path}.from: names no soft break on this line`
                        : `${path}.from: is not the block this line has here`,
            };
        }
        keyIndex = at;
    }

    const runStyles: readonly unknown[] = overlay.runStyles;
    if (!Array.isArray(runStyles)) {
        return {
            code: 'invalid-run-style',
            message: 'overlay.runStyles: is not an array',
        };
    }
    let lastStyleGroup = '';
    let lastStyleOffset = -1;
    for (let index = 0; index < runStyles.length; index += 1) {
        const path = `overlay.runStyles[${index}]`;
        const entry = asRecord(runStyles[index]);
        if (entry === null) {
            return {
                code: 'invalid-run-style',
                message: `${path}: is not an object`,
            };
        }
        const group = entry['group'];
        if (typeof group !== 'string' || group === '') {
            return {
                code: 'invalid-run-style',
                message: `${path}.group: is empty`,
            };
        }
        const styleId = entry['styleId'];
        if (typeof styleId !== 'string' || styleId === '') {
            return {
                code: 'invalid-run-style',
                message: `${path}.styleId: is empty`,
            };
        }
        const runs = ctx.runsOf(group);
        if (runs === null) {
            return {
                code: 'invalid-run-style',
                message: `${path}.group: names no group on this line`,
            };
        }
        const offset = entry['offset'];
        if (
            typeof offset !== 'number' ||
            !Number.isSafeInteger(offset) ||
            offset < 0
        ) {
            return {
                code: 'invalid-run-style',
                message: `${path}.offset: is not a run start`,
            };
        }
        if (!runs.some((run) => run.offset === offset)) {
            return {
                code: 'invalid-run-style',
                message: `${path}.offset: is not the first cell of a run`,
            };
        }
        if (
            index > 0 &&
            (group < lastStyleGroup ||
                (group === lastStyleGroup && offset <= lastStyleOffset))
        ) {
            return {
                code: 'invalid-run-style',
                message: `${path}: is out of order or repeated`,
            };
        }
        lastStyleGroup = group;
        lastStyleOffset = offset;
    }

    const annotations: readonly unknown[] = overlay.annotations;
    if (!Array.isArray(annotations)) {
        return {
            code: 'invalid-annotation-style',
            message: 'overlay.annotations: is not an array',
        };
    }
    let lastNoteGroup = '';
    let lastNoteRun = -1;
    let lastNoteEnd = -1;
    for (let index = 0; index < annotations.length; index += 1) {
        const path = `overlay.annotations[${index}]`;
        const entry = asRecord(annotations[index]);
        if (entry === null) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}: is not an object`,
            };
        }
        const group = entry['group'];
        if (typeof group !== 'string' || group === '') {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.group: is empty`,
            };
        }
        const styleId = entry['styleId'];
        if (typeof styleId !== 'string' || styleId === '') {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.styleId: is empty`,
            };
        }
        const runs = ctx.runsOf(group);
        if (runs === null) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.group: names no group on this line`,
            };
        }
        const runOffset = entry['runOffset'];
        if (
            typeof runOffset !== 'number' ||
            !Number.isSafeInteger(runOffset) ||
            runOffset < 0
        ) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.runOffset: is not a run start`,
            };
        }
        const run = runs.find((candidate) => candidate.offset === runOffset);
        if (run === undefined) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.runOffset: is not the first cell of a run`,
            };
        }
        const offset = entry['offset'];
        if (
            typeof offset !== 'number' ||
            !Number.isSafeInteger(offset) ||
            offset < 0
        ) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.offset: is not a cell of the run`,
            };
        }
        const length = entry['length'];
        if (
            typeof length !== 'number' ||
            !Number.isSafeInteger(length) ||
            length < 1
        ) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.length: is not a positive cell count`,
            };
        }
        const cells = runTextCells(run);
        if (offset + length > cells) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}.offset: runs past the ${cells} cells of the run`,
            };
        }
        const sameRun =
            index > 0 && group === lastNoteGroup && runOffset === lastNoteRun;
        if (
            index > 0 &&
            (group < lastNoteGroup ||
                (group === lastNoteGroup &&
                    (runOffset < lastNoteRun ||
                        (sameRun && offset < lastNoteEnd))))
        ) {
            return {
                code: 'invalid-annotation-style',
                message: `${path}: is out of order or overlaps the entry before it`,
            };
        }
        lastNoteGroup = group;
        lastNoteRun = runOffset;
        lastNoteEnd = offset + length;
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
export function assertOverlay(overlay: LineOverlay, ctx: OverlayContext): void {
    const problem = overlayProblem(overlay, ctx);
    if (problem === null) {
        return;
    }
    throw new LyricoreError(problem.code, problem.message, {
        expected: 'a valid overlay',
    });
}
