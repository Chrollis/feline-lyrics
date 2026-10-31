// The WebSocket client, doc section 9. One socket for the whole app; JSON
// envelopes for control, binary frames reassembled per req_id. The transport
// knows nothing about media: it answers requests, forwards events, and hands
// complete payloads to the engine.
//
// Failure containment matters as much as framing here, because one stalled
// media range must never take the renderer down:
// - a factory that throws rejects instead of throwing synchronously;
// - a listener that throws is contained (console.error) and cannot stop the
//   other listeners or the socket handler;
// - a range whose frames stop arriving is failed by a frame idle timer;
// - a frame-level protocol error rejects its request instead of leaving it
//   waiting for the request timer.

import { FrameReassembler } from './reassembler.js';
import type { AssembledFrame } from './reassembler.js';
import {
    ProtocolError,
    decodeFrame,
    encodeRequest,
    parseEnvelope,
} from './protocol.js';
import type { Envelope, EventEnvelope } from './protocol.js';

/** The slice of a WebSocket this package needs; Node and Chromium both fit. */
export interface SocketLike {
    send(text: string): void;
    close(): void;
    /** Chromium delivers binary frames as Blob unless this is 'arraybuffer'. */
    binaryType?: string;
    onOpen?: (() => void) | undefined;
    onMessage?: ((data: string | ArrayBuffer | Blob) => void) | undefined;
    onClose?: ((code?: number, reason?: string) => void) | undefined;
    onError?: ((error: unknown) => void) | undefined;
}

export type SocketFactory = (url: string) => SocketLike;

export type EventListener = (event: EventEnvelope) => void;
export type FrameListener = (frame: AssembledFrame) => void;
export type ErrorListener = (error: TransportError) => void;
/** The socket closed; code 4401 means the backend refused the token. */
export type CloseListener = (info: {
    readonly code: number | null;
    readonly reason: string;
}) => void;

export class TransportError extends Error {
    readonly code: string;
    readonly data: Record<string, unknown> | undefined;

    constructor(code: string, message: string, data?: Record<string, unknown>) {
        super(message);
        this.name = 'TransportError';
        this.code = code;
        this.data = data;
    }
}

interface PendingRequest {
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason: unknown) => void;
    readonly timer: ReturnType<typeof setTimeout> | null;
}

export interface ConnectOptions {
    readonly createSocket: SocketFactory;
    readonly url: string;
    /**
     * Per-request timeout; 0 disables it. A media window that builds its ack
     * slowly passes 0 and relies on the frame idle timer instead.
     */
    readonly timeoutMs?: number;
    /** How long to wait for the socket to open; 0 or less disables it. */
    readonly openTimeoutMs?: number;
    /**
     * A bound range that stops sending frames is failed after this long; 0
     * disables the deadline (tests drive time themselves).
     */
    readonly frameIdleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_FRAME_IDLE_MS = 10_000;

export class Transport {
    private readonly socket: SocketLike;
    private readonly timeoutMs: number;
    private readonly frameIdleMs: number;
    private readonly reassembler = new FrameReassembler();
    private readonly pending = new Map<number, PendingRequest>();
    /**
     * Frame idle deadlines, armed by the ack (expectBytes/expectFrames), not
     * by the pending entry: the ack settles the request promise, so the
     * deadline must outlive it to catch a backend that goes quiet mid-range.
     */
    private readonly frameTimers = new Map<
        number,
        ReturnType<typeof setTimeout>
    >();
    private readonly eventListeners = new Set<EventListener>();
    private readonly frameListeners = new Set<FrameListener>();
    private readonly errorListeners = new Set<ErrorListener>();
    private readonly closeListeners = new Set<CloseListener>();
    private nextId = 1;
    private closed = false;
    private closeState: {
        readonly code: number | null;
        readonly reason: string;
    } | null = null;

    private constructor(
        socket: SocketLike,
        timeoutMs: number,
        frameIdleMs: number,
    ) {
        this.socket = socket;
        this.timeoutMs = timeoutMs;
        this.frameIdleMs = frameIdleMs;
    }

    static connect(options: ConnectOptions): Promise<Transport> {
        let socket: SocketLike;
        try {
            socket = options.createSocket(options.url);
        } catch (cause) {
            // The factory is caller code; a throw must surface as a rejection.
            return Promise.reject(
                new TransportError('socket-error', 'socket factory failed', {
                    cause: String(cause),
                }),
            );
        }
        // Chromium strings binary frames as Blob by default; decodeFrame needs
        // ArrayBuffer, so the factory contract cannot leave this to the caller.
        try {
            socket.binaryType = 'arraybuffer';
        } catch {
            // A socket without a settable binaryType (custom factory) is the
            // factory author's promise; nothing to do here.
        }
        const transport = new Transport(
            socket,
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            options.frameIdleMs ?? DEFAULT_FRAME_IDLE_MS,
        );
        return new Promise<Transport>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const detach = (): void => {
                socket.onOpen = undefined;
                socket.onError = undefined;
                socket.onClose = undefined;
            };
            const fail = (reason: unknown): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== null) {
                    clearTimeout(timer);
                }
                detach();
                try {
                    socket.close();
                } catch {
                    // The socket may already be gone.
                }
                reject(reason);
            };
            const openTimeout =
                options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
            if (openTimeout > 0) {
                timer = setTimeout(
                    () =>
                        fail(
                            new TransportError(
                                'timeout',
                                'websocket did not open',
                            ),
                        ),
                    openTimeout,
                );
            }
            socket.onOpen = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== null) {
                    clearTimeout(timer);
                }
                transport.attach();
                resolve(transport);
            };
            socket.onError = (error: unknown) => {
                fail(
                    new TransportError(
                        'socket-error',
                        'websocket failed to open',
                        {
                            cause: String(error),
                        },
                    ),
                );
            };
            socket.onClose = (code?: number) => {
                fail(
                    new TransportError(
                        'closed',
                        `websocket closed before open (${String(code)})`,
                    ),
                );
                transport.onSocketClosed(code);
            };
        });
    }

    private attach(): void {
        this.socket.onMessage = (data) => {
            this.onMessage(data);
        };
        this.socket.onClose = (code?: number, reason?: string) => {
            this.onSocketClosed(code, reason);
        };
        this.socket.onError = (error: unknown) => {
            this.emitError(
                new TransportError('socket-error', 'websocket error', {
                    cause: String(error),
                }),
            );
        };
    }

    private detach(): void {
        this.socket.onMessage = undefined;
        this.socket.onClose = undefined;
        this.socket.onError = undefined;
    }

    get pendingRequests(): number {
        return this.pending.size;
    }

    get pendingFrames(): number {
        return this.reassembler.pendingCount;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * The socket close frame, once it closed. The server uses 4401 for a wrong
     * token, and that code is the only way an app can tell a bad token from a
     * dropped process.
     */
    get closeInfo(): {
        readonly code: number | null;
        readonly reason: string;
    } | null {
        return this.closeState;
    }

    onEvent(listener: EventListener): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }

    onFrame(listener: FrameListener): () => void {
        this.frameListeners.add(listener);
        return () => {
            this.frameListeners.delete(listener);
        };
    }

    onError(listener: ErrorListener): () => void {
        this.errorListeners.add(listener);
        return () => {
            this.errorListeners.delete(listener);
        };
    }

    onClose(listener: CloseListener): () => void {
        this.closeListeners.add(listener);
        return () => {
            this.closeListeners.delete(listener);
        };
    }

    /**
     * Sends one request and resolves with its result. The id is generated here
     * unless the caller supplies one (needed when an ack has to be bound to a
     * byte expectation before the response lands).
     */
    request(
        method: string,
        params?: Record<string, unknown>,
        options?: { readonly id?: number; readonly timeoutMs?: number },
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(
                new TransportError('closed', 'transport is closed'),
            );
        }
        const requestedId = options?.id;
        if (
            requestedId !== undefined &&
            (!Number.isInteger(requestedId) || requestedId <= 0)
        ) {
            return Promise.reject(
                new TransportError(
                    'bad-request',
                    `request id ${String(requestedId)} is not a positive integer`,
                ),
            );
        }
        const id = requestedId ?? this.nextId;
        if (id >= this.nextId) {
            this.nextId = id + 1;
        }
        if (this.pending.has(id)) {
            return Promise.reject(
                new TransportError(
                    'bad-request',
                    `request id ${id} is in flight`,
                ),
            );
        }
        const timeout = options?.timeoutMs ?? this.timeoutMs;
        return new Promise<unknown>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeout > 0) {
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    this.reassembler.cancel(id);
                    reject(
                        new TransportError(
                            'timeout',
                            `request ${method} timed out`,
                            { reqId: id },
                        ),
                    );
                }, timeout);
            }
            this.pending.set(id, {
                resolve,
                reject,
                timer,
            });
            try {
                this.socket.send(encodeRequest(id, method, params));
            } catch (error) {
                this.pending.delete(id);
                if (timer !== null) {
                    clearTimeout(timer);
                }
                reject(
                    new TransportError('socket-error', 'send failed', {
                        cause: String(error),
                    }),
                );
            }
        });
    }

    /**
     * Binds the byte count from an ack so the reassembler can verify it.
     * Returns false when the request already finished or was abandoned: an
     * ack racing a timeout is not an error.
     */
    expectBytes(reqId: number, expectedBytes: number): boolean {
        const bound = this.reassembler.expect(reqId, { bytes: expectedBytes });
        if (bound) {
            this.armFrameTimer(reqId);
        }
        return bound;
    }

    /** Binds the frame count from a video ack; pass max(1, count). */
    expectFrames(reqId: number, expectedFrames: number): boolean {
        const bound = this.reassembler.expect(reqId, {
            frames: expectedFrames,
        });
        if (bound) {
            this.armFrameTimer(reqId);
        }
        return bound;
    }

    cancelFrames(reqId: number): void {
        this.reassembler.cancel(reqId);
        this.clearFrameTimer(reqId);
    }

    /** Graceful close: rejects in-flight work, then closes the socket. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.detach();
        this.failAll(new TransportError('closed', 'transport closed'));
        this.socket.close();
    }

    private onMessage(data: string | ArrayBuffer | Blob): void {
        if (this.closed) {
            return;
        }
        if (typeof data === 'string') {
            this.onText(data);
            return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            this.emitError(
                new TransportError(
                    'protocol-error',
                    'socket delivered a Blob; binaryType must be arraybuffer',
                ),
            );
            return;
        }
        try {
            const { header, payload } = decodeFrame(
                new Uint8Array(data as ArrayBuffer),
            );
            const frame = this.reassembler.accept(header, payload);
            if (frame === null) {
                this.touchFrameTimer(header.req_id);
                return;
            }
            if (this.reassembler.hasPending(header.req_id)) {
                this.touchFrameTimer(header.req_id);
            } else {
                this.clearFrameTimer(header.req_id);
            }
            for (const listener of this.frameListeners) {
                safeInvoke(listener, frame);
            }
        } catch (error) {
            if (error instanceof ProtocolError && error.reqId !== null) {
                this.failRequest(error.reqId, error);
            }
            this.emitError(toTransportError(error));
        }
    }

    private onText(text: string): void {
        if (this.closed) {
            return;
        }
        let envelope: Envelope;
        try {
            envelope = parseEnvelope(text);
        } catch (error) {
            this.emitError(toTransportError(error));
            return;
        }
        if ('type' in envelope && envelope.type === 'event') {
            for (const listener of this.eventListeners) {
                safeInvoke(listener, envelope);
            }
            return;
        }
        const response = envelope as Extract<Envelope, { ok: boolean }>;
        if (response.id === null) {
            // The backend could not even parse a request id (malformed JSON):
            // it is an error report with no reply to match.
            const wire = response.error;
            this.emitError(
                new TransportError(
                    wire?.code ?? 'bad-request',
                    wire?.message ?? 'uncorrelated error',
                    { ...wire?.data, uncorrelated: true },
                ),
            );
            return;
        }
        const pending = this.pending.get(response.id);
        if (pending === undefined) {
            this.emitError(
                new TransportError(
                    'protocol-error',
                    `response for unknown request ${String(response.id)}`,
                ),
            );
            return;
        }
        this.pending.delete(response.id);
        if (pending.timer !== null) {
            clearTimeout(pending.timer);
        }
        this.clearFrameTimer(response.id);
        if (response.ok) {
            pending.resolve(response.result);
            return;
        }
        const wire = response.error;
        pending.reject(
            new TransportError(
                wire?.code ?? 'internal-error',
                wire?.message ?? 'request failed',
                wire?.data,
            ),
        );
    }

    private onSocketClosed(code?: number, reason?: string): void {
        this.closeState =
            this.closeState === null
                ? { code: code ?? null, reason: reason ?? '' }
                : this.closeState;
        if (!this.closed) {
            this.closed = true;
            this.detach();
            const detail =
                reason === undefined
                    ? `code ${String(code)}`
                    : `code ${String(code)}: ${reason}`;
            // 4401 is the backend's "wrong token"; a network drop is not.
            this.failAll(
                code === 4401
                    ? new TransportError(
                          'unauthorized',
                          `websocket closed (${detail})`,
                          { closeCode: 4401, reason: reason ?? '' },
                      )
                    : new TransportError(
                          'closed',
                          `websocket closed (${detail})`,
                          { closeCode: code ?? null, reason: reason ?? '' },
                      ),
            );
            const info = { code: code ?? null, reason: reason ?? '' };
            for (const listener of this.closeListeners) {
                try {
                    listener(info);
                } catch (error) {
                    console.error('transport: close listener threw', error);
                }
            }
        }
        this.reassembler.clear();
    }

    private failAll(error: TransportError): void {
        for (const [id, pending] of this.pending) {
            if (pending.timer !== null) {
                clearTimeout(pending.timer);
            }
            pending.reject(error);
            this.reassembler.cancel(id);
        }
        for (const id of [...this.frameTimers.keys()]) {
            this.clearFrameTimer(id);
        }
        this.pending.clear();
        this.reassembler.clear();
    }

    /**
     * A protocol error at frame level is terminal for that request: reject it
     * instead of letting it wait for the request timer.
     */
    private failRequest(reqId: number, error: ProtocolError): void {
        const pending = this.pending.get(reqId);
        if (pending === undefined) {
            return;
        }
        this.pending.delete(reqId);
        if (pending.timer !== null) {
            clearTimeout(pending.timer);
        }
        this.clearFrameTimer(reqId);
        this.reassembler.cancel(reqId);
        pending.reject(
            new TransportError('protocol-error', error.message, { reqId }),
        );
    }

    /** Re-arms the idle deadline; called for every frame of a bound range. */
    private touchFrameTimer(reqId: number): void {
        if (this.frameTimers.has(reqId)) {
            this.armFrameTimer(reqId);
        }
    }

    /** Arms the deadline from the ack; the request promise is already settled. */
    private armFrameTimer(reqId: number): void {
        if (this.closed || this.frameIdleMs <= 0) {
            return;
        }
        this.clearFrameTimer(reqId);
        this.frameTimers.set(
            reqId,
            setTimeout(() => {
                this.frameTimers.delete(reqId);
                this.reassembler.cancel(reqId);
                const error = new TransportError(
                    'frame-stalled',
                    `request ${reqId} stopped receiving frames`,
                    { reqId, idleMs: this.frameIdleMs },
                );
                const pending = this.pending.get(reqId);
                if (pending !== undefined) {
                    // The ack never arrived: reject the request itself.
                    this.pending.delete(reqId);
                    if (pending.timer !== null) {
                        clearTimeout(pending.timer);
                    }
                    pending.reject(error);
                    return;
                }
                // The ack settled the promise; a stall is an error event.
                this.emitError(error);
            }, this.frameIdleMs),
        );
    }

    private clearFrameTimer(reqId: number): void {
        const timer = this.frameTimers.get(reqId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.frameTimers.delete(reqId);
        }
    }

    private emitError(error: TransportError): void {
        for (const listener of this.errorListeners) {
            safeInvoke(listener, error);
        }
    }
}

/** A listener must never be able to break dispatch or the socket handler. */
function safeInvoke<Argument>(
    listener: (argument: Argument) => void,
    argument: Argument,
): void {
    try {
        listener(argument);
    } catch (error) {
        console.error('mediapipe: a transport listener threw', error);
    }
}

function toTransportError(error: unknown): TransportError {
    if (error instanceof TransportError) {
        return error;
    }
    if (error instanceof ProtocolError) {
        return new TransportError(
            'protocol-error',
            error.message,
            error.reqId === null ? undefined : { reqId: error.reqId },
        );
    }
    return new TransportError(
        'protocol-error',
        'unexpected transport failure',
        {
            cause: String(error),
        },
    );
}
