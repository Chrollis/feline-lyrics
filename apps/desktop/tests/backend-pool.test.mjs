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
