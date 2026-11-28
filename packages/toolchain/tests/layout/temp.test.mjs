import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  cleanTempResidue,
  clearLegacyTempEntries,
  clearStaleTempEntries,
  clearTempDir,
  ensureOwnedTempRoot,
  tempRoleRoot,
  ToolchainError,
  withTempDir,
} from '../../out/index.js';

const MARKER = '.felyrics-temp';
const PID_MARKER = '.felyrics-temp-pid';
const DEAD_PID = 99_999_999;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeScratch(root, name, { pid, ageMs } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  if (pid !== undefined) {
    writeFileSync(join(dir, PID_MARKER), String(pid));
  }

  if (ageMs !== undefined) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(dir, when, when);
  }

  return dir;
}

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

test('ensures a missing base root by adopting it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-ensure-'));
  const base = join(parent, 'temp');

  try {
    await ensureOwnedTempRoot(base);

    assert.equal(existsSync(join(base, MARKER)), true);
    assert.deepEqual(readdirSync(base), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('ensures an empty base root by adopting it', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-ensure-'));
  const base = join(parent, 'temp');

  try {
    mkdirSync(base);

    await ensureOwnedTempRoot(base);

    assert.equal(existsSync(join(base, MARKER)), true);
    assert.deepEqual(readdirSync(base), [MARKER]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('adopts a base whose only entries are marked role directories', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-ensure-'));
  const base = join(parent, 'temp');

  try {
    mkdirSync(join(base, 'app'), { recursive: true });
    mkdirSync(join(base, 'cli'), { recursive: true });
    writeFileSync(join(base, 'app', MARKER), '');
    writeFileSync(join(base, 'cli', MARKER), '');

    await ensureOwnedTempRoot(base);

    assert.deepEqual(readdirSync(base).sort(), [MARKER, 'app', 'cli']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('refuses an unmarked base with a role directory without its marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-ensure-'));
  const base = join(parent, 'temp');

  try {
    mkdirSync(join(base, 'app'), { recursive: true });

    await assert.rejects(ensureOwnedTempRoot(base), (error) => {
      assert.equal(error.code, 'temp/unowned');

      return true;
    });
    assert.equal(existsSync(join(base, MARKER)), false);
    assert.equal(existsSync(join(base, 'app')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('refuses an unmarked base with an unknown entry', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-ensure-'));
  const base = join(parent, 'temp');

  try {
    mkdirSync(base);
    writeFileSync(join(base, 'notes.txt'), 'keep');

    await assert.rejects(ensureOwnedTempRoot(base), (error) => {
      assert.equal(error.code, 'temp/unowned');

      return true;
    });
    assert.equal(existsSync(join(base, MARKER)), false);
    assert.equal(readFileSync(join(base, 'notes.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('leaves a marked base root untouched', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-ensure-'));
  const base = join(parent, 'temp');

  try {
    mkdirSync(base);
    writeFileSync(join(base, MARKER), '');
    writeFileSync(join(base, 'keep.txt'), 'keep');

    await ensureOwnedTempRoot(base);

    assert.equal(readFileSync(join(base, MARKER), 'utf8'), '');
    assert.equal(readFileSync(join(base, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
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

test('writes the owning pid beside a scratch directory', async () => {
  let seen;

  await withTempDir('felyrics-pid-', async (dir) => {
    seen = readFileSync(join(dir, PID_MARKER), 'utf8');
  });

  assert.equal(seen, String(process.pid));
});

test('keeps a scratch whose recorded pid is still alive, even when old', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), '');
  makeScratch(root, 'felyrics-live', { pid: process.pid, ageMs: 2 * DAY_MS });

  try {
    assert.deepEqual(await clearStaleTempEntries(root), []);
    assert.equal(existsSync(join(root, 'felyrics-live')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('removes a fresh scratch whose recorded pid is dead', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), '');
  makeScratch(root, 'felyrics-dead', { pid: DEAD_PID });

  try {
    assert.deepEqual(await clearStaleTempEntries(root), ['felyrics-dead']);
    assert.equal(existsSync(join(root, 'felyrics-dead')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('removes an old scratch without a pid marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), '');
  makeScratch(root, 'felyrics-old', { ageMs: 2 * DAY_MS });

  try {
    assert.deepEqual(await clearStaleTempEntries(root), ['felyrics-old']);
    assert.equal(existsSync(join(root, 'felyrics-old')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('keeps a fresh scratch without a pid marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, MARKER), '');
  makeScratch(root, 'felyrics-fresh');

  try {
    assert.deepEqual(await clearStaleTempEntries(root), []);
    assert.equal(existsSync(join(root, 'felyrics-fresh')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('leaves the marker, role directories and unknown entries alone', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const root = join(parent, 'temp');
  mkdirSync(join(root, 'app'), { recursive: true });
  mkdirSync(join(root, 'cli'), { recursive: true });
  writeFileSync(join(root, MARKER), '');
  writeFileSync(join(root, 'notes.txt'), 'keep');
  makeScratch(root, 'felyrics-old', { ageMs: 2 * DAY_MS });

  try {
    assert.deepEqual(await clearStaleTempEntries(root), ['felyrics-old']);
    assert.deepEqual(readdirSync(root).sort(), [
      MARKER,
      'app',
      'cli',
      'notes.txt',
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing stale entries under a missing root is a no-op', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const missing = join(parent, 'missing');

  try {
    assert.deepEqual(await clearStaleTempEntries(missing), []);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('clearing stale entries refuses a root without a marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-stale-'));
  const root = join(parent, 'temp');
  mkdirSync(root);
  writeFileSync(join(root, 'felyrics-old'), 'x');
  writeFileSync(join(root, 'keep.txt'), 'x');

  try {
    await assert.rejects(clearStaleTempEntries(root), (error) => {
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

test('cleanTempResidue reclaims cli stale scratch and legacy entries', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'felyrics-residue-'));
  const base = join(parent, 'temp');
  const cli = tempRoleRoot(base, 'cli');
  mkdirSync(base);
  writeFileSync(join(base, MARKER), '');
  mkdirSync(cli);
  writeFileSync(join(cli, MARKER), '');
  makeScratch(cli, 'felyrics-dead', { pid: DEAD_PID });
  makeScratch(cli, 'felyrics-old', { ageMs: 2 * DAY_MS });
  makeScratch(cli, 'provision-fresh');
  makeScratch(cli, 'felyrics-live', { pid: process.pid, ageMs: 2 * DAY_MS });
  mkdirSync(join(base, 'app'));
  writeFileSync(join(base, 'notes.txt'), 'keep');
  makeScratch(base, 'felyrics-legacy');

  try {
    const residue = await cleanTempResidue(base);

    assert.equal(residue.cliRoot, cli);
    assert.deepEqual(residue.cleaned, ['felyrics-dead', 'felyrics-old']);
    assert.deepEqual(residue.legacy, ['felyrics-legacy']);
    assert.deepEqual(readdirSync(cli).sort(), [
      MARKER,
      'felyrics-live',
      'provision-fresh',
    ]);
    assert.deepEqual(readdirSync(base).sort(), [
      MARKER,
      'app',
      'cli',
      'notes.txt',
    ]);
    assert.equal(existsSync(join(cli, 'felyrics-dead')), false);
    assert.equal(existsSync(join(cli, 'felyrics-old')), false);
    assert.equal(existsSync(join(base, 'felyrics-legacy')), false);
    assert.equal(existsSync(join(cli, 'felyrics-live')), true);
    assert.equal(existsSync(join(cli, 'provision-fresh')), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
