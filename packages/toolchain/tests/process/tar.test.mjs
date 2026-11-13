import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ToolchainError, findTar, requireTar } from '../../out/index.js';

function fakeSpawn(available) {
  const calls = [];

  const spawn = (command, args) => {
    calls.push([command, ...args]);

    return {
      status: available.includes(command) ? 0 : 1,
      stdout: '',
      stderr: '',
    };
  };

  return { spawn, calls };
}

test('returns the first candidate that reports a version', () => {
  const { spawn, calls } = fakeSpawn(['tar']);

  assert.equal(findTar(spawn), 'tar');
  assert.deepEqual(calls, [['tar', '--version']]);
});

test('tries every candidate before giving up', () => {
  const { spawn, calls } = fakeSpawn([]);

  assert.equal(findTar(spawn), null);
  assert.ok(calls.length >= 1);
});

test('requireTar explains what is missing', () => {
  const { spawn } = fakeSpawn([]);

  assert.throws(
    () => requireTar(spawn),
    (error) =>
      error instanceof ToolchainError && error.code === 'tar/not-found',
  );
});
