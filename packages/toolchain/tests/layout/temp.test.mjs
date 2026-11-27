import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  clearTempDir,
  ToolchainError,
  withTempDir,
} from '../../out/index.js';

const MARKER = '.felyrics-temp';

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

test('creates a missing root with a marker and removes only its own directory', async () => {
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

    assert.equal(existsSync(seen), false);
    assert.deepEqual(readdirSync(root), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('adopts an empty explicit root with a marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-root-'));
  const root = join(parent, 'scratch');
  mkdirSync(root);

  try {
    await withTempDir('felyrics-temp-', async () => {}, root);
    assert.deepEqual(readdirSync(root), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('uses an explicit root that already carries the marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-root-'));
  const root = join(parent, 'scratch');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), '');

  try {
    await withTempDir('felyrics-temp-', async () => {}, root);
    assert.deepEqual(readdirSync(root), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('refuses a non-empty explicit root without a marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-root-'));
  const root = join(parent, 'scratch');
  mkdirSync(root);
  writeFileSync(join(root, 'keep.txt'), 'x');

  try {
    let called = false;

    await assert.rejects(
      withTempDir(
        'felyrics-temp-',
        async () => {
          called = true;
        },
        root,
      ),
      (error) => {
        assert.ok(error instanceof ToolchainError);
        assert.equal(error.code, 'temp/unowned');
        assert.equal(error.context.path, root);

        return true;
      },
    );
    assert.equal(called, false);
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'x');
    assert.deepEqual(readdirSync(root), ['keep.txt']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing a missing root is a no-op', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-clear-'));
  const missing = join(parent, 'missing');

  try {
    await clearTempDir(missing);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing an empty root adopts it with a marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-clear-'));
  const root = join(parent, 'scratch');
  mkdirSync(root);

  try {
    await clearTempDir(root);
    assert.deepEqual(readdirSync(root), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing an owned root removes entries and keeps the marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-clear-'));
  const root = join(parent, 'scratch');
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, MARKER), '');
  writeFileSync(join(root, 'note.txt'), 'x');
  writeFileSync(join(root, 'nested', 'child.txt'), 'y');

  try {
    await clearTempDir(root);
    assert.deepEqual(readdirSync(root), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing an unowned root rejects and deletes nothing', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-clear-'));
  const root = join(parent, 'scratch');
  mkdirSync(root);
  writeFileSync(join(root, 'keep.txt'), 'x');

  try {
    await assert.rejects(clearTempDir(root), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'temp/unowned');
      assert.equal(error.context.path, root);

      return true;
    });
    assert.deepEqual(readdirSync(root), ['keep.txt']);
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'x');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
