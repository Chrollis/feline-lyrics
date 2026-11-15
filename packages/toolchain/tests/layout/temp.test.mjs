import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { withTempDir } from '../../out/index.js';

test('hands over a directory and removes it afterwards', async () => {
  let seen;

  const result = await withTempDir('felyrics-temp-', async (dir) => {
    seen = dir;
    assert.equal(existsSync(dir), true);

    return 'value';
  });

  assert.equal(result, 'value');
  assert.equal(existsSync(seen), false);
});

test('removes the directory when the callback throws', async () => {
  let seen;

  await assert.rejects(
    withTempDir('felyrics-temp-', async (dir) => {
      seen = dir;
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(existsSync(seen), false);
});

test('gives each call its own directory', async () => {
  const first = await withTempDir('felyrics-temp-', async (dir) => dir);
  const second = await withTempDir('felyrics-temp-', async (dir) => dir);

  assert.notEqual(first, second);
});
