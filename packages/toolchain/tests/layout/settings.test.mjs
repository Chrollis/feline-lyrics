import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertWritableRoots,
  defaultSettings,
  loadSettings,
  resolveSettingsPath,
  ToolchainError,
} from '../../out/index.js';

const repoRoot = resolve('repo');
const userData = resolve('user-data');

async function loadText(text) {
  const directory = await mkdtemp(join(tmpdir(), 'felyrics-settings-'));

  try {
    const file = join(directory, 'settings.json');
    await writeFile(file, text, 'utf8');

    return await loadSettings(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rejects(text, expectedPath) {
  await assert.rejects(loadText(text), (error) => {
    assert.ok(error instanceof ToolchainError);
    assert.equal(error.code, 'settings/invalid');
    assert.equal(error.context.path, expectedPath);

    return true;
  });
}

test('development defaults hang off the checkout', () => {
  assert.deepEqual(defaultSettings({ packaged: false, userData, repoRoot }), {
    backendRoot: join(repoRoot, 'python'),
    cacheDir: join(repoRoot, 'cache'),
    tempDir: join(repoRoot, '.temp'),
    userPluginsRoot: join(userData, 'plugins'),
  });
});

test('packaged defaults keep everything under userData', () => {
  assert.deepEqual(defaultSettings({ packaged: true, userData, repoRoot }), {
    backendRoot: join(userData, 'backend'),
    cacheDir: join(userData, 'cache'),
    tempDir: join(userData, 'temp'),
    userPluginsRoot: join(userData, 'plugins'),
  });
});

test('the settings file follows the build kind', () => {
  assert.equal(
    resolveSettingsPath({ packaged: false, userData, repoRoot }),
    join(repoRoot, 'settings.json'),
  );
  assert.equal(
    resolveSettingsPath({ packaged: true, userData, repoRoot }),
    join(userData, 'settings.json'),
  );
});

test('a missing file means all defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'felyrics-settings-'));

  try {
    assert.deepEqual(await loadSettings(join(directory, 'settings.json')), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts a UTF-8 BOM before the JSON', async () => {
  const cacheDir = resolve('bom-cache');

  assert.deepEqual(await loadText(`\uFEFF${JSON.stringify({ cacheDir })}`), {
    cacheDir,
  });
});

test('reads the four writable roots', async () => {
  const settings = {
    backendRoot: resolve('custom-backend'),
    cacheDir: resolve('custom-cache'),
    tempDir: resolve('custom-temp'),
    userPluginsRoot: resolve('custom-plugins'),
  };

  assert.deepEqual(await loadText(JSON.stringify(settings)), settings);
});

test('refuses an unknown key', async () => {
  await rejects('{"cache-root":"C:\\\\cache"}', 'settings.json.cache-root');
});

test('refuses a relative path', async () => {
  await rejects('{"cacheDir":"cache"}', 'settings.json.cacheDir');
});

test('refuses a filesystem root for every writable setting', async () => {
  const value = process.platform === 'win32' ? 'C:\\' : '/';

  for (const key of [
    'backendRoot',
    'cacheDir',
    'tempDir',
    'userPluginsRoot',
  ]) {
    await rejects(JSON.stringify({ [key]: value }), `settings.json.${key}`);
  }
});

test(
  'refuses Windows roots and root-relative paths',
  { skip: process.platform !== 'win32' },
  async () => {
    for (const value of [
      'C:\\',
      'C:/',
      '\\',
      '\\foo',
      '/foo',
      '\\\\',
      '\\\\server\\share',
    ]) {
      await rejects(JSON.stringify({ tempDir: value }), 'settings.json.tempDir');
    }
  },
);

test(
  'accepts normal absolute paths on Windows',
  { skip: process.platform !== 'win32' },
  async () => {
    const settings = {
      backendRoot: 'C:\\Users\\x\\backend',
      cacheDir: 'C:\\Users\\x\\cache',
      tempDir: '\\\\server\\share\\dir',
      userPluginsRoot: 'C:\\Users\\x\\plugins',
    };

    assert.deepEqual(await loadText(JSON.stringify(settings)), settings);
  },
);

test(
  'accepts normal absolute paths on POSIX',
  { skip: process.platform === 'win32' },
  async () => {
    const settings = {
      backendRoot: '/tmp/x/backend',
      cacheDir: '/tmp/x/cache',
      tempDir: '/tmp/x/temp',
      userPluginsRoot: '/tmp/x/plugins',
    };

    assert.deepEqual(await loadText(JSON.stringify(settings)), settings);
  },
);

test(
  'refuses the POSIX filesystem root',
  { skip: process.platform === 'win32' },
  async () => {
    for (const value of ['/', '//']) {
      await rejects(JSON.stringify({ tempDir: value }), 'settings.json.tempDir');
    }
  },
);

test('refuses an empty path', async () => {
  await rejects('{"tempDir":""}', 'settings.json.tempDir');
});

test('refuses a non-string value', async () => {
  await rejects('{"backendRoot":4}', 'settings.json.backendRoot');
});

test('refuses malformed JSON', async () => {
  await rejects('{"cacheDir":', 'settings.json');
});

test('refuses a file that is not a JSON object', async () => {
  await rejects('[]', 'settings.json');
});

const writableRoot = resolve('writable-roots');
const settingsFile = join(writableRoot, 'settings.json');
const settingsUserData = join(writableRoot, 'user-data');

function mergedSettings(overrides = {}) {
  return {
    backendRoot: join(writableRoot, 'backend'),
    cacheDir: join(writableRoot, 'cache'),
    tempDir: join(writableRoot, 'temp'),
    userPluginsRoot: join(writableRoot, 'plugins'),
    ...overrides,
  };
}

function rejectsWritable(merged) {
  assert.throws(
    () => assertWritableRoots(merged, settingsFile, settingsUserData),
    (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'settings/invalid');
      assert.equal(error.context.path, 'settings.json.tempDir');

      return true;
    },
  );
}

test('accepts the development defaults', () => {
  const repoRoot = resolve('default-repo');
  const userData = resolve('default-user-data');

  assert.doesNotThrow(() =>
    assertWritableRoots(
      defaultSettings({ packaged: false, userData, repoRoot }),
      join(repoRoot, 'settings.json'),
      userData,
    ),
  );
});

test('accepts the packaged defaults', () => {
  const repoRoot = resolve('default-repo');
  const userData = resolve('default-user-data');

  assert.doesNotThrow(() =>
    assertWritableRoots(
      defaultSettings({ packaged: true, userData, repoRoot }),
      join(userData, 'settings.json'),
      userData,
    ),
  );
});

test('accepts a temp directory inside userData', () => {
  assert.doesNotThrow(() =>
    assertWritableRoots(
      mergedSettings({ tempDir: join(settingsUserData, 'scratch') }),
      settingsFile,
      settingsUserData,
    ),
  );
});

test('accepts a temp directory inside the repository', () => {
  const repoRoot = resolve('inside-repo');
  const merged = mergedSettings({
    backendRoot: join(repoRoot, 'python'),
    cacheDir: join(repoRoot, 'cache'),
    tempDir: join(repoRoot, '.temp'),
  });

  assert.doesNotThrow(() =>
    assertWritableRoots(
      merged,
      join(repoRoot, 'settings.json'),
      resolve('outside-user-data'),
    ),
  );
});

test('does not confuse a sibling with a prefix match', () => {
  assert.doesNotThrow(() =>
    assertWritableRoots(
      mergedSettings({ cacheDir: join(writableRoot, 'tempest') }),
      settingsFile,
      settingsUserData,
    ),
  );
});

test('refuses a temp directory equal to cacheDir', () => {
  rejectsWritable(
    mergedSettings({ cacheDir: join(writableRoot, 'temp') }),
  );
});

test('refuses a temp directory that contains backendRoot', () => {
  rejectsWritable(mergedSettings({ tempDir: writableRoot }));
});

test('refuses a temp directory equal to the settings file', () => {
  rejectsWritable(mergedSettings({ tempDir: settingsFile }));
});

test('refuses a temp directory equal to userData', () => {
  rejectsWritable(mergedSettings({ tempDir: settingsUserData }));
});

test(
  'folds case on Windows',
  { skip: process.platform !== 'win32' },
  () => {
    const base = resolve('case-roots');

    rejectsWritable({
      backendRoot: join(base, 'backend'),
      cacheDir: join(base, 'CACHE'),
      tempDir: join(base, 'cache'),
      userPluginsRoot: join(base, 'plugins'),
    });
  },
);
