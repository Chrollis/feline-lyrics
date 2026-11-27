import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
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
