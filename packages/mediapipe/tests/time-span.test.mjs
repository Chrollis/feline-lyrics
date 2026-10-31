import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SAMPLES_PER_MS,
    SAMPLE_RATE,
    clampMs,
    msToSamples,
    msToSec,
    msToUs,
    samplesToMs,
    secToMs,
    spanContains,
    spanEnd,
    spanFromBounds,
    spanIntersect,
    spanIntersects,
    spanOffset,
    usToMs,
} from '../src/renderer/index.js';

test('time: 48 samples per millisecond on both directions', () => {
    assert.equal(SAMPLE_RATE, 48000);
    assert.equal(SAMPLES_PER_MS, 48);
    assert.equal(msToSamples(1), 48);
    assert.equal(msToSamples(1000), 48000);
    assert.equal(samplesToMs(48000), 1000);
});

test('time: wire units', () => {
    assert.equal(secToMs(1.5), 1500);
    assert.equal(msToSec(1500), 1.5);
    assert.equal(usToMs(250000), 250);
    assert.equal(msToUs(250), 250000);
    assert.equal(clampMs(-5, 0, 10), 0);
    assert.equal(clampMs(15, 0, 10), 10);
    assert.equal(clampMs(5, 0, 10), 5);
});

test('span: half-open containment', () => {
    const span = spanFromBounds(1000, 1500);
    assert.equal(spanEnd(span), 1500);
    assert.equal(span.durationMs, 500);
    assert.equal(spanContains(span, 1000), true);
    assert.equal(spanContains(span, 1499), true);
    assert.equal(spanContains(span, 1500), false);
    assert.equal(spanContains(span, 999), false);
});

test('span: intersect and touch', () => {
    const a = spanFromBounds(0, 1000);
    const b = spanFromBounds(400, 1600);
    assert.equal(spanIntersects(a, b), true);
    assert.deepEqual(spanIntersect(a, b), { startMs: 400, durationMs: 600 });
    const touching = spanFromBounds(1000, 1200);
    assert.equal(spanIntersects(a, touching), false);
    assert.equal(spanIntersect(a, touching), null);
    const empty = spanFromBounds(500, 500);
    assert.equal(spanIntersects(a, empty), false);
    assert.equal(spanIntersect(a, empty), null);
    assert.deepEqual(spanOffset(a, 250), { startMs: 250, durationMs: 1000 });
});
