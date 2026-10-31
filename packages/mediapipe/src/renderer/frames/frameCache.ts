// Frame cache, doc sections 10 and 15.2. One byte-budgeted LRU per renderer
// process, keyed by an integer token + frame index (a numeric Map key, no
// string concatenation), dwarfed only by the decoded pixels themselves.

const KEY_TOKENS = 1 << 20;

/** Pack a cache key. Tokens are small per-source indexes, not uuids. */
export function frameKey(token: number, frameIndex: number): number {
    if (!Number.isInteger(token) || token < 0 || token >= KEY_TOKENS) {
        throw new TypeError(`token out of range: ${token}`);
    }
    if (
        !Number.isInteger(frameIndex) ||
        frameIndex < 0 ||
        frameIndex >= KEY_TOKENS
    ) {
        throw new TypeError(`frameIndex out of range: ${frameIndex}`);
    }
    return token * KEY_TOKENS + frameIndex;
}

export interface FrameEntry {
    readonly token: number;
    readonly frameIndex: number;
    readonly ptsMs: number;
    readonly width: number;
    readonly height: number;
    /** Approximate decoded size; the budget is about memory, not wire bytes. */
    readonly bytes: number;
    readonly image: unknown;
}

export interface FrameCacheStats {
    readonly bytes: number;
    readonly frames: number;
    readonly pinnedBytes: number;
    /** True when pins/recent frames keep the cache above its budget. */
    readonly overBudget: boolean;
}

interface Candidate {
    readonly key: number;
    readonly entry: FrameEntry;
    readonly dist: number;
    readonly behind: boolean;
}

/**
 * Decoded frames keyed by (token, frameIndex). Eviction follows Blender's
 * final_image_cache rule: drop the frames furthest from the token's playhead,
 * not the ones read longest ago (libopenshot's Touch is O(n) and a frame read
 * a millisecond ago can be a thousand frames behind the playhead). Equal
 * distances drop the frame behind the playhead first.
 */
export class FrameCache {
    private readonly entries = new Map<number, FrameEntry>();
    private readonly tokenKeys = new Map<number, Set<number>>();
    private readonly focusMs = new Map<number, number>();
    private readonly pinned = new Set<number>();
    /** Recently inserted keys: a prefetch must not evict itself. */
    private readonly recent = new Set<number>();
    private bytesUsed = 0;
    private pinnedBytesUsed = 0;
    private budget: number;

    constructor(budgetBytes = 128 * 1024 * 1024) {
        this.assertBudget(budgetBytes);
        this.budget = budgetBytes;
    }

    get bytes(): number {
        return this.bytesUsed;
    }

    get size(): number {
        return this.entries.size;
    }

    has(token: number, frameIndex: number): boolean {
        return this.entries.has(frameKey(token, frameIndex));
    }

    get(token: number, frameIndex: number): FrameEntry | undefined {
        return this.entries.get(frameKey(token, frameIndex));
    }

    put(entry: FrameEntry): void {
        const key = frameKey(entry.token, entry.frameIndex);
        this.assertBytes(entry.bytes);
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            this.subtract(existing);
        }
        this.entries.set(key, entry);
        this.bytesUsed += entry.bytes;
        let row = this.tokenKeys.get(entry.token);
        if (row === undefined) {
            row = new Set();
            this.tokenKeys.set(entry.token, row);
        }
        row.add(key);
        if (this.pinned.has(key)) {
            this.pinnedBytesUsed += entry.bytes;
        }
        this.recent.add(key);
        if (this.recent.size > 2) {
            const oldest = this.recent.values().next().value;
            if (oldest !== undefined) {
                this.recent.delete(oldest);
            }
        }
        if (this.bytesUsed > this.budget) {
            this.evict();
        }
    }

    /** Tell the cache where the playhead of a token is (eviction distance). */
    setFocus(token: number, ms: number): void {
        if (!Number.isFinite(ms)) {
            throw new TypeError(`focus must be finite: ${ms}`);
        }
        this.focusMs.set(token, ms);
    }

    /** Pin a frame (drawn this frame) so eviction never drops what is shown. */
    pin(token: number, frameIndex: number): void {
        const key = frameKey(token, frameIndex);
        if (this.pinned.has(key)) {
            return;
        }
        this.pinned.add(key);
        const entry = this.entries.get(key);
        if (entry !== undefined) {
            this.pinnedBytesUsed += entry.bytes;
        }
    }

    unpinAll(): void {
        this.pinned.clear();
        this.pinnedBytesUsed = 0;
    }

    dropToken(token: number): void {
        const row = this.tokenKeys.get(token);
        if (row !== undefined) {
            for (const key of [...row]) {
                const entry = this.entries.get(key);
                if (entry !== undefined) {
                    this.remove(key, entry);
                }
            }
            this.tokenKeys.delete(token);
        }
        this.focusMs.delete(token);
    }

    /**
     * Drop every frame rendered at one width: a viewport change makes those
     * frames unreachable (the key includes the width) and keeping them would
     * let them evict frames of the new viewport.
     */
    dropWidth(width: number): void {
        for (const [key, entry] of [...this.entries]) {
            if (entry.width === width && !this.pinned.has(key)) {
                this.remove(key, entry);
            }
        }
    }

    dropAll(): void {
        this.entries.clear();
        this.tokenKeys.clear();
        this.pinned.clear();
        this.recent.clear();
        this.focusMs.clear();
        this.bytesUsed = 0;
        this.pinnedBytesUsed = 0;
    }

    setBudget(budgetBytes: number): void {
        this.assertBudget(budgetBytes);
        this.budget = budgetBytes;
        this.evict();
    }

    stats(): FrameCacheStats {
        return {
            bytes: this.bytesUsed,
            frames: this.entries.size,
            pinnedBytes: this.pinnedBytesUsed,
            // Everything evictable is gone; what remains is pinned or recent.
            overBudget: this.bytesUsed > this.budget,
        };
    }

    private assertBudget(value: number): void {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError(
                `budget must be a non-negative integer: ${value}`,
            );
        }
    }

    private assertBytes(value: number): void {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError(
                `bytes must be a non-negative integer: ${value}`,
            );
        }
    }

    /**
     * Evict down to 90% of the budget, so one miss does not trigger a scan on
     * every following put. Returns the number of removed frames.
     */
    private evict(): number {
        if (this.bytesUsed <= this.budget) {
            return 0;
        }
        const target = Math.floor(this.budget * 0.9);
        const candidates: Candidate[] = [];
        for (const [key, entry] of this.entries) {
            if (this.pinned.has(key) || this.recent.has(key)) {
                continue;
            }
            const focus = this.focusMs.get(entry.token);
            if (focus === undefined) {
                candidates.push({
                    key,
                    entry,
                    dist: Number.POSITIVE_INFINITY,
                    behind: true,
                });
                continue;
            }
            candidates.push({
                key,
                entry,
                dist: Math.abs(entry.ptsMs - focus),
                behind: entry.ptsMs < focus,
            });
        }
        // Farthest first; equal distance evicts the frame behind the playhead.
        candidates.sort(
            (a, b) =>
                b.dist - a.dist ||
                (a.behind === b.behind ? 0 : a.behind ? -1 : 1),
        );
        let removed = 0;
        for (const { key, entry } of candidates) {
            if (this.bytesUsed <= target) {
                break;
            }
            this.remove(key, entry);
            removed++;
        }
        return removed;
    }

    private remove(key: number, entry: FrameEntry): void {
        this.entries.delete(key);
        this.subtract(entry);
        const row = this.tokenKeys.get(entry.token);
        if (row !== undefined) {
            row.delete(key);
            if (row.size === 0) {
                this.tokenKeys.delete(entry.token);
            }
        }
        this.recent.delete(key);
        if (this.pinned.has(key)) {
            this.pinned.delete(key);
            this.pinnedBytesUsed -= entry.bytes;
        }
    }

    private subtract(entry: FrameEntry): void {
        this.bytesUsed -= entry.bytes;
    }
}
