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
  clearLegacyTempEntries,
  clearTempDir,
  tempRoleRoot,
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

test('names a role directory under the temp base', () => {
  const base = join(tmpdir(), 'felyrics-base');

  assert.equal(tempRoleRoot(base, 'app'), join(base, 'app'));
  assert.equal(tempRoleRoot(base, 'cli'), join(base, 'cli'));
});

test('clearing the app role leaves the cli role untouched', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-roles-'));
  const base = join(parent, 'temp');
  const appRoot = tempRoleRoot(base, 'app');
  const cliRoot = tempRoleRoot(base, 'cli');

  try {
    await withTempDir(
      'app-',
      async (dir) => {
        writeFileSync(join(dir, 'scratch.txt'), 'x');
      },
      appRoot,
    );
    await withTempDir(
      'cli-',
      async (dir) => {
        writeFileSync(join(dir, 'scratch.txt'), 'y');
      },
      cliRoot,
    );
    writeFileSync(join(cliRoot, 'keep.txt'), 'y');

    await clearTempDir(appRoot);

    assert.equal(readFileSync(join(cliRoot, 'keep.txt'), 'utf8'), 'y');
    assert.equal(existsSync(join(appRoot, MARKER)), true);
    assert.equal(existsSync(join(cliRoot, MARKER)), true);
    assert.deepEqual(readdirSync(appRoot), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clears only legacy temp entries and keeps roles, marker and unknown entries', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-legacy-'));
  const root = join(parent, 'temp');
  mkdirSync(join(root, 'felyrics-old', 'nested'), { recursive: true });
  mkdirSync(join(root, 'provision-old'), { recursive: true });
  mkdirSync(join(root, 'plugin-env-old'), { recursive: true });
  mkdirSync(join(root, 'app'), { recursive: true });
  mkdirSync(join(root, 'cli'), { recursive: true });
  writeFileSync(join(root, MARKER), '');
  writeFileSync(join(root, 'notes.txt'), 'keep');
  writeFileSync(join(root, 'felyrics-old', 'nested', 'file.txt'), 'x');
  writeFileSync(join(root, 'provision-old', 'file.txt'), 'x');
  writeFileSync(join(root, 'plugin-env-old', 'file.txt'), 'x');
  writeFileSync(join(root, 'app', 'keep.txt'), 'app');
  writeFileSync(join(root, 'cli', 'keep.txt'), 'cli');

  try {
    const removed = await clearLegacyTempEntries(root);

    assert.deepEqual(removed, [
      'felyrics-old',
      'plugin-env-old',
      'provision-old',
    ]);
    assert.deepEqual(readdirSync(root).sort(), [
      MARKER,
      'app',
      'cli',
      'notes.txt',
    ]);
    assert.equal(readFileSync(join(root, 'app', 'keep.txt'), 'utf8'), 'app');
    assert.equal(readFileSync(join(root, 'cli', 'keep.txt'), 'utf8'), 'cli');
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing legacy entries under a missing root is a no-op', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-legacy-'));
  const missing = join(parent, 'missing');

  try {
    assert.deepEqual(await clearLegacyTempEntries(missing), []);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing legacy entries under an empty root leaves it empty', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-legacy-'));
  const root = join(parent, 'temp');
  mkdirSync(root);

  try {
    assert.deepEqual(await clearLegacyTempEntries(root), []);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing legacy entries refuses a root without a marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-legacy-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, 'felyrics-old'), 'x');
  writeFileSync(join(root, 'keep.txt'), 'x');

  try {
    await assert.rejects(clearLegacyTempEntries(root), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'temp/unowned');
      assert.equal(error.context.path, root);

      return true;
    });
    assert.deepEqual(readdirSync(root).sort(), ['felyrics-old', 'keep.txt']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('returns the removed legacy entries sorted by name', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-legacy-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), '');
  writeFileSync(join(root, 'provision-z'), 'x');
  writeFileSync(join(root, 'felyrics-b'), 'x');
  writeFileSync(join(root, 'plugin-env-a'), 'x');
  writeFileSync(join(root, 'felyrics-a'), 'x');

  try {
    assert.deepEqual(await clearLegacyTempEntries(root), [
      'felyrics-a',
      'felyrics-b',
      'plugin-env-a',
      'provision-z',
    ]);
    assert.deepEqual(readdirSync(root), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
