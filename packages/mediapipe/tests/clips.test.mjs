import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LAYER_AUDIO,
    LAYER_SUBTITLE,
    LAYER_VIDEO,
    clipEnd,
    compareTopmost,
    hitTestAt,
    moveBy,
    moveTo,
    msToSamples,
    splitAt,
    trimLeft,
    trimRight,
} from '../src/renderer/index.js';

function videoClip(id, startMs, durationMs, extra = {}) {
    return {
        id,
        kind: 'video',
        sourceId: 'src',
        span: { startMs, durationMs },
        layer: LAYER_VIDEO,
        z: 0,
        state: 'live',
        stream: 0,
        inSec: 0,
        ...extra,
    };
}

function subtitleClip(id, startMs, durationMs, extra = {}) {
    return {
        id,
        kind: 'subtitle',
        span: { startMs, durationMs },
        layer: LAYER_SUBTITLE,
        z: 0,
        state: 'live',
        sourceKey: 'lyric:one',
        inMs: 0,
        ...extra,
    };
}

test('move: changes placement only', () => {
    const clip = videoClip('a', 1000, 2000);
    const moved = moveTo(clip, 5000);
    assert.deepEqual(moved.span, { startMs: 5000, durationMs: 2000 });
    assert.equal(moved.inSec, 0);
    assert.deepEqual(moveBy(clip, 500).span, {
        startMs: 1500,
        durationMs: 2000,
    });
    assert.equal(moveTo(clip, 1000), clip);
    assert.equal(moveTo(clip, -1), null);
    assert.equal(moveTo(clip, 1.5), null);
});

test('trimLeft: advances the source in-point so content stays put', () => {
    const clip = videoClip('a', 1000, 2000);
    const trimmed = trimLeft(clip, 1500);
    assert.deepEqual(trimmed.span, { startMs: 1500, durationMs: 1500 });
    assert.equal(trimmed.inSec, 0.5);
    assert.equal(clipEnd(trimmed), 3000);
    assert.ok(Object.isFrozen(trimmed));
    assert.ok(Object.isFrozen(trimmed.span));

    const audio = {
        id: 'b',
        kind: 'audio',
        sourceId: 'src',
        span: { startMs: 0, durationMs: 4000 },
        layer: LAYER_AUDIO,
        z: 0,
        state: 'live',
        stream: 0,
        inMs: 250,
    };
    const trimmedAudio = trimLeft(audio, 1000);
    assert.equal(trimmedAudio.inMs, 1250);

    assert.equal(trimLeft(clip, 3000), null);
    assert.equal(trimLeft(clip, 1000), clip);
    assert.equal(trimLeft(clip, 999), null);
});

test('trimLeft: repeated trims keep the video in-point on a whole millisecond', () => {
    let clip = videoClip('a', 0, 5000);
    clip = trimLeft(clip, 100);
    clip = trimLeft(clip, 700);
    assert.equal(Math.round(clip.inSec * 1000), 700);
    assert.equal(msToSamples(Math.round(clip.inSec * 1000)), 33600);
});

test('trimRight: keeps the in-point and only shrinks the span', () => {
    const clip = videoClip('a', 1000, 2000, { inSec: 3 });
    const trimmed = trimRight(clip, 2500);
    assert.deepEqual(trimmed.span, { startMs: 1000, durationMs: 1500 });
    assert.equal(trimmed.inSec, 3);
    assert.ok(Object.isFrozen(trimmed));
    assert.equal(trimRight(clip, 1000), null);
    assert.equal(trimRight(clip, 3000), clip);
    assert.equal(trimRight(clip, 4000), null);
});

test('split: halves spans, advances the right in-point, z + 0.5', () => {
    const clip = videoClip('a', 1000, 2000, { inSec: 2, z: 1 });
    const halves = splitAt(clip, 1600, 'b');
    assert.ok(halves);
    const [left, right] = halves;
    assert.equal(left.id, 'a');
    assert.deepEqual(left.span, { startMs: 1000, durationMs: 600 });
    assert.equal(left.inSec, 2);
    assert.equal(right.id, 'b');
    assert.deepEqual(right.span, { startMs: 1600, durationMs: 1400 });
    assert.equal(right.inSec, 2.6);
    assert.equal(right.z, 1.5);
    assert.equal(splitAt(clip, 1000, 'b'), null);
    assert.equal(splitAt(clip, 3000, 'b'), null);
    assert.equal(splitAt(clip, 1600, 'a'), null);
    assert.equal(splitAt(clip, 1600, ''), null);
    assert.equal(splitAt(clip, 1000.5, 'b'), null);
});

test('hitTest: layer beats z, z beats id', () => {
    const video = videoClip('z', 0, 1000, { z: 9 });
    const subtitle = subtitleClip('s', 0, 1000, { z: 0 });
    assert.equal(hitTestAt([video, subtitle], 500), subtitle);
    assert.equal(hitTestAt([video, subtitle], 1500), null);

    const back = videoClip('a', 0, 1000);
    const front = videoClip('b', 0, 1000, { z: 1 });
    assert.equal(hitTestAt([back, front], 10), front);

    const tieA = videoClip('a', 0, 1000);
    const tieB = videoClip('b', 0, 1000);
    assert.equal(hitTestAt([tieB, tieA], 10), tieA);
    assert.ok(compareTopmost(tieA, tieB) < 0);
});
