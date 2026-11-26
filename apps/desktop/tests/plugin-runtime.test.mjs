import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { PluginHosts, servePlugin } from '@felyrics/host';

import { BackendPool } from '../src/main/backend-pool.ts';
import { installPickedPlugin } from '../src/main/plugin-install-runtime.ts';
import { installPluginDirectory } from '../src/main/plugin-install.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/** A pair of endpoints that delivers asynchronously, like a real port. */
function createPair() {
  const toHost = new Set();
  const toPlugin = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const host = {
    send(message) {
      queueMicrotask(() => {
        for (const listener of toPlugin) {
          listener(message);
        }
      });
    },
    onMessage(listener) {
      toHost.add(listener);
      return () => toHost.delete(listener);
    },
    closed,
    close() {
      resolveClosed();
    },
  };

  const plugin = {
    send(message) {
      queueMicrotask(() => {
        for (const listener of toHost) {
          listener(message);
        }
      });
    },
    onMessage(listener) {
      toPlugin.add(listener);
      return () => toPlugin.delete(listener);
    },
    closed,
    close() {
      resolveClosed();
    },
  };

  return { host, plugin };
}

function fakePool(root) {
  const calls = [];
  const closes = [];

  const service = {
    async request(method, params) {
      calls.push([method, params]);

      return { echo: params };
    },
    async close() {
      closes.push(1);

      return 0;
    },
  };

  const pool = new BackendPool({
    cacheDir: join(root, 'cache'),
    cwd: join(REPO, 'packages', 'host', 'backend'),
    builtinPython: 'builtin-python',
    builtin: [],
    user: [],
    userPython: (id) => join(root, 'envs', id, 'python.exe'),
    start: () => service,
  });

  return { pool, calls, closes };
}

test('an installed plugin runs end to end: install, enable, call, disable, re-enable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-runtime-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const { pool, calls, closes } = fakePool(root);
  const discovered = [];
  const jobIds = new Set();
  const hosts = new PluginHosts([], {
    createChannel: () => {
      const pair = createPair();

      void servePlugin(pair.plugin);

      return pair.host;
    },
    host: {
      backend: {
        call: (name, params, options) =>
          pool.call(name, params, options?.timeoutMs ?? 1000),
      },
    },
  });

  const listed = await installPickedPlugin(
    join(REPO, 'fixtures', 'plugins', 'fixtures.echo'),
    {
      pluginsRoot: join(root, 'plugins'),
      install: installPluginDirectory,
      discovered: () => discovered,
      addDiscovered: (manifest) => {
        discovered.push({ manifest, root: 'user' });
      },
      jobIds,
      hosts: () => hosts,
      addUserBackend: (plugin) => {
        pool.addUser(plugin);
      },
      list: () => hosts.list(),
    },
  );

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].manifest.id, 'fixtures.echo');
  assert.equal(
    discovered[0].manifest.directory,
    join(root, 'plugins', 'fixtures.echo'),
  );
  assert.ok(jobIds.has('fixtures.echo'));
  assert.deepEqual(
    listed.map((plugin) => plugin.id),
    ['fixtures.echo'],
  );
  assert.equal(listed[0].state, 'PENDING');

  await hosts.enable('fixtures.echo');
  assert.equal(hosts.handle('fixtures.echo')?.state, 'ACTIVE');

  assert.deepEqual(await hosts.request('fixtures.echo/echo', { value: 7 }), {
    echo: { value: 7 },
  });
  assert.deepEqual(calls, [['fixtures.echo/echo', { value: 7 }]]);

  await hosts.disable('fixtures.echo');
  await pool.stop('fixtures.echo');

  assert.equal(hosts.handle('fixtures.echo')?.state, 'DISPOSED');
  assert.equal(closes.length, 1);

  await hosts.enable('fixtures.echo');
  assert.deepEqual(await hosts.request('fixtures.echo/echo', { value: 9 }), {
    echo: { value: 9 },
  });
  assert.equal(calls.length, 2);
  assert.equal(closes.length, 1);
});
