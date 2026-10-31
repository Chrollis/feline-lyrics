// Engine core tests: lazy connect, media queries and the subtitle seam.
// The backend is faked with a FrameTransport that records requests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMediapipe } from '../src/renderer/index.js';

const WIDTH = 160;
const HEIGHT = 120;

class FakeTransport {
    constructor() {
        this.calls = [];
        this.expected = [];
        this.expectedBytes = [];
        this.listeners = [];
        this.errorListeners = [];
        this.closeListeners = [];
        this.cancelled = [];
        this.ackCount = 2;
        this.ackBytes = 4;
        this.failRangeOnce = false;
        this.closed = false;
    }

    async request(method, params, opts) {
        this.calls.push({
            method,
            params,
            id: opts === undefined ? undefined : opts.id,
        });
        if (method === 'hello') {
            return { protocol: 1 };
        }
        if (method === 'open_source') {
            return {
                source_id: 'src-1',
                path: params.path,
                duration_sec: 10,
                streams: [
                    {
                        index: 0,
                        kind: 'audio',
                        codec: 'flac',
                        sample_rate: 48000,
                        channels: 2,
                        total_samples: 480000,
                    },
                ],
            };
        }
        if (method === 'request_range') {
            if (this.failRangeOnce) {
                this.failRangeOnce = false;
                throw new Error('send failed');
            }
            return {
                req_id: opts.id,
                start_pts_us: 0,
                count: this.ackCount,
                bytes: this.ackBytes,
            };
        }
        throw new Error(`unexpected method ${method}`);
    }

    expectFrames(reqId, frames) {
        this.expected.push({ reqId, frames });
        return true;
    }

    expectBytes(reqId, bytes) {
        this.expectedBytes.push({ reqId, bytes });
        return true;
    }

    cancelFrames(reqId) {
        this.cancelled.push(reqId);
    }

    onFrame(listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    onError(listener) {
        this.errorListeners.push(listener);
        return () => {
            this.errorListeners = this.errorListeners.filter(
                (l) => l !== listener,
            );
        };
    }

    onClose(listener) {
        this.closeListeners.push(listener);
        return () => {
            this.closeListeners = this.closeListeners.filter(
                (l) => l !== listener,
            );
        };
    }

    emitClose(info) {
        for (const listener of this.closeListeners) {
            listener(info);
        }
    }

    emitError(err) {
        for (const listener of this.errorListeners) {
            listener(err);
        }
    }

    close() {
        this.closed = true;
    }

    emit(reqId, frameIndex, last) {
        const frame = {
            reqId,
            header: {
                seq: frameIndex + 1,
                last,
                frame_index: frameIndex,
                pts_us: frameIndex * 33_333,
                width: WIDTH,
                height: HEIGHT,
            },
            bytes: new Uint8Array([frameIndex, 1, 2, 3]),
        };
        for (const listener of this.listeners) {
            listener(frame);
        }
    }

    emitEmpty(reqId) {
        const frame = {
            reqId,
            header: { seq: 1, last: true },
            bytes: new Uint8Array(0),
        };
        for (const listener of this.listeners) {
            listener(frame);
        }
    }
}

function videoClip(id) {
    return {
        id,
        kind: 'video',
        sourceId: 'src-1',
        stream: 0,
        inSec: 0,
        span: { startMs: 0, durationMs: 1000 },
        layer: 0,
        z: 0,
        state: 'live',
    };
}

function subtitleClip(id) {
    return {
        id,
        kind: 'subtitle',
        sourceKey: 'sub-1',
        inMs: 0,
        span: { startMs: 0, durationMs: 2000 },
        layer: 2,
        z: 0,
        state: 'live',
    };
}

function audioClip(id) {
    return {
        id,
        kind: 'audio',
        sourceId: 'src-1',
        stream: 0,
        inMs: 0,
        span: { startMs: 0, durationMs: 2000 },
        layer: 1,
        z: 0,
        state: 'live',
    };
}

class FakeSubtitle {
    constructor() {
        this.rev = 0;
        this.renders = 0;
    }
    revision() {
        return this.rev;
    }
    bump() {
        this.rev += 1;
    }
    frameRate() {
        return 60;
    }
    durationMs() {
        return 3000;
    }
    renderWindow(fromMs, toMs) {
        this.renders += 1;
        const out = [];
        const step = 1000 / 60;
        for (let at = fromMs; at < toMs; at += step) {
            out.push({ ptsMs: Math.floor(at), rows: [{ text: `t${fromMs}` }] });
        }
        return out;
    }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('openSource connects lazily, sends hello once and records the source', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    assert.equal(transport.calls.length, 0);

    const info = await engine.openSource('a.mp3');
    assert.equal(info.sourceId, 'src-1');
    assert.deepEqual(
        transport.calls.map((c) => c.method),
        ['hello', 'open_source'],
    );
    await engine.openSource('b.mp3');
    assert.equal(transport.calls.filter((c) => c.method === 'hello').length, 1);
    await engine.dispose();
});

test('videoFrame goes pending, requests a window, then serves the frame', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        clock: { nowMs: () => 0 },
    });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    const first = engine.videoFrame('c1', 0);
    assert.equal(first.status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    assert.ok(req !== undefined);
    assert.equal(typeof req.id, 'number');
    assert.deepEqual(req.params, {
        source_id: 'src-1',
        kind: 'video',
        stream: 0,
        start_sec: 0,
        duration_sec: 1,
        scale: 0.5,
        fps: 30,
    });

    transport.emit(req.id, 0, false);
    transport.emit(req.id, 1, true);
    const ready = engine.videoFrame('c1', 0);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.width, WIDTH);
    assert.equal(ready.height, HEIGHT);
    assert.equal(ready.frameIndex, 0);
    assert.equal(ready.image[0], 0);

    const later = engine.videoFrame('c1', 40);
    assert.equal(later.status, 'ready');
    assert.equal(later.frameIndex, 1);
    assert.equal(later.image[0], 1);
    assert.equal(engine.videoFrame('c1', 70).status, 'pending');
    await engine.dispose();
});

test('videoFrame outside the span is unavailable and counts an underrun', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    const q = engine.videoFrame('c1', 1500);
    assert.equal(q.status, 'unavailable');
    assert.equal(engine.stats().underruns, 1);
    await engine.dispose();
});

test('setViewport keeps frames of the previous preset', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    assert.equal(engine.videoFrame('c1', 0).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emit(req.id, 0, false);
    transport.emit(req.id, 1, true);
    assert.equal(engine.videoFrame('c1', 0).status, 'ready');

    engine.setViewport({ scale: 1, fps: 30 });
    assert.equal(engine.videoFrame('c1', 0).status, 'pending');

    // Back to the first preset: the frame is still cached (doc 15.2).
    engine.setViewport({ scale: 0.5, fps: 30 });
    assert.equal(engine.videoFrame('c1', 0).status, 'ready');
    assert.throws(() => engine.setViewport({ scale: 0, fps: 30 }), TypeError);
    await engine.dispose();
});

test('tick prefetches a video clip that starts inside the horizon', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    const next = videoClip('c2');
    next.span = { startMs: 200, durationMs: 1000 };
    engine.addClip(next);

    engine.tick(0);
    const ranges = transport.calls.filter((c) => c.method === 'request_range');
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].params.start_sec, 0);
    await engine.dispose();
});

test('tick prefetches the active clip and reuses its window', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    engine.tick(100);
    engine.tick(140);
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        1,
    );
    await engine.dispose();
});

test('subtitle frames render on demand and reset when the revision moves', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    const subtitle = new FakeSubtitle();
    engine.registerSubtitleSource('sub-1', subtitle);
    engine.addClip(subtitleClip('s1'));

    const first = engine.subtitleFrame('s1', 20);
    assert.equal(first.status, 'ready');
    assert.equal(engine.subtitleFrame('s1', 20).status, 'ready');
    assert.equal(subtitle.renders, 1);

    subtitle.bump();
    assert.equal(engine.subtitleFrame('s1', 20).status, 'ready');
    assert.equal(subtitle.renders, 2);
    await engine.dispose();
});

test('a subtitle clip past the source duration reports empty', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    const subtitle = new FakeSubtitle();
    engine.registerSubtitleSource('sub-1', subtitle);
    engine.addClip({
        ...subtitleClip('s1'),
        inMs: 2990,
        span: { startMs: 0, durationMs: 2000 },
    });
    const q = engine.subtitleFrame('s1', 20);
    assert.equal(q.status, 'empty');
    assert.equal(q.reason, 'no-frame-at-slot');
    assert.equal(subtitle.renders, 0);
    await engine.dispose();
});

test('unknown clips and wrong kinds are rejected or unavailable', async () => {
    const engine = createMediapipe({
        connect: async () => new FakeTransport(),
    });
    assert.throws(() => engine.videoFrame('nope', 0), TypeError);

    engine.addClip(videoClip('v1'));
    const withoutSource = engine.videoFrame('v1', 0);
    assert.equal(withoutSource.status, 'unavailable');
    assert.equal(withoutSource.reason, 'source-not-open');
    assert.equal(engine.evaluateClip('v1', 0).kind, 'video');
    assert.throws(() => engine.evaluateClip('v1', Number.NaN), TypeError);
    await engine.dispose();
});

test('preview writes a value; commit returns static actions by default', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        clock: { nowMs: () => 0 },
    });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    engine.preview('c1', 'opacity', 0.5);
    assert.equal(engine.evaluateClip('c1', 0).opacity, 0.5);

    const actions = engine.commitPreview();
    assert.deepEqual(actions, [
        {
            ownerId: 'c1',
            path: 'opacity',
            value: 0.5,
            tMs: 0,
            animated: false,
        },
    ]);
    // Static paths are applied to the clip by the app, not stored as keys.
    assert.equal(engine.evaluateClip('c1', 0).opacity, 1);
    await engine.dispose();
});

test('clearPreview can end one path without touching the others', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));
    engine.addClip(videoClip('c2'));

    engine.preview('c1', 'opacity', 0.5);
    engine.preview('c2', 'opacity', 0.25);
    engine.clearPreview('c1', 'opacity');

    assert.equal(engine.evaluateClip('c1', 0).opacity, 1);
    assert.equal(engine.evaluateClip('c2', 0).opacity, 0.25);
    engine.clearPreview();
    assert.equal(engine.evaluateClip('c2', 0).opacity, 1);
    await engine.dispose();
});

test('autoKey makes a committed preview a real key on the track', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        clock: { nowMs: () => 0 },
        autoKey: true,
    });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    engine.preview('c1', 'opacity', 0.5);
    const actions = engine.commitPreview();
    assert.equal(actions[0].animated, true);
    assert.equal(engine.evaluateClip('c1', 0).opacity, 0.5);
    await engine.dispose();
});

test('stats exposes the frame budget and in-flight windows', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));
    engine.tick(0);
    await flush();
    const stats = engine.stats();
    assert.equal(stats.inFlight, 1);
    assert.equal(stats.videoBytes, 0);
    await engine.dispose();
});

test('an ack with count 0 marks the region empty and is not re-requested', async () => {
    const transport = new FakeTransport();
    transport.ackCount = 0;
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    assert.equal(engine.videoFrame('c1', 0).status, 'pending');
    await flush();
    assert.equal(engine.videoFrame('c1', 0).status, 'empty');
    engine.tick(0);
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        1,
    );
    await engine.dispose();
});

test('a viewport change keeps the windows in flight on the wire', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    assert.equal(engine.videoFrame('c1', 0).status, 'pending');
    await flush();
    engine.setViewport({ scale: 0.25, fps: 30 });
    assert.equal(transport.cancelled.length, 0);
    await engine.dispose();
});

test('the cache slot comes from seq, not from header.frame_index', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));

    assert.equal(engine.videoFrame('c1', 0).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    for (const listener of transport.listeners) {
        listener({
            reqId: req.id,
            header: {
                seq: 1,
                last: true,
                frame_index: 99,
                pts_us: 0,
                width: WIDTH,
                height: HEIGHT,
            },
            bytes: new Uint8Array([7]),
        });
    }
    const ready = engine.videoFrame('c1', 0);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.frameIndex, 0);
    assert.equal(ready.image[0], 7);
    await engine.dispose();
});

test('two clips on one layer prefetch independently', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('c1'));
    engine.addClip(videoClip('c2'));
    engine.tick(100);
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        2,
    );
    await engine.dispose();
});

test('subtitle frames honour the clip inMs', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    const subtitle = new FakeSubtitle();
    engine.registerSubtitleSource('sub-1', subtitle);
    engine.addClip({ ...subtitleClip('s1'), inMs: 500 });

    assert.equal(engine.subtitleFrame('s1', 0).status, 'ready');
    assert.deepEqual(engine.subtitleFrame('s1', 0).rows, [{ text: 't500' }]);
    assert.equal(subtitle.renders, 1);
    await engine.dispose();
});

test('audioPage fetches one page, decodes it and caches it', async () => {
    const transport = new FakeTransport();
    let decodes = 0;
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => {
            decodes += 1;
            return {
                left: new Float32Array(48000),
                right: new Float32Array(48000),
            };
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));

    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    assert.deepEqual(req.params, {
        source_id: 'src-1',
        kind: 'audio',
        stream: 0,
        start_sec: 0,
        duration_sec: 1,
    });
    assert.equal(transport.expectedBytes.length, 1);

    transport.emit(req.id, 0, true);
    await flush();
    const ready = engine.audioPage('a1', 250);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.pageIndex, 0);
    assert.equal(ready.channels[0].length, 48000);
    assert.equal(decodes, 1);
    assert.equal(engine.stats().audioBytes, 48000 * 2 * 4);
    await engine.dispose();
});

test('audio pages follow the source position and the track span', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));

    const second = engine.audioPage('a1', 1500);
    assert.equal(second.status, 'pending');
    assert.equal(second.pageIndex, 1);
    const outside = engine.audioPage('a1', 3000);
    assert.equal(outside.status, 'unavailable');
    assert.equal(outside.reason, 'out-of-span');
    await engine.dispose();
});

test('tick prefetches the audio page and the one ahead', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    engine.tick(100);
    await flush();
    const ranges = transport.calls.filter((c) => c.method === 'request_range');
    assert.equal(ranges.length, 2);
    assert.deepEqual(
        ranges.map((c) => c.params.start_sec),
        [0, 1],
    );
    await engine.dispose();
});

test('an audio page past the source end is empty and never re-requested', async () => {
    const transport = new FakeTransport();
    transport.ackBytes = 0;
    let decodes = 0;
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => {
            decodes += 1;
            return {
                left: new Float32Array(48000),
                right: new Float32Array(48000),
            };
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));

    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emitEmpty(req.id);
    await flush();

    const empty = engine.audioPage('a1', 250);
    assert.equal(empty.status, 'empty');
    assert.equal(empty.reason, 'no-page');
    assert.equal(empty.pageIndex, 0);
    assert.equal(decodes, 0);

    const before = transport.calls.filter(
        (c) => c.method === 'request_range',
    ).length;
    assert.equal(engine.audioPage('a1', 250).status, 'empty');
    await flush();
    const after = transport.calls.filter(
        (c) => c.method === 'request_range',
    ).length;
    assert.equal(after, before);
    await engine.dispose();
});

test('a page that keeps failing is retired instead of retried forever', async () => {
    const transport = new FakeTransport();
    let decodes = 0;
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => {
            decodes += 1;
            throw new Error('bad flac');
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));

    // Every answered frame fails to decode, so each retry burns one attempt.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal(engine.audioPage('a1', 250).status, 'pending');
        await flush();
        const req = transport.calls
            .filter((c) => c.method === 'request_range')
            .at(-1);
        transport.emit(req.id, 0, true);
        await flush();
    }

    const retired = engine.audioPage('a1', 250);
    assert.equal(retired.status, 'unavailable');
    assert.equal(retired.reason, 'page-failed');
    const before = transport.calls.filter(
        (c) => c.method === 'request_range',
    ).length;
    assert.equal(before, 3);

    assert.equal(engine.audioPage('a1', 250).status, 'unavailable');
    await flush();
    const after = transport.calls.filter(
        (c) => c.method === 'request_range',
    ).length;
    assert.equal(after, before);
    assert.equal(decodes, 3);
    await engine.dispose();
});

test('a decoder that throws synchronously still releases the page', async () => {
    const transport = new FakeTransport();
    let decodes = 0;
    const engine = createMediapipe({
        connect: async () => transport,
        // Not async on purpose: the throw happens before any promise exists.
        decodeAudio: () => {
            decodes += 1;
            throw new Error('sync decode failure');
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));

    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emit(req.id, 0, true);
    await flush();

    // The failure was counted and the request settled, so the page is retried
    // instead of staying pending forever.
    assert.equal(decodes, 1);
    assert.equal(engine.stats().inFlight, 0);
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await engine.dispose();
});

test('a reconnect gives a retired page a fresh set of attempts', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => {
            throw new Error('bad flac');
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal(engine.audioPage('a1', 250).status, 'pending');
        await flush();
        const req = transport.calls
            .filter((c) => c.method === 'request_range')
            .at(-1);
        transport.emit(req.id, 0, true);
        await flush();
    }
    assert.equal(engine.audioPage('a1', 250).status, 'unavailable');

    transport.emitClose({ code: 1006, reason: 'drop' });
    // A new transport session may find the page healthy again.
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await engine.dispose();
});

test('an ack without a byte count is not armed as zero bytes', async () => {
    const transport = new FakeTransport();
    transport.ackBytes = undefined;
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    assert.equal(transport.expectedBytes.length, 0);
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emit(req.id, 0, true);
    await flush();
    assert.equal(engine.audioPage('a1', 250).status, 'ready');
    await engine.dispose();
});

test('a wire failure after the ack releases the audio slot', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    assert.equal(engine.stats().inFlight, 1);
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emitError({ code: 'frame-stalled', data: { reqId: req.id } });
    assert.equal(engine.stats().inFlight, 0);
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        2,
    );
    await engine.dispose();
});

test('a decode that returns the wrong frame count is not cached', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(44100),
            right: new Float32Array(44100),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emit(req.id, 0, true);
    await flush();
    assert.equal(engine.stats().audioBytes, 0);
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        2,
    );
    await engine.dispose();
});

test('a rejecting decoder leaves the page missing for a retry', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => {
            throw new Error('bad flac');
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    transport.emit(req.id, 0, true);
    await flush();
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        2,
    );
    await engine.dispose();
});

test('an audio clip must point at the source audio stream', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip({ ...audioClip('a1'), stream: 3 });
    const q = engine.audioPage('a1', 250);
    assert.equal(q.status, 'unavailable');
    assert.equal(q.reason, 'bad-stream');
    assert.equal(engine.stats().underruns, 0);
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        0,
    );
    await engine.dispose();
});

test('a non-finite time is refused instead of throwing', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    engine.addClip(videoClip('v1'));
    assert.equal(engine.audioPage('a1', Number.NaN).reason, 'bad-time');
    assert.equal(engine.videoFrame('v1', Number.NaN).reason, 'bad-time');
    await engine.dispose();
});

test('two clips on one source share one audio page request', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    engine.addClip(audioClip('a2'));
    assert.equal(engine.audioPage('a1', 250).status, 'pending');
    assert.equal(engine.audioPage('a2', 250).status, 'pending');
    await flush();
    assert.equal(
        transport.calls.filter((c) => c.method === 'request_range').length,
        1,
    );
    await engine.dispose();
});

test('a socket close settles its windows and the next request reconnects', async () => {
    let connects = 0;
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => {
            connects += 1;
            return transport;
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(videoClip('v1'));
    assert.equal(engine.videoFrame('v1', 0).status, 'pending');
    assert.equal(engine.stats().inFlight, 1);
    transport.emitClose({ code: 1006, reason: 'drop' });
    assert.equal(engine.stats().inFlight, 0);
    assert.equal(engine.videoFrame('v1', 33).status, 'pending');
    await flush();
    assert.equal(connects, 2);
    assert.equal(transport.calls.filter((c) => c.method === 'hello').length, 2);
    await engine.dispose();
});

test('audio honours the clip in-point when choosing the page', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip({ ...audioClip('a1'), inMs: 1500 });
    const q = engine.audioPage('a1', 0);
    assert.equal(q.status, 'pending');
    assert.equal(q.pageIndex, 1);
    await flush();
    const req = transport.calls.find((c) => c.method === 'request_range');
    assert.equal(req.params.start_sec, 1);
    await engine.dispose();
});

test('audioPage needs a registered decoder and an open source', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({ connect: async () => transport });
    engine.addClip(audioClip('a1'));
    const withoutSource = engine.audioPage('a1', 0);
    assert.equal(withoutSource.status, 'unavailable');
    assert.equal(withoutSource.reason, 'source-not-open');
    await engine.openSource('a.mp3');
    const withoutDecoder = engine.audioPage('a1', 0);
    assert.equal(withoutDecoder.status, 'pending');
    await engine.dispose();
});

test('a hung decoder releases its media slot after the decode timeout', async () => {
    const transport = new FakeTransport();
    const engine = createMediapipe({
        connect: async () => transport,
        decodeTimeoutMs: 5,
        decodeAudio: () => new Promise(() => {}),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));

    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal(engine.audioPage('a1', 0).status, 'pending');
        await flush();
        const req = transport.calls
            .filter((call) => call.method === 'request_range')
            .at(-1);
        transport.emit(req.id, 0, true);
        await flush();
        assert.equal(engine.stats().decoding, 1);
        await wait(15);
        assert.equal(engine.stats().decoding, 0);
    }
    assert.equal(engine.stats().failedPages, 1);
    const retired = engine.audioPage('a1', 0);
    assert.equal(retired.status, 'unavailable');
    assert.equal(retired.reason, 'page-failed');
    await engine.dispose();
});

test('a transport failure does not burn a decode attempt', async () => {
    const transport = new FakeTransport();
    transport.failRangeOnce = true;
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => ({
            left: new Float32Array(48000),
            right: new Float32Array(48000),
        }),
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    assert.equal(engine.audioPage('a1', 0).status, 'pending');
    await flush();
    assert.equal(engine.stats().wireFailures, 1);
    assert.equal(engine.stats().failedPages, 0);

    // The page stayed requestable: the next tick retries it and it decodes.
    assert.equal(engine.audioPage('a1', 0).status, 'pending');
    await flush();
    const req = transport.calls
        .filter((call) => call.method === 'request_range')
        .at(-1);
    transport.emit(req.id, 0, true);
    await flush();
    assert.equal(engine.audioPage('a1', 0).status, 'ready');
    await engine.dispose();
});

test('a successful decode clears an earlier failed attempt', async () => {
    const transport = new FakeTransport();
    let decodes = 0;
    const engine = createMediapipe({
        connect: async () => transport,
        decodeAudio: async () => {
            decodes += 1;
            if (decodes === 1) {
                throw new Error('decode failed once');
            }
            return {
                left: new Float32Array(48000),
                right: new Float32Array(48000),
            };
        },
    });
    await engine.openSource('a.mp3');
    engine.addClip(audioClip('a1'));
    engine.audioPage('a1', 0);
    await flush();
    let req = transport.calls
        .filter((call) => call.method === 'request_range')
        .at(-1);
    transport.emit(req.id, 0, true);
    await flush();
    await flush();
    assert.equal(engine.stats().failedPages, 0);

    engine.audioPage('a1', 0);
    await flush();
    req = transport.calls
        .filter((call) => call.method === 'request_range')
        .at(-1);
    transport.emit(req.id, 0, true);
    await flush();
    await flush();
    assert.equal(engine.audioPage('a1', 0).status, 'ready');
    assert.equal(engine.stats().failedPages, 0);
    await engine.dispose();
});

test('a clip the index rejects is not left registered', () => {
    const engine = createMediapipe({});
    assert.throws(
        () => {
            engine.addClip({
                ...videoClip('bad'),
                span: { startMs: -1, durationMs: 1000 },
            });
        },
        (error) => error instanceof TypeError,
    );
    assert.equal(engine.getClip('bad'), undefined);
    engine.addClip(videoClip('ok'));
    assert.ok(engine.getClip('ok'));
});
