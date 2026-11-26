import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { installPluginDirectory } from '../src/main/plugin-install.ts';

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-install-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function packageAt(root, name) {
  const directory = join(root, name);

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@someone/echo',
      version: '1.0.0',
      author: 'someone',
      main: 'index.js',
      felyrics: {
        api: 1,
        host: 'utility',
        contributes: { methods: ['echo'] },
      },
    }),
  );
  await writeFile(join(directory, 'index.js'), 'export {}\n');

  return directory;
}

test('copies the package under its id and returns the manifest', async (t) => {
  const root = await scratch(t);
  const source = await packageAt(join(root, 'source'), 'someone.echo');
  const target = join(root, 'plugins');

  const manifest = await installPluginDirectory(source, target);

  assert.equal(manifest.id, 'someone.echo');
  assert.equal(manifest.directory, join(target, 'someone.echo'));
  assert.match(
    await readFile(join(target, 'someone.echo', 'package.json'), 'utf8'),
    /@someone\/echo/,
  );
});

test('refuses to overwrite an installed plugin', async (t) => {
  const root = await scratch(t);
  const source = await packageAt(join(root, 'source'), 'someone.echo');
  const target = join(root, 'plugins');

  await mkdir(join(target, 'someone.echo'), { recursive: true });

  await assert.rejects(
    () => installPluginDirectory(source, target),
    (error) =>
      error.code === 'core/backend-failed' &&
      /already installed/.test(error.message),
  );
});

test('a broken package is refused before anything is copied', async (t) => {
  const root = await scratch(t);
  const source = join(root, 'source', 'someone.broken');

  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'package.json'), '{"name":"@someone/broken"}');

  await assert.rejects(
    () => installPluginDirectory(source, join(root, 'plugins')),
    (error) => error.code === 'core/manifest-invalid',
  );
  await assert.rejects(
    () => readFile(join(root, 'plugins', 'someone.broken', 'package.json')),
  );
});

test('an id that is already loaded is refused before it is copied', async (t) => {
  const root = await scratch(t);
  const source = await packageAt(join(root, 'source'), 'someone.echo');
  const target = join(root, 'plugins');

  await assert.rejects(
    () =>
      installPluginDirectory(source, target, {
        knownIds: new Set(['someone.echo']),
      }),
    (error) => error.code === 'core/duplicate-id',
  );
  await assert.rejects(() => readFile(join(target, 'someone.echo', 'package.json'))); 
});

test('a copy that fails leaves no half-installed directory', async (t) => {
  const root = await scratch(t);
  const source = await packageAt(join(root, 'source'), 'someone.echo');
  const target = join(root, 'plugins');

  await assert.rejects(
    () =>
      installPluginDirectory(source, target, {
        copy: async (from, to) => {
          await mkdir(to, { recursive: true });
          await writeFile(join(to, 'half.txt'), 'half');
          throw new Error('disk full');
        },
      }),
    /disk full/,
  );

  await assert.rejects(() => readFile(join(target, 'someone.echo', 'half.txt')));
  assert.deepEqual(await readdir(target), []);

  const manifest = await installPluginDirectory(source, target);

  assert.equal(manifest.directory, join(target, 'someone.echo'));
});

