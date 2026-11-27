import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  backendPaths,
  provisionPluginEnvironment,
  readReadyMarker,
} from '../../out/index.js';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-plugin-env-'));
  const paths = {
    cacheDir: join(root, 'cache'),
    backendRoot: join(root, 'backend'),
  };
  const shared = backendPaths(paths.backendRoot);

  mkdirSync(dirname(shared.uvExe), { recursive: true });
  writeFileSync(shared.uvExe, '');
  mkdirSync(dirname(shared.venvPython), { recursive: true });
  writeFileSync(shared.venvPython, '');

  return { root, paths, shared, envRoot: join(root, 'plugin-envs') };
}

function fakeRun(calls) {
  return async (exe, args) => {
    calls.push({ exe, args: [...args] });
    if (args[0] === 'venv') {
      // The real uv writes the interpreter; the fake one has to as well, or
      // the next call finds no python and rebuilds.
      for (const name of ['Scripts\\python.exe', 'bin/python']) {
        const file = join(args[1], name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '');
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('builds a venv from the shared interpreter and its own pth', async () => {
  const { root, paths, shared, envRoot } = makeRoot();
  const calls = [];
  const hostBackend = join(root, 'host-backend');
  const pluginBackend = join(root, 'plugins', 'fixtures.echo', 'backend');

  const environment = await provisionPluginEnvironment({
    paths,
    envRoot,
    id: 'fixtures.echo',
    importPaths: [hostBackend, pluginBackend],
    requirements: ['av==19.0.2', 'numpy==2.5.5'],
    tempDir: join(root, 'temp'),
    run: fakeRun(calls),
  });

  const expected = backendPaths(join(envRoot, 'fixtures.echo'));

  assert.equal(environment.python, expected.venvPython);
  assert.deepEqual(calls[0]?.args, [
    'venv',
    expected.venvDir,
    '--python',
    shared.venvPython,
    '--clear',
  ]);
  assert.deepEqual(calls[1]?.args, [
    'pip',
    'install',
    '--python',
    expected.venvPython,
    'av==19.0.2',
    'numpy==2.5.5',
  ]);

  const pth = readFileSync(join(expected.sitePackages, 'felyrics.pth'), 'utf8');
  assert.equal(pth, `${resolve(hostBackend)}\n${resolve(pluginBackend)}\n`);

  const marker = await readReadyMarker(expected);
  assert.equal(marker?.requirements, 'av==19.0.2\nnumpy==2.5.5');
  assert.equal(marker?.imports, `${resolve(hostBackend)}\n${resolve(pluginBackend)}`);

  rmSync(root, { recursive: true, force: true });
});

test('reuses the environment when the inputs did not change', async () => {
  const { root, paths, envRoot } = makeRoot();
  const calls = [];
  const options = {
    paths,
    envRoot,
    id: 'fixtures.echo',
    importPaths: [join(root, 'host-backend')],
    requirements: ['av==19.0.2'],
    tempDir: join(root, 'temp'),
    run: fakeRun(calls),
  };

  await provisionPluginEnvironment(options);
  const afterFirst = calls.length;
  await provisionPluginEnvironment(options);

  assert.equal(calls.length, afterFirst, 'a matching marker should skip uv');

  rmSync(root, { recursive: true, force: true });
});

test('rebuilds when the requirements change', async () => {
  const { root, paths, envRoot } = makeRoot();
  const calls = [];
  const options = {
    paths,
    envRoot,
    id: 'fixtures.echo',
    importPaths: [join(root, 'host-backend')],
    requirements: ['av==19.0.2'],
    tempDir: join(root, 'temp'),
    run: fakeRun(calls),
  };

  await provisionPluginEnvironment(options);
  const afterFirst = calls.length;
  await provisionPluginEnvironment({ ...options, requirements: ['av==20.0.0'] });

  assert.ok(calls.length > afterFirst, 'changed requirements rebuild the venv');

  rmSync(root, { recursive: true, force: true });
});

test('rebuilds when the import paths move', async () => {
  const { root, paths, envRoot } = makeRoot();
  const calls = [];
  const options = {
    paths,
    envRoot,
    id: 'fixtures.echo',
    importPaths: [join(root, 'host-a')],
    requirements: ['av==19.0.2'],
    tempDir: join(root, 'temp'),
    run: fakeRun(calls),
  };

  await provisionPluginEnvironment(options);
  const afterFirst = calls.length;
  await provisionPluginEnvironment({ ...options, importPaths: [join(root, 'host-b')] });

  assert.ok(calls.length > afterFirst, 'changed import paths rebuild the venv');

  const marker = await readReadyMarker(backendPaths(join(envRoot, 'fixtures.echo')));
  assert.equal(marker?.imports, resolve(join(root, 'host-b')));

  rmSync(root, { recursive: true, force: true });
});

test('a failed install leaves no ready marker', async () => {
  const { root, paths, envRoot } = makeRoot();
  const calls = [];
  const failInstall = async (exe, args) => {
    calls.push({ exe, args: [...args] });
    const installing = args[0] === 'pip';

    if (!installing) {
      for (const name of ['Scripts\\python.exe', 'bin/python']) {
        const file = join(args[1], name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '');
      }
    }

    return installing
      ? { status: 1, stdout: '', stderr: 'no wheel' }
      : { status: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    provisionPluginEnvironment({
      paths,
      envRoot,
      id: 'fixtures.echo',
      importPaths: [join(root, 'host-backend')],
      requirements: ['av==19.0.2'],
      tempDir: join(root, 'temp'),
      run: failInstall,
    }),
    { code: 'uv/packages-failed' },
  );

  assert.equal(existsSync(join(envRoot, 'fixtures.echo', '.ready')), false);

  rmSync(root, { recursive: true, force: true });
});
