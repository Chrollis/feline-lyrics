import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadManifest } from '@felyrics/host';

import { UserPluginController } from '../src/main/plugin-enable.ts';

const FIXTURE = fileURLToPath(
  new URL('../../../fixtures/plugins/fixtures.echo', import.meta.url),
);

function summary(id) {
  return { id, state: 'ACTIVE', methods: [] };
}

function actions(log) {
  return {
    async provision(id) {
      log.push(`provision:${id}`);
    },
    async enableHost(id) {
      log.push(`enable:${id}`);
    },
    async disableHost(id) {
      log.push(`disable:${id}`);
    },
    async stopBackend(id) {
      log.push(`stop:${id}`);
    },
    list() {
      return [summary('fixtures.echo')];
    },
  };
}

test('the repository fixture enables, lists, then disables in order', async () => {
  const manifest = await loadManifest(FIXTURE);

  assert.equal(manifest.id, 'fixtures.echo');
  assert.deepEqual(manifest.methods, ['echo']);

  const log = [];
  const controller = new UserPluginController(() => manifest, actions(log));

  const listed = await controller.enable(manifest.id);
  assert.equal(listed[0].state, 'ACTIVE');
  await controller.disable(manifest.id);

  assert.deepEqual(log, [
    'provision:fixtures.echo',
    'enable:fixtures.echo',
    'disable:fixtures.echo',
    'stop:fixtures.echo',
  ]);
});

test('disable waits for an enable that is still provisioning', async () => {
  const manifest = await loadManifest(FIXTURE);
  const log = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const base = actions(log);
  const controller = new UserPluginController(() => manifest, {
    ...base,
    async provision(id) {
      log.push(`provision:${id}`);
      await gate;
    },
  });

  const enabled = controller.enable(manifest.id);
  const disabled = controller.disable(manifest.id);

  await Promise.resolve();
  assert.deepEqual(log, ['provision:fixtures.echo'], 'disable stays queued');

  release();
  await enabled;
  await disabled;

  assert.deepEqual(log, [
    'provision:fixtures.echo',
    'enable:fixtures.echo',
    'disable:fixtures.echo',
    'stop:fixtures.echo',
  ]);
});

test('a renderer-only plugin is refused before provisioning', async () => {
  const manifest = {
    id: 'someone.panel',
    host: 'renderer',
    python: undefined,
  };
  const log = [];
  const controller = new UserPluginController(() => manifest, actions(log));

  await assert.rejects(
    () => controller.enable('someone.panel'),
    (error) => error.code === 'core/not-ready',
  );
  assert.deepEqual(log, []);
});
