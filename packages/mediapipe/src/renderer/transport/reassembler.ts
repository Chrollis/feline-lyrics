// Per-request payload assembly, doc section 9. Two shapes travel over one
// request id:
//
// - audio: one FLAC stream split into byte slices, reassembled until `last`
//   and verified against the byte count of the ack before anything decodes;
// - video: one PNG per frame, each payload already a complete picture with its
//   own header (pts, index, size), so every frame is delivered on its own and
//   the ack's frame count is the integrity check (a count of 0 still sends one
//   terminal empty frame, so callers expect max(1, count)).
//
// The ack lands before the frames on the wire, but a socket may deliver both in
// one turn, so an expectation declared just after the ack is merged into a
// stream that already started. A request the engine abandoned (timeout, close,
// reconnect) is remembered for a while: its late frames are reported once and
// then dropped, never a lazily reopened stream. Frames without a declared
// expectation are a protocol error, not a silent delivery: whoever asked for
// the range is expected to bind the ack before the frames can arrive.

import { ProtocolError } from './protocol.js';
import type { FrameHeader } from './protocol.js';

export interface AssembledFrame {
    readonly reqId: number;
    readonly codec: string;
    /** Header of this frame; video carries pts_us/frame_index/width/height here. */
    readonly header: FrameHeader;
    /** Audio: the whole request payload. Video: exactly one encoded frame. */
    readonly bytes: Uint8Array;
}

export interface FrameExpectation {
    /** Exact payload length for a stream codec (audio). */
    readonly bytes?: number;
    /** Frame count for a frame-wise codec (video), ack count. */
    readonly frames?: number;
}

/** Codecs whose payloads are standalone frames instead of slices of a stream. */
const FRAME_WISE_CODECS = new Set(['png']);

/** One stalled range can no longer retain the whole renderer heap. */
const PENDING_BYTES_CAP = 8 * 1024 * 1024;

/** Bound on remembered ids: an ack whose frames never come must not leak. */
const ID_HISTORY = 256;

interface Pending {
    codec: string;
    frameWise: boolean;
    nextSeq: number;
    chunks: Uint8Array[];
    bytes: number;
    frames: number;
    expectedBytes: number | null;
    expectedFrames: number | null;
}

/**
 * Tracks every in-flight range request. A request is opened by its first frame
 * and must carry an expectation declared from its ack; it closes on `last` or
 * on the first inconsistency, and is never reopened once abandoned.
 */
export class FrameReassembler {
    private readonly open = new Map<number, Pending>();
    private readonly expected = new Map<number, FrameExpectation>();
    private readonly expectedOrder: number[] = [];
    /** Recent ids that finished; their late frames are dropped silently. */
    private readonly completed = new Set<number>();
    private readonly completedOrder: number[] = [];
    /** Recent ids the engine gave up on; their frames are dropped. */
    private readonly abandoned = new Set<number>();
    private readonly abandonedOrder: number[] = [];
    /** Abandoned ids that already produced one late-frame report. */
    private readonly reported = new Set<number>();

    /**
     * Declares what the request will carry. Safe to call while frames are
     * already streaming: the count only tightens a pending verification.
     *
     * Returns false when the id finished or was abandoned before the ack
     * landed (a timeout racing the ack): there is nothing left to verify, and
     * the caller - often an ack handler - must not see an exception.
     */
    expect(reqId: number, expectation: FrameExpectation): boolean {
        if (this.abandoned.has(reqId) || this.completed.has(reqId)) {
            return false;
        }
        const pending = this.open.get(reqId);
        if (pending !== undefined) {
            this.expectInto(reqId, pending, expectation);
            return true;
        }
        const prior = this.expected.get(reqId);
        if (prior !== undefined) {
            if (!sameExpectation(prior, expectation)) {
                throw new ProtocolError(
                    `request ${reqId}: the expectation changed before its frames`,
                    { before: prior, after: expectation },
                    reqId,
                );
            }
            return true;
        }
        this.expected.set(reqId, expectation);
        this.expectedOrder.push(reqId);
        this.boundExpectations();
        return true;
    }

    private expectInto(
        reqId: number,
        pending: Pending,
        expectation: FrameExpectation,
    ): void {
        if (expectation.bytes !== undefined) {
            if (
                pending.expectedBytes !== null &&
                pending.expectedBytes !== expectation.bytes
            ) {
                throw new ProtocolError(
                    `request ${reqId}: ack changed from ${pending.expectedBytes} to ${expectation.bytes} bytes`,
                    undefined,
                    reqId,
                );
            }
            if (pending.bytes > expectation.bytes) {
                throw new ProtocolError(
                    `request ${reqId}: received ${pending.bytes} bytes, ack announced ${expectation.bytes}`,
                    undefined,
                    reqId,
                );
            }
            pending.expectedBytes = expectation.bytes;
        }
        if (expectation.frames !== undefined) {
            if (
                pending.expectedFrames !== null &&
                pending.expectedFrames !== expectation.frames
            ) {
                throw new ProtocolError(
                    `request ${reqId}: ack changed from ${pending.expectedFrames} to ${expectation.frames} frames`,
                    undefined,
                    reqId,
                );
            }
            pending.expectedFrames = expectation.frames;
        }
    }

    get pendingCount(): number {
        return this.open.size;
    }

    get pendingBytes(): number {
        let total = 0;
        for (const pending of this.open.values()) {
            total += pending.bytes;
        }
        return total;
    }

    get expectedCount(): number {
        return this.expected.size;
    }

    /** True while the request has frames left to arrive. */
    hasPending(reqId: number): boolean {
        return this.open.has(reqId);
    }

    /** Consumes one decoded frame; null until `last` for a stream codec. */
    accept(header: FrameHeader, payload: Uint8Array): AssembledFrame | null {
        const reqId = header.req_id;
        if (this.abandoned.has(reqId)) {
            // A timeout or cancel dropped the request; report the first late
            // frame once, then stay quiet - one stalled range must not turn
            // into an error per stale frame.
            if (this.reported.has(reqId)) {
                return null;
            }
            this.reported.add(reqId);
            throw new ProtocolError(
                `frame for request ${reqId}, which was abandoned`,
                undefined,
                reqId,
            );
        }
        if (this.completed.has(reqId)) {
            // A frame after `last` cannot belong to an open request; drop it
            // without a report, the request is already answered.
            return null;
        }
        let pending = this.open.get(reqId);
        if (pending === undefined) {
            const expectation = this.expected.get(reqId);
            if (expectation === undefined) {
                throw new ProtocolError(
                    `unexpected frame for request ${reqId}: no ack bound it`,
                    undefined,
                    reqId,
                );
            }
            this.expected.delete(reqId);
            pending = {
                codec: header.codec,
                frameWise: FRAME_WISE_CODECS.has(header.codec),
                nextSeq: 1,
                chunks: [],
                bytes: 0,
                frames: 0,
                expectedBytes: null,
                expectedFrames: null,
            };
            this.expectInto(reqId, pending, expectation);
            this.open.set(reqId, pending);
        }
        if (header.seq !== pending.nextSeq) {
            this.fail(reqId);
            throw new ProtocolError(
                `request ${reqId}: expected seq ${pending.nextSeq}, got ${header.seq}`,
                undefined,
                reqId,
            );
        }
        if (pending.codec !== header.codec) {
            this.fail(reqId);
            throw new ProtocolError(
                `request ${reqId}: mixed codecs ${pending.codec} and ${header.codec}`,
                undefined,
                reqId,
            );
        }
        pending.nextSeq += 1;
        pending.frames += 1;

        if (pending.frameWise) {
            if (
                pending.expectedFrames !== null &&
                pending.frames > pending.expectedFrames
            ) {
                this.fail(reqId);
                throw new ProtocolError(
                    `request ${reqId}: received ${pending.frames} frames, ack announced ${pending.expectedFrames}`,
                    undefined,
                    reqId,
                );
            }
            if (header.last) {
                this.open.delete(reqId);
                this.complete(reqId);
                this.checkFrames(reqId, pending);
            }
            // A standalone frame is rendered at once; a copy keeps the buffer
            // independent of the socket's receive area.
            return {
                reqId,
                codec: header.codec,
                header,
                bytes: payload.slice(),
            };
        }

        pending.chunks.push(payload);
        pending.bytes += payload.byteLength;
        if (pending.bytes > PENDING_BYTES_CAP) {
            this.fail(reqId);
            throw new ProtocolError(
                `request ${reqId}: pending payload exceeds ${PENDING_BYTES_CAP} bytes`,
                undefined,
                reqId,
            );
        }
        if (
            pending.expectedBytes !== null &&
            pending.bytes > pending.expectedBytes
        ) {
            this.fail(reqId);
            throw new ProtocolError(
                `request ${reqId}: received ${pending.bytes} bytes, ack announced ${pending.expectedBytes}`,
                undefined,
                reqId,
            );
        }
        if (!header.last) {
            return null;
        }
        this.open.delete(reqId);
        this.complete(reqId);
        if (
            pending.expectedBytes !== null &&
            pending.bytes !== pending.expectedBytes
        ) {
            throw new ProtocolError(
                `request ${reqId}: received ${pending.bytes} bytes, ack announced ${pending.expectedBytes}`,
                undefined,
                reqId,
            );
        }
        return {
            reqId,
            codec: pending.codec,
            header,
            bytes: concat(pending.chunks, pending.bytes),
        };
    }

    private checkFrames(reqId: number, pending: Pending): void {
        if (
            pending.expectedFrames !== null &&
            pending.frames !== pending.expectedFrames
        ) {
            throw new ProtocolError(
                `request ${reqId}: received ${pending.frames} frames, ack announced ${pending.expectedFrames}`,
                undefined,
                reqId,
            );
        }
    }

    /** Drops one request and remembers it, so late frames cannot reopen it. */
    cancel(reqId: number): void {
        this.open.delete(reqId);
        this.expected.delete(reqId);
        if (this.abandoned.has(reqId) || this.completed.has(reqId)) {
            return;
        }
        this.abandoned.add(reqId);
        this.abandonedOrder.push(reqId);
        if (this.abandonedOrder.length > ID_HISTORY) {
            const oldest = this.abandonedOrder.shift();
            if (oldest !== undefined) {
                this.abandoned.delete(oldest);
                this.reported.delete(oldest);
            }
        }
    }

    clear(): void {
        this.open.clear();
        this.expected.clear();
        this.expectedOrder.length = 0;
        this.completed.clear();
        this.completedOrder.length = 0;
        this.abandoned.clear();
        this.abandonedOrder.length = 0;
        this.reported.clear();
    }

    private fail(reqId: number): void {
        this.open.delete(reqId);
        this.expected.delete(reqId);
    }

    private complete(reqId: number): void {
        if (this.completed.has(reqId)) {
            return;
        }
        this.completed.add(reqId);
        this.completedOrder.push(reqId);
        if (this.completedOrder.length > ID_HISTORY * 2) {
            const oldest = this.completedOrder.shift();
            if (oldest !== undefined) {
                this.completed.delete(oldest);
            }
        }
    }

    /** An ack whose frames never arrive must not pile up in `expected`. */
    private boundExpectations(): void {
        while (this.expectedOrder.length > ID_HISTORY) {
            const oldest = this.expectedOrder.shift();
            if (oldest !== undefined) {
                this.expected.delete(oldest);
            }
        }
    }
}

function sameExpectation(a: FrameExpectation, b: FrameExpectation): boolean {
    return a.bytes === b.bytes && a.frames === b.frames;
}

/**
 * One FLAC stream split into slices. The result is always a fresh, offset-0
 * buffer: decodeAudioData takes its input detached, and a subarray would carry
 * the frame container bytes in front of it.
 */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
