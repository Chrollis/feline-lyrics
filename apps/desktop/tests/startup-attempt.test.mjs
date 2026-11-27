import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BackendError } from '@felyrics/host';

import {
  beginStartup,
  settleStartup,
  withDeadline,
} from '../src/main/startup-attempt.ts';

test('withDeadline resolves before the deadline', async () => {
  let timedOut = false;

  const value = await withDeadline(
    Promise.resolve(42),
    () => {
      timedOut = true;
    },
    1_000,
  );

  assert.equal(value, 42);
  assert.equal(timedOut, false);
});

test('a timeout aborts the attempt and rejects with core/timeout', async () => {
  const attempt = beginStartup(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  );

  await assert.rejects(
    withDeadline(attempt.work, () => attempt.controller.abort(), 20),
    (error) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.code, 'core/timeout');
      assert.equal(error.message, 'the startup did not finish');

      return true;
    },
  );

  assert.equal(attempt.controller.signal.aborted, true);
  await attempt.settled;
});

test('settleStartup waits for abort-aware work and reports it settled', async () => {
  const attempt = beginStartup(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('stopped'), {
          once: true,
        });
      }),
  );

  assert.equal(await settleStartup(attempt, 1_000), true);
  assert.equal(attempt.controller.signal.aborted, true);
});

test('settleStartup reports work that already finished as settled', async () => {
  const attempt = beginStartup(async () => 'done');

  assert.equal(await settleStartup(attempt, 1_000), true);
  assert.equal(attempt.controller.signal.aborted, true);
});

test('settleStartup returns false when the work ignores the abort', async () => {
  const attempt = beginStartup(() => new Promise(() => {}));
  const started = Date.now();

  assert.equal(await settleStartup(attempt, 20), false);
  assert.equal(attempt.controller.signal.aborted, true);
  assert.ok(Date.now() - started < 1_000);
});
