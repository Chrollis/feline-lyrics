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

  const { plugins, issues } = await discoverPlugins([
    { path: builtin, kind: 'builtin' },
    { path: user, kind: 'user' },
  ]);

  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.id).sort(),
    ['felyrics.echo', 'felyrics.media', 'someone.tool'],
  );
  assert.deepEqual(issues, []);
  assert.equal(
    plugins.find((plugin) => plugin.manifest.id === 'someone.tool')?.root,
    'user',
  );
});

test('a missing root contributes no plugins', async () => {
  const builtin = await root();
  await plugin(builtin, 'felyrics.media');

  const { plugins } = await discoverPlugins([
    { path: builtin, kind: 'builtin' },
    { path: join(builtin, 'missing'), kind: 'user' },
  ]);

  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.id),
    ['felyrics.media'],
  );
});

test('the builtin copy wins over a user copy of the same id', async () => {
  const builtin = await root();
  const user = await root();

  await plugin(builtin, 'felyrics.media');
  await plugin(user, 'felyrics.media');

  const { plugins, issues } = await discoverPlugins([
    { path: builtin, kind: 'builtin' },
    { path: user, kind: 'user' },
  ]);

  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.id),
    ['felyrics.media'],
  );
  assert.equal(plugins[0].root, 'builtin');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'core/duplicate-id');
  assert.equal(issues[0].root, 'user');
});

test('a broken user manifest becomes an issue, not a failed discovery', async () => {
  const builtin = await root();
  const user = await root();

  await plugin(builtin, 'felyrics.media');
  await mkdir(join(user, 'someone.broken'));

  const { plugins, issues } = await discoverPlugins([
    { path: builtin, kind: 'builtin' },
    { path: user, kind: 'user' },
  ]);

  assert.deepEqual(
    plugins.map((plugin) => plugin.manifest.id),
    ['felyrics.media'],
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'core/manifest-invalid');
  assert.equal(issues[0].root, 'user');
  assert.equal(issues[0].issues[0].path, 'package.json');
});

test('a bad builtin manifest is an issue too, with its own code', async () => {
  const builtin = await root();

  await plugin(builtin, 'felyrics.media', { felyrics: { api: 9 } });

  const { plugins, issues } = await discoverPlugins([
    { path: builtin, kind: 'builtin' },
  ]);

  assert.deepEqual(plugins, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'core/manifest-invalid');
  assert.equal(issues[0].root, 'builtin');
});
