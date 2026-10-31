import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROTOCOL,
    ProtocolError,
    Transport,
    TransportError,
    decodeFrame,
    encodeErrorResponse,
    encodeEvent,
    encodeFrame,
    encodeRequest,
    encodeResponse,
    parseEnvelope,
} from '../src/renderer/index.js';

class FakeSocket {
    sent = [];
    closed = false;

    send(text) {
        this.sent.push(text);
    }

    close() {
        this.closed = true;
        this.onClose?.(1000, 'closed by test');
    }

    open() {
        this.onOpen?.();
    }

    text(value) {
        this.onMessage?.(value);
    }

    binary(bytes) {
        this.onMessage?.(bytes);
    }
}

async function connected(options = {}) {
    const socket = new FakeSocket();
    const pending = Transport.connect({
        createSocket: () => socket,
        url: 'ws://127.0.0.1:1/x?token=t',
        timeoutMs: 50,
        ...options,
    });
    socket.open();
    const transport = await pending;
    return { transport, socket };
}

function frame(reqId, seq, last, codec, payload) {
    return encodeFrame({ req_id: reqId, seq, last, codec }, payload);
}

function pngFrame(reqId, seq, last, frameIndex, payload) {
    return encodeFrame(
        {
            req_id: reqId,
            seq,
            last,
            codec: 'png',
            pts_us: frameIndex * 33333,
            frame_index: frameIndex,
            width: 960,
            height: 540,
        },
        payload,
    );
}

test('protocol: requests serialize the documented envelope', () => {
    const text = encodeRequest(7, 'hello', { name: 'mediapipe' });
    assert.deepEqual(JSON.parse(text), {
        v: PROTOCOL,
        id: 7,
        method: 'hello',
        params: { name: 'mediapipe' },
    });
    assert.deepEqual(JSON.parse(encodeRequest(8, 'shutdown')), {
        v: PROTOCOL,
        id: 8,
        method: 'shutdown',
    });
});

test('protocol: responses and events parse into their kinds', () => {
    assert.deepEqual(parseEnvelope(encodeResponse(3, { ok: 1 })), {
        v: PROTOCOL,
        id: 3,
        ok: true,
        result: { ok: 1 },
    });
    const event = encodeEvent('task.progress', { done: 1, total: 2 }, 'task-1');
    const parsed = parseEnvelope(event);
    assert.equal(parsed.type, 'event');
    assert.equal(parsed.event, 'task.progress');
    assert.equal(parsed.task_id, 'task-1');
});

test('protocol: malformed control messages are ProtocolError', () => {
    assert.throws(() => parseEnvelope('not json'), ProtocolError);
    assert.throws(
        () => parseEnvelope('{"v":2,"id":1,"ok":true}'),
        /unsupported protocol version/,
    );
    assert.throws(() => parseEnvelope('{"v":1,"ok":true}'), /missing an id/);
    assert.throws(() => parseEnvelope('{"v":1,"id":1}'), /server-initiated/);
    assert.throws(
        () => parseEnvelope('{"v":1,"type":"event"}'),
        /missing a name/,
    );
    assert.throws(() => parseEnvelope('[]'), /JSON object/);
});

test('protocol: binary frames round trip with a header and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const bytes = frame(9, 2, true, 'flac', payload);
    const decoded = decodeFrame(bytes);
    assert.equal(decoded.header.req_id, 9);
    assert.equal(decoded.header.seq, 2);
    assert.equal(decoded.header.last, true);
    assert.equal(decoded.header.codec, 'flac');
    assert.deepEqual(Array.from(decoded.payload), [1, 2, 3, 4]);
});

test('protocol: binary frame validation rejects truncation', () => {
    assert.throws(() => decodeFrame(new Uint8Array([1, 0])), /shorter than/);
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint32(0, 999, true);
    assert.throws(() => decodeFrame(bad), /out of range/);
    const header = new TextEncoder().encode('{"req_id":1}');
    const bytes = new Uint8Array(4 + header.byteLength);
    new DataView(bytes.buffer).setUint32(0, header.byteLength, true);
    bytes.set(header, 4);
    assert.throws(() => decodeFrame(bytes), /incomplete/);
});

test('transport: request sends one envelope and resolves with its result', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('hello', { name: 'mediapipe' });
    assert.equal(socket.sent.length, 1);
    const envelope = JSON.parse(socket.sent[0]);
    assert.equal(envelope.v, PROTOCOL);
    assert.equal(envelope.id, 1);
    assert.equal(envelope.method, 'hello');
    socket.text(encodeResponse(1, { version: '0.1.0' }));
    assert.deepEqual(await done, { version: '0.1.0' });
    assert.equal(transport.pendingRequests, 0);
    transport.close();
});

test('transport: an error response rejects with the wire code', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('open_source', { path: 'missing.mp3' });
    socket.text(
        encodeErrorResponse(1, {
            code: 'source-not-found',
            message: 'no such file',
            data: { path: 'x' },
        }),
    );
    await assert.rejects(done, (error) => {
        assert.ok(error instanceof TransportError);
        assert.equal(error.code, 'source-not-found');
        assert.deepEqual(error.data, { path: 'x' });
        return true;
    });
    transport.close();
});

test('transport: a string id from the backend still matches the request', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('hello', {});
    socket.text(JSON.stringify({ v: PROTOCOL, id: '1', ok: true, result: 1 }));
    assert.deepEqual(await done, 1);
    transport.close();
});

test('transport: events reach listeners with their task id', async () => {
    const { transport, socket } = await connected();
    const seen = [];
    const off = transport.onEvent((event) => seen.push(event));
    socket.text(encodeEvent('task.done', { kind: 'transcribe' }, 'task-1'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].event, 'task.done');
    assert.equal(seen[0].task_id, 'task-1');
    off();
    socket.text(encodeEvent('task.done', {}, 'task-2'));
    assert.equal(seen.length, 1);
    transport.close();
});

test('transport: responses for unknown ids become protocol errors', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.code));
    socket.text(encodeResponse(42, {}));
    assert.deepEqual(errors, ['protocol-error']);
    transport.close();
});

test('transport: binary frames are reassembled and verified against the ack', async () => {
    const { transport, socket } = await connected();
    const frames = [];
    transport.onFrame((assembled) => frames.push(assembled));
    transport.expectBytes(5, 6);
    socket.binary(frame(5, 1, false, 'flac', new Uint8Array([1, 2, 3])));
    assert.equal(frames.length, 0);
    socket.binary(frame(5, 2, true, 'flac', new Uint8Array([4, 5, 6])));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].reqId, 5);
    assert.equal(frames[0].codec, 'flac');
    assert.deepEqual(Array.from(frames[0].bytes), [1, 2, 3, 4, 5, 6]);
    transport.close();
});

test('transport: a byte-count mismatch surfaces as a protocol error', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.code));
    transport.expectBytes(5, 10);
    socket.binary(frame(5, 1, true, 'flac', new Uint8Array([1, 2, 3])));
    assert.deepEqual(errors, ['protocol-error']);
    transport.close();
});

test('transport: out-of-order frames are rejected', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.message));
    transport.expectBytes(5, 1);
    socket.binary(frame(5, 2, true, 'flac', new Uint8Array([1])));
    assert.match(errors[0], /expected seq 1, got 2/);
    transport.close();
});

test('transport: requests time out and free their id', async () => {
    const { transport } = await connected({ timeoutMs: 20 });
    await assert.rejects(
        transport.request('open_source', {}),
        (error) => error.code === 'timeout',
    );
    assert.equal(transport.pendingRequests, 0);
    transport.close();
});

test('transport: close rejects in-flight work', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('hello', {});
    transport.close();
    await assert.rejects(done, (error) => error.code === 'closed');
    assert.equal(socket.closed, true);
    await assert.rejects(
        transport.request('hello', {}),
        (error) => error.code === 'closed',
    );
});

test('transport: a socket drop rejects pending requests', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('hello', {});
    socket.onClose?.(1006, 'drop');
    await assert.rejects(done, (error) => error.code === 'closed');
    assert.equal(transport.isClosed, true);
});

test('transport: the close frame keeps the code the server used', async () => {
    const { transport, socket } = await connected();
    assert.equal(transport.closeInfo, null);
    socket.onClose?.(4401, 'unauthorized');
    assert.deepEqual(transport.closeInfo, {
        code: 4401,
        reason: 'unauthorized',
    });
    // A later close must not overwrite the first (real) reason.
    socket.onClose?.(1000, 'closed by test');
    assert.deepEqual(transport.closeInfo, {
        code: 4401,
        reason: 'unauthorized',
    });
});

test('transport: duplicate in-flight ids are refused', async () => {
    const { transport } = await connected();
    const first = transport.request('hello', {}, { id: 3 });
    await assert.rejects(
        transport.request('hello', {}, { id: 3 }),
        (error) => error.code === 'bad-request',
    );
    first.catch(() => {});
    transport.close();
});

test('transport: invalid explicit ids are refused', async () => {
    const { transport } = await connected();
    for (const id of [0, -1, 1.5, Number.NaN]) {
        await assert.rejects(
            transport.request('hello', {}, { id }),
            (error) => error.code === 'bad-request',
            `id ${String(id)} must be refused`,
        );
    }
    transport.close();
});

test('transport: video frames arrive one AssembledFrame per PNG', async () => {
    const { transport, socket } = await connected();
    const frames = [];
    transport.onFrame((assembled) => frames.push(assembled));
    transport.expectFrames(9, 2);
    socket.binary(pngFrame(9, 1, false, 0, new Uint8Array([1, 2])));
    assert.equal(frames.length, 1);
    socket.binary(pngFrame(9, 2, true, 1, new Uint8Array([3])));
    assert.equal(frames.length, 2);
    assert.deepEqual(
        frames.map((assembled) => assembled.header.frame_index),
        [0, 1],
    );
    assert.equal(frames[1].header.last, true);
    assert.equal(frames[1].header.width, 960);
    assert.deepEqual(Array.from(frames[1].bytes), [3]);
    assert.equal(transport.pendingFrames, 0);
    transport.close();
});

test('transport: a truncated video range fails the frame count', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.message));
    transport.expectFrames(9, 3);
    socket.binary(pngFrame(9, 1, true, 0, new Uint8Array([1])));
    assert.match(errors[0], /received 1 frames, ack announced 3/);
    transport.close();
});

test('transport: frames of an abandoned request are errors', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.message));
    transport.cancelFrames(5);
    socket.binary(frame(5, 1, true, 'flac', new Uint8Array([1])));
    assert.match(errors[0], /abandoned/);
    transport.close();
});

test('transport: a repeated ack expectation is accepted mid-stream', async () => {
    const { transport, socket } = await connected();
    const frames = [];
    transport.onFrame((assembled) => frames.push(assembled));
    transport.expectBytes(5, 6);
    socket.binary(frame(5, 1, false, 'flac', new Uint8Array([1, 2, 3])));
    assert.equal(transport.expectBytes(5, 6), true);
    socket.binary(frame(5, 2, true, 'flac', new Uint8Array([4, 5, 6])));
    assert.equal(frames.length, 1);
    assert.deepEqual(Array.from(frames[0].bytes), [1, 2, 3, 4, 5, 6]);
    transport.close();
});

test('transport: a single packet is a fresh offset-0 buffer', async () => {
    const { transport, socket } = await connected();
    const frames = [];
    transport.onFrame((assembled) => frames.push(assembled));
    transport.expectBytes(5, 3);
    socket.binary(frame(5, 1, true, 'flac', new Uint8Array([1, 2, 3])));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].bytes.byteOffset, 0);
    assert.equal(frames[0].bytes.buffer.byteLength, 3);
    transport.close();
});

test('transport: expectations after completion are refused, not leaked', async () => {
    const { transport, socket } = await connected();
    transport.expectBytes(5, 3);
    socket.binary(frame(5, 1, true, 'flac', new Uint8Array([1, 2, 3])));
    // A late ack for a finished request is not an exception: there is nothing
    // left to verify, and the caller is usually a socket event handler.
    assert.equal(transport.expectBytes(5, 3), false);
    assert.equal(transport.pendingFrames, 0);
    transport.close();
});

test('transport: an abandoned request accepts a late ack as a no-op', async () => {
    const { transport } = await connected();
    transport.cancelFrames(13);
    assert.equal(transport.expectBytes(13, 10), false);
    transport.cancelFrames(14);
    assert.equal(transport.expectFrames(14, 5), false);
    transport.close();
});

test('transport: a frame with no bound expectation is a protocol error', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('request_range', {}, { id: 20 });
    const errors = [];
    transport.onError((error) => errors.push(error.message));
    socket.binary(frame(20, 1, true, 'flac', new Uint8Array([1])));
    await assert.rejects(done, (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.match(error.message, /unexpected frame/);
        return true;
    });
    assert.match(errors[0], /unexpected frame/);
    assert.equal(transport.pendingRequests, 0);
    transport.close();
});

test('transport: a frame-level error rejects its request immediately', async () => {
    const { transport, socket } = await connected();
    const done = transport.request(
        'request_range',
        {},
        { id: 18, timeoutMs: 0 },
    );
    transport.expectBytes(18, 1);
    socket.binary(frame(18, 2, true, 'flac', new Uint8Array([1])));
    await assert.rejects(done, (error) => {
        assert.equal(error.code, 'protocol-error');
        assert.equal(error.data.reqId, 18);
        return true;
    });
    transport.close();
});

test('transport: video oversend fails before the extra frame is delivered', async () => {
    const { transport, socket } = await connected();
    const frames = [];
    const errors = [];
    transport.onFrame((assembled) => frames.push(assembled));
    transport.onError((error) => errors.push(error.message));
    transport.expectFrames(9, 3);
    for (let index = 1; index <= 3; index += 1) {
        socket.binary(
            pngFrame(9, index, false, index - 1, new Uint8Array([index])),
        );
    }
    socket.binary(pngFrame(9, 4, false, 3, new Uint8Array([4])));
    assert.equal(frames.length, 3);
    assert.match(errors[0], /received 4 frames, ack announced 3/);
    transport.close();
});

test('transport: an unbounded stream is capped at 8 MiB', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.message));
    transport.expectBytes(12, 1_000_000_000);
    const chunk = new Uint8Array(65536);
    for (let seq = 1; seq <= 129; seq += 1) {
        socket.binary(frame(12, seq, false, 'flac', chunk));
    }
    assert.match(errors[0], /pending payload exceeds/);
    assert.equal(transport.pendingFrames, 0);
    transport.close();
});

test('transport: a bound range that stops sending frames is failed', async () => {
    const { transport } = await connected({ timeoutMs: 0, frameIdleMs: 25 });
    const done = transport.request('request_range', {}, { id: 30 });
    transport.expectBytes(30, 100);
    await assert.rejects(done, (error) => {
        assert.equal(error.code, 'frame-stalled');
        assert.equal(error.data.reqId, 30);
        return true;
    });
    transport.close();
});

test('transport: a range that goes quiet after the ack is failed', async () => {
    const { transport, socket } = await connected({
        timeoutMs: 0,
        frameIdleMs: 20,
    });
    const errors = [];
    transport.onError((error) => errors.push([error.code, error.data]));
    const done = transport.request('request_range', {}, { id: 31 });
    socket.text(encodeResponse(31, { count: 2 }));
    await done;
    assert.equal(transport.expectBytes(31, 100), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(
        errors.map(([code]) => code),
        ['frame-stalled'],
    );
    assert.equal(errors[0][1].reqId, 31);
    transport.close();
});

test('transport: a socket factory that throws rejects instead of throwing', async () => {
    await assert.rejects(
        Transport.connect({
            createSocket: () => {
                throw new Error('ctor boom');
            },
            url: 'ws://127.0.0.1:1/x',
        }),
        (error) => {
            assert.equal(error.code, 'socket-error');
            return true;
        },
    );
});

test('transport: a throwing listener does not break the others', async () => {
    const { transport, socket } = await connected();
    const seen = [];
    transport.onEvent(() => {
        throw new Error('listener boom');
    });
    transport.onEvent((event) => seen.push(event.event));
    const original = console.error;
    console.error = () => {};
    try {
        socket.text(encodeEvent('task.done', {}, 'task-1'));
    } finally {
        console.error = original;
    }
    assert.deepEqual(seen, ['task.done']);
    transport.close();
});

test('transport: frames after close are ignored', async () => {
    const { transport, socket } = await connected();
    const frames = [];
    const errors = [];
    transport.onFrame((assembled) => frames.push(assembled));
    transport.onError((error) => errors.push(error.code));
    transport.expectBytes(50, 2);
    transport.close();
    socket.binary(frame(50, 1, true, 'flac', new Uint8Array([1, 2])));
    assert.deepEqual(frames, []);
    assert.deepEqual(errors, []);
});

test('transport: a conflicting expectation before the frames is refused', async () => {
    const { transport } = await connected();
    assert.equal(transport.expectBytes(30, 5), true);
    assert.equal(transport.expectBytes(30, 5), true);
    assert.throws(() => transport.expectBytes(30, 6), ProtocolError);
    transport.close();
});

test('transport: an uncorrelated error (id null) reaches onError', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error));
    socket.text(
        JSON.stringify({
            v: PROTOCOL,
            id: null,
            ok: false,
            error: { code: 'bad-request', message: 'not JSON' },
        }),
    );
    assert.equal(errors[0].code, 'bad-request');
    assert.equal(errors[0].data.uncorrelated, true);
    transport.close();
});

test('transport: a 4401 close is reported as unauthorized', async () => {
    const { transport, socket } = await connected();
    const done = transport.request('hello', {});
    const errors = [];
    transport.onError((error) => errors.push(error.code));
    socket.onClose?.(4401, 'unauthorized');
    await assert.rejects(done, (error) => {
        assert.equal(error.code, 'unauthorized');
        assert.equal(error.data.closeCode, 4401);
        return true;
    });
    assert.equal(transport.isClosed, true);
    assert.deepEqual(transport.closeInfo, {
        code: 4401,
        reason: 'unauthorized',
    });
    assert.deepEqual(errors, []);
});

test('transport: a Blob delivery is a named protocol error', async () => {
    const { transport, socket } = await connected();
    const errors = [];
    transport.onError((error) => errors.push(error.message));
    socket.binary(new Blob([new Uint8Array([1, 2, 3])]));
    assert.match(errors[0], /Blob/);
    transport.close();
});
