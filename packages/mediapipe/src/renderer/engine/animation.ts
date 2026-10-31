// Animation store, doc section 7. Keyframes are a property of a property:
// the store is keyed (ownerId, path) and knows nothing about clips. Sampling
// is pure; the engine memoizes one result per (clipId, tMs, version), which is
// why a sample must not allocate and a preview must bump the version.

export type Handle = { readonly dx: number; readonly dy: number };
export type Interp =
    'hold' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bezier';

export interface Keyframe {
    /** Clip-local time in milliseconds. */
    readonly tMs: number;
    readonly value: number;
    /** How the segment that ENDS at this key is interpolated (doc 7.2). */
    readonly interp: Interp;
    /** Control leaving this key (bezier only), normalized 0..1. */
    readonly hOut?: Handle;
    /** Control arriving at this key (bezier only), normalized 0..1. */
    readonly hIn?: Handle;
}

export interface Channel {
    readonly path: string;
    readonly keys: readonly Keyframe[];
}

/** Serialized grouping of channels for one owner. */
export interface Track {
    readonly channels: readonly Channel[];
}

/** CSS cubic-bezier control points, P0=(0,0) and P3=(1,1) implied. */
type Curve = readonly [x1: number, y1: number, x2: number, y2: number];

const EASE_IN: Curve = [0.42, 0, 1, 1];
const EASE_OUT: Curve = [0, 0, 0.58, 1];
const EASE_IN_OUT: Curve = [0.42, 0, 0.58, 1];
/** Default handles when a bezier key carries none (CSS "ease"). */
const DEFAULT_BEZIER: Curve = [0.33, 0, 0.67, 1];

function bezierAt(t: number, c: Curve): [x: number, y: number] {
    const [x1, y1, x2, y2] = c;
    const u = 1 - t;
    const x = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
    const y = 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
    return [x, y];
}

/** Solve x(t) = x for a unit cubic bezier and return y(t). */
function solveCurve(x: number, c: Curve): number {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32 && hi - lo > 1e-6; i++) {
        const mid = (lo + hi) / 2;
        if (bezierAt(mid, c)[0] < x) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return bezierAt((lo + hi) / 2, c)[1];
}

function curveFor(interp: Interp): Curve {
    switch (interp) {
        case 'easeIn':
            return EASE_IN;
        case 'easeOut':
            return EASE_OUT;
        case 'easeInOut':
            return EASE_IN_OUT;
        default:
            return DEFAULT_BEZIER;
    }
}

/** A handle coordinate, falling back when the stored value is not a number. */
function unit(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}

/** The segment a -> b uses a's hOut as start control and b's hIn as end. */
function segmentCurve(a: Keyframe, b: Keyframe): Curve {
    const hOut = a.hOut;
    const hIn = b.hIn;
    // NaN must never reach the curve: sampleChannel would return NaN values
    // that render as blank frames (review L10).
    return [
        unit(hOut?.dx, 0.33),
        unit(hOut?.dy, 0),
        1 - unit(hIn?.dx, 0.33),
        1 - unit(hIn?.dy, 0),
    ];
}

/** The key governing the segment that ends at `tMs` (upper bound). */
function governingKey(
    keys: readonly Keyframe[],
    tMs: number,
): Keyframe | undefined {
    for (const key of keys) {
        if (key.tMs > tMs) {
            return key;
        }
    }
    return keys[keys.length - 1];
}

/**
 * Sample one channel at localMs. Segments take their interpolation from the
 * right-hand key; values hold before the first key and after the last one.
 */
export function sampleChannel(
    keys: readonly Keyframe[],
    localMs: number,
): number {
    if (keys.length === 0) {
        throw new Error('sampleChannel: empty channel');
    }
    const first = keys[0] as Keyframe;
    const last = keys[keys.length - 1] as Keyframe;
    if (localMs <= first.tMs) {
        return first.value;
    }
    if (localMs >= last.tMs) {
        return last.value;
    }
    let lo = 0;
    let hi = keys.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((keys[mid] as Keyframe).tMs <= localMs) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    const a = keys[lo] as Keyframe;
    const b = keys[hi] as Keyframe;
    if (b.interp === 'hold') {
        return a.value;
    }
    const span = b.tMs - a.tMs;
    const u = span <= 0 ? 1 : (localMs - a.tMs) / span;
    if (b.interp === 'linear') {
        return a.value + (b.value - a.value) * u;
    }
    const curve =
        b.interp === 'bezier' ? segmentCurve(a, b) : curveFor(b.interp);
    return a.value + (b.value - a.value) * solveCurve(u, curve);
}

/** Shift every key by deltaMs (trim left by d shifts by -d). */
export function shiftKeys(
    keys: readonly Keyframe[],
    deltaMs: number,
): readonly Keyframe[] {
    if (deltaMs === 0) {
        return keys;
    }
    return Object.freeze(
        keys.map((k) => Object.freeze({ ...k, tMs: k.tMs + deltaMs })),
    );
}

/**
 * Split a channel at local s: the head keeps its keys up to s plus a sampled
 * key at s, the tail starts at 0 with the same sampled value. The inserted
 * boundary key inherits the curve of the segment it cuts, so the cut value and
 * the curve leading into it both match the original.
 */
export function splitKeys(
    keys: readonly Keyframe[],
    atMs: number,
): { head: readonly Keyframe[]; tail: readonly Keyframe[] } {
    if (keys.length === 0) {
        return { head: Object.freeze([]), tail: Object.freeze([]) };
    }
    const at = sampleChannel(keys, atMs);
    const governor = governingKey(keys, atMs);
    const boundary = Object.freeze({
        tMs: atMs,
        value: at,
        interp: governor?.interp ?? 'linear',
        ...(governor?.hOut === undefined ? {} : { hOut: governor.hOut }),
        ...(governor?.hIn === undefined ? {} : { hIn: governor.hIn }),
    });
    const head: Keyframe[] = keys
        .filter((k) => k.tMs < atMs)
        .map((k) => Object.freeze({ ...k }));
    head.push(boundary);
    const tail: Keyframe[] = keys
        .filter((k) => k.tMs > atMs)
        .map((k) => Object.freeze({ ...k, tMs: k.tMs - atMs }));
    if (tail.length === 0 || tail[0]!.tMs > 0) {
        tail.unshift(
            Object.freeze({
                tMs: 0,
                value: at,
                interp: governor?.interp ?? 'linear',
            }),
        );
    }
    return { head: Object.freeze(head), tail: Object.freeze(tail) };
}

/**
 * Insert or replace a key at tMs inside a sorted channel. A replaced key keeps
 * its interpolation and handles (only the value changes); a new key takes the
 * curve of the segment it lands in. A lone key holds.
 */
export function mergeKey(
    keys: readonly Keyframe[],
    tMs: number,
    value: number,
): readonly Keyframe[] {
    const at = keys.findIndex((k) => k.tMs === tMs);
    if (at >= 0) {
        const old = keys[at] as Keyframe;
        return Object.freeze(
            keys.map((k, i) =>
                i === at
                    ? Object.freeze({ ...old, value })
                    : Object.freeze({ ...k }),
            ),
        );
    }
    const governor = governingKey(keys, tMs);
    const inserted = Object.freeze({
        tMs,
        value,
        interp: governor?.interp ?? 'linear',
        ...(governor?.hOut === undefined ? {} : { hOut: governor.hOut }),
        ...(governor?.hIn === undefined ? {} : { hIn: governor.hIn }),
    });
    const next: Keyframe[] = keys.map((k) => Object.freeze({ ...k }));
    let index = 0;
    while (index < next.length && (next[index] as Keyframe).tMs < tMs) {
        index++;
    }
    next.splice(index, 0, inserted);
    if (next.length === 1) {
        next[0] = Object.freeze({ tMs, value, interp: 'hold' as Interp });
    }
    return Object.freeze(next);
}

/**
 * The three stores serialize separately (doc 7). The animation store is keyed
 * (ownerId, path) with two nested Maps, so the hot sample path builds no
 * string. Owners are clips or effect instances; the store never knows which.
 */
export class AnimationStore {
    private readonly tracks = new Map<
        string,
        Map<string, readonly Keyframe[]>
    >();
    private readonly preview = new Map<
        string,
        Map<string, { value: number; tMs: number }>
    >();
    /** A whole Track dragged in by a gesture; replaced, never merged on commit. */
    private readonly previewTracks = new Map<
        string,
        Map<string, readonly Keyframe[]>
    >();
    private _version = 0;
    private readonly autoKey: boolean;

    /**
     * `autoKey` decides whether a preview on a path WITHOUT a track creates a
     * curve (doc 7.5: auto-key only when on or the path is already animated).
     */
    constructor(autoKey = false) {
        this.autoKey = autoKey;
    }

    /** Bumps on every change, preview included; memo keys include it. */
    get version(): number {
        return this._version;
    }

    set(ownerId: string, path: string, keys: readonly Keyframe[]): void {
        this.write(ownerId, path, keys);
        this._version++;
    }

    get(ownerId: string, path: string): readonly Keyframe[] | undefined {
        return this.tracks.get(ownerId)?.get(path);
    }

    has(ownerId: string, path: string): boolean {
        return this.tracks.get(ownerId)?.has(path) ?? false;
    }

    /** Channels of one owner for serialization (doc 7, three stores). */
    channels(ownerId: string): readonly Channel[] {
        const row = this.tracks.get(ownerId);
        if (row === undefined) {
            return [];
        }
        const out: Channel[] = [];
        for (const [path, keys] of row) {
            out.push({ path, keys });
        }
        return out;
    }

    track(ownerId: string): Track {
        return { channels: this.channels(ownerId) };
    }

    remove(ownerId: string, path: string): void {
        const row = this.tracks.get(ownerId);
        if (row !== undefined && row.delete(path)) {
            if (row.size === 0) {
                this.tracks.delete(ownerId);
            }
            this._version++;
        }
    }

    /** Delete every track and preview of an owner (clip deletion cascade). */
    removeOwner(ownerId: string): void {
        let changed = this.tracks.delete(ownerId);
        if (this.preview.delete(ownerId)) {
            changed = true;
        }
        if (this.previewTracks.delete(ownerId)) {
            changed = true;
        }
        if (changed) {
            this._version++;
        }
    }

    /** Copy every track of one owner to another id (deep copy, doc 7.4). */
    copyOwner(fromId: string, toId: string): void {
        const row = this.tracks.get(fromId);
        if (row === undefined) {
            return;
        }
        const copy = new Map<string, readonly Keyframe[]>();
        for (const [path, keys] of row) {
            copy.set(
                path,
                Object.freeze(keys.map((k) => Object.freeze({ ...k }))),
            );
        }
        this.tracks.set(toId, copy);
        this._version++;
    }

    /**
     * Sample one owner path. The preview overlay (doc 7.5) is consulted first;
     * a preview value replaces the sampled value until commit or clear.
     */
    sample(
        ownerId: string,
        path: string,
        localMs: number,
        fallback: number,
    ): number {
        const preview = this.preview.get(ownerId)?.get(path);
        if (preview !== undefined) {
            return preview.value;
        }
        const previewKeys = this.previewTracks.get(ownerId)?.get(path);
        if (previewKeys !== undefined) {
            return sampleChannel(previewKeys, localMs);
        }
        const keys = this.tracks.get(ownerId)?.get(path);
        if (keys === undefined) {
            return fallback;
        }
        return sampleChannel(keys, localMs);
    }

    /** Preview one path at a local time without touching the store. */
    previewSet(
        ownerId: string,
        path: string,
        value: number,
        tMs: number,
    ): void {
        if (!Number.isFinite(tMs) || !Number.isInteger(tMs)) {
            throw new TypeError(`preview tMs must be integer ms: ${tMs}`);
        }
        if (!Number.isFinite(value)) {
            throw new TypeError(`preview value must be finite: ${value}`);
        }
        let row = this.preview.get(ownerId);
        if (row === undefined) {
            row = new Map();
            this.preview.set(ownerId, row);
        }
        row.set(path, { value, tMs });
        this._version++;
    }

    previewHas(ownerId: string, path: string): boolean {
        return (
            (this.preview.get(ownerId)?.has(path) ?? false) ||
            (this.previewTracks.get(ownerId)?.has(path) ?? false)
        );
    }

    /**
     * Preview a whole authored track for one path (doc 7.5: a curve dragged in
     * by the user). Sampling and clearing treat it exactly like a value
     * preview, so cancel is always possible; commit replaces the channel.
     */
    previewTrack(
        ownerId: string,
        path: string,
        keys: readonly Keyframe[],
    ): void {
        if (keys.length === 0) {
            this.previewTracks.get(ownerId)?.delete(path);
            this._version++;
            return;
        }
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i] as Keyframe;
            if (!Number.isInteger(key.tMs) || !Number.isFinite(key.value)) {
                throw new TypeError(
                    `preview keys must be integer ms and finite: ${ownerId}:${path}`,
                );
            }
            if (i > 0 && key.tMs <= (keys[i - 1] as Keyframe).tMs) {
                throw new TypeError(
                    `preview keys must be strictly increasing: ${ownerId}:${path}`,
                );
            }
        }
        let row = this.previewTracks.get(ownerId);
        if (row === undefined) {
            row = new Map();
            this.previewTracks.set(ownerId, row);
        }
        row.set(path, Object.freeze(keys.map((k) => Object.freeze({ ...k }))));
        this._version++;
    }

    /** Drop one previewed path, or every path of an owner, or all of them. */
    clearPreview(ownerId?: string, path?: string): void {
        let changed = false;
        if (ownerId !== undefined) {
            const row = this.preview.get(ownerId);
            if (row !== undefined) {
                if (path !== undefined) {
                    changed = row.delete(path);
                } else {
                    changed = row.size > 0;
                    this.preview.delete(ownerId);
                }
                if (row.size === 0) {
                    this.preview.delete(ownerId);
                }
            }
            const rowTracks = this.previewTracks.get(ownerId);
            if (rowTracks !== undefined) {
                if (path !== undefined) {
                    changed = rowTracks.delete(path) || changed;
                } else {
                    changed = rowTracks.size > 0 || changed;
                    this.previewTracks.delete(ownerId);
                }
                if (rowTracks.size === 0) {
                    this.previewTracks.delete(ownerId);
                }
            }
        } else {
            changed = this.preview.size > 0 || this.previewTracks.size > 0;
            this.preview.clear();
            this.previewTracks.clear();
        }
        if (changed) {
            this._version++;
        }
    }

    /**
     * One commit for the whole gesture (one undo entry, doc 7.5). An animated
     * path merges a key at the preview time; a static path becomes a key only
     * when autoKey is on, otherwise the caller applies it to the static params.
     */
    commit(): ReadonlyArray<{
        readonly ownerId: string;
        readonly path: string;
        readonly value: number;
        readonly tMs: number;
        readonly animated: boolean;
    }> {
        const committed: Array<{
            ownerId: string;
            path: string;
            value: number;
            tMs: number;
            animated: boolean;
        }> = [];
        let changed = false;
        for (const ownerId of this.preview.keys()) {
            const row = this.preview.get(ownerId);
            if (row === undefined) {
                continue;
            }
            for (const path of row.keys()) {
                const preview = row.get(path);
                if (preview === undefined) {
                    continue;
                }
                const existing = this.tracks.get(ownerId)?.get(path);
                const animated = existing !== undefined || this.autoKey;
                if (animated) {
                    const merged = mergeKey(
                        existing ?? [],
                        preview.tMs,
                        preview.value,
                    );
                    this.write(ownerId, path, merged);
                    changed = true;
                }
                committed.push({
                    ownerId,
                    path,
                    value: preview.value,
                    tMs: preview.tMs,
                    animated,
                });
            }
        }
        for (const ownerId of this.previewTracks.keys()) {
            const row = this.previewTracks.get(ownerId);
            if (row === undefined) {
                continue;
            }
            for (const path of row.keys()) {
                const keys = row.get(path);
                if (keys === undefined) {
                    continue;
                }
                this.write(ownerId, path, keys);
                changed = true;
                const last = keys[keys.length - 1] as Keyframe;
                committed.push({
                    ownerId,
                    path,
                    value: last.value,
                    tMs: last.tMs,
                    animated: true,
                });
            }
        }
        this.preview.clear();
        this.previewTracks.clear();
        if (changed || committed.length > 0) {
            this._version++;
        }
        return committed;
    }

    /** Validated write used by set() and commit(); never bumps the version. */
    private write(
        ownerId: string,
        path: string,
        keys: readonly Keyframe[],
    ): void {
        if (keys.length === 0) {
            this.tracks.get(ownerId)?.delete(path);
            return;
        }
        // The first key has no predecessor to compare against, so it needs its
        // own check: a single-key track (or a NaN first key) used to slip
        // through and make sampleChannel return NaN.
        const first = keys[0] as Keyframe;
        if (!Number.isInteger(first.tMs) || !Number.isFinite(first.value)) {
            throw new TypeError(
                `keys must be whole milliseconds with finite values: ${ownerId}:${path}`,
            );
        }
        for (let i = 1; i < keys.length; i++) {
            const prev = keys[i - 1] as Keyframe;
            const cur = keys[i] as Keyframe;
            if (
                !Number.isInteger(cur.tMs) ||
                !Number.isFinite(cur.value) ||
                cur.tMs <= prev.tMs
            ) {
                throw new TypeError(
                    `keys must be strictly increasing integers: ${ownerId}:${path}`,
                );
            }
        }
        const frozen = Object.freeze(keys.map((k) => Object.freeze({ ...k })));
        let row = this.tracks.get(ownerId);
        if (row === undefined) {
            row = new Map();
            this.tracks.set(ownerId, row);
        }
        row.set(path, frozen);
    }
}
