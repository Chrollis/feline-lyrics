import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnv, buildUvEnv } from '../../out/index.js';

const dirs = { tempDir: 'C:\\tmp', pipCacheDir: 'C:\\pip' };

const uvDirs = {
  tempDir: 'C:\\tmp',
  cacheDir: 'C:\\uv-cache',
  pythonInstallDir: 'C:\\backend\\python',
  installMirror: 'https://mirror.example/pbs',
  pythonBuild: '20261021',
  packageIndex: 'https://index.example/simple',
};

test('sets the isolation variables', () => {
  const env = buildEnv(dirs, { PATH: 'C:\\bin' });

  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PIP_DISABLE_PIP_VERSION_CHECK, '1');
  assert.equal(env.PIP_CACHE_DIR, dirs.pipCacheDir);
});

test('points every scratch variable at the injected temp directory', () => {
  const env = buildEnv(dirs, { PATH: 'C:\\bin' });

  // All three, because only `TMPDIR` counts off Windows.
  assert.equal(env.TEMP, dirs.tempDir);
  assert.equal(env.TMP, dirs.tempDir);
  assert.equal(env.TMPDIR, dirs.tempDir);
});

test('points the uv scratch variables at the injected temp directory', () => {
  const env = buildUvEnv(uvDirs, { PATH: 'C:\\bin' });

  assert.equal(env.TEMP, uvDirs.tempDir);
  assert.equal(env.TMP, uvDirs.tempDir);
  assert.equal(env.TMPDIR, uvDirs.tempDir);
});

test('drops pip and python variables from the parent process', () => {
  const env = buildEnv(dirs, {
    PATH: 'C:\\bin',
    PIP_INDEX_URL: 'https://example.com',
    PYTHONPATH: 'C:\\leak',
    PYTHONHOME: 'C:\\python',
    PYTHONUSERBASE: 'C:\\user',
    VIRTUAL_ENV: 'C:\\venv',
  });

  assert.equal(env.PIP_INDEX_URL, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONUSERBASE, undefined);
  assert.equal(env.VIRTUAL_ENV, undefined);
  assert.equal(env.PATH, 'C:\\bin');
});

test('drops a lower-case pip variable too', () => {
  const env = buildEnv(dirs, { PATH: 'C:\\bin', pip_index_url: 'https://x' });

  assert.equal(env.pip_index_url, undefined);
});

test('keeps exactly the parent keys it does not deny', () => {
  const env = buildEnv(dirs, {
    PATH: 'C:\\bin',
    KEEP_ME: 'yes',
    pip_index_url: 'https://x',
    PYTHONPATH: 'C:\\leak',
  });

  assert.deepEqual(Object.keys(env).sort(), [
    'KEEP_ME',
    'PATH',
    'PIP_CACHE_DIR',
    'PIP_DISABLE_PIP_VERSION_CHECK',
    'PYTHONNOUSERSITE',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]);
});

test('does not mutate the parent environment', () => {
  const base = { PYTHONPATH: 'C:\\leak' };

  buildEnv(dirs, base);

  assert.equal(base.PYTHONPATH, 'C:\\leak');
});
