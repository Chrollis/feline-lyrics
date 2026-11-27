import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { clearTempDir, withTempDir } from '../../out/index.js';

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

test('keeps the directory alive while the callback still awaits', async () => {
  // `return fn(dir)` instead of `return await fn(dir)` runs the `finally` as
  // soon as the callback returns its promise, deleting the directory while the
  // callback is still writing into it. This is the only test that notices.
  await withTempDir('felyrics-temp-', async (dir) => {
    await new Promise((settle) => setTimeout(settle, 20));

    assert.equal(existsSync(dir), true);
  });
});

test('gives each call its own directory', async () => {
  const first = await withTempDir('felyrics-temp-', async (dir) => dir);
  const second = await withTempDir('felyrics-temp-', async (dir) => dir);

  assert.notEqual(first, second);
});

test('creates a missing root and removes only its own directory', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-root-'));
  const root = join(parent, 'scratch');
  let seen;

  try {
    await withTempDir(
      'felyrics-temp-',
      async (dir) => {
        seen = dir;
        assert.equal(existsSync(root), true);
        assert.equal(dirname(dir), root);
      },
      root,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  assert.equal(existsSync(seen), false);
  assert.equal(existsSync(root), false);
});

test('clears every entry and ignores a missing root', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-clear-'));
  const root = join(parent, 'scratch');

  try {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'note.txt'), 'x');
    writeFileSync(join(root, 'nested', 'child.txt'), 'y');

    await clearTempDir(root);
    assert.deepEqual(readdirSync(root), []);
    assert.equal(existsSync(join(parent, 'missing')), false);
    await clearTempDir(join(parent, 'missing'));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
