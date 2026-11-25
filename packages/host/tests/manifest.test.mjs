import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadManifest, ManifestError } from '../dist/index.js';

const BASE = {
  name: '@felyrics/echo',
  version: '0.1.0',
  author: 'Fixture Author',
  main: 'dist/index.js',
  felyrics: {
    api: 1,
    host: 'renderer',
    backend: { python: 'echo_plugin:serve' },
    engines: { python: '>=3.10' },
    contributes: { methods: ['probe'], internal: ['probe'] },
  },
};

const roots = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(pkg, directory = 'felyrics.echo') {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-manifest-'));
  roots.push(root);

  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify(pkg));

  return path;
}

function copy(value) {
  return structuredClone(value);
}

async function expectError(code, pkg, directory) {
  const path = await fixture(pkg, directory);

  await assert.rejects(loadManifest(path), (error) => {
    assert.ok(error instanceof ManifestError);
    assert.equal(error.code, code);

    return true;
  });
}

test('a scoped name derives the id and every declared field', async () => {
  const manifest = await loadManifest(await fixture(copy(BASE)));

  assert.equal(manifest.id, 'felyrics.echo');
  assert.equal(manifest.api, 1);
  assert.equal(manifest.host, 'renderer');
  assert.deepEqual(manifest.python, {
    module: 'echo_plugin',
    attribute: 'serve',
  });
  assert.equal(manifest.enginesPython, '>=3.10');
  assert.deepEqual(manifest.methods, ['probe']);
  assert.deepEqual(manifest.internal, ['probe']);
  assert.equal(manifest.name, '@felyrics/echo');
});

test('a plain name with publisher derives the same shape of id', async () => {
  const pkg = copy(BASE);
  pkg.name = 'echo';
  pkg.publisher = 'felyrics';

  const manifest = await loadManifest(await fixture(pkg));

  assert.equal(manifest.id, 'felyrics.echo');
});

test('a plain name without publisher is refused', async () => {
  const pkg = copy(BASE);
  pkg.name = 'echo';

  await expectError('core/manifest-invalid', pkg);
});

test('a scoped name must not declare publisher', async () => {
  const pkg = copy(BASE);
  pkg.publisher = 'felyrics';

  const path = await fixture(pkg);

  await assert.rejects(loadManifest(path), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.ok(
      error.issues.some((entry) => entry.path === 'publisher'),
    );

    return true;
  });
});

test('the directory name is the id', async () => {
  await expectError('core/identity-mismatch', copy(BASE), 'felyrics.other');
});

test('unknown keys inside felyrics are refused', async () => {
  const pkg = copy(BASE);
  pkg.felyrics.magic = true;

  const path = await fixture(pkg);

  await assert.rejects(loadManifest(path), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.deepEqual(
      error.issues.map((entry) => entry.path),
      ['felyrics.magic'],
    );

    return true;
  });
});

test('exec is not a backend', async () => {
  const pkg = copy(BASE);
  pkg.felyrics.backend.exec = 'backend/bin/run';

  const path = await fixture(pkg);

  await assert.rejects(loadManifest(path), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.ok(
      error.issues.some((entry) => entry.path === 'felyrics.backend.exec'),
    );

    return true;
  });
});

test('a python backend requires engines', async () => {
  const pkg = copy(BASE);
  delete pkg.felyrics.engines;

  await expectError('core/manifest-invalid', pkg);
});

test('engines without a backend are refused', async () => {
  const pkg = copy(BASE);
  delete pkg.felyrics.backend;
  delete pkg.felyrics.contributes.internal;

  await expectError('core/manifest-invalid', pkg);
});

test('an unsupported api is reported', async () => {
  const pkg = copy(BASE);
  pkg.felyrics.api = 2;

  await expectError('core/api-unsupported', pkg);
});

test('a python the plugin cannot run on is reported', async () => {
  const pkg = copy(BASE);
  pkg.felyrics.engines.python = '>=99.0';

  const path = await fixture(pkg);

  await assert.rejects(
    loadManifest(path, { pythonVersion: '3.12' }),
    (error) => {
      assert.equal(error.code, 'core/engine-unsatisfied');

      return true;
    },
  );
});

test('the engine is not checked when no version is supplied', async () => {
  const pkg = copy(BASE);
  pkg.felyrics.engines.python = '>=99.0';

  const manifest = await loadManifest(await fixture(pkg));

  assert.equal(manifest.enginesPython, '>=99.0');
});

test('version and main are validated together', async () => {
  const pkg = copy(BASE);
  pkg.version = '1.0';
  pkg.main = '../escape.js';

  const path = await fixture(pkg);

  await assert.rejects(loadManifest(path), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.deepEqual(
      error.issues.map((entry) => entry.path).sort(),
      ['main', 'version'],
    );

    return true;
  });
});

test('a broken package.json is manifest-invalid', async () => {
  const path = await fixture(copy(BASE));
  await writeFile(join(path, 'package.json'), '{not json');

  await assert.rejects(loadManifest(path), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.equal(error.issues[0].path, 'package.json');

    return true;
  });
});
