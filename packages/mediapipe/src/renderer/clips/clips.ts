// Clip algebra, doc section 5. Clips are plain data, never classes, and every
// operation is a pure function `(clip, args) -> clip | null`. The algebra is
// payload-agnostic: it only reads `span` and the kind payload's in-point.

import { spanContains, spanEnd, spanFromBounds } from './span.js';
import type { Span } from './span.js';

export type ClipKind = 'video' | 'audio' | 'subtitle';
export type ClipState = 'live' | 'muted' | 'hidden' | 'stale';

/** Layer numbers every document uses: video below audio below subtitle. */
export const LAYER_VIDEO = 0;
export const LAYER_AUDIO = 1;
export const LAYER_SUBTITLE = 2;

export interface ClipBase<K extends ClipKind> {
    readonly id: string;
    readonly kind: K;
    /** Backend source id; absent for local sources such as subtitles. */
    readonly sourceId?: string;
    /** Song time, always. */
    readonly span: Span;
    readonly layer: number;
    readonly z: number;
    readonly state: ClipState;
}

export interface VideoClip extends ClipBase<'video'> {
    readonly stream: number;
    /** Source in-point in seconds (the wire unit for video). */
    readonly inSec: number;
    readonly gain?: number;
}

export interface AudioClip extends ClipBase<'audio'> {
    readonly stream: number;
    /** Source in-point in milliseconds. */
    readonly inMs: number;
    readonly gain?: number;
}

export interface SubtitleClip extends ClipBase<'subtitle'> {
    /** Registered local subtitle source (doc 6.1). */
    readonly sourceKey: string;
    /** Source in-point in milliseconds. */
    readonly inMs: number;
}

export type Clip = VideoClip | AudioClip | SubtitleClip;

/** Song time at which a clip stops covering its layer. */
export function clipEnd(clip: Clip): number {
    return spanEnd(clip.span);
}

export function coversAt(clip: Clip, tMs: number): boolean {
    return spanContains(clip.span, tMs);
}

/** Deep-freeze a clip and its span so undo snapshots cannot alias. */
export function freezeClip(clip: Clip): Clip {
    return Object.freeze({ ...clip, span: Object.freeze({ ...clip.span }) });
}

/**
 * Shift the kind payload's source in-point by deltaMs. The in-point is kept
 * in integer milliseconds and converted once: accumulating deltas on a float
 * second value loses a millisecond after a few trims (doc section 4).
 */
export function shiftSourceIn(clip: Clip, deltaMs: number): Clip {
    switch (clip.kind) {
        case 'video':
            return {
                ...clip,
                inSec: (Math.round(clip.inSec * 1000) + deltaMs) / 1000,
            };
        case 'audio':
            return { ...clip, inMs: clip.inMs + deltaMs };
        case 'subtitle':
            return { ...clip, inMs: clip.inMs + deltaMs };
    }
}

/** Move a clip so its span starts at startMs. Duration and payload stay. */
export function moveTo(clip: Clip, startMs: number): Clip | null {
    if (!Number.isInteger(startMs) || startMs < 0) {
        return null;
    }
    if (startMs === clip.span.startMs) {
        return clip;
    }
    return freezeClip({
        ...clip,
        span: { startMs, durationMs: clip.span.durationMs },
    });
}

/** Drag a clip by deltaMs. */
export function moveBy(clip: Clip, deltaMs: number): Clip | null {
    return moveTo(clip, clip.span.startMs + deltaMs);
}

/**
 * Trim the left edge to newStartMs. The clip keeps its content in place in
 * song time, so the source in-point advances by the same delta.
 */
export function trimLeft(clip: Clip, newStartMs: number): Clip | null {
    if (!Number.isInteger(newStartMs)) {
        return null;
    }
    if (newStartMs === clip.span.startMs) {
        return clip;
    }
    const endMs = clipEnd(clip);
    if (newStartMs < clip.span.startMs || newStartMs >= endMs) {
        return null;
    }
    const deltaMs = newStartMs - clip.span.startMs;
    return freezeClip(
        shiftSourceIn(
            { ...clip, span: spanFromBounds(newStartMs, endMs) },
            deltaMs,
        ),
    );
}

/**
 * Trim the right edge to newEndMs. The in-point does not move. Only shrinking
 * is accepted: extending would need the source duration, which slice 1 does
 * not carry, so extension stays an engine-side operation with a known bound.
 */
export function trimRight(clip: Clip, newEndMs: number): Clip | null {
    if (!Number.isInteger(newEndMs)) {
        return null;
    }
    const startMs = clip.span.startMs;
    if (newEndMs === clipEnd(clip)) {
        return clip;
    }
    if (newEndMs <= startMs || newEndMs > clipEnd(clip)) {
        return null;
    }
    return freezeClip({ ...clip, span: spanFromBounds(startMs, newEndMs) });
}

/**
 * Split at atMs into [left, right]. The left half keeps the id, the right half
 * must get a fresh one and gets z + 0.5 so it keeps drawing above.
 */
export function splitAt(
    clip: Clip,
    atMs: number,
    nextId: string,
): [Clip, Clip] | null {
    if (nextId === '' || nextId === clip.id) {
        return null;
    }
    if (
        !Number.isInteger(atMs) ||
        atMs <= clip.span.startMs ||
        atMs >= clipEnd(clip)
    ) {
        return null;
    }
    const left: Clip = {
        ...clip,
        span: spanFromBounds(clip.span.startMs, atMs),
    };
    const right = shiftSourceIn(
        {
            ...clip,
            id: nextId,
            z: clip.z + 0.5,
            span: spanFromBounds(atMs, clipEnd(clip)),
        },
        atMs - clip.span.startMs,
    );
    return [left, right];
}

/** Topmost clip rule: highest layer, then highest z, then the lower id. */
export function compareTopmost(a: Clip, b: Clip): number {
    if (a.layer !== b.layer) {
        return b.layer - a.layer;
    }
    if (a.z !== b.z) {
        return b.z - a.z;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Hit test over an already active list: the clip the pointer would grab, by the
 * same rule as topmostAt (layer, then z, then id) but without a LayerIndex.
 */
export function hitTestAt(clips: readonly Clip[], tMs: number): Clip | null {
    let best: Clip | null = null;
    for (const clip of clips) {
        if (!coversAt(clip, tMs)) {
            continue;
        }
        if (best === null || compareTopmost(clip, best) < 0) {
            best = clip;
        }
    }
    return best;
}

export type { Span };
