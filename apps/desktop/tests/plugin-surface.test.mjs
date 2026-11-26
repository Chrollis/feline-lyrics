import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  discoverPlugins,
  PluginHosts,
  UTILITY_PROTOCOL_VERSION,
} from '@felyrics/host';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MEDIA_ROOT = join(REPO_ROOT, 'plugins', 'felyrics.media');

/**
 * A plugin host that answers `activate` with the given short names.
 *
 * It never runs plugin code: this test asks one question -- does the host
 * expose each method the manifest declares under `<id>/<short>`? -- and a
 * transport that answers by the book is enough to answer it.
 */
function fakeChannel(manifest, methods) {
  const toHost = new Set();
  const toPlugin = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function deliver(listeners, message) {
    queueMicrotask(() => {
      for (const listener of listeners) {
        listener(message);
      }
    });
  }

  const host = {
    send(command) {
      deliver(toPlugin, command);
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
    send(event) {
      deliver(toHost, event);
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

  plugin.onMessage((command) => {
    if (command.kind === 'activate') {
      plugin.send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'ready',
        methods,
      });
    } else if (command.kind === 'dispose') {
      plugin.send({ v: UTILITY_PROTOCOL_VERSION, kind: 'disposed' });
    }
  });

  return host;
}

async function mediaSurface(t, methods) {
  const discovery = await discoverPlugins([
    { path: join(REPO_ROOT, 'plugins'), kind: 'builtin' },
  ]);
  const discovered = discovery.plugins.find(
    (plugin) => plugin.manifest.id === 'felyrics.media',
  );
  const manifest = discovered?.manifest;

  assert.ok(manifest, 'felyrics.media is discovered');

  const hosts = new PluginHosts([manifest], {
    createChannel: () => fakeChannel(manifest, methods),
    activationTimeoutMs: 2_000,
  });

  t.after(() => hosts.disable(manifest.id).catch(() => {}));

  return { hosts, manifest };
}

test('the app table prefixes every method the manifest declares', async (t) => {
  const packageJson = JSON.parse(
    await readFile(join(MEDIA_ROOT, 'package.json'), 'utf8'),
  );
  const declared = packageJson.felyrics.contributes.methods;
  const { hosts, manifest } = await mediaSurface(t, declared);

  await hosts.enable(manifest.id);

  const [summary] = hosts.list();
  const expected = declared.map((short) => `${manifest.id}/${short}`);

  assert.deepEqual([...summary.methods].sort(), [...expected].sort());
  assert.equal(summary.state, 'ACTIVE');
});

test('a missing registration fails the enable with the manifest diff', async (t) => {
  const packageJson = JSON.parse(
    await readFile(join(MEDIA_ROOT, 'package.json'), 'utf8'),
  );
  const declared = packageJson.felyrics.contributes.methods;
  const { hosts, manifest } = await mediaSurface(t, declared.slice(1));

  await assert.rejects(hosts.enable(manifest.id), (error) => {
    assert.equal(error.code, 'core/methods-mismatch');
    assert.equal(error.issues[0].path, 'contributes.methods');

    return true;
  });
  assert.equal(hosts.list()[0].state, 'FAILED');
});
