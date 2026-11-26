import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planUserEnable } from '../src/main/plugin-enable.ts';

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
