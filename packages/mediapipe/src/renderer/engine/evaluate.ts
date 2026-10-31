// Clip evaluation, doc section 7.3: renderers read ClipRenderState and never
// sample tracks themselves.

import type { Span } from '../clips/span.js';
import type { Clip, ClipKind, ClipState } from '../clips/clips.js';
import type { AnimationStore } from './animation.js';

export interface ClipRenderState {
    readonly clipId: string;
    readonly kind: ClipKind;
    readonly state: ClipState;
    readonly span: Span;
    readonly localMs: number;
    readonly opacity: number;
    readonly transform: {
        readonly x: number;
        readonly y: number;
        readonly scale: number;
        readonly rotation: number;
    };
    readonly audio: { readonly gain: number; readonly pan: number };
}

/** Static audio gain carried by the clip payload (video clips carry one too). */
const DEFAULT_OPACITY = 1;
const DEFAULT_GAIN = 1;
/** Same int32 bound the layer index enforces (doc 15.1). */
const MAX_SPAN_MS = 2 ** 31 - 1;

function validate(clip: Clip, atMs: number): void {
    if (!Number.isFinite(atMs)) {
        throw new TypeError(`evaluateClip: atMs must be finite: ${atMs}`);
    }
    const span = clip.span;
    if (
        span === undefined ||
        !Number.isInteger(span.startMs) ||
        !Number.isInteger(span.durationMs) ||
        span.startMs < 0 ||
        span.durationMs < 0 ||
        span.startMs + span.durationMs > MAX_SPAN_MS
    ) {
        throw new TypeError(
            `evaluateClip: clip ${clip.id} has an invalid span`,
        );
    }
}

/** Static gain from the payload, shared by video and audio kinds (doc 7.1). */
function staticGain(clip: Clip): number {
    if (clip.kind === 'audio' || clip.kind === 'video') {
        return typeof clip.gain === 'number' ? clip.gain : DEFAULT_GAIN;
    }
    return DEFAULT_GAIN;
}

/**
 * Evaluate one clip at song time atMs. Paths follow doc 7.3:
 * opacity, transform.x/y/scale/rotation, audio.gain/pan. `localMs` is the
 * clip-local coordinate every channel is keyed in; `state` lets a renderer
 * honour muted/hidden/stale without asking the engine again.
 */
export function evaluateClip(
    clip: Clip,
    atMs: number,
    store: AnimationStore,
): ClipRenderState {
    validate(clip, atMs);
    const localMs = atMs - clip.span.startMs;
    const sample = (path: string, fallback: number): number =>
        store.sample(clip.id, path, localMs, fallback);
    return {
        clipId: clip.id,
        kind: clip.kind,
        state: clip.state,
        span: clip.span,
        localMs,
        opacity: sample('opacity', DEFAULT_OPACITY),
        transform: {
            x: sample('transform.x', 0),
            y: sample('transform.y', 0),
            scale: sample('transform.scale', 1),
            rotation: sample('transform.rotation', 0),
        },
        audio: {
            gain: sample('audio.gain', staticGain(clip)),
            pan: sample('audio.pan', 0),
        },
    };
}
