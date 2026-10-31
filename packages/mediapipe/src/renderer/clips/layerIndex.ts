// Timeline index, doc section 15.1: one index per layer, buckets of 250 ms,
// a playback cursor, and binary-search snapping. The index is derived state:
// the clip array is the truth. Rebuild only when the array identity changes
// (layerIndexFor caches by identity); never rebuild per pointer move.

import { compareTopmost, coversAt } from './clips.js';
import type { Clip } from './clips.js';

/** Bucket width in milliseconds. A 10-minute song is 2400 buckets. */
export const BUCKET_MS = 250;

export interface PlaybackCursor {
    bucket: number;
    tMs: number;
    /** Next unconsumed index into `startIds`. */
    nextStart: number;
    ids: number[];
}

export interface LayerIndex {
    readonly clips: readonly Clip[];
    /** Sorted clip starts (snapping). */
    readonly starts: Int32Array;
    /** Sorted clip ends (snapping). */
    readonly ends: Int32Array;
    /** Ids ordered by clip start, parallel to `starts`. */
    readonly startIds: readonly number[];
    /** bucket b holds ids of clips intersecting [b*BUCKET_MS, (b+1)*BUCKET_MS). */
    readonly buckets: readonly (readonly number[])[];
    cursor: PlaybackCursor | null;
}

function assertSpans(clips: readonly Clip[]): void {
    for (const clip of clips) {
        const { startMs, durationMs } = clip.span;
        if (
            !Number.isInteger(startMs) ||
            !Number.isInteger(durationMs) ||
            durationMs < 0
        ) {
            throw new TypeError(
                `clip ${clip.id}: span must be integer milliseconds with a non-negative duration`,
            );
        }
    }
}

export function buildLayerIndex(clips: readonly Clip[]): LayerIndex {
    assertSpans(clips);
    const n = clips.length;
    const starts = new Int32Array(n);
    const ends = new Int32Array(n);
    let maxEnd = 0;
    for (let i = 0; i < n; i += 1) {
        const startMs = clips[i].span.startMs;
        starts[i] = startMs;
        ends[i] = startMs + clips[i].span.durationMs;
        if (ends[i] > maxEnd) {
            maxEnd = ends[i];
        }
    }
    const bucketCount = Math.max(1, Math.ceil(maxEnd / BUCKET_MS));
    const buckets: number[][] = new Array(bucketCount);
    for (let b = 0; b < bucketCount; b += 1) {
        buckets[b] = [];
    }
    for (let i = 0; i < n; i += 1) {
        if (clips[i].span.durationMs === 0) {
            continue;
        }
        const first = Math.floor(starts[i] / BUCKET_MS);
        const last = Math.floor((ends[i] - 1) / BUCKET_MS);
        for (let b = first; b <= last; b += 1) {
            buckets[b].push(i);
        }
    }
    starts.sort();
    ends.sort();
    const startIds: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
        startIds[i] = i;
    }
    startIds.sort(
        (a, b) => clips[a].span.startMs - clips[b].span.startMs || a - b,
    );

    return { clips, starts, ends, startIds, buckets, cursor: null };
}

const indexCache = new WeakMap<readonly Clip[], LayerIndex>();

/**
 * The index for a clip array, rebuilt only when the array identity changes.
 * A fresh document means a fresh array; the cached index must not outlive
 * in-place mutation of its array (the engine rebuilds on new identities).
 */
export function layerIndexFor(clips: readonly Clip[]): LayerIndex {
    let index = indexCache.get(clips);
    if (index === undefined) {
        index = buildLayerIndex(clips);
        indexCache.set(clips, index);
    }
    return index;
}

/** Negative and NaN times cover nothing; NaN would also poison the cursor. */
function isRejected(tMs: number): boolean {
    return !(tMs >= 0);
}

/**
 * Clips covering tMs, written into `out` (cleared first) so the frame loop
 * can reuse one array. O(k) with k = clips in one bucket, never O(n). A
 * bucket holds each id at most once, so no dedupe stamp is needed.
 */
export function activeInto(
    index: LayerIndex,
    tMs: number,
    out: Clip[],
): Clip[] {
    out.length = 0;
    if (isRejected(tMs)) {
        return out;
    }
    const bucket = Math.floor(tMs / BUCKET_MS);
    if (bucket >= index.buckets.length) {
        return out;
    }
    for (const id of index.buckets[bucket]) {
        const clip = index.clips[id];
        if (coversAt(clip, tMs)) {
            out.push(clip);
        }
    }
    return out;
}

/** Allocating form of activeInto, for callers that do not own a buffer. */
export function activeAt(index: LayerIndex, tMs: number): Clip[] {
    return activeInto(index, tMs, []);
}

/** The clip a pointer would grab at tMs: highest layer, then z, then id. */
export function topmostAt(index: LayerIndex, tMs: number): Clip | null {
    if (isRejected(tMs)) {
        return null;
    }
    const bucket = Math.floor(tMs / BUCKET_MS);
    if (bucket >= index.buckets.length) {
        return null;
    }
    let best: Clip | null = null;
    for (const id of index.buckets[bucket]) {
        const clip = index.clips[id];
        if (!coversAt(clip, tMs)) {
            continue;
        }
        if (best === null || compareTopmost(clip, best) < 0) {
            best = clip;
        }
    }
    return best;
}

function rebuildCursor(index: LayerIndex, bucket: number, tMs: number): void {
    const ids: number[] = [];
    if (bucket < index.buckets.length) {
        for (const id of index.buckets[bucket]) {
            if (coversAt(index.clips[id], tMs)) {
                ids.push(id);
            }
        }
    }
    index.cursor = {
        bucket,
        tMs,
        nextStart: upperBound(index.starts, tMs),
        ids,
    };
}

/**
 * Playback path, written into `out`. New clips enter through a binary search
 * on the globally sorted starts; ended ids are compacted in place. A backward
 * or far jump rebuilds from one bucket. Forward cost is O(log n + entered +
 * left) per tick, independent of clip count.
 */
export function playbackInto(
    index: LayerIndex,
    tMs: number,
    out: Clip[],
): Clip[] {
    out.length = 0;
    if (isRejected(tMs)) {
        return out;
    }
    const bucket = Math.floor(tMs / BUCKET_MS);
    let cursor = index.cursor;

    if (
        cursor === null ||
        tMs < cursor.tMs ||
        bucket < cursor.bucket ||
        bucket > cursor.bucket + 1
    ) {
        rebuildCursor(index, bucket, tMs);
        cursor = index.cursor!;
    } else {
        const to = upperBound(index.starts, tMs);
        const from = Math.min(cursor.nextStart, to);
        for (let i = from; i < to; i += 1) {
            const id = index.startIds[i];
            const clip = index.clips[id];
            if (coversAt(clip, tMs)) {
                cursor.ids.push(id);
            }
        }
        cursor.nextStart = to;
        cursor.bucket = bucket;
        cursor.tMs = tMs;
        let kept = 0;
        for (const id of cursor.ids) {
            if (coversAt(index.clips[id], tMs)) {
                cursor.ids[kept] = id;
                kept += 1;
            }
        }
        cursor.ids.length = kept;
    }

    for (const id of cursor.ids) {
        out.push(index.clips[id]);
    }
    return out;
}

/** Allocating form of playbackInto, for callers that do not own a buffer. */
export function playbackActive(index: LayerIndex, tMs: number): Clip[] {
    return playbackInto(index, tMs, []);
}

export function resetCursor(index: LayerIndex): void {
    index.cursor = null;
}

/** First index whose value is >= tMs. */
function lowerBound(values: Int32Array, tMs: number): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (values[mid] < tMs) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/** First index whose value is > tMs (a clip starting exactly at t is active). */
function upperBound(values: Int32Array, tMs: number): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (values[mid] <= tMs) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Nearest edit point (any clip start or end) within radiusMs, else null.
 * Binary search over both sorted arrays, no per-query sort. Ties go to the
 * start side, which is iterated first: a start is the more useful snap.
 */
export function snapToEditPoint(
    index: LayerIndex,
    tMs: number,
    radiusMs: number,
): number | null {
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const values of [index.starts, index.ends]) {
        const at = lowerBound(values, tMs);
        for (const i of [at - 1, at]) {
            if (i < 0 || i >= values.length) {
                continue;
            }
            const distance = Math.abs(values[i] - tMs);
            if (distance < bestDistance && distance <= radiusMs) {
                bestDistance = distance;
                best = values[i];
            }
        }
    }
    return best;
}
