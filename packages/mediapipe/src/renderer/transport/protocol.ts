// Wire protocol, doc section 9: one WebSocket, JSON envelopes for control,
// and binary frames [4B LE header length][JSON header][payload] for media.
// One value per kind so a caller cannot confuse a response with an event.

export const PROTOCOL = 1;

/** Error code plus the fact that came with it; codes are kebab-case. */
export interface WireError {
    readonly code: string;
    readonly message: string;
    readonly data?: Record<string, unknown>;
}

export interface RequestEnvelope {
    readonly v: typeof PROTOCOL;
    readonly id: number;
    readonly method: string;
    readonly params?: Record<string, unknown>;
}

export interface ResponseEnvelope {
    readonly v: typeof PROTOCOL;
    /** null only for an error nobody could correlate (malformed request). */
    readonly id: number | null;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: WireError;
}

export interface EventEnvelope {
    readonly v: typeof PROTOCOL;
    readonly type: 'event';
    readonly event: string;
    readonly task_id?: string;
    readonly data?: unknown;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

/** First bytes of a binary frame: a JSON object naming the request. */
export interface FrameHeader {
    readonly req_id: number;
    readonly seq: number;
    readonly last: boolean;
    readonly codec: string;
    /** Video frames only: presentation time, index, output size. */
    readonly pts_us?: number;
    readonly frame_index?: number;
    readonly width?: number;
    readonly height?: number;
    readonly [key: string]: unknown;
}

export class ProtocolError extends Error {
    readonly detail: unknown;
    /** Request the failure belongs to, when the frame named one. */
    readonly reqId: number | null;

    constructor(message: string, detail?: unknown, reqId?: number) {
        super(message);
        this.name = 'ProtocolError';
        this.detail = detail;
        this.reqId = reqId ?? null;
    }
}

export function encodeRequest(
    id: number,
    method: string,
    params?: Record<string, unknown>,
): string {
    return JSON.stringify(
        params === undefined
            ? { v: PROTOCOL, id, method }
            : { v: PROTOCOL, id, method, params },
    );
}

export function encodeResponse(id: number, result: unknown): string {
    return JSON.stringify({ v: PROTOCOL, id, ok: true, result });
}

export function encodeErrorResponse(id: number, error: WireError): string {
    return JSON.stringify({ v: PROTOCOL, id, ok: false, error });
}

export function encodeEvent(
    event: string,
    data?: unknown,
    taskId?: string,
): string {
    const envelope: Record<string, unknown> = {
        v: PROTOCOL,
        type: 'event',
        event,
    };
    if (taskId !== undefined) {
        envelope.task_id = taskId;
    }
    if (data !== undefined) {
        envelope.data = data;
    }
    return JSON.stringify(envelope);
}

/** Parses one text frame and rejects anything that is not protocol v1. */
export function parseEnvelope(text: string): Envelope {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (cause) {
        throw new ProtocolError('message is not JSON', cause);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ProtocolError('message must be a JSON object');
    }
    const record = value as Record<string, unknown>;
    if (record.v !== PROTOCOL) {
        throw new ProtocolError(
            `unsupported protocol version ${String(record.v)}`,
        );
    }
    if (record.type === 'event') {
        if (typeof record.event !== 'string' || record.event.length === 0) {
            throw new ProtocolError('event is missing a name');
        }
        return record as unknown as EventEnvelope;
    }
    if (record.ok === undefined || typeof record.ok !== 'boolean') {
        throw new ProtocolError('server-initiated requests are not supported');
    }
    if (record.id === null) {
        // The backend answers a request it could not even correlate (bad JSON)
        // with id null; it is an error report, not a reply to this client.
        if (record.ok) {
            throw new ProtocolError('response has id null but claims ok');
        }
        if (record.error === undefined) {
            throw new ProtocolError('response has id null but no error');
        }
        return record as unknown as ResponseEnvelope;
    }
    if (
        typeof record.id !== 'number' ||
        !Number.isInteger(record.id) ||
        record.id <= 0
    ) {
        // The doc's examples print ids as strings; a backend that normalizes
        // with str() would echo "7" for our 7. Accept the digits either way.
        const rawId = record.id;
        if (typeof rawId !== 'string' || !/^\d+$/.test(rawId)) {
            throw new ProtocolError('response is missing an id');
        }
        const id = Number(rawId);
        if (id <= 0) {
            throw new ProtocolError('response is missing an id');
        }
        return { ...record, id } as unknown as ResponseEnvelope;
    }
    if (!record.ok) {
        const error = record.error;
        if (
            typeof error !== 'object' ||
            error === null ||
            typeof (error as Record<string, unknown>).code !== 'string'
        ) {
            throw new ProtocolError('error response is missing its error');
        }
    }
    return record as unknown as ResponseEnvelope;
}

const HEADER_LENGTH_BYTES = 4;

/** One binary frame: [4B LE header length][JSON header][payload]. */
export function encodeFrame(
    header: FrameHeader,
    payload: Uint8Array,
): Uint8Array {
    const encoded = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(
        HEADER_LENGTH_BYTES + encoded.byteLength + payload.byteLength,
    );
    new DataView(out.buffer).setUint32(0, encoded.byteLength, true);
    out.set(encoded, HEADER_LENGTH_BYTES);
    out.set(payload, HEADER_LENGTH_BYTES + encoded.byteLength);
    return out;
}

/** Splits one binary frame; the header is validated, the payload is a view. */
export function decodeFrame(bytes: Uint8Array): {
    header: FrameHeader;
    payload: Uint8Array;
} {
    if (bytes.byteLength < HEADER_LENGTH_BYTES) {
        throw new ProtocolError(
            'binary frame is shorter than its header length',
        );
    }
    const headerLength = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    ).getUint32(0, true);
    const start = HEADER_LENGTH_BYTES;
    if (headerLength === 0 || start + headerLength > bytes.byteLength) {
        throw new ProtocolError('binary frame header length is out of range');
    }
    let header: unknown;
    try {
        header = JSON.parse(
            new TextDecoder().decode(
                bytes.subarray(start, start + headerLength),
            ),
        );
    } catch (cause) {
        throw new ProtocolError('binary frame header is not JSON', cause);
    }
    if (typeof header !== 'object' || header === null) {
        throw new ProtocolError('binary frame header must be an object');
    }
    const record = header as Record<string, unknown>;
    if (
        typeof record.req_id !== 'number' ||
        typeof record.seq !== 'number' ||
        typeof record.codec !== 'string' ||
        typeof record.last !== 'boolean'
    ) {
        throw new ProtocolError('binary frame header is incomplete');
    }
    for (const key of ['pts_us', 'frame_index', 'width', 'height'] as const) {
        const value = record[key];
        if (value !== undefined && typeof value !== 'number') {
            throw new ProtocolError(
                `binary frame header ${key} is not a number`,
            );
        }
    }
    return {
        header: record as unknown as FrameHeader,
        payload: bytes.subarray(start + headerLength),
    };
}
