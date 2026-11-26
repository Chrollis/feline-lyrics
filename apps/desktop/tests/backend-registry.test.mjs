import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  callBackend,
  configureBackends,
  shutdownBackend,
} from '../src/main/backend-registry.ts';

function service(label, closed) {
  return {
    async ping() {
      return label;
    },
    async call(method) {
      return `${label}:${method}`;
    },
    async stop() {},
    async close() {
      closed.push(label);

      return 0;
    },
  };
}

const host = { cacheDir: 'cache', backendRoot: 'backend', pluginEnvsRoot: 'envs' };
const plugins = { host, builtin: [], user: [] };

test('closes the previous pool before installing the next one', async () => {
  const closed = [];

  await configureBackends(plugins, () => service('first', closed));
  await configureBackends(plugins, () => service('second', closed));

  assert.deepEqual(closed, ['first'], 'the old pool is gone before the new call');
  assert.equal(await callBackend('a.b/method', {}, 10), 'second:a.b/method');
  assert.equal(await shutdownBackend(), 0);
  assert.deepEqual(closed, ['first', 'second']);
  assert.equal(await shutdownBackend(), null, 'a second shutdown is a no-op');
});

test('a call before configuration is not ready', async () => {
  await assert.rejects(
    () => callBackend('a.b/method', {}, 10),
    (error) => error.code === 'core/not-ready',
  );
});
