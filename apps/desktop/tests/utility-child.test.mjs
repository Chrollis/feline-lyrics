// One real child process, one activate/request/dispose round trip: the utility
// entry and the in-memory pair are covered elsewhere, but only this test would
// catch a protocol message that does not survive serialization.

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  createUtilityChannel,
  loadManifest,
  PluginHosts,
} from '@felyrics/host';

const CHILD = fileURLToPath(
  new URL('./fixtures/parent-port-child.mjs', import.meta.url),
);

async function fixturePlugin(root) {
  const directory = join(root, 'fixtures.echo');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@fixtures/echo',
      version: '1.0.0',
      author: 'tester',
      main: 'index.mjs',
      felyrics: {
        api: 1,
        host: 'utility',
        contributes: { methods: ['echo'] },
      },
    }),
  );
  await writeFile(
    join(directory, 'index.mjs'),
    'export async function activate(ctx) {\n' +
      "  ctx.method('echo', (params) => ({ echo: params.value }));\n" +
      '}\n',
  );

  return loadManifest(directory);
}

test('a request survives a real child process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-child-'));
  const manifest = await fixturePlugin(root);
  const children = [];

  t.after(async () => {
    for (const child of children) {
      child.kill();
    }

    await rm(root, { recursive: true, force: true });
  });

  const hosts = new PluginHosts([manifest], {
    createChannel: () =>
      createUtilityChannel({
        fork: () => {
          const child = fork(CHILD, [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          children.push(child);

          return {
            postMessage: (message) => {
              child.send(message);
            },
            on: (event, listener) => {
              child.on(event, listener);
            },
            off: (event, listener) => {
              child.off(event, listener);
            },
            kill: () => {
              child.kill();
            },
          };
        },
      }),
  });

  await hosts.enable('fixtures.echo');
  const result = await hosts.request('fixtures.echo/echo', { value: 7 });
  assert.deepEqual(result, { echo: 7 });

  await hosts.disable('fixtures.echo');
  assert.equal(hosts.list()[0].state, 'DISPOSED');
});

test('a manifest whose main does not exist fails the activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-child-'));
  const directory = join(root, 'fixtures.missing');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@fixtures/missing',
      version: '1.0.0',
      author: 'tester',
      main: 'index.mjs',
      felyrics: {
        api: 1,
        host: 'utility',
        contributes: { methods: ['echo'] },
      },
    }),
  );

  const children = [];
  t.after(async () => {
    for (const child of children) {
      child.kill();
    }

    await rm(root, { recursive: true, force: true });
  });

  const manifest = await loadManifest(directory);
  const hosts = new PluginHosts([manifest], {
    createChannel: () =>
      createUtilityChannel({
        fork: () => {
          const child = fork(CHILD, [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          children.push(child);

          return {
            postMessage: (message) => {
              child.send(message);
            },
            on: (event, listener) => {
              child.on(event, listener);
            },
            off: (event, listener) => {
              child.off(event, listener);
            },
            kill: () => {
              child.kill();
            },
          };
        },
      }),
  });

  await assert.rejects(hosts.enable('fixtures.missing'));
  assert.equal(hosts.list()[0].state, 'FAILED');
});
