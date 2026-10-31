import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BUCKET_MS,
    activeAt,
    activeInto,
    buildLayerIndex,
    layerIndexFor,
    playbackActive,
    resetCursor,
    snapToEditPoint,
    topmostAt,
} from '../src/renderer/index.js';

function clip(id, startMs, durationMs, layer = 0, z = 0) {
    return {
        id,
        kind: 'video',
        sourceId: 'src',
        span: { startMs, durationMs },
        layer,
        z,
        state: 'live',
        stream: 0,
        inSec: 0,
    };
}

function bruteForce(clips, tMs) {
    return clips
        .filter(
            (c) =>
                c.span.startMs <= tMs &&
                tMs < c.span.startMs + c.span.durationMs,
        )
        .map((c) => c.id)
        .sort();
}

function idsOf(clips) {
    return clips.map((c) => c.id).sort();
}

function rng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const clips = [];
{
    const random = rng(20260818);
    for (let i = 0; i < 200; i += 1) {
        const startMs = Math.floor(random() * 600000);
        const durationMs = 100 + Math.floor(random() * 40000);
        clips.push(clip(`c${i}`, startMs, durationMs, i % 3, random() * 10));
    }
}

const index = buildLayerIndex(clips);

test('index: activeAt matches brute force on random probes', () => {
    const random = rng(7);
    for (let i = 0; i < 300; i += 1) {
        const t = Math.floor(random() * 640000);
        assert.deepEqual(
            idsOf(activeAt(index, t)),
            bruteForce(clips, t),
            `t=${t}`,
        );
    }
});

test('index: a long clip appears once even across buckets', () => {
    const long = clip('long', 0, 100000);
    const short = clip('short', 40000, 1000);
    const longIndex = buildLayerIndex([long, short]);
    for (const t of [0, 1000, 39999, 40000, 41000, 49999, 50000, 99999]) {
        assert.deepEqual(
            idsOf(activeAt(longIndex, t)),
            bruteForce([long, short], t),
            `t=${t}`,
        );
    }
    assert.equal(activeAt(longIndex, 100000).length, 0);
});

test('index: topmost honors layer then z', () => {
    const base = clip('base', 0, 10000, 0, 0);
    const overlay = clip('overlay', 0, 10000, 2, 0);
    const zed = clip('zed', 0, 10000, 2, 5);
    const top = buildLayerIndex([base, overlay, zed]);
    assert.equal(topmostAt(top, 500).id, 'zed');
    assert.equal(topmostAt(top, 20000), null);
});

test('index: playback cursor equals activeAt across a forward sweep and jumps', () => {
    resetCursor(index);
    let t = 0;
    while (t <= 620000) {
        assert.deepEqual(
            idsOf(playbackActive(index, t)),
            bruteForce(clips, t),
            `forward t=${t}`,
        );
        t += 40;
    }
    const jump = (value) => {
        assert.deepEqual(
            idsOf(playbackActive(index, value)),
            bruteForce(clips, value),
            `jump t=${value}`,
        );
    };
    jump(500000);
    jump(1000);
    jump(299999);
    jump(300000);
    jump(BUCKET_MS * 2 + 1);
    jump(0);
});

test('index: snapping finds the nearest edit point', () => {
    const snapping = buildLayerIndex([
        clip('a', 1000, 2000), // start 1000, end 3000
        clip('b', 5000, 2000), // start 5000, end 7000
    ]);
    assert.equal(snapToEditPoint(snapping, 1040, 100), 1000);
    assert.equal(snapToEditPoint(snapping, 2960, 100), 3000);
    assert.equal(snapToEditPoint(snapping, 4010, 100), null);
    assert.equal(snapToEditPoint(snapping, 4990, 100), 5000);
    assert.equal(snapToEditPoint(snapping, 4600, 800), 5000);
    assert.equal(snapToEditPoint(snapping, 4100, 50), null);
    assert.equal(snapToEditPoint(snapping, -10, 100), null);
});

test('index: empty layer and rejected times are safe', () => {
    const empty = buildLayerIndex([]);
    assert.deepEqual(activeAt(empty, 0), []);
    assert.deepEqual(playbackActive(empty, 500), []);
    assert.equal(snapToEditPoint(empty, 100, 50), null);

    assert.deepEqual(activeAt(index, -1), []);
    assert.deepEqual(activeAt(index, NaN), []);
    assert.deepEqual(playbackActive(index, -1), []);
    assert.deepEqual(playbackActive(index, NaN), []);
    assert.equal(topmostAt(index, NaN), null);
});

test('index: fractional spans are rejected at build time', () => {
    assert.throws(
        () => buildLayerIndex([clip('a', 1000.5, 500)]),
        /span must be integer milliseconds/,
    );
    assert.throws(
        () => buildLayerIndex([clip('a', 0, 100.7)]),
        /span must be integer milliseconds/,
    );
    assert.throws(
        () => buildLayerIndex([clip('a', 0, -1)]),
        /span must be integer milliseconds/,
    );
});

test('index: layerIndexFor caches by array identity', () => {
    const array = [clip('a', 0, 1000), clip('b', 500, 500)];
    assert.equal(layerIndexFor(array), layerIndexFor(array));
    assert.notEqual(layerIndexFor(array), layerIndexFor([...array]));
    assert.deepEqual(
        idsOf(activeAt(layerIndexFor(array), 600)),
        bruteForce(array, 600),
    );
});

test('index: activeInto reuses the caller buffer', () => {
    const out = ['sentinel'];
    const returned = activeInto(index, 1000, out);
    assert.equal(returned, out);
    assert.deepEqual(idsOf(out), bruteForce(index.clips, 1000));
    activeInto(index, 620000, out);
    assert.deepEqual(idsOf(out), bruteForce(index.clips, 620000));
    assert.equal(returned, out);
});

test('index: snapping ties go to the start side and radius is inclusive', () => {
    const snapping = buildLayerIndex([
        clip('a', 0, 1000),
        clip('b', 2000, 1000),
    ]);
    // t=1500 is 500 ms from the end 1000 and 500 ms from the start 2000;
    // starts are iterated first, so the start wins.
    assert.equal(snapToEditPoint(snapping, 1500, 500), 2000);
    assert.equal(snapToEditPoint(snapping, 1000, 0), 1000);
    assert.equal(snapToEditPoint(snapping, 1001, 0), null);
    assert.equal(snapToEditPoint(snapping, 999, 0), null);
    assert.equal(snapToEditPoint(snapping, 2001, 100), 2000);
});

test('index: refuses a span that starts before zero', () => {
    // A negative start used to index buckets[-1] and throw a bare TypeError
    // from inside the fill loop, far from the clip that caused it.
    assert.throws(() => buildLayerIndex([clip('neg', -1, 500)]), TypeError);
});

test('index: refuses a span whose end leaves the int32 range', () => {
    // The starts and ends live in Int32Array: a larger end wrapped negative
    // and the clip was silently left out of every bucket.
    assert.throws(
        () => buildLayerIndex([clip('huge', 1, 2 ** 31 - 1)]),
        TypeError,
    );
});
