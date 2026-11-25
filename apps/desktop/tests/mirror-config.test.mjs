import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mirrorConfigPath } from '@felyrics/toolchain';

import { loadOrCreateMirrorConfig } from '../src/main/mirror-config.ts';

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-mirrors-'));

  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('writes the built-in document on the first run', async () => {
  await withRoot(async (root) => {
    const mirrors = await loadOrCreateMirrorConfig(root);

    assert.deepEqual(mirrors.packages, ['https://pypi.org/simple']);
    assert.match(mirrors.uv[0], /astral-sh\/uv/);

    const text = readFileSync(mirrorConfigPath(root), 'utf8');

    assert.match(text, /"sources"/);
    assert.match(text, /"python"/);
  });
});

test('reads an edited configuration', async () => {
  await withRoot(async (root) => {
    await loadOrCreateMirrorConfig(root);

    const path = mirrorConfigPath(root);
    const config = JSON.parse(readFileSync(path, 'utf8'));

    config.sources.packages = ['https://mirror.example/simple'];
    writeFileSync(path, JSON.stringify(config), 'utf8');

    const mirrors = await loadOrCreateMirrorConfig(root);

    assert.deepEqual(mirrors.packages, ['https://mirror.example/simple']);
  });
});

test('reads a configuration saved with a BOM', async () => {
  await withRoot(async (root) => {
    await loadOrCreateMirrorConfig(root);

    const path = mirrorConfigPath(root);
    const config = JSON.parse(readFileSync(path, 'utf8'));

    config.sources.packages = ['https://mirror.example/simple'];
    writeFileSync(path, `\uFEFF${JSON.stringify(config)}`, 'utf8');

    const mirrors = await loadOrCreateMirrorConfig(root);

    assert.deepEqual(mirrors.packages, ['https://mirror.example/simple']);
  });
});

test('rejects a configuration that is not valid JSON', async () => {
  await withRoot(async (root) => {
    await loadOrCreateMirrorConfig(root);

    writeFileSync(mirrorConfigPath(root), '{', 'utf8');

    await assert.rejects(
      loadOrCreateMirrorConfig(root),
      (error) => error.code === 'mirrors/invalid',
    );
  });
});
