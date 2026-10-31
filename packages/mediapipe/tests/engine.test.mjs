import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AnimationStore,
    mergeKey,
    sampleChannel,
    shiftKeys,
    splitKeys,
} from '../src/renderer/engine/animation.js';
import { evaluateClip } from '../src/renderer/engine/evaluate.js';
import { FrameCache, frameKey } from '../src/renderer/frames/frameCache.js';
import {
    AudioPageCache,
    PAGE_BYTES,
    PAGE_FRAMES,
    pageKey,
} from '../src/renderer/audio/pageCache.js';

const key = (tMs, value, interp = 'linear', extra = {}) => ({
    tMs,
    value,
    interp,
    ...extra,
});

test('sampleChannel holds before the first and after the last key', () => {
    const keys = [key(500, 10), key(1500, 20)];
    assert.equal(sampleChannel(keys, 0), 10);
    assert.equal(sampleChannel(keys, 2500), 20);
});

test('sampleChannel takes interpolation from the right-hand key', () => {
    const keys = [key(0, 0, 'linear'), key(1000, 10, 'hold')];
    assert.equal(sampleChannel(keys, 500), 0);
    const linear = [key(0, 0, 'hold'), key(1000, 10, 'linear')];
    assert.equal(sampleChannel(linear, 500), 5);
});

test('sampleChannel easeIn stays below linear in the first half', () => {
    const keys = [key(0, 0, 'linear'), key(1000, 10, 'easeIn')];
    assert.ok(sampleChannel(keys, 250) < 2.5);
    assert.ok(sampleChannel(keys, 500) < 5);
});

test('sampleChannel bezier stays between the two values', () => {
    const keys = [
        key(0, 0, 'bezier', {
            hOut: { dx: 0.9, dy: 0 },
            hIn: { dx: 0.9, dy: 1 },
        }),
        key(1000, 10, 'bezier', {
            hOut: { dx: 0.9, dy: 0 },
            hIn: { dx: 0.9, dy: 1 },
        }),
    ];
    const mid = sampleChannel(keys, 500);
    assert.ok(mid > 0 && mid < 10.01);
    assert.equal(sampleChannel(keys, 0), 0);
    assert.equal(sampleChannel(keys, 1000), 10);
});

test('mergeKey inserts in order and replaces an existing time', () => {
    const merged = mergeKey([key(0, 0), key(1000, 10)], 500, 5);
    assert.deepEqual(
        merged.map((k) => [k.tMs, k.value]),
        [
            [0, 0],
            [500, 5],
            [1000, 10],
        ],
    );
    const replaced = mergeKey(merged, 500, 7);
    assert.equal(replaced.length, 3);
    assert.equal(replaced[1].value, 7);
});

test('mergeKey holds a lone key', () => {
    assert.equal(mergeKey([], 300, 4)[0].interp, 'hold');
});

test('shiftKeys moves times and keeps negative ones', () => {
    const shifted = shiftKeys([key(0, 1), key(800, 2)], -500);
    assert.deepEqual(
        shifted.map((k) => k.tMs),
        [-500, 300],
    );
});

test('splitKeys rebases the tail and samples the cut', () => {
    const keys = [key(0, 0), key(1000, 10)];
    const { head, tail } = splitKeys(keys, 500);
    assert.deepEqual(
        head.map((k) => [k.tMs, k.value]),
        [
            [0, 0],
            [500, 5],
        ],
    );
    assert.deepEqual(
        tail.map((k) => [k.tMs, k.value]),
        [
            [0, 5],
            [500, 10],
        ],
    );
    assert.equal(sampleChannel(head, 500), sampleChannel(keys, 500));
    assert.equal(sampleChannel(tail, 0), sampleChannel(keys, 500));
});

test('AnimationStore rejects keys that are not strictly increasing', () => {
    const store = new AnimationStore();
    assert.throws(
        () => store.set('clip', 'opacity', [key(10, 1), key(10, 2)]),
        /strictly increasing/,
    );
});

test('AnimationStore preview overrides sampling until committed', () => {
    const store = new AnimationStore();
    store.set('clip', 'opacity', [key(0, 0), key(1000, 1)]);
    assert.equal(store.sample('clip', 'opacity', 500, 1), 0.5);
    store.previewSet('clip', 'opacity', 0.9, 250);
    assert.equal(store.sample('clip', 'opacity', 500, 1), 0.9);
    const committed = store.commit();
    assert.equal(committed.length, 1);
    assert.equal(committed[0].animated, true);
    assert.equal(store.sample('clip', 'opacity', 250, 1), 0.9);
    assert.equal(store.previewHas('clip', 'opacity'), false);
});

test('AnimationStore commit leaves a static path alone without autoKey', () => {
    const store = new AnimationStore();
    store.previewSet('clip', 'transform.x', 40, 0);
    const [committed] = store.commit();
    assert.equal(committed.animated, false);
    assert.equal(store.has('clip', 'transform.x'), false);
    assert.equal(store.sample('clip', 'transform.x', 0, 0), 0);
});

test('AnimationStore commit creates a curve when autoKey is on', () => {
    const store = new AnimationStore(true);
    store.previewSet('clip', 'transform.x', 40, 0);
    const [committed] = store.commit();
    assert.equal(committed.animated, true);
    assert.equal(store.sample('clip', 'transform.x', 500, 0), 40);
});

test('AnimationStore copyOwner deep copies and removeOwner cascades', () => {
    const store = new AnimationStore();
    store.set('a', 'opacity', [key(0, 0), key(1000, 1)]);
    store.set('a', 'transform.scale', [key(0, 1)]);
    store.copyOwner('a', 'b');
    assert.equal(store.sample('b', 'opacity', 500, 1), 0.5);
    store.set('b', 'opacity', [key(0, 0), key(1000, 0.25)]);
    assert.equal(store.sample('a', 'opacity', 500, 1), 0.5);
    store.removeOwner('a');
    assert.equal(store.has('a', 'opacity'), false);
    assert.equal(store.has('b', 'transform.scale'), true);
});

test('sampleChannel easeOut starts fast and easeInOut crosses half at half', () => {
    const out = [key(0, 0, 'linear'), key(1000, 10, 'easeOut')];
    assert.ok(sampleChannel(out, 250) > 2.5);
    const inOut = [key(0, 0, 'linear'), key(1000, 10, 'easeInOut')];
    assert.ok(Math.abs(sampleChannel(inOut, 500) - 5) < 0.01);
    assert.ok(sampleChannel(inOut, 250) < 2.5);
    assert.ok(sampleChannel(inOut, 750) > 5);
});

test('sampleChannel bezier uses the leaving handle of the left key', () => {
    const near = [
        key(0, 0, 'bezier', { hOut: { dx: 0.1, dy: 0 } }),
        key(1000, 10, 'bezier', { hIn: { dx: 0.1, dy: 1 } }),
    ];
    const far = [
        key(0, 0, 'bezier', { hOut: { dx: 0.9, dy: 0 } }),
        key(1000, 10, 'bezier', { hIn: { dx: 0.9, dy: 1 } }),
    ];
    assert.notEqual(
        Math.round(sampleChannel(near, 250) * 100),
        Math.round(sampleChannel(far, 250) * 100),
    );
});

test('preview bumps the version and clearPreview restores sampling', () => {
    const store = new AnimationStore();
    store.set('clip', 'opacity', [key(0, 0), key(1000, 1)]);
    const before = store.version;
    store.previewSet('clip', 'opacity', 0.9, 250);
    assert.ok(store.version > before);
    assert.equal(store.sample('clip', 'opacity', 500, 1), 0.9);
    store.clearPreview('clip', 'opacity');
    assert.equal(store.sample('clip', 'opacity', 500, 1), 0.5);
    assert.ok(store.version > before + 1);
});

test('mergeKey keeps the replaced key interpolation and handles', () => {
    const keys = [
        key(0, 0, 'linear'),
        key(1000, 10, 'bezier', { hIn: { dx: 0.2, dy: 0.9 } }),
    ];
    const merged = mergeKey(keys, 1000, 20);
    assert.equal(merged[1].interp, 'bezier');
    assert.deepEqual(merged[1].hIn, { dx: 0.2, dy: 0.9 });
});

test('splitKeys handles existing keys, edges and hold channels', () => {
    const keys = [key(0, 0, 'hold'), key(1000, 10, 'hold')];
    const atKey = splitKeys(keys, 1000);
    assert.deepEqual(
        atKey.head.map((k) => k.tMs),
        [0, 1000],
    );
    assert.deepEqual(
        atKey.tail.map((k) => k.tMs),
        [0],
    );
    assert.equal(sampleChannel(atKey.tail, 0), 10);
    const before = splitKeys(keys, -500);
    assert.equal(before.head[0].value, 0);
    assert.equal(sampleChannel(before.tail, 500), 0);
    const after = splitKeys(keys, 2000);
    assert.equal(after.tail[0].tMs, 0);
    assert.equal(after.tail[0].value, 10);
});

test('evaluateClip fills kind defaults for a plain clip', () => {
    const store = new AnimationStore();
    const clip = {
        id: 'c1',
        kind: 'video',
        stream: 0,
        inSec: 0,
        span: { startMs: 1000, durationMs: 1000 },
        layer: 0,
        z: 1,
        state: 'live',
    };
    const state = evaluateClip(clip, 1250, store);
    assert.equal(state.clipId, 'c1');
    assert.equal(state.localMs, 250);
    assert.equal(state.opacity, 1);
    assert.deepEqual(state.transform, { x: 0, y: 0, scale: 1, rotation: 0 });
    assert.deepEqual(state.audio, { gain: 1, pan: 0 });
});

test('evaluateClip samples tracks and keeps the static audio gain fallback', () => {
    const store = new AnimationStore();
    store.set('c1', 'opacity', [key(0, 0), key(1000, 1)]);
    store.set('c1', 'audio.pan', [key(0, -1), key(1000, 1)]);
    const clip = {
        id: 'c1',
        kind: 'audio',
        stream: 0,
        inMs: 0,
        gain: 0.5,
        span: { startMs: 0, durationMs: 2000 },
        layer: 1,
        z: 1,
        state: 'live',
    };
    const state = evaluateClip(clip, 250, store);
    assert.equal(state.opacity, 0.25);
    assert.equal(state.audio.pan, -0.5);
    assert.equal(state.audio.gain, 0.5);
    assert.equal(state.state, 'live');
});

test('evaluateClip rejects a malformed time', () => {
    const store = new AnimationStore();
    const clip = {
        id: 'c1',
        kind: 'video',
        stream: 0,
        inSec: 0,
        span: { startMs: 0, durationMs: 1000 },
        layer: 0,
        z: 1,
        state: 'live',
    };
    assert.throws(() => evaluateClip(clip, NaN, store), /atMs must be finite/);
});

test('frameKey packs tokens and refuses indexes that would alias', () => {
    assert.equal(frameKey(2, 3), 2 * (1 << 20) + 3);
    assert.throws(() => frameKey(-1, 0), /token out of range/);
    assert.throws(() => frameKey(0, -1), /frameIndex out of range/);
    assert.throws(() => frameKey(0, 1 << 20), /frameIndex out of range/);
});

test('FrameCache evicts furthest from the playhead and keeps pins', () => {
    const cache = new FrameCache(100);
    const frame = (token, index, ptsMs, bytes = 10) => ({
        token,
        frameIndex: index,
        ptsMs,
        width: 2,
        height: 2,
        bytes,
        image: { token, index },
    });
    cache.setFocus(0, 0);
    for (let i = 0; i <= 10; i++) {
        cache.put(frame(0, i, i * 100));
    }
    assert.ok(cache.bytes <= 100);
    assert.equal(cache.get(0, 10) !== undefined, true);
    // Farthest from the playhead go first, but the newest frames are recent.
    assert.equal(cache.has(0, 8), false);
    assert.equal(cache.has(0, 7), false);
    assert.equal(cache.has(0, 0), true);
    cache.pin(0, 9);
    cache.pin(0, 10);
    cache.put(frame(0, 11, 1100));
    assert.equal(cache.get(0, 10) !== undefined, true);
    if (cache.bytes > 100) {
        assert.equal(cache.stats().overBudget, true);
    }
    const before = cache.bytes;
    cache.put(frame(0, 11, 1100));
    assert.equal(cache.bytes, before);
    assert.ok(cache.stats().pinnedBytes >= 10);
    cache.unpinAll();
    cache.put(frame(1, 0, 0));
    assert.ok(cache.bytes <= 100 || cache.stats().overBudget);
    cache.dropToken(0);
    assert.equal(cache.has(0, 10), false);
    assert.equal(cache.has(1, 0), true);
});

test('FrameCache with a zero budget keeps only the newly inserted frames', () => {
    const cache = new FrameCache(0);
    const frame = (index) => ({
        token: 0,
        frameIndex: index,
        ptsMs: index,
        width: 1,
        height: 1,
        bytes: 10,
        image: null,
    });
    cache.put(frame(0));
    cache.put(frame(1));
    cache.put(frame(2));
    assert.equal(cache.has(0, 0), false);
    assert.equal(cache.has(0, 2), true);
    assert.equal(cache.stats().overBudget, true);
});

test('FrameCache dropWidth forgets one viewport only', () => {
    const cache = new FrameCache(1000);
    const frame = (index, width) => ({
        token: 0,
        frameIndex: index,
        ptsMs: index,
        width,
        height: 2,
        bytes: 10,
        image: null,
    });
    cache.put(frame(0, 160));
    cache.put(frame(1, 320));
    assert.equal(cache.has(0, 0), true);
    cache.dropWidth(160);
    assert.equal(cache.has(0, 0), false);
    assert.equal(cache.has(0, 1), true);
});

test('AudioPageCache caps each source and keeps pinned pages', () => {
    const cache = new AudioPageCache(PAGE_BYTES * 6, PAGE_BYTES * 3);
    const page = (token, pageIndex) => ({
        token,
        pageIndex,
        channels: [
            new Float32Array(PAGE_FRAMES),
            new Float32Array(PAGE_FRAMES),
        ],
        sampleRate: 48000,
    });
    cache.setFocusBySample(0, 5 * PAGE_FRAMES);
    for (let i = 0; i < 6; i++) {
        cache.put(page(0, i));
    }
    assert.ok(cache.bytes <= PAGE_BYTES * 3);
    assert.equal(cache.get(0, 5) !== undefined, true);
    cache.pinPage(0, 5);
    cache.put(page(0, 0));
    assert.equal(cache.get(0, 5) !== undefined, true);
    assert.throws(() => cache.pinWindow(0, 3, 2), /inverted/);
    assert.throws(() => cache.pinWindow(0, -1, 2), /out of range/);
    assert.throws(() => pageKey(0, -1), /out of range/);
    assert.throws(
        () =>
            cache.put({
                token: 0,
                pageIndex: 0,
                channels: [new Float32Array(10), new Float32Array(10)],
                sampleRate: 48000,
            }),
        /two 48000-frame channels/,
    );
    cache.unpinAll(0);
    cache.dropToken(0);
    assert.equal(cache.size, 0);
});
