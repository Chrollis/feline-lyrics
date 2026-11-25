import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_MIRRORS,
  defaultUserDataDir,
  loadMirrorConfig,
  mirrorConfigPath,
  parseMirrorConfig,
  resolveMirrorConfig,
  ToolchainError,
} from '../out/index.js';

function rejects(json, pathPart) {
  let error;

  try {
    parseMirrorConfig(json);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof ToolchainError);
  assert.equal(error.code, 'mirrors/invalid');
  assert.equal(error.context.path, pathPart);
}

test('the built-in sources are the official ones', () => {
  const resolved = resolveMirrorConfig({});

  assert.deepEqual(resolved, DEFAULT_MIRRORS);
  assert.ok(resolved.uv[0].includes('github.com/astral-sh/uv/releases/latest'));
  assert.ok(resolved.python[0].includes('python-build-standalone/releases/download'));
  assert.equal(resolved.pythonRelease, 'latest');
});

test('a category replaces only itself', () => {
  const resolved = resolveMirrorConfig({
    sources: { python: ['https://mirror.example/python/{tag}/{asset}'] },
  });

  assert.deepEqual(resolved.python, ['https://mirror.example/python/{tag}/{asset}']);
  assert.deepEqual(resolved.uv, DEFAULT_MIRRORS.uv);
  assert.deepEqual(resolved.packages, DEFAULT_MIRRORS.packages);
});

test('reads every category and the release policy', () => {
  const config = parseMirrorConfig(
    JSON.stringify({
      sources: {
        uv: ['https://mirror.example/uv/{asset}'],
        python: ['https://mirror.example/python/{tag}/{asset}'],
        packages: ['https://pypi.example/simple'],
      },
      release: { python: '20261124' },
    }),
  );

  assert.deepEqual(resolveMirrorConfig(config), {
    uv: ['https://mirror.example/uv/{asset}'],
    python: ['https://mirror.example/python/{tag}/{asset}'],
    packages: ['https://pypi.example/simple'],
    pythonRelease: '20261124',
  });
});

test('refuses an unknown top-level key', () => {
  rejects('{"mirrors":{}}', 'mirrors.json.mirrors');
});

test('refuses an unknown source category', () => {
  rejects('{"sources":{"npm":["https://registry.example"]}}', 'sources.npm');
});

test('refuses a uv template without {asset}', () => {
  rejects('{"sources":{"uv":["https://mirror.example/uv/zip"]}}', 'sources.uv[0]');
});

test('refuses a python template without {tag}', () => {
  rejects(
    '{"sources":{"python":["https://mirror.example/{asset}"]}}',
    'sources.python[0]',
  );
});

test('refuses a package index with a placeholder', () => {
  rejects(
    '{"sources":{"packages":["https://pypi.example/{tag}/simple"]}}',
    'sources.packages[0]',
  );
});

test('refuses a non-http source', () => {
  rejects('{"sources":{"uv":["ftp://mirror.example/{asset}"]}}', 'sources.uv[0]');
});

test('refuses an empty source list', () => {
  rejects('{"sources":{"uv":[]}}', 'sources.uv');
});

test('refuses a release value that is neither latest nor a tag', () => {
  rejects('{"release":{"python":"3.12"}}', 'release.python');
});

test('refuses malformed json', () => {
  rejects('{"sources":', 'mirrors.json');
});

test('a missing file means the built-in sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-mirrors-'));

  try {
    assert.deepEqual(await loadMirrorConfig(join(root, 'mirrors.json')), DEFAULT_MIRRORS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loads a file from disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-mirrors-'));
  const path = join(root, 'mirrors.json');

  try {
    writeFileSync(path, '{"sources":{"uv":["https://mirror.example/{asset}"]}}');

    const resolved = await loadMirrorConfig(path);

    assert.deepEqual(resolved.uv, ['https://mirror.example/{asset}']);
    assert.equal(resolved.pythonRelease, 'latest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('places the file under the platform user data directory', () => {
  assert.equal(
    defaultUserDataDir('Felyrics', 'win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }),
    'C:\\Users\\me\\AppData\\Roaming\\Felyrics',
  );
  assert.equal(
    defaultUserDataDir('Felyrics', 'linux', { XDG_CONFIG_HOME: '/home/me/.config' }),
    join('/home/me/.config', 'Felyrics'),
  );
  assert.ok(
    defaultUserDataDir('Felyrics', 'darwin').endsWith(
      join('Library', 'Application Support', 'Felyrics'),
    ),
  );

  assert.equal(
    mirrorConfigPath('C:\\Users\\me\\AppData\\Roaming\\Felyrics'),
    'C:\\Users\\me\\AppData\\Roaming\\Felyrics\\mirrors.json',
  );
});
