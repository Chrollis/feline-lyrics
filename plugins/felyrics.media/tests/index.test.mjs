// The plugin's TS face, exercised against a fake context: what is asserted here
// is the registration list and that each method forwards its own name and
// parameters unchanged. The backend itself is covered by the Python suite.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activate, FRAMES_BUDGET_MS, METHODS } from '../dist/index.js';

function fakeContext() {
  const handlers = new Map();
  const calls = [];
  const ctx = {
    pluginId: 'felyrics.media',
    api: 1,
    method(name, handler) {
      handlers.set(name, handler);
    },
    backend: {
      async call(name, params, options) {
        calls.push([name, params, options]);
        return { name, params };
      },
    },
  };

  return { ctx, handlers, calls };
}

test('activate registers every declared method', async () => {
  const { ctx, handlers } = fakeContext();

  await activate(ctx);

  assert.deepEqual([...handlers.keys()], [...METHODS]);
});

test('a public method forwards its name and parameters', async () => {
  const { ctx, handlers } = fakeContext();

  await activate(ctx);

  const params = { path: 'song.flac' };
  const answer = await handlers.get('probe')(params);

  assert.deepEqual(answer, { name: 'probe', params });
});

test('only a still batch raises the call budget', async () => {
  const { ctx, handlers, calls } = fakeContext();

  await activate(ctx);

  await handlers.get('decode')({ path: 'song.flac' });
  await handlers.get('video-frames')({ path: 'clip.mp4', count: 2 });

  assert.deepEqual(
    calls.map(([name, , options]) => [name, options]),
    [
      ['decode', undefined],
      ['video-frames', { timeoutMs: FRAMES_BUDGET_MS }],
    ],
  );
});
