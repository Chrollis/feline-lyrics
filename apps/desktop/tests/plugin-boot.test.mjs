import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  enableBuiltinHosts,
  restartBuiltinHosts,
  shutdownHosts,
} from '../src/main/plugin-boot.ts';

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

test('a retry stops the previous hosts before creating the next table', async () => {
  const order = [];
  const previous = {
    list: () => [{ id: 'felyrics.media', state: 'ACTIVE' }],
    disable: async (id) => {
      order.push(`disable:${id}`);
    },
  };

  const next = {
    enable: async (id) => {
      order.push(`enable:${id}`);
    },
  };

  const hosts = await restartBuiltinHosts(
    previous,
    [plugin('felyrics.media', 'utility', 'builtin')],
    () => {
      order.push('create');

      return next;
    },
  );

  assert.equal(hosts, next);
  assert.deepEqual(order, ['disable:felyrics.media', 'create', 'enable:felyrics.media']);
});

test('a failed enable closes the hosts it already started', async () => {
  const disabled = [];
  const next = {
    enable: async (id) => {
      if (id === 'felyrics.second') {
        throw new Error('activate did not finish');
      }
    },
    list: () => [{ id: 'felyrics.first', state: 'ACTIVE' }],
    disable: async (id) => {
      disabled.push(id);
    },
  };

  await assert.rejects(
    restartBuiltinHosts(
      undefined,
      [
        plugin('felyrics.first', 'utility', 'builtin'),
        plugin('felyrics.second', 'utility', 'builtin'),
      ],
      () => next,
    ),
    (error) => {
      assert.equal(error.code, 'core/backend-failed');
      assert.match(error.message, /felyrics\.second/);

      return true;
    },
  );

  assert.deepEqual(disabled, ['felyrics.first']);
});

test('a shutdown skips hosts that stopped and survives a failed stop', async () => {
  const disabled = [];

  await shutdownHosts({
    list: () => [
      { id: 'a', state: 'ACTIVE' },
      { id: 'b', state: 'DISPOSED' },
      { id: 'c', state: 'FAILED' },
      { id: 'd', state: 'LOADING' },
    ],
    disable: async (id) => {
      disabled.push(id);

      if (id === 'd') {
        throw new Error('the child did not answer');
      }
    },
  });

  assert.deepEqual(disabled, ['a', 'd']);
});
