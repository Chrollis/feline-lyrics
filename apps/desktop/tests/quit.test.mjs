import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createQuitController } from '../src/main/quit.ts';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

function event() {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented += 1;
    },
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('a fast shutdown quits once after plugins and the backend', async () => {
  const calls = [];
  const logs = [];
  const quit = deferred();
  let quitCalls = 0;
  const exitCalls = [];
  let forceCalls = 0;

  const controller = createQuitController({
    shutdownPlugins: async () => {
      calls.push('plugins');
    },
    shutdownBackend: async () => {
      calls.push('backend');
    },
    forceClosePlugins: () => {
      forceCalls += 1;
    },
    quit: () => {
      quitCalls += 1;
      quit.resolve();
    },
    exit: (code) => {
      exitCalls.push(code);
    },
    log: (message) => {
      logs.push(message);
    },
    timeoutMs: 1_000,
  });

  const first = event();
  controller.beforeQuit(first);
  await quit.promise;

  assert.equal(first.prevented, 1);
  assert.deepEqual(calls, ['plugins', 'backend']);
  assert.equal(quitCalls, 1);
  assert.deepEqual(exitCalls, []);
  assert.equal(forceCalls, 0);
  assert.deepEqual(logs, []);

  const afterReady = event();
  controller.beforeQuit(afterReady);
  assert.equal(afterReady.prevented, 0);

  const again = event();
  controller.beforeQuit(again);
  assert.equal(again.prevented, 0);
});

test('a failing plugin shutdown is logged and the backend still closes', async () => {
  const failure = new Error('plugin did not dispose');
  const logs = [];
  const calls = [];
  const quit = deferred();

  const controller = createQuitController({
    shutdownPlugins: async () => {
      throw failure;
    },
    shutdownBackend: async () => {
      calls.push('backend');
    },
    forceClosePlugins: () => {},
    quit: () => quit.resolve(),
    exit: () => {},
    log: (message, error) => {
      logs.push([message, error]);
    },
    timeoutMs: 1_000,
  });

  controller.beforeQuit(event());
  await quit.promise;

  assert.deepEqual(calls, ['backend']);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /plugin shutdown failed/);
  assert.equal(logs[0][1], failure);
});

test('the deadline force-closes and exits once', async () => {
  const exit = deferred();
  const exitCalls = [];
  const logs = [];
  let forceCalls = 0;

  const controller = createQuitController({
    shutdownPlugins: () => new Promise(() => {}),
    shutdownBackend: async () => {},
    forceClosePlugins: () => {
      forceCalls += 1;
    },
    quit: () => {},
    exit: (code) => {
      exitCalls.push(code);
      exit.resolve();
    },
    log: (message) => {
      logs.push(message);
    },
    timeoutMs: 20,
  });

  const first = event();
  controller.beforeQuit(first);

  assert.equal(first.prevented, 1);
  await exit.promise;

  assert.equal(forceCalls, 1);
  assert.deepEqual(exitCalls, [0]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], 'shutdown did not finish within 20 ms');

  const duplicate = event();
  controller.beforeQuit(duplicate);
  assert.equal(duplicate.prevented, 1);
  assert.deepEqual(exitCalls, [0]);
  assert.equal(forceCalls, 1);
});

test('a second quit while stopping forces immediately and exits once', async () => {
  const exitCalls = [];
  const logs = [];
  let forceCalls = 0;

  const controller = createQuitController({
    shutdownPlugins: () => new Promise(() => {}),
    shutdownBackend: async () => {},
    forceClosePlugins: () => {
      forceCalls += 1;
    },
    quit: () => {},
    exit: (code) => {
      exitCalls.push(code);
    },
    log: (message) => {
      logs.push(message);
    },
    timeoutMs: 1_000,
  });

  const first = event();
  controller.beforeQuit(first);
  assert.equal(first.prevented, 1);

  const second = event();
  controller.beforeQuit(second);
  assert.equal(second.prevented, 1);
  assert.equal(forceCalls, 1);
  assert.deepEqual(exitCalls, [0]);

  await sleep(20);

  const third = event();
  controller.beforeQuit(third);
  assert.equal(third.prevented, 1);
  assert.equal(forceCalls, 1);
  assert.deepEqual(exitCalls, [0]);
  assert.deepEqual(logs, []);
});
