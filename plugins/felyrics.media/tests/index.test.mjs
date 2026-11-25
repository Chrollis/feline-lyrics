// The plugin's TS face, exercised against a fake context: what is asserted here
// is the registration list, what each method forwards, and that picking asks the
// host and keeps no state. The backend itself is covered by the Python suite.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activate,
  FRAMES_BUDGET_MS,
  METHODS,
  PICKS,
} from '../dist/index.js';

// The manifest is the declaration the host compares against; reading it here is
// what keeps `METHODS` from drifting away from it.
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'),
);
const DECLARED = MANIFEST.felyrics.contributes;

function fakeContext(picked = null) {
  const methods = new Map();
  const calls = [];
  const picks = [];
  const ctx = {
    pluginId: 'felyrics.media',
    api: 1,
    method(name, handler) {
      methods.set(name, handler);
    },
    backend: {
      async call(name, params, options) {
        calls.push([name, params, options]);
        return { name, params };
      },
    },
    host: {
      async pickFile(options) {
        picks.push(options.kind);
        return typeof picked === 'function' ? picked() : picked;
      },
    },
  };

  return { ctx, methods, calls, picks };
}

test('activate registers every method the manifest declares', async () => {
  const { ctx, methods } = fakeContext();

  await activate(ctx);

  assert.deepEqual(
    [...METHODS, ...PICKS].sort(),
    [...DECLARED.methods].sort(),
  );
  assert.deepEqual([...PICKS].sort(), ['pick-audio', 'pick-video']);
  assert.deepEqual([...methods.keys()].sort(), [...DECLARED.methods].sort());
});

test('a public method forwards its name and parameters', async () => {
  const { ctx, methods } = fakeContext();

  await activate(ctx);

  const params = { path: 'song.flac' };
  const answer = await methods.get('probe')(params);

  assert.deepEqual(answer, { name: 'probe', params });
});

test('only a still batch raises the call budget', async () => {
  const { ctx, methods, calls } = fakeContext();

  await activate(ctx);

  await methods.get('decode')({ path: 'song.flac', rate: 44100 });
  await methods.get('video-frames')({ path: 'clip.mp4', count: 2 });

  assert.deepEqual(
    calls.map(([name, , options]) => [name, options]),
    [
      ['decode', undefined],
      ['video-frames', { timeoutMs: FRAMES_BUDGET_MS }],
    ],
  );
  assert.deepEqual(calls[0][1], { path: 'song.flac', rate: 44100 });
});

test('pick-audio asks the host and returns the path without storing it', async () => {
  const { ctx, methods, picks } = fakeContext('/music/song.flac');

  await activate(ctx);

  assert.equal(await methods.get('pick-audio')({}), '/music/song.flac');
  assert.deepEqual(picks, ['audio']);

  // The next pick asks again: the plugin keeps no "last picked" state.
  assert.equal(await methods.get('pick-audio')({}), '/music/song.flac');
  assert.deepEqual(picks, ['audio', 'audio']);
});

test('a cancelled pick returns null', async () => {
  const { ctx, methods } = fakeContext(null);

  await activate(ctx);

  assert.equal(await methods.get('pick-audio')({}), null);
  assert.equal(await methods.get('pick-video')({}), null);
});

test('pick-video asks the host for a video', async () => {
  const { ctx, methods, picks } = fakeContext('/clips/video.mp4');

  await activate(ctx);

  assert.equal(await methods.get('pick-video')({}), '/clips/video.mp4');
  assert.deepEqual(picks, ['video']);
});
