import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { PluginHosts, servePlugin } from '@felyrics/host';

import { BackendPool } from '../src/main/backend-pool.ts';
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

  const installed = await installPluginDirectory(
    join(REPO, 'fixtures', 'plugins', 'fixtures.echo'),
    join(root, 'plugins'),
  );

  assert.equal(installed.id, 'fixtures.echo');

  const { pool, calls, closes } = fakePool(root);

  pool.addUser({ id: installed.id, directory: installed.directory });

  let pair = null;

  const hosts = new PluginHosts([installed], {
    createChannel: () => {
      pair = createPair();
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

  await hosts.enable(installed.id);
  assert.equal(hosts.handle(installed.id)?.state, 'ACTIVE');

  assert.deepEqual(
    await hosts.request('fixtures.echo/echo', { value: 7 }),
    { echo: { value: 7 } },
  );
  assert.deepEqual(calls, [['fixtures.echo/echo', { value: 7 }]]);

  await hosts.disable(installed.id);
  await pool.stop(installed.id);

  assert.equal(hosts.handle(installed.id)?.state, 'DISPOSED');
  assert.equal(closes.length, 1);

  await hosts.enable(installed.id);
  assert.deepEqual(
    await hosts.request('fixtures.echo/echo', { value: 9 }),
    { echo: { value: 9 } },
  );
  assert.equal(calls.length, 2);
  assert.equal(closes.length, 1);
});
