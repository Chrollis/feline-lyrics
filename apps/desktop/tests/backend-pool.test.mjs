import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BackendPool } from '../src/main/backend-pool.ts';

function fakeStarter(starts, closes) {
  return (options) => {
    starts.push(options);

    return {
      async request(method) {
        return { method };
      },
      async close() {
        closes.push(options.pythonExe);

        return 0;
      },
    };
  };
}

test('builtin plugins share one process', async () => {
  const starts = [];
  const closes = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'C:\\backend\\venv\\python.exe',
    builtin: [
      { id: 'builtin.one', directory: 'C:\\plugins\\builtin.one' },
      { id: 'builtin.two', directory: 'C:\\plugins\\builtin.two' },
    ],
    user: [],
    userPython: () => 'unused',
    start: fakeStarter(starts, closes),
  });

  assert.deepEqual(await pool.call('builtin.one/a', {}, 1000), {
    method: 'builtin.one/a',
  });
  assert.deepEqual(await pool.call('builtin.two/b', {}, 1000), {
    method: 'builtin.two/b',
  });

  assert.equal(starts.length, 1);
  assert.equal(starts[0].pythonExe, 'C:\\backend\\venv\\python.exe');
  assert.deepEqual(starts[0].args, [
    '-m',
    'felyrics_host',
    '--cache',
    'C:\\cache',
    '--plugin',
    'builtin.one',
    '--plugin-dir',
    'C:\\plugins\\builtin.one',
    '--plugin',
    'builtin.two',
    '--plugin-dir',
    'C:\\plugins\\builtin.two',
  ]);

  await pool.close();
  assert.equal(closes.length, 1);
});

test('a user plugin gets its own process and interpreter', async () => {
  const starts = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'C:\\backend\\venv\\python.exe',
    builtin: [],
    user: [{ id: 'someone.echo', directory: 'C:\\user\\someone.echo' }],
    userPython: (id) => `C:\\envs\\${id}\\venv\\python.exe`,
    start: fakeStarter(starts, []),
  });

  await pool.call('someone.echo/echo', { value: 1 }, 1000);
  await pool.call('someone.echo/echo', { value: 2 }, 1000);

  assert.equal(starts.length, 1);
  assert.equal(
    starts[0].pythonExe,
    'C:\\envs\\someone.echo\\venv\\python.exe',
  );
  assert.deepEqual(starts[0].args, [
    '-m',
    'felyrics_host',
    '--cache',
    'C:\\cache',
    '--plugin',
    'someone.echo',
    '--plugin-dir',
    'C:\\user\\someone.echo',
  ]);
});

test('an unknown plugin id fails before spawning anything', async () => {
  const starts = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [],
    user: [],
    userPython: () => 'unused',
    start: fakeStarter(starts, []),
  });

  await assert.rejects(pool.call('unknown.plugin/x', {}, 1000), {
    code: 'core/not-ready',
  });
  assert.equal(starts.length, 0);
});

test('stopping a user plugin closes its process and the next call respawns it', async () => {
  const starts = [];
  const closes = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [],
    user: [{ id: 'someone.echo', directory: 'C:\\user\\someone.echo' }],
    userPython: () => 'C:\\env\\venv\\python.exe',
    start: fakeStarter(starts, closes),
  });

  await pool.call('someone.echo/echo', {}, 1000);
  await pool.stop('someone.echo');
  assert.equal(closes.length, 1);

  await pool.call('someone.echo/echo', {}, 1000);
  assert.equal(starts.length, 2, 'the next call starts a fresh process');
});

test('a plugin installed at runtime joins the user routes', async () => {
  const starts = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [],
    user: [],
    userPython: (id) => `C:\\envs\\${id}\\venv\\python.exe`,
    start: fakeStarter(starts, []),
  });

  pool.addUser({ id: 'fixtures.echo', directory: 'C:\\user\\fixtures.echo' });

  assert.deepEqual(await pool.call('fixtures.echo/echo', { value: 7 }, 1000), {
    method: 'fixtures.echo/echo',
  });
  assert.equal(
    starts[0].pythonExe,
    'C:\\envs\\fixtures.echo\\venv\\python.exe',
  );

  assert.throws(
    () =>
      pool.addUser({ id: 'fixtures.echo', directory: 'C:\\user\\other' }),
    { code: 'core/duplicate-id' },
  );
});

test('stopping while a process starts still closes it', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const closes = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [],
    user: [{ id: 'someone.echo', directory: 'C:\\user\\someone.echo' }],
    userPython: () => 'python.exe',
    start: (options) =>
      gate.then(() => ({
        async request() {
          return {};
        },
        async close() {
          closes.push(options.pythonExe);

          return 0;
        },
      })),
  });

  const call = pool.call('someone.echo/echo', {}, 1000).catch(() => undefined);

  await Promise.resolve();

  const stopped = pool.stop('someone.echo');

  release();
  await stopped;
  await call;

  assert.equal(closes.length, 1);
});

test('closing while a process starts closes it once it arrives', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const closes = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [{ id: 'builtin.one', directory: 'C:\\plugins\\builtin.one' }],
    user: [],
    userPython: () => 'unused',
    start: (options) =>
      gate.then(() => ({
        async request() {
          return {};
        },
        async close() {
          closes.push(options.pythonExe);

          return 0;
        },
      })),
  });

  const call = pool.call('builtin.one/a', {}, 1000).catch(() => undefined);

  await Promise.resolve();

  const closed = pool.close();

  release();
  await closed;
  await call;

  assert.equal(closes.length, 1);
});

test('a method without a plugin id is refused', async () => {
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [],
    user: [],
    userPython: () => 'unused',
    start: fakeStarter([], []),
  });

  await assert.rejects(pool.call('ping', {}, 1000), {
    code: 'protocol/unknown-method',
  });
});

test('closes every backend at the same time', async () => {
  const starts = [];
  const closes = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'C:\\backend\\venv\\python.exe',
    builtin: [{ id: 'builtin.one', directory: 'C:\\plugins\\builtin.one' }],
    user: [
      { id: 'someone.one', directory: 'C:\\user\\someone.one' },
      { id: 'someone.two', directory: 'C:\\user\\someone.two' },
    ],
    userPython: (id) => `C:\\envs\\${id}\\venv\\python.exe`,
    start: (options) => {
      starts.push(options);

      return {
        async request(method) {
          return { method };
        },
        async close() {
          closes.push(options.pythonExe);
          await gate;

          return 0;
        },
      };
    },
  });

  await Promise.all([
    pool.call('builtin.one/a', {}, 1000),
    pool.call('someone.one/a', {}, 1000),
    pool.call('someone.two/a', {}, 1000),
  ]);
  assert.equal(starts.length, 3);

  const closed = pool.close();

  await new Promise((resolve) => setImmediate(resolve));
  // Each close reaches its own service before any of them returns: a serial
  // loop would show one here and the other two only after the gate opens.
  assert.equal(closes.length, 3);

  release();
  assert.equal(await closed, 0);
});

test('one backend that fails to close does not abort the others', async () => {
  const closes = [];
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'C:\\backend\\venv\\python.exe',
    builtin: [{ id: 'builtin.one', directory: 'C:\\plugins\\builtin.one' }],
    user: [{ id: 'someone.echo', directory: 'C:\\user\\someone.echo' }],
    userPython: () => 'C:\\envs\\someone.echo\\venv\\python.exe',
    start: (options) => ({
      async request() {
        return {};
      },
      async close() {
        closes.push(options.pythonExe);

        if (options.args.includes('builtin.one')) {
          throw new Error('stuck');
        }

        return 7;
      },
    }),
  });

  await pool.call('builtin.one/a', {}, 1000);
  await pool.call('someone.echo/a', {}, 1000);

  const originalError = console.error;
  console.error = () => {};

  try {
    // The surviving close still reports its code, so quit learns what happened
    // to the process that did exit.
    assert.equal(await pool.close(), 7);
  } finally {
    console.error = originalError;
  }

  assert.equal(closes.length, 2);
});

test('hands the job factory and close deadline to every service', async () => {
  const starts = [];
  const job = { assign() {}, close() {} };
  const pool = new BackendPool({
    cacheDir: 'C:\\cache',
    cwd: 'C:\\backend',
    builtinPython: 'python.exe',
    builtin: [{ id: 'builtin.one', directory: 'C:\\plugins\\builtin.one' }],
    user: [],
    userPython: () => 'unused',
    createJob: () => job,
    closeTimeoutMs: 250,
    start: fakeStarter(starts, []),
  });

  await pool.call('builtin.one/a', {}, 1000);

  assert.equal(starts[0].createJob(), job);
  assert.equal(starts[0].closeTimeoutMs, 250);
});
