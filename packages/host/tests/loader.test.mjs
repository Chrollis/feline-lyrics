import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { discoverPlugins } from '../dist/index.js';

const BASE = {
  version: '0.1.0',
  author: 'Fixture Author',
  main: 'dist/index.js',
  felyrics: {
    api: 1,
    host: 'renderer',
    contributes: { methods: ['probe'] },
  },
};

const roots = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'felyrics-loader-'));
  roots.push(path);

  return path;
}

async function plugin(path, id, pkg = {}) {
  const [scope, name] = id.split('.');

  await mkdir(join(path, id), { recursive: true });
  await writeFile(
    join(path, id, 'package.json'),
    JSON.stringify({ name: `@${scope}/${name}`, ...BASE, ...pkg }),
  );
}

test('discovery reads one level of both roots and ignores the rest', async () => {
  const builtin = await root();
  const user = await root();

  await plugin(builtin, 'felyrics.media');
  await plugin(builtin, 'felyrics.echo');
  await plugin(user, 'someone.tool');
  await writeFile(join(builtin, 'loose-file.js'), '');

  const manifests = await discoverPlugins([builtin, user]);

  assert.deepEqual(
    manifests.map((manifest) => manifest.id).sort(),
    ['felyrics.echo', 'felyrics.media', 'someone.tool'],
  );
  assert.ok(manifests.every((manifest) => manifest.directory.startsWith(builtin) || manifest.directory.startsWith(user)));
});

test('a missing root contributes no plugins', async () => {  const builtin = await root();
  await plugin(builtin, 'felyrics.media');

  const manifests = await discoverPlugins([builtin, join(builtin, 'missing')]);

  assert.deepEqual(manifests.map((manifest) => manifest.id), ['felyrics.media']);
});

test('the same id in both roots is refused', async () => {
  const builtin = await root();
  const user = await root();

  await plugin(builtin, 'felyrics.media');
  await plugin(user, 'felyrics.media');

  await assert.rejects(discoverPlugins([builtin, user]), (error) => {
    assert.equal(error.code, 'core/duplicate-id');

    return true;
  });
});

test('a directory without a manifest is refused', async () => {
  const builtin = await root();
  await mkdir(join(builtin, 'felyrics.media'));

  await assert.rejects(discoverPlugins([builtin]), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');
    assert.equal(error.issues[0].path, 'package.json');

    return true;
  });
});

test('a bad manifest stops discovery with its own code', async () => {
  const builtin = await root();

  await plugin(builtin, 'felyrics.media', { felyrics: { api: 9 } });

  await assert.rejects(discoverPlugins([builtin]), (error) => {
    assert.equal(error.code, 'core/manifest-invalid');

    return true;
  });
});
