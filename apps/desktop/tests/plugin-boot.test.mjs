import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enableBuiltinHosts } from '../src/main/plugin-boot.ts';

function plugin(id, host, root) {
  return { manifest: { id, host }, root };
}

function hosts() {
  const enabled = [];

  return {
    enabled,
    enable: async (id) => {
      enabled.push(id);
    },
  };
}

test('it enables the builtin utility plugins only', async () => {
  const target = hosts();

  await enableBuiltinHosts(target, [
    plugin('felyrics.media', 'utility', 'builtin'),
    plugin('felyrics.panel', 'renderer', 'builtin'),
    plugin('someone.echo', 'utility', 'user'),
  ]);

  assert.deepEqual(target.enabled, ['felyrics.media']);
});

test('a failed builtin enable fails the startup with its id', async () => {
  const target = {
    enable: async () => {
      throw new Error('activate did not finish');
    },
  };

  await assert.rejects(
    enableBuiltinHosts(target, [plugin('felyrics.media', 'utility', 'builtin')]),
    (error) => {
      assert.equal(error.code, 'core/backend-failed');
      assert.match(error.message, /felyrics\.media/);
      assert.match(error.message, /activate did not finish/);

      return true;
    },
  );
});

test('a failed user plugin is not enabled and cannot fail the startup', async () => {
  const target = {
    enable: async () => {
      throw new Error('must not be called');
    },
  };

  await enableBuiltinHosts(target, [
    plugin('someone.echo', 'utility', 'user'),
  ]);
});
