// The IPC edge is pure: the app's tests can assert the error mapping and the
// request validation without starting Electron. The handlers in `index.ts` are
// three lines around these functions.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BackendError } from '@felyrics/host';
import { ToolchainError } from '@felyrics/toolchain';

import {
  asResult,
  parsePluginCall,
  parsePluginCommand,
} from '../src/main/plugin-ipc.ts';

test('asResult hands back the value', async () => {
  assert.deepEqual(await asResult(async () => ({ pong: true })), {
    ok: true,
    value: { pong: true },
  });
});

test('asResult keeps a backend code', async () => {
  const answer = await asResult(async () => {
    throw new BackendError('core/not-ready', 'the hosts are not enabled');
  });

  assert.deepEqual(answer, {
    ok: false,
    code: 'core/not-ready',
    message: 'the hosts are not enabled',
  });
});

test('asResult forwards the data an error carried', async () => {
  const answer = await asResult(async () => {
    throw new BackendError('core/internal', 'replaced', {
      originalCode: 'fixtures.echo/boom',
    });
  });

  assert.deepEqual(answer, {
    ok: false,
    code: 'core/internal',
    message: 'replaced',
    data: { originalCode: 'fixtures.echo/boom' },
  });
});

test('asResult keeps a toolchain code', async () => {
  const answer = await asResult(async () => {
    throw new ToolchainError('uv/missing-binary', 'uv did not answer');
  });

  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'uv/missing-binary');
});

test('asResult turns an unknown failure into ipc/unexpected', async () => {
  const answer = await asResult(async () => {
    throw new Error('the renderer sent nonsense');
  });

  assert.deepEqual(answer, {
    ok: false,
    code: 'ipc/unexpected',
    message: 'the renderer sent nonsense',
  });
});

test('a request carries a name, params and an optional timeout', () => {
  assert.deepEqual(parsePluginCall({ name: 'felyrics.media/probe' }), {
    name: 'felyrics.media/probe',
    params: {},
  });
  assert.deepEqual(
    parsePluginCall({
      name: 'felyrics.media/probe',
      params: { path: 'song.flac' },
      timeoutMs: 5000,
    }),
    {
      name: 'felyrics.media/probe',
      params: { path: 'song.flac' },
      timeoutMs: 5000,
    },
  );
});

test('a malformed request is refused before the host sees it', () => {
  const bad = [
    null,
    'probe',
    {},
    { name: 3 },
    { name: 'probe', params: [] },
    { name: 'probe', params: 'path' },
    { name: 'probe', timeoutMs: 0 },
    { name: 'probe', timeoutMs: -1 },
    { name: 'probe', timeoutMs: Number.NaN },
  ];

  for (const value of bad) {
    assert.throws(
      () => parsePluginCall(value),
      (error) => error.code === 'protocol/bad-request',
      JSON.stringify(value),
    );
  }
});

test('a command carries only a name and an optional timeout', () => {
  assert.deepEqual(parsePluginCommand({ name: 'felyrics.media/pick-audio' }), {
    name: 'felyrics.media/pick-audio',
  });
  assert.deepEqual(
    parsePluginCommand({ name: 'felyrics.media/decode-audio', timeoutMs: 60_000 }),
    { name: 'felyrics.media/decode-audio', timeoutMs: 60_000 },
  );
});

test('a malformed command is refused', () => {
  for (const value of [null, {}, { name: 1 }, { name: 'x', timeoutMs: 0 }]) {
    assert.throws(
      () => parsePluginCommand(value),
      (error) => error.code === 'protocol/bad-request',
      JSON.stringify(value),
    );
  }
});
