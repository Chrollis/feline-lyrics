// Engine, doc section 8. The engine is a clock slave: the app owns play,
// pause and position, calls tick(nowMs) from its rAF loop, and asks
// videoFrame/subtitleFrame synchronously. Nothing here awaits on the draw
// path; prefetch happens between ticks.

import {
    activeInto,
    buildLayerIndex,
    type LayerIndex,
} from '../clips/layerIndex.js';
import type {
    AudioClip,
    Clip,
    SubtitleClip,
    VideoClip,
} from '../clips/clips.js';
import { AnimationStore, type Track } from './animation.js';
import { evaluateClip, type ClipRenderState } from './evaluate.js';
import { FrameCache } from '../frames/frameCache.js';
import {
    AudioPageCache,
    PAGE_FRAMES,
    type AudioPage,
} from '../audio/pageCache.js';

export type VideoPreset = { readonly scale: number; readonly fps: number };
export type FrameStatus = 'ready' | 'pending' | 'unavailable' | 'empty';

export interface SourceStream {
    readonly index: number;
    readonly kind: string;
    readonly codec: string | null;
    /** Audio streams report their length in samples (open_source). */
    readonly sampleRate?: number;
    readonly channels?: number;
    readonly totalSamples?: number;
    /** Video streams report their picture size and rate. */
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
}

/** The wire spells these with underscores; the engine reads camelCase. */
interface WireStream {
    readonly index: number;
    readonly kind: string;
    readonly codec?: string | null;
    readonly sample_rate?: number;
    readonly channels?: number;
    readonly total_samples?: number;
    readonly width?: number;
    readonly height?: number;
    readonly fps?: number;
}

function toSourceStream(wire: WireStream): SourceStream {
    const stream: {
        index: number;
        kind: string;
        codec: string | null;
        sampleRate?: number;
        channels?: number;
        totalSamples?: number;
        width?: number;
        height?: number;
        fps?: number;
    } = {
        index: wire.index,
        kind: wire.kind,
        codec: wire.codec ?? null,
    };
    if (typeof wire.sample_rate === 'number') {
        stream.sampleRate = wire.sample_rate;
    }
    if (typeof wire.channels === 'number') {
        stream.channels = wire.channels;
    }
    if (typeof wire.total_samples === 'number') {
        stream.totalSamples = wire.total_samples;
    }
    if (typeof wire.width === 'number') {
        stream.width = wire.width;
    }
    if (typeof wire.height === 'number') {
        stream.height = wire.height;
    }
    if (typeof wire.fps === 'number') {
        stream.fps = wire.fps;
    }
    return stream;
}

export interface SourceInfo {
    readonly sourceId: string;
    readonly path: string;
    readonly durationSec: number;
    readonly streams: readonly SourceStream[];
}

export interface FrameQuery {
    readonly status: FrameStatus;
    readonly clipId: string;
    readonly atMs: number;
    readonly frameIndex: number;
    readonly width: number;
    readonly height: number;
    readonly ptsMs?: number;
    readonly image?: Uint8Array;
    /** Subtitle rows when the picture came from a local subtitle source. */
    readonly rows?: readonly unknown[];
    /** Why a pending/unavailable answer is pending/unavailable. */
    readonly reason?: string;
}

export interface SubtitleFrame {
    readonly ptsMs: number;
    readonly rows: readonly unknown[];
}

/** What a local subtitle source must provide (doc 6.1). */
export interface SubtitleSource {
    revision(): number;
    frameRate(): number;
    durationMs(): number;
    renderWindow(fromMs: number, toMs: number): readonly SubtitleFrame[];
}

export type AudioStatus = 'ready' | 'pending' | 'unavailable' | 'empty';

export interface AudioPageQuery {
    readonly status: AudioStatus;
    readonly clipId: string;
    readonly atMs: number;
    readonly pageIndex: number;
    readonly sampleRate: number;
    readonly channels?: readonly [Float32Array, Float32Array];
    readonly reason?: string;
}

export interface DecodedAudio {
    readonly left: Float32Array;
    readonly right: Float32Array;
}

/** Decodes one range of FLAC bytes into planar stereo; the app supplies it. */
export type AudioDecoder = (flac: Uint8Array) => Promise<DecodedAudio>;

/** The subset of Transport the engine uses, so tests can fake the backend. */
export interface FrameTransport {
    request(
        method: string,
        params: unknown,
        opts?: { id?: number; timeoutMs?: number },
    ): Promise<unknown>;
    expectFrames(reqId: number, frames: number): boolean;
    expectBytes?(reqId: number, bytes: number): boolean;
    cancelFrames?(reqId: number): void;
    onError?(listener: (error: unknown) => void): () => void;
    /** The socket closed; the engine reconnects on the next request. */
    onClose?(
        listener: (info: {
            readonly code: number | null;
            readonly reason: string;
        }) => void,
    ): () => void;
    onFrame(
        listener: (frame: {
            readonly reqId: number;
            readonly header: {
                readonly seq: number;
                readonly last: boolean;
                readonly frame_index?: number;
                readonly pts_us?: number;
                readonly width?: number;
                readonly height?: number;
            };
            readonly bytes: Uint8Array;
        }) => void,
    ): () => void;
    close?(): void;
}

export interface MediapipeOptions {
    /** Connect to the backend; called lazily on the first openSource. */
    connect?: () => Promise<FrameTransport>;
    presets?: {
        /** Initial viewport; the app switches quality with setViewport. */
        readonly playback?: VideoPreset;
    };
    cache?: { readonly videoBytes?: number; readonly audioBytes?: number };
    /** Decodes FLAC range bytes into planar 48 kHz pages (doc 11). */
    decodeAudio?: AudioDecoder;
    autoKey?: boolean;
    /** Prefetch horizon per window (one second at the preset fps). */
    windowMs?: number;
}

export interface MediapipeStats {
    readonly videoBytes: number;
    readonly audioBytes: number;
    readonly subtitleFrames: number;
    readonly inFlight: number;
    readonly underruns: number;
}

/** One static value the app applies to the clip after a gesture (doc 7.5). */
export interface CommitAction {
    readonly ownerId: string;
    readonly path: string;
    readonly value: number;
    readonly tMs: number;
    readonly animated: boolean;
}

const DEFAULT_PRESET: VideoPreset = { scale: 0.5, fps: 30 };
const MAX_IN_FLIGHT = 4;
/** Video windows leave one slot to audio: a missed page is an audible miss. */
const MAX_VIDEO_IN_FLIGHT = MAX_IN_FLIGHT - 1;
const KEY_TOKENS = 1 << 20;
const FIRST_ENGINE_ID = 1_000_000;
/** Bound for a window build-then-ack; the backend builds before acking. */
const WINDOW_TIMEOUT_MS = 30_000;
const AUDIO_RATE = 48_000;

function sourceSampleOf(clip: AudioClip, localMs: number): number {
    const sourceMs = clip.inMs + localMs;
    return Math.round((sourceMs * AUDIO_RATE) / 1000);
}

/** A page always holds exactly PAGE_FRAMES samples; a short tail is padded. */
function fitPage(samples: Float32Array): Float32Array {
    // Always a fresh array: the decoder may reuse its buffers (review M2).
    const page = new Float32Array(PAGE_FRAMES);
    page.set(samples.subarray(0, Math.min(samples.length, PAGE_FRAMES)));
    return page;
}

/** First index whose start is strictly after tMs (starts is sorted). */
function firstStartAfter(starts: Int32Array, tMs: number): number {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (starts[mid] <= tMs) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

interface WindowRequest {
    clipId: string;
    token: number;
    slotStart: number;
    slots: number;
}

interface AudioRequest {
    readonly clipId: string;
    readonly token: number;
    readonly pageIndex: number;
    /** Samples the ack announced for this page (0 until the ack lands). */
    count: number;
    /** First sample of the acked region; must be the page's first sample. */
    startSample: number | undefined;
}

interface SubtitleEntry {
    readonly source: SubtitleSource;
    readonly durationMs: number;
    revision: number;
    readonly frames: Map<number, SubtitleFrame>;
}

interface VideoCaps {
    readonly scales?: readonly number[];
    readonly fps?: readonly number[];
}

export interface Mediapipe {
    openSource(path: string): Promise<SourceInfo>;
    closeSource(sourceId: string): Promise<void>;
    addClip(clip: Clip): void;
    updateClip(clip: Clip): void;
    removeClip(id: string): void;
    getClip(id: string): Clip | undefined;
    clips(): readonly Clip[];
    setViewport(preset: VideoPreset): VideoPreset;
    tick(nowMs: number): void;
    evaluateClip(clipId: string, atMs: number): ClipRenderState;
    preview(ownerId: string, path: string, value: number | Track | null): void;
    commitPreview(): readonly CommitAction[];
    clearPreview(ownerId?: string, path?: string): void;
    videoFrame(clipId: string, atMs: number): FrameQuery;
    audioPage(clipId: string, atMs: number): AudioPageQuery;
    registerSubtitleSource(key: string, source: SubtitleSource): void;
    subtitleFrame(clipId: string, atMs: number): FrameQuery;
    stats(): MediapipeStats;
    dispose(): Promise<void>;
}

class Engine implements Mediapipe {
    private readonly opts: MediapipeOptions;
    private client: FrameTransport | undefined;
    private connecting: Promise<FrameTransport> | undefined;
    private connectingHello: Promise<void> | undefined;
    private helloCaps: VideoCaps | undefined;
    private readonly sources = new Map<string, SourceInfo>();
    private readonly tokens = new Map<string, number>();
    private nextToken = 1;
    private nextRequestId = FIRST_ENGINE_ID;
    private readonly clipsById = new Map<string, Clip>();
    private indexVideo: LayerIndex;
    private indexAudio: LayerIndex;
    private indexSubtitle: LayerIndex;
    private readonly activeBuf: Clip[] = [];
    private readonly animation: AnimationStore;
    private readonly frames: FrameCache;
    private readonly pages: AudioPageCache;
    private readonly audioTokens = new Map<string, number>();
    private nextAudioToken = 1;
    private readonly audioRequests = new Map<number, AudioRequest>();
    private readonly audioPendingPages = new Map<number, Set<number>>();
    /** Pages the backend reported as past the source end (ack bytes 0). */
    private readonly audioEmpties = new Map<number, Set<number>>();
    private readonly windows = new Map<number, WindowRequest>();
    private readonly windowByClip = new Map<string, number>();
    /** Slot ranges the backend reported as having no frame (ack count 0). */
    private readonly empties = new Map<
        number,
        { start: number; end: number }[]
    >();
    private readonly subtitles = new Map<string, SubtitleEntry>();
    private readonly windowMs: number;
    private lastTickMs = 0;
    private helloDone = false;
    private viewport: VideoPreset;
    private underruns = 0;
    private disposed = false;
    private detach: (() => void) | undefined;
    private detachError: (() => void) | undefined;
    private detachClose: (() => void) | undefined;

    constructor(opts: MediapipeOptions = {}) {
        this.opts = opts;
        this.viewport = opts.presets?.playback ?? DEFAULT_PRESET;
        this.animation = new AnimationStore(opts.autoKey ?? false);
        this.frames = new FrameCache(opts.cache?.videoBytes);
        this.pages = new AudioPageCache(opts.cache?.audioBytes);
        this.windowMs = opts.windowMs ?? 1000;
        this.indexVideo = buildLayerIndex([]);
        this.indexAudio = buildLayerIndex([]);
        this.indexSubtitle = buildLayerIndex([]);
    }

    async openSource(path: string): Promise<SourceInfo> {
        this.assertAlive();
        const client = await this.ensureClient();
        await this.ensureHello();
        const raw = (await client.request('open_source', { path })) as {
            source_id: string;
            path: string;
            duration_sec: number;
            streams: WireStream[];
        };
        const info: SourceInfo = {
            sourceId: raw.source_id,
            path: raw.path,
            durationSec: raw.duration_sec,
            streams: raw.streams.map((stream) => toSourceStream(stream)),
        };
        this.sources.set(info.sourceId, info);
        return info;
    }

    async closeSource(sourceId: string): Promise<void> {
        const client = await this.ensureClient();
        await client.request('close_source', { source_id: sourceId });
        this.sources.delete(sourceId);
        for (const [reqId, req] of [...this.windows]) {
            const clip = this.clipsById.get(req.clipId);
            if (clip?.sourceId === sourceId) {
                this.dropWindow(reqId, true);
            }
        }
        for (const key of [...this.tokens.keys()]) {
            if (key.startsWith(`${sourceId}|`)) {
                const token = this.tokens.get(key);
                if (token !== undefined) {
                    this.frames.dropToken(token);
                    this.empties.delete(token);
                }
                this.tokens.delete(key);
            }
        }
        for (const key of [...this.audioTokens.keys()]) {
            if (!key.startsWith(`${sourceId}|`)) {
                continue;
            }
            const token = this.audioTokens.get(key);
            if (token === undefined) {
                continue;
            }
            for (const [reqId, req] of [...this.audioRequests]) {
                if (req.token === token) {
                    this.settleAudio(reqId, true);
                }
            }
            this.pages.dropToken(token);
            this.audioPendingPages.delete(token);
            this.audioEmpties.delete(token);
            this.audioTokens.delete(key);
        }
    }

    addClip(clip: Clip): void {
        if (this.clipsById.has(clip.id)) {
            throw new TypeError(`clip already exists: ${clip.id}`);
        }
        this.clipsById.set(clip.id, clip);
        this.rebuild();
    }

    updateClip(clip: Clip): void {
        if (!this.clipsById.has(clip.id)) {
            throw new TypeError(`unknown clip: ${clip.id}`);
        }
        this.clipsById.set(clip.id, clip);
        this.rebuild();
    }

    removeClip(id: string): void {
        if (!this.clipsById.delete(id)) {
            return;
        }
        this.animation.removeOwner(id);
        this.cancelClipWindow(id);
        this.rebuild();
    }

    getClip(id: string): Clip | undefined {
        return this.clipsById.get(id);
    }

    clips(): readonly Clip[] {
        return [...this.clipsById.values()];
    }

    /**
     * Global viewport (doc 10). A quality switch keeps the frames of the
     * previous preset: the cache key carries scale and fps, so an entry stays
     * valid and reachable when the user switches back, and eviction reclaims
     * it under pressure (Adobe keys per-quality entries the same way, doc
     * 15.2). Only the focus moves.
     */
    setViewport(preset: VideoPreset): VideoPreset {
        if (!(preset.fps > 0) || !(preset.scale > 0)) {
            throw new TypeError(`bad preset: ${JSON.stringify(preset)}`);
        }
        this.assertSupported(preset);
        this.viewport = preset;
        return this.viewport;
    }

    /** One per rAF: focus the caches and keep prefetch windows alive. */
    tick(nowMs: number): void {
        if (this.disposed) {
            return;
        }
        this.lastTickMs = nowMs;
        // Audio goes first: a missed page is audible, a late frame is not.
        activeInto(this.indexAudio, nowMs, this.activeBuf);
        for (const clip of this.activeBuf) {
            if (clip.kind === 'audio') {
                this.prefetchAudio(clip, nowMs);
            }
        }
        activeInto(this.indexVideo, nowMs, this.activeBuf);
        for (const clip of this.activeBuf) {
            this.prefetch(clip, nowMs);
        }
        this.prefetchAhead(nowMs);
        activeInto(this.indexSubtitle, nowMs, this.activeBuf);
        for (const clip of this.activeBuf) {
            if (clip.kind === 'subtitle') {
                this.prefetchSubtitle(clip, nowMs);
            }
        }
        // Pins last exactly one frame: whatever this tick did not touch may
        // be evicted by the next page cache put.
        this.pages.unpinAll();
    }

    evaluateClip(clipId: string, atMs: number): ClipRenderState {
        return evaluateClip(this.requireClip(clipId), atMs, this.animation);
    }

    preview(ownerId: string, path: string, value: number | Track | null): void {
        if (value === null) {
            this.animation.clearPreview(ownerId, path);
            return;
        }
        if (typeof value === 'number') {
            this.animation.previewSet(
                ownerId,
                path,
                value,
                this.previewTime(ownerId),
            );
            return;
        }
        const local = this.previewTime(ownerId);
        for (const channel of value.channels) {
            this.animation.previewTrack(
                ownerId,
                channel.path,
                channel.keys.map((k) => ({ ...k, tMs: k.tMs + local })),
            );
        }
    }

    commitPreview(): readonly CommitAction[] {
        return this.animation.commit();
    }

    clearPreview(ownerId?: string, path?: string): void {
        this.animation.clearPreview(ownerId, path);
    }

    videoFrame(clipId: string, atMs: number): FrameQuery {
        const clip = this.requireClip(clipId);
        if (!Number.isFinite(atMs)) {
            return this.unavailable(clipId, atMs, 0, 'bad-time');
        }
        if (clip.kind !== 'video') {
            return this.unavailable(clipId, atMs, 0, 'not-a-video-clip');
        }
        if (clip.sourceId === undefined) {
            return this.unavailable(clipId, atMs, 0, 'no-source');
        }
        const localMs = atMs - clip.span.startMs;
        if (localMs < 0 || localMs >= clip.span.durationMs) {
            return this.unavailable(clipId, atMs, 0, 'out-of-span');
        }
        if (!this.sources.has(clip.sourceId)) {
            return this.unavailable(clipId, atMs, 0, 'source-not-open');
        }
        const sourceMs = Math.round(clip.inSec * 1000) + localMs;
        const slot = Math.floor((sourceMs * this.viewport.fps) / 1000);
        if (slot < 0) {
            return this.unavailable(clipId, atMs, 0, 'before-source');
        }
        const token = this.tokenFor(clip, this.viewport.scale);
        if (this.isKnownEmpty(token, slot)) {
            return this.empty(clipId, atMs, slot);
        }
        const entry = this.frames.get(token, slot);
        if (entry !== undefined) {
            return {
                status: 'ready',
                clipId,
                atMs,
                frameIndex: slot,
                width: entry.width,
                height: entry.height,
                ptsMs: entry.ptsMs,
                image: entry.image as Uint8Array,
            };
        }
        const started = this.ensureWindow(clip, slot);
        return {
            status: 'pending',
            clipId,
            atMs,
            frameIndex: slot,
            width: 0,
            height: 0,
            reason: started ? 'inflight' : 'window-full',
        };
    }

    audioPage(clipId: string, atMs: number): AudioPageQuery {
        const clip = this.requireClip(clipId);
        if (!Number.isFinite(atMs)) {
            return this.audioRejected(clipId, atMs, 0, 'bad-time');
        }
        if (clip.kind !== 'audio') {
            return this.audioRejected(clipId, atMs, 0, 'not-an-audio-clip');
        }
        if (clip.sourceId === undefined) {
            return this.audioRejected(clipId, atMs, 0, 'no-source');
        }
        const source = this.sources.get(clip.sourceId);
        if (source === undefined) {
            return this.audioRejected(clipId, atMs, 0, 'source-not-open');
        }
        const streamIndex = this.audioStreamIndex(source);
        if (streamIndex === undefined) {
            return this.audioRejected(clipId, atMs, 0, 'no-audio-stream');
        }
        if (clip.stream !== streamIndex) {
            // The backend only serves the audio stream at its own index; a
            // wrong index must not become a per-tick request storm.
            return this.audioRejected(clipId, atMs, 0, 'bad-stream');
        }
        const localMs = atMs - clip.span.startMs;
        if (localMs < 0) {
            return this.audioUnavailable(clipId, atMs, 0, 'before-clip');
        }
        if (localMs >= clip.span.durationMs) {
            return this.audioUnavailable(clipId, atMs, 0, 'out-of-span');
        }
        const sample = sourceSampleOf(clip, localMs);
        if (sample < 0) {
            return this.audioUnavailable(clipId, atMs, 0, 'before-source');
        }
        const total = this.audioTotalSamples(source);
        const pageIndex = Math.floor(sample / PAGE_FRAMES);
        const token = this.audioTokenFor(clip);
        if (total !== undefined && sample >= total) {
            // A clip outlived its source: there is no data past the end.
            this.markAudioEmpty(token, pageIndex);
            return this.audioEmpty(clipId, atMs, pageIndex);
        }
        if (this.isAudioEmpty(token, pageIndex)) {
            return this.audioEmpty(clipId, atMs, pageIndex);
        }
        const page = this.pages.get(token, pageIndex);
        if (page !== undefined) {
            return {
                status: 'ready',
                clipId,
                atMs,
                pageIndex,
                sampleRate: page.sampleRate,
                channels: page.channels,
            };
        }
        const refused = this.ensureAudioPage(clip, token, pageIndex);
        return {
            status: 'pending',
            clipId,
            atMs,
            pageIndex,
            sampleRate: AUDIO_RATE,
            reason: refused ?? 'inflight',
        };
    }

    registerSubtitleSource(key: string, source: SubtitleSource): void {
        const fps = source.frameRate();
        const revision = source.revision();
        const durationMs = source.durationMs();
        if (!(fps > 0) || !Number.isFinite(fps)) {
            throw new TypeError(`subtitle frame rate must be positive: ${fps}`);
        }
        if (!Number.isFinite(revision)) {
            throw new TypeError(
                `subtitle revision must be finite: ${revision}`,
            );
        }
        if (!(durationMs > 0) || !Number.isFinite(durationMs)) {
            throw new TypeError(
                `subtitle duration must be positive: ${durationMs}`,
            );
        }
        this.subtitles.set(key, {
            source,
            durationMs,
            revision,
            frames: new Map(),
        });
    }

    subtitleFrame(clipId: string, atMs: number): FrameQuery {
        const clip = this.requireClip(clipId);
        if (!Number.isFinite(atMs)) {
            return this.unavailable(clipId, atMs, 0, 'bad-time');
        }
        if (clip.kind !== 'subtitle') {
            return this.unavailable(clipId, atMs, 0, 'not-a-subtitle-clip');
        }
        const entry = this.subtitles.get(clip.sourceKey);
        if (entry === undefined) {
            return this.unavailable(clipId, atMs, 0, 'source-not-registered');
        }
        if (this.refreshSubtitleRevision(entry)) {
            entry.frames.clear();
        }
        const localMs = atMs - clip.span.startMs;
        if (localMs < 0 || localMs >= clip.span.durationMs) {
            return this.unavailable(clipId, atMs, 0, 'out-of-span');
        }
        const sourceMs = clip.inMs + localMs;
        if (sourceMs >= entry.durationMs) {
            return this.empty(
                clipId,
                atMs,
                Math.floor((sourceMs * entry.source.frameRate()) / 1000),
            );
        }
        const fps = entry.source.frameRate();
        if (!(fps > 0) || !Number.isFinite(fps)) {
            return this.unavailable(clipId, atMs, 0, 'bad-frame-rate');
        }
        const index = Math.floor((sourceMs * fps) / 1000);
        const hit = entry.frames.get(index);
        if (hit !== undefined) {
            return {
                status: 'ready',
                clipId,
                atMs,
                frameIndex: index,
                width: 0,
                height: 0,
                ptsMs: hit.ptsMs,
                rows: hit.rows,
            };
        }
        this.renderSubtitleWindow(entry, sourceMs);
        const after = entry.frames.get(index);
        if (after !== undefined) {
            return {
                status: 'ready',
                clipId,
                atMs,
                frameIndex: index,
                width: 0,
                height: 0,
                ptsMs: after.ptsMs,
                rows: after.rows,
            };
        }
        return {
            status: 'pending',
            clipId,
            atMs,
            frameIndex: index,
            width: 0,
            height: 0,
            reason: 'no-subtitle-frame',
        };
    }

    stats(): MediapipeStats {
        let subtitleFrames = 0;
        for (const entry of this.subtitles.values()) {
            subtitleFrames += entry.frames.size;
        }
        return {
            videoBytes: this.frames.bytes,
            audioBytes: this.pages.bytes,
            subtitleFrames,
            inFlight: this.windows.size + this.audioRequests.size,
            underruns: this.underruns,
        };
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.detach?.();
        this.detach = undefined;
        this.detachError?.();
        this.detachError = undefined;
        this.detachClose?.();
        this.detachClose = undefined;
        for (const reqId of [...this.windows.keys()]) {
            this.dropWindow(reqId, true);
        }
        for (const reqId of [...this.audioRequests.keys()]) {
            this.settleAudio(reqId, true);
        }
        this.frames.dropAll();
        this.pages.dropAll();
        this.empties.clear();
        this.audioEmpties.clear();
        this.subtitles.clear();
        this.sources.clear();
        this.client?.close?.();
        this.client = undefined;
        this.connecting = undefined;
        this.connectingHello = undefined;
        this.helloDone = false;
    }

    // ---------------------------------------------------------------------

    private rebuild(): void {
        const video: VideoClip[] = [];
        const audio: Clip[] = [];
        const subtitle: SubtitleClip[] = [];
        for (const clip of this.clipsById.values()) {
            if (clip.kind === 'video') {
                video.push(clip);
            } else if (clip.kind === 'audio') {
                audio.push(clip);
            } else {
                subtitle.push(clip);
            }
        }
        this.indexVideo = buildLayerIndex(video);
        this.indexAudio = buildLayerIndex(audio);
        this.indexSubtitle = buildLayerIndex(subtitle);
    }

    private prefetch(clip: Clip, nowMs: number): void {
        if (clip.kind !== 'video') {
            return;
        }
        if (clip.sourceId === undefined) {
            return;
        }
        if (!this.sources.has(clip.sourceId)) {
            return;
        }
        const localMs = nowMs - clip.span.startMs;
        if (localMs < 0 || localMs >= clip.span.durationMs) {
            return;
        }
        const sourceMs = Math.round(clip.inSec * 1000) + localMs;
        const token = this.tokenFor(clip, this.viewport.scale);
        this.frames.setFocus(token, sourceMs);
        const slot = Math.floor((sourceMs * this.viewport.fps) / 1000);
        if (slot >= 0 && !this.isKnownEmpty(token, slot)) {
            this.ensureWindow(clip, slot);
        }
    }

    /**
     * Video clips whose span starts inside the prefetch horizon get their
     * first window now, so a cut does not open on an unfetched frame. The
     * walk starts at the first start after nowMs (binary search over the
     * sorted starts) and stops at the window cap, never over every clip.
     */
    private prefetchAhead(nowMs: number): void {
        const index = this.indexVideo;
        const starts = index.starts;
        const until = nowMs + this.windowMs;
        for (
            let i = firstStartAfter(starts, nowMs);
            i < starts.length;
            i += 1
        ) {
            if (starts[i] > until) {
                return;
            }
            if (this.windows.size >= MAX_VIDEO_IN_FLIGHT) {
                return;
            }
            const clip = index.clips[index.startIds[i]];
            if (clip.kind !== 'video' || clip.sourceId === undefined) {
                continue;
            }
            if (clip.span.durationMs === 0) {
                continue;
            }
            if (!this.sources.has(clip.sourceId)) {
                continue;
            }
            if (this.windowByClip.has(clip.id)) {
                continue;
            }
            const sourceMs = Math.round(clip.inSec * 1000);
            const token = this.tokenFor(clip, this.viewport.scale);
            this.frames.setFocus(token, sourceMs);
            const slot = Math.floor((sourceMs * this.viewport.fps) / 1000);
            if (slot >= 0 && !this.isKnownEmpty(token, slot)) {
                this.ensureWindow(clip, slot);
            }
        }
    }

    private prefetchSubtitle(clip: SubtitleClip, nowMs: number): void {
        const entry = this.subtitles.get(clip.sourceKey);
        if (entry === undefined) {
            return;
        }
        if (this.refreshSubtitleRevision(entry)) {
            entry.frames.clear();
        }
        const localMs = nowMs - clip.span.startMs;
        if (localMs < 0 || localMs >= clip.span.durationMs) {
            return;
        }
        this.renderSubtitleWindow(entry, clip.inMs + localMs);
    }

    private prefetchAudio(clip: AudioClip, nowMs: number): void {
        const sourceId = clip.sourceId;
        if (sourceId === undefined) {
            return;
        }
        const source = this.sources.get(sourceId);
        if (source === undefined) {
            return;
        }
        if (this.audioStreamIndex(source) !== clip.stream) {
            return;
        }
        const localMs = nowMs - clip.span.startMs;
        if (localMs < 0 || localMs >= clip.span.durationMs) {
            return;
        }
        const sample = sourceSampleOf(clip, localMs);
        if (sample < 0) {
            return;
        }
        const token = this.audioTokenFor(clip);
        this.pages.setFocusBySample(token, sample);
        const page = Math.floor(sample / PAGE_FRAMES);
        this.pages.pinWindow(token, Math.max(0, page - 1), page + 2);
        const total = this.audioTotalSamples(source);
        if (total !== undefined && sample >= total) {
            this.markAudioEmpty(token, page);
            return;
        }
        this.ensureAudioPage(clip, token, page);
        // Only prefetch the next page when the source still has samples in it.
        if (total === undefined || (page + 1) * PAGE_FRAMES < total) {
            this.ensureAudioPage(clip, token, page + 1);
        }
    }

    private ensureAudioPage(
        clip: AudioClip,
        token: number,
        pageIndex: number,
    ): string | undefined {
        const client = this.client;
        if (client === undefined || !this.helloDone) {
            this.reconnect();
            return 'no-backend';
        }
        if (this.opts.decodeAudio === undefined) {
            return 'no-decoder';
        }
        if (clip.sourceId === undefined) {
            return 'no-source';
        }
        if (this.pages.get(token, pageIndex) !== undefined) {
            return 'cached';
        }
        if (
            !Number.isInteger(pageIndex) ||
            pageIndex < 0 ||
            pageIndex >= KEY_TOKENS
        ) {
            return 'page-out-of-range';
        }
        let pending = this.audioPendingPages.get(token);
        if (pending?.has(pageIndex) === true) {
            return undefined;
        }
        if (this.isAudioEmpty(token, pageIndex)) {
            return 'empty';
        }
        if (this.windows.size + this.audioRequests.size >= MAX_IN_FLIGHT) {
            return 'window-full';
        }
        const reqId = this.nextRequestId++;
        this.audioRequests.set(reqId, {
            clipId: clip.id,
            token,
            pageIndex,
            count: 0,
            startSample: undefined,
        });
        if (pending === undefined) {
            pending = new Set<number>();
            this.audioPendingPages.set(token, pending);
        }
        pending.add(pageIndex);
        void client
            .request(
                'request_range',
                {
                    source_id: clip.sourceId,
                    kind: 'audio',
                    stream: clip.stream,
                    start_sec: pageIndex,
                    duration_sec: 1,
                },
                { id: reqId, timeoutMs: WINDOW_TIMEOUT_MS },
            )
            .then((raw) => {
                const req = this.audioRequests.get(reqId);
                if (req === undefined) {
                    return;
                }
                const ack = raw as {
                    bytes?: unknown;
                    count?: unknown;
                    start_sample?: unknown;
                };
                const count =
                    typeof ack.count === 'number' && Number.isInteger(ack.count)
                        ? ack.count
                        : 0;
                if (count === 0) {
                    // Past the end of the source: remember it so the next tick
                    // does not ask for the same page again, and swallow the
                    // single terminal frame the backend still sends.
                    this.markAudioEmpty(req.token, req.pageIndex);
                    client.expectFrames?.(reqId, 1);
                    this.settleAudio(reqId, false);
                    return;
                }
                req.count = count;
                if (
                    typeof ack.start_sample === 'number' &&
                    Number.isInteger(ack.start_sample) &&
                    ack.start_sample >= 0
                ) {
                    req.startSample = ack.start_sample;
                }
                // A missing byte count is not "expect zero bytes": arming a
                // bogus expectation would fail a healthy stream.
                const bytes = ack.bytes;
                if (
                    typeof bytes === 'number' &&
                    Number.isInteger(bytes) &&
                    bytes > 0
                ) {
                    client.expectBytes?.(reqId, bytes);
                }
            })
            .catch(() => {
                this.settleAudio(reqId, true);
            });
        return undefined;
    }

    /** Start a window for the slot, or restart when the slot moved (scrub). */
    private ensureWindow(clip: VideoClip, slot: number): boolean {
        if (this.client === undefined || !this.helloDone) {
            this.reconnect();
            return false;
        }
        if (clip.sourceId === undefined) {
            return false;
        }
        const current = this.windowByClip.get(clip.id);
        if (current !== undefined) {
            const req = this.windows.get(current);
            if (
                req !== undefined &&
                slot >= req.slotStart &&
                slot < req.slotStart + req.slots
            ) {
                return true;
            }
            this.dropWindow(current, true);
        }
        if (
            this.windows.size >= MAX_VIDEO_IN_FLIGHT ||
            this.windows.size + this.audioRequests.size >= MAX_IN_FLIGHT
        ) {
            return false;
        }
        return this.requestWindow(clip, slot);
    }

    private requestWindow(clip: VideoClip, slot: number): boolean {
        const client = this.client;
        if (client === undefined || slot >= KEY_TOKENS) {
            return false;
        }
        const reqId = this.nextRequestId++;
        const token = this.tokenFor(clip, this.viewport.scale);
        const slots = Math.max(
            1,
            Math.ceil((this.windowMs * this.viewport.fps) / 1000),
        );
        this.windows.set(reqId, {
            clipId: clip.id,
            token,
            slotStart: slot,
            slots,
        });
        this.windowByClip.set(clip.id, reqId);
        void client
            .request(
                'request_range',
                {
                    source_id: clip.sourceId,
                    kind: 'video',
                    stream: clip.stream,
                    start_sec: slot / this.viewport.fps,
                    duration_sec: this.windowMs / 1000,
                    scale: this.viewport.scale,
                    fps: this.viewport.fps,
                },
                { id: reqId, timeoutMs: WINDOW_TIMEOUT_MS },
            )
            .then((raw) => {
                const ack = raw as { count?: number };
                const rec = this.windows.get(reqId);
                if (rec === undefined) {
                    return;
                }
                const count = ack.count ?? 0;
                if (count === 0) {
                    // An empty region: record it so the next tick does not
                    // rebuild the same window forever.
                    this.markEmpty(rec.token, rec.slotStart, rec.slots);
                    client.expectFrames(reqId, 1);
                    this.settle(reqId);
                    return;
                }
                client.expectFrames(reqId, count);
            })
            .catch(() => {
                this.settle(reqId);
            });
        return true;
    }

    /** Premature drop: cancels the wire request so its frames stop arriving. */
    private dropWindow(reqId: number, cancelWire: boolean): void {
        const rec = this.windows.get(reqId);
        this.windows.delete(reqId);
        if (rec !== undefined && this.windowByClip.get(rec.clipId) === reqId) {
            this.windowByClip.delete(rec.clipId);
        }
        if (cancelWire) {
            this.client?.cancelFrames?.(reqId);
        }
    }

    private settle(reqId: number): void {
        this.dropWindow(reqId, false);
    }

    private cancelClipWindow(clipId: string): void {
        const reqId = this.windowByClip.get(clipId);
        if (reqId !== undefined) {
            this.dropWindow(reqId, true);
        }
    }

    private handleFrame(frame: {
        readonly reqId: number;
        readonly header: {
            readonly seq: number;
            readonly last: boolean;
            readonly frame_index?: number;
            readonly pts_us?: number;
            readonly width?: number;
            readonly height?: number;
        };
        readonly bytes: Uint8Array;
    }): void {
        const audio = this.audioRequests.get(frame.reqId);
        if (audio !== undefined) {
            // Audio arrives as one assembled stream at `last`. An empty
            // stream is the terminal frame of a page past the source end.
            if (frame.header.last) {
                if (frame.bytes.length < 4) {
                    this.markAudioEmpty(audio.token, audio.pageIndex);
                } else {
                    this.finishAudioFrame(audio, frame.bytes);
                }
                this.settleAudio(frame.reqId, false);
            }
            return;
        }
        const rec = this.windows.get(frame.reqId);
        if (rec === undefined) {
            return;
        }
        // The backend emits one PNG per output slot; seq is that slot's
        // offset and frame_index is a source frame number, not a cache key.
        const slot = rec.slotStart + (frame.header.seq - 1);
        const width = frame.header.width ?? 0;
        const height = frame.header.height ?? 0;
        if (slot >= 0 && slot < KEY_TOKENS) {
            this.frames.put({
                token: rec.token,
                frameIndex: slot,
                ptsMs:
                    typeof frame.header.pts_us === 'number'
                        ? frame.header.pts_us / 1000
                        : (slot * 1000) / this.viewport.fps,
                width,
                height,
                bytes: width * height * 4,
                image: frame.bytes,
            });
        }
        if (frame.header.last) {
            this.settle(frame.reqId);
        }
    }

    private markEmpty(token: number, start: number, slots: number): void {
        let ranges = this.empties.get(token);
        if (ranges === undefined) {
            ranges = [];
            this.empties.set(token, ranges);
        }
        ranges.push({ start, end: start + slots });
    }

    private isKnownEmpty(token: number, slot: number): boolean {
        const ranges = this.empties.get(token);
        if (ranges === undefined) {
            return false;
        }
        for (const range of ranges) {
            if (slot >= range.start && slot < range.end) {
                return true;
            }
        }
        return false;
    }

    private renderSubtitleWindow(entry: SubtitleEntry, sourceMs: number): void {
        const fps = entry.source.frameRate();
        if (!(fps > 0) || !Number.isFinite(fps)) {
            return;
        }
        if (sourceMs >= entry.durationMs) {
            return;
        }
        const windowFrames = Math.max(
            1,
            Math.ceil((this.windowMs * fps) / 1000),
        );
        for (const frame of entry.source.renderWindow(
            sourceMs,
            Math.min(sourceMs + this.windowMs, entry.durationMs),
        )) {
            entry.frames.set(Math.floor((frame.ptsMs * fps) / 1000), frame);
        }
        const centre = Math.floor((sourceMs * fps) / 1000);
        const lo = centre - windowFrames;
        const hi = centre + windowFrames * 2;
        for (const key of entry.frames.keys()) {
            if (key < lo || key > hi) {
                entry.frames.delete(key);
            }
        }
    }

    private refreshSubtitleRevision(entry: SubtitleEntry): boolean {
        const revision = entry.source.revision();
        if (revision === entry.revision) {
            return false;
        }
        entry.revision = revision;
        return true;
    }

    private previewTime(ownerId: string): number {
        const clip = this.clipsById.get(ownerId);
        if (clip === undefined) {
            return 0;
        }
        return Math.max(0, Math.round(this.lastTickMs - clip.span.startMs));
    }

    private tokenFor(clip: VideoClip, scale: number): number {
        const key = `${clip.sourceId ?? ''}|${clip.stream}|${scale}|${this.viewport.fps}`;
        const existing = this.tokens.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const token = this.nextToken++;
        if (token >= KEY_TOKENS) {
            throw new RangeError('too many source tokens');
        }
        this.tokens.set(key, token);
        return token;
    }

    private requireClip(id: string): Clip {
        const clip = this.clipsById.get(id);
        if (clip === undefined) {
            throw new TypeError(`unknown clip: ${id}`);
        }
        return clip;
    }

    private unavailable(
        clipId: string,
        atMs: number,
        slot: number,
        reason: string,
    ): FrameQuery {
        this.underruns++;
        return {
            status: 'unavailable',
            clipId,
            atMs,
            frameIndex: slot,
            width: 0,
            height: 0,
            reason,
        };
    }

    private empty(clipId: string, atMs: number, slot: number): FrameQuery {
        return {
            status: 'empty',
            clipId,
            atMs,
            frameIndex: slot,
            width: 0,
            height: 0,
            reason: 'no-frame-at-slot',
        };
    }

    private audioUnavailable(
        clipId: string,
        atMs: number,
        pageIndex: number,
        reason: string,
    ): AudioPageQuery {
        this.underruns++;
        return {
            status: 'unavailable',
            clipId,
            atMs,
            pageIndex,
            sampleRate: AUDIO_RATE,
            reason,
        };
    }

    /** A configuration problem: refuse without counting an underrun. */
    private audioRejected(
        clipId: string,
        atMs: number,
        pageIndex: number,
        reason: string,
    ): AudioPageQuery {
        return {
            status: 'unavailable',
            clipId,
            atMs,
            pageIndex,
            sampleRate: AUDIO_RATE,
            reason,
        };
    }

    private audioTokenFor(clip: AudioClip): number {
        const key = `${clip.sourceId ?? ''}|${clip.stream}`;
        const existing = this.audioTokens.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const token = this.nextAudioToken++;
        if (token >= KEY_TOKENS) {
            throw new RangeError('too many audio source tokens');
        }
        this.audioTokens.set(key, token);
        return token;
    }

    private settleAudio(reqId: number, cancelWire: boolean): void {
        const req = this.audioRequests.get(reqId);
        if (req === undefined) {
            return;
        }
        this.audioRequests.delete(reqId);
        const pending = this.audioPendingPages.get(req.token);
        if (pending !== undefined) {
            pending.delete(req.pageIndex);
            if (pending.size === 0) {
                this.audioPendingPages.delete(req.token);
            }
        }
        if (cancelWire) {
            this.client?.cancelFrames?.(reqId);
        }
    }

    private markAudioEmpty(token: number, pageIndex: number): void {
        let pages = this.audioEmpties.get(token);
        if (pages === undefined) {
            pages = new Set<number>();
            this.audioEmpties.set(token, pages);
        }
        pages.add(pageIndex);
    }

    private isAudioEmpty(token: number, pageIndex: number): boolean {
        return this.audioEmpties.get(token)?.has(pageIndex) === true;
    }

    private audioEmpty(
        clipId: string,
        atMs: number,
        pageIndex: number,
    ): AudioPageQuery {
        return {
            status: 'empty',
            clipId,
            atMs,
            pageIndex,
            sampleRate: AUDIO_RATE,
            reason: 'no-page',
        };
    }

    private finishAudioFrame(req: AudioRequest, flac: Uint8Array): void {
        const decoder = this.opts.decodeAudio;
        if (decoder === undefined) {
            return;
        }
        void decoder(flac)
            .then((decoded) => {
                // A decode that lands after dispose or after its source was
                // closed must not repopulate a dead pool.
                if (this.disposed || !this.isAudioTokenAlive(req.token)) {
                    return;
                }
                if (
                    req.startSample !== undefined &&
                    req.startSample !== req.pageIndex * PAGE_FRAMES
                ) {
                    // The acked region does not start where the page does, so
                    // caching it under pageIndex would play shifted audio.
                    console.error(
                        `mediapipe: audio page start mismatch: page ${req.pageIndex} starts at ${req.pageIndex * PAGE_FRAMES}, ack says ${req.startSample}`,
                    );
                    return;
                }
                const left = decoded.left;
                const right = decoded.right;
                if (
                    !(left instanceof Float32Array) ||
                    !(right instanceof Float32Array)
                ) {
                    console.error(
                        'mediapipe: audio decode returned non-float32 channels',
                    );
                    return;
                }
                if (left.length !== right.length) {
                    console.error(
                        'mediapipe: audio decode channels differ in length',
                    );
                    return;
                }
                const expected = Math.min(Math.max(req.count, 0), PAGE_FRAMES);
                if (
                    expected > 0 &&
                    left.length !== expected &&
                    left.length !== PAGE_FRAMES
                ) {
                    // A decoder that returns the wrong number of frames (wrong
                    // context rate, mono copy) would silently pitch-shift the
                    // whole page; refuse it instead.
                    console.error(
                        `mediapipe: audio decode length mismatch: got ${left.length}, expected ${expected}`,
                    );
                    return;
                }
                const page: AudioPage = {
                    token: req.token,
                    pageIndex: req.pageIndex,
                    channels: [fitPage(left), fitPage(right)],
                    sampleRate: AUDIO_RATE,
                };
                this.pages.put(page);
            })
            .catch((err: unknown) => {
                console.error('mediapipe: audio decode failed', err);
            });
    }

    private isAudioTokenAlive(token: number): boolean {
        for (const value of this.audioTokens.values()) {
            if (value === token) {
                return true;
            }
        }
        return false;
    }

    private audioStreamIndex(source: SourceInfo): number | undefined {
        for (const stream of source.streams) {
            if (stream.kind === 'audio') {
                return stream.index;
            }
        }
        return undefined;
    }

    private audioTotalSamples(source: SourceInfo): number | undefined {
        for (const stream of source.streams) {
            if (stream.kind !== 'audio') {
                continue;
            }
            if (typeof stream.totalSamples === 'number') {
                return stream.totalSamples;
            }
            return Math.round(source.durationSec * AUDIO_RATE);
        }
        return undefined;
    }

    private assertSupported(preset: VideoPreset): void {
        const caps = this.helloCaps;
        if (caps === undefined) {
            return;
        }
        const scales = caps.scales;
        const rates = caps.fps;
        if (scales !== undefined && !scales.some((s) => s === preset.scale)) {
            throw new TypeError(`unsupported scale: ${preset.scale}`);
        }
        if (rates !== undefined && !rates.some((r) => r === preset.fps)) {
            throw new TypeError(`unsupported fps: ${preset.fps}`);
        }
    }

    private async ensureHello(): Promise<void> {
        if (this.connectingHello === undefined) {
            this.connectingHello = (async () => {
                const client = await this.ensureClient();
                const info = (await client.request('hello', {
                    protocol: 1,
                })) as { video?: VideoCaps };
                this.helloCaps = info.video;
                this.helloDone = true;
            })();
            this.connectingHello = this.connectingHello.then(
                undefined,
                (err) => {
                    this.connectingHello = undefined;
                    throw err;
                },
            );
        }
        return this.connectingHello;
    }

    private async ensureClient(): Promise<FrameTransport> {
        this.assertAlive();
        if (this.client !== undefined) {
            return this.client;
        }
        if (this.connecting === undefined) {
            const connect = this.opts.connect;
            if (connect === undefined) {
                throw new Error('mediapipe: no backend connector');
            }
            this.connecting = connect().then((client) => {
                if (this.disposed) {
                    client.close?.();
                    throw new Error('mediapipe: disposed');
                }
                this.client = client;
                this.detach = client.onFrame((frame) =>
                    this.handleFrame(frame),
                );
                // Frame-level failures arrive after the ack has settled the
                // request promise; without this listener their slot leaks.
                this.detachError = client.onError?.((err) => {
                    this.handleTransportError(err);
                });
                this.detachClose = client.onClose?.((info) => {
                    this.handleClose(info);
                });
                // Frames the last tick could not request are flushed once.
                queueMicrotask(() => {
                    if (!this.disposed) {
                        this.tick(this.lastTickMs);
                    }
                });
                return client;
            });
            this.connecting = this.connecting.then(undefined, (err) => {
                this.connecting = undefined;
                throw err;
            });
        }
        return this.connecting;
    }

    private assertAlive(): void {
        if (this.disposed) {
            throw new Error('mediapipe: disposed');
        }
    }

    /** Release the slot of a request the transport failed after its ack. */
    private handleTransportError(err: unknown): void {
        const data = (err as { data?: { reqId?: unknown } } | null)?.data;
        const reqId =
            data !== undefined && typeof data.reqId === 'number'
                ? data.reqId
                : undefined;
        if (reqId === undefined) {
            return;
        }
        if (this.audioRequests.has(reqId)) {
            this.settleAudio(reqId, false);
            return;
        }
        if (this.windows.has(reqId)) {
            this.settle(reqId);
        }
    }

    /**
     * The socket closed. Every request died with it, so the windows and audio
     * pages are settled (the wire is gone, cancelling would throw) and the
     * connection state is cleared; the next request reconnects and re-hellos.
     * Sources are kept: the backend still owns them while its process lives.
     */
    private handleClose(info: {
        readonly code: number | null;
        readonly reason: string;
    }): void {
        if (this.disposed) {
            return;
        }
        console.warn(
            `mediapipe: backend closed (code ${String(info.code)})`,
            info.reason,
        );
        for (const reqId of [...this.windows.keys()]) {
            this.dropWindow(reqId, false);
        }
        for (const reqId of [...this.audioRequests.keys()]) {
            this.settleAudio(reqId, false);
        }
        this.detach?.();
        this.detach = undefined;
        this.detachError?.();
        this.detachError = undefined;
        this.detachClose?.();
        this.detachClose = undefined;
        this.client = undefined;
        this.connecting = undefined;
        this.connectingHello = undefined;
        this.helloCaps = undefined;
        this.helloDone = false;
    }

    /** A dropped socket reconnects on the next request; never throw from tick. */
    private reconnect(): void {
        if (this.disposed || this.client !== undefined) {
            return;
        }
        void this.ensureClient()
            .then(() => this.ensureHello())
            .catch(() => {});
    }
}

export function createMediapipe(opts: MediapipeOptions = {}): Mediapipe {
    return new Engine(opts);
}
