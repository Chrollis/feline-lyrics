// Environment planning is the one piece of startup that is pure: it reads the
// plugin roots and says what to install. The Electron window and uv itself are
// covered by their own suites.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { planEnvironment } from '../src/main/environment.ts';

async function plugin(root, id, requirements, { python = true } = {}) {
  const directory = join(root, id);
  await mkdir(join(directory, 'backend'), { recursive: true });

  const manifest = {
    name: id.split('.')[1],
    publisher: id.split('.')[0],
    version: '1.0.0',
    author: 'tester',
    main: 'dist/index.js',
    felyrics: {
      api: 1,
      host: 'utility',
      contributes: {
        methods: ['echo'],
        ...(python ? { internal: ['echo'] } : {}),
      },
      ...(python
        ? {
            backend: { python: `${id.split('.')[1]}_backend:serve` },
            engines: { python: '>=3.12' },
          }
        : {}),
    },
  };

  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify(manifest),
    'utf8',
  );

  if (requirements !== null) {
    await mkdir(join(directory, 'backend'), { recursive: true });
    await writeFile(
      join(directory, 'backend', 'requirements.txt'),
      requirements,
      'utf8',
    );
  }

  return directory;
}

async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('the host backend comes first, then every python plugin', async (t) => {
  const root = await withRoot(t);
  await plugin(root, 'fixtures.alpha', 'av==19.0.2\n');
  await plugin(root, 'fixtures.beta', 'numpy==2.5.5\nav==19.0.2\n');
  await plugin(root, 'fixtures.ts-only', null, { python: false });

  const hostBackend = join(root, 'host-backend');
  const environment = await planEnvironment(hostBackend, root);

  assert.deepEqual(environment.importPaths, [
    hostBackend,
    join(root, 'fixtures.alpha', 'backend'),
    join(root, 'fixtures.beta', 'backend'),
  ]);
  assert.deepEqual(environment.requirements, ['av==19.0.2', 'numpy==2.5.5']);
  assert.deepEqual(
    environment.plugins.map((spec) => [spec.id, spec.python]),
    [
      ['fixtures.alpha', 'alpha_backend:serve'],
      ['fixtures.beta', 'beta_backend:serve'],
    ],
  );
});

test('a python plugin without requirements is refused', async (t) => {
  const root = await withRoot(t);
  await plugin(root, 'fixtures.broken', null);

  await assert.rejects(planEnvironment('/host/backend', root), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.match(error.message, /requirements\.txt/);

    return true;
  });
});
