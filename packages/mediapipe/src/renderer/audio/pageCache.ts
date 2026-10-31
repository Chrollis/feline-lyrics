// Audio page cache, doc section 11. A page is one second of planar float32
// stereo at 48 kHz (48000 frames, 384000 bytes) shared by every clip on a
// source; memory is bounded per pool and per source, and pages around the
// playhead are pinned so a seek cannot evict what is about to play.

export const PAGE_FRAMES = 48000;
export const PAGE_BYTES = PAGE_FRAMES * 2 * 4;

const KEY_TOKENS = 1 << 20;

export interface AudioPage {
    readonly token: number;
    readonly pageIndex: number;
    /** Planar [left, right], each 48000 floats. */
    readonly channels: readonly [Float32Array, Float32Array];
    readonly sampleRate: number;
}

export interface AudioPageStats {
    readonly bytes: number;
    readonly pages: number;
    readonly pinnedBytes: number;
    /** True when pins keep a source above its cap. */
    readonly overBudget: boolean;
}

interface Candidate {
    readonly key: number;
    readonly page: AudioPage;
    readonly dist: number;
}

function checkIndex(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0 || value >= KEY_TOKENS) {
        throw new TypeError(`${name} out of range: ${value}`);
    }
}

export function pageKey(token: number, pageIndex: number): number {
    checkIndex('token', token);
    checkIndex('pageIndex', pageIndex);
    return token * KEY_TOKENS + pageIndex;
}

export class AudioPageCache {
    private readonly pages = new Map<number, AudioPage>();
    private readonly pageKeys = new Map<number, Set<number>>();
    private readonly focus = new Map<number, number>();
    private readonly pinned = new Set<number>();
    private readonly usedPerToken = new Map<number, number>();
    private bytesUsed = 0;
    private pinnedBytesUsed = 0;
    private budget: number;
    private readonly perTokenBudget: number;

    constructor(
        budgetBytes = 64 * 1024 * 1024,
        perTokenBudget = 32 * 1024 * 1024,
    ) {
        this.assertBudget(budgetBytes);
        this.assertBudget(perTokenBudget);
        this.budget = budgetBytes;
        this.perTokenBudget = perTokenBudget;
    }

    get bytes(): number {
        return this.bytesUsed;
    }

    get size(): number {
        return this.pages.size;
    }

    has(token: number, pageIndex: number): boolean {
        return this.pages.has(pageKey(token, pageIndex));
    }

    get(token: number, pageIndex: number): AudioPage | undefined {
        return this.pages.get(pageKey(token, pageIndex));
    }

    put(page: AudioPage): void {
        const key = pageKey(page.token, page.pageIndex);
        this.assertPage(page);
        const existing = this.pages.get(key);
        if (existing !== undefined) {
            this.subtract(existing);
        }
        this.pages.set(key, page);
        this.bytesUsed += PAGE_BYTES;
        this.count(page.token, PAGE_BYTES);
        let row = this.pageKeys.get(page.token);
        if (row === undefined) {
            row = new Set();
            this.pageKeys.set(page.token, row);
        }
        row.add(key);
        if (this.pinned.has(key)) {
            this.pinnedBytesUsed += PAGE_BYTES;
        }
        this.enforce();
    }

    /** Page index holding a sample time (samples since source start). */
    setFocusBySample(token: number, sample: number): void {
        if (!Number.isInteger(sample) || sample < 0) {
            throw new TypeError(`sample out of range: ${sample}`);
        }
        this.focus.set(token, Math.floor(sample / PAGE_FRAMES));
    }

    pinPage(token: number, pageIndex: number): void {
        const key = pageKey(token, pageIndex);
        if (this.pinned.has(key)) {
            return;
        }
        this.pinned.add(key);
        if (this.pages.has(key)) {
            this.pinnedBytesUsed += PAGE_BYTES;
        }
    }

    /** Pinned pages for a token covering [fromPage, toPage], inclusive. */
    pinWindow(token: number, fromPage: number, toPage: number): void {
        checkIndex('pageIndex', fromPage);
        checkIndex('pageIndex', toPage);
        if (fromPage > toPage) {
            throw new TypeError(
                `pinWindow is inverted: ${fromPage} > ${toPage}`,
            );
        }
        for (let page = fromPage; page <= toPage; page++) {
            this.pinPage(token, page);
        }
    }

    unpinAll(token?: number): void {
        if (token === undefined) {
            this.pinned.clear();
            this.pinnedBytesUsed = 0;
            return;
        }
        const row = this.pageKeys.get(token);
        if (row === undefined) {
            return;
        }
        for (const key of row) {
            if (this.pinned.delete(key)) {
                this.pinnedBytesUsed -= PAGE_BYTES;
            }
        }
    }

    dropToken(token: number): void {
        const row = this.pageKeys.get(token);
        if (row !== undefined) {
            for (const key of [...row]) {
                const page = this.pages.get(key);
                if (page !== undefined) {
                    this.remove(key, page);
                }
            }
            this.pageKeys.delete(token);
        }
        this.focus.delete(token);
        this.usedPerToken.delete(token);
    }

    dropAll(): void {
        this.pages.clear();
        this.pageKeys.clear();
        this.pinned.clear();
        this.focus.clear();
        this.usedPerToken.clear();
        this.bytesUsed = 0;
        this.pinnedBytesUsed = 0;
    }

    setBudget(budgetBytes: number): void {
        this.assertBudget(budgetBytes);
        this.budget = budgetBytes;
        this.enforce();
    }

    stats(): AudioPageStats {
        return {
            bytes: this.bytesUsed,
            pages: this.pages.size,
            pinnedBytes: this.pinnedBytesUsed,
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

    private assertPage(page: AudioPage): void {
        const [left, right] = page.channels;
        if (
            !(left instanceof Float32Array) ||
            !(right instanceof Float32Array) ||
            left.length !== PAGE_FRAMES ||
            right.length !== PAGE_FRAMES
        ) {
            throw new TypeError(
                `page ${page.token}:${page.pageIndex} must be two ${PAGE_FRAMES}-frame channels`,
            );
        }
        if (page.sampleRate <= 0 || !Number.isInteger(page.sampleRate)) {
            throw new TypeError(`bad sampleRate: ${page.sampleRate}`);
        }
    }

    private enforce(): void {
        this.evictGlobal();
        this.evictPerToken();
    }

    /** Batched to 90% so a single miss does not scan on every put. */
    private evictGlobal(): void {
        if (this.bytesUsed <= this.budget) {
            return;
        }
        const target = Math.floor(this.budget * 0.9);
        const candidates: Candidate[] = [];
        for (const [key, page] of this.pages) {
            if (this.pinned.has(key)) {
                continue;
            }
            const focus = this.focus.get(page.token);
            candidates.push({
                key,
                page,
                dist:
                    focus === undefined
                        ? Number.POSITIVE_INFINITY
                        : Math.abs(page.pageIndex - focus),
            });
        }
        candidates.sort((a, b) => b.dist - a.dist);
        for (const { key, page } of candidates) {
            if (this.bytesUsed <= target) {
                break;
            }
            this.remove(key, page);
        }
    }

    /** Only the sources that exceed their cap pay for a candidate list. */
    private evictPerToken(): void {
        for (const [token, used] of this.usedPerToken) {
            if (used <= this.perTokenBudget) {
                continue;
            }
            const target = Math.floor(this.perTokenBudget * 0.9);
            const candidates: Candidate[] = [];
            const row = this.pageKeys.get(token);
            if (row === undefined) {
                continue;
            }
            for (const key of row) {
                if (this.pinned.has(key)) {
                    continue;
                }
                const page = this.pages.get(key);
                if (page === undefined) {
                    continue;
                }
                const focus = this.focus.get(token);
                candidates.push({
                    key,
                    page,
                    dist:
                        focus === undefined
                            ? Number.POSITIVE_INFINITY
                            : Math.abs(page.pageIndex - focus),
                });
            }
            candidates.sort((a, b) => b.dist - a.dist);
            for (const { key, page } of candidates) {
                if ((this.usedPerToken.get(token) ?? 0) <= target) {
                    break;
                }
                this.remove(key, page);
            }
        }
    }

    private remove(key: number, page: AudioPage): void {
        this.pages.delete(key);
        this.subtract(page);
        const row = this.pageKeys.get(page.token);
        if (row !== undefined) {
            row.delete(key);
            if (row.size === 0) {
                this.pageKeys.delete(page.token);
            }
        }
        if (this.pinned.delete(key)) {
            this.pinnedBytesUsed -= PAGE_BYTES;
        }
        if ((this.usedPerToken.get(page.token) ?? 0) === 0) {
            this.usedPerToken.delete(page.token);
        }
    }

    private subtract(page: AudioPage): void {
        this.bytesUsed -= PAGE_BYTES;
        this.count(page.token, -PAGE_BYTES);
    }

    private count(token: number, delta: number): void {
        const next = (this.usedPerToken.get(token) ?? 0) + delta;
        if (next === 0) {
            this.usedPerToken.delete(token);
        } else {
            this.usedPerToken.set(token, next);
        }
    }
}
