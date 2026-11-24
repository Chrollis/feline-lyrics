// The plugin's TS face, exercised against a fake context: what is asserted here
// is the registration lists, what each method forwards, and that the four
// commands remember the picked file instead of asking the dialog again. The
// backend itself is covered by the Python suite.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activate,
  COMMANDS,
  FRAMES_BUDGET_MS,
  METHODS,
  SAMPLE_FRAMES,
} from '../dist/index.js';

// The manifest is the declaration the host compares against; reading it here is
// what keeps `METHODS`/`COMMANDS` from drifting away from it.
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'),
);
const DECLARED = MANIFEST.felyrics.contributes;

function fakeContext(picked = null) {
  const methods = new Map();
  const commands = new Map();
  const calls = [];
  const picks = [];
  const ctx = {
    pluginId: 'felyrics.media',
    api: 1,
    method(name, handler) {
      methods.set(name, handler);
    },
    command(id, handler) {
      commands.set(id, handler);
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

  return { ctx, methods, commands, calls, picks };
}

test('activate registers exactly what the manifest declares', async () => {
  const { ctx, methods, commands } = fakeContext();

  await activate(ctx);

  assert.deepEqual([...METHODS].sort(), [...DECLARED.methods].sort());
  assert.deepEqual(
    [...COMMANDS].sort(),
    DECLARED.commands.map((command) => command.id).sort(),
  );
  assert.deepEqual([...methods.keys()].sort(), [...DECLARED.methods].sort());
  assert.deepEqual(
    [...commands.keys()].sort(),
    DECLARED.commands.map((command) => command.id).sort(),
  );
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

  await methods.get('decode')({ path: 'song.flac' });
  await methods.get('video-frames')({ path: 'clip.mp4', count: 2 });

  assert.deepEqual(
    calls.map(([name, , options]) => [name, options]),
    [
      ['decode', undefined],
      ['video-frames', { timeoutMs: FRAMES_BUDGET_MS }],
    ],
  );
});

test('pick-audio remembers the path and decode uses it', async () => {
  const { ctx, commands, calls, picks } = fakeContext('/music/song.flac');

  await activate(ctx);

  assert.equal(await commands.get('pick-audio')(), '/music/song.flac');
  assert.deepEqual(picks, ['audio']);

  await commands.get('decode-audio')();

  assert.deepEqual(calls.at(-1)?.[1], { path: '/music/song.flac' });
  assert.equal(calls.at(-1)?.[0], 'decode');
});

test('decode-audio before a pick is the declared bad request', async () => {
  const { ctx, commands, calls } = fakeContext();

  await activate(ctx);

  await assert.rejects(
    commands.get('decode-audio')(),
    (error) => {
      assert.equal(error.code, 'felyrics.media/bad-request');

      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('a cancelled pick keeps the file picked before it', async () => {
  let answer = '/music/first.flac';

  const { ctx, commands } = fakeContext(() => answer);

  await activate(ctx);

  await commands.get('pick-audio')();
  answer = null;
  assert.equal(await commands.get('pick-audio')(), null);

  await commands.get('decode-audio')();

  assert.deepEqual(
    (await commands.get('decode-audio')()).params,
    { path: '/music/first.flac' },
  );
});

test('frames-video uses the picked video and the sample count', async () => {
  const { ctx, commands, calls } = fakeContext('/clips/video.mp4');

  await activate(ctx);

  await commands.get('pick-video')();
  await commands.get('frames-video')();

  assert.deepEqual(calls.at(-1)?.[1], {
    path: '/clips/video.mp4',
    count: SAMPLE_FRAMES,
  });
  assert.deepEqual(calls.at(-1)?.[2], { timeoutMs: FRAMES_BUDGET_MS });
});

test('frames-video before a pick is the declared bad request', async () => {
  const { ctx, commands } = fakeContext();

  await activate(ctx);

  await assert.rejects(
    commands.get('frames-video')(),
    (error) => {
      assert.equal(error.code, 'felyrics.media/bad-request');

      return true;
    },
  );
});
