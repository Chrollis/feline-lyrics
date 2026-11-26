import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  oncePerId,
  planUserEnable,
  readPluginRequirements,
} from '../src/main/plugin-enable.ts';

function manifest(overrides) {
  return {
    id: 'someone.plugin',
    directory: 'somewhere',
    host: 'utility',
    python: undefined,
    ...overrides,
  };
}

test('a renderer plugin is refused with a readable code', () => {
  assert.throws(
    () => planUserEnable(manifest({ host: 'renderer' })),
    (error) =>
      error.code === 'core/not-ready' &&
      error.message.includes('renderer host is not available'),
  );
});

test('a utility plugin with a python face builds an environment', () => {
  assert.deepEqual(
    planUserEnable(
      manifest({ python: { module: 'fixtures', attribute: 'serve' } }),
    ),
    { provision: true },
  );
});

test('a utility plugin without a python face starts without a venv', () => {
  assert.deepEqual(planUserEnable(manifest({})), { provision: false });
});

test('a missing requirements file is a manifest error, not a crash', () => {
  const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });

  assert.throws(
    () => readPluginRequirements('someone.plugin', 'backend', () => {
      throw missing;
    }),
    (error) =>
      error.code === 'core/manifest-invalid' &&
      error.message.includes('backend/requirements.txt is missing'),
  );
});

test('another read error is passed through unchanged', () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });

  assert.throws(
    () => readPluginRequirements('someone.plugin', 'backend', () => {
      throw denied;
    }),
    (error) => error === denied,
  );
});

test('a requirements file is handed back as read', () => {
  assert.deepEqual(
    readPluginRequirements('someone.plugin', 'backend', () => ['numpy==2.5.5']),
    ['numpy==2.5.5'],
  );
});

test('concurrent enables share one run, and a later one runs again', async () => {
  const pending = new Map();
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = async () => {
    runs += 1;
    await gate;

    return runs;
  };

  const first = oncePerId(pending, 'someone.plugin', run);
  const second = oncePerId(pending, 'someone.plugin', run);

  assert.equal(first, second, 'the second call gets the in-flight promise');
  release();
  assert.equal(await first, 1);
  assert.equal(runs, 1);
  assert.equal(
    await oncePerId(pending, 'someone.plugin', async () => 2),
    2,
    'a settled id is free to run again',
  );
});

test('a failed run frees the id for the next attempt', async () => {
  const pending = new Map();

  await assert.rejects(
    oncePerId(pending, 'someone.plugin', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(
    await oncePerId(pending, 'someone.plugin', async () => 'retry'),
    'retry',
  );
});
