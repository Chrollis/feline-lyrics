import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUtilityChannel } from '../dist/index.js';

/** A stand-in for Electron's UtilityProcess: it only moves messages. */
class FakeChild {
  messages = [];
  killed = false;
  listeners = new Map();

  postMessage(message) {
    this.messages.push(message);
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  kill() {
    this.killed = true;
    return true;
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }
}

test('sends commands to the child and closes it', async () => {
  const child = new FakeChild();
  const channel = createUtilityChannel({ fork: () => child });

  channel.send({ v: 1, kind: 'dispose' });
  assert.deepEqual(child.messages, [{ v: 1, kind: 'dispose' }]);

  channel.close();
  assert.equal(child.killed, true);
  await channel.closed;
});

test('delivers plugin events and stops after unsubscribe', () => {
  const child = new FakeChild();
  const channel = createUtilityChannel({ fork: () => child });
  const seen = [];
  const stop = channel.onMessage((event) => seen.push(event));

  child.emit('message', { v: 1, kind: 'disposed' });
  stop();
  child.emit('message', { v: 1, kind: 'disposed' });

  assert.deepEqual(seen, [{ v: 1, kind: 'disposed' }]);
});

test('close is idempotent and silences the channel', async () => {
  const child = new FakeChild();
  const channel = createUtilityChannel({ fork: () => child });

  channel.close();
  channel.close();
  channel.send({ v: 1, kind: 'dispose' });

  assert.equal(child.killed, true);
  assert.equal(child.messages.length, 0);
  await channel.closed;
});

test('a child exit resolves closed and drops listeners', async () => {
  const child = new FakeChild();
  const channel = createUtilityChannel({ fork: () => child });
  const seen = [];
  channel.onMessage((event) => seen.push(event));

  child.emit('exit', 1);
  child.emit('message', { v: 1, kind: 'disposed' });

  await channel.closed;
  assert.deepEqual(seen, []);
});
