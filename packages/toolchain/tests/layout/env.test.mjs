import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnv } from '../../out/index.js';

const dirs = { tempDir: 'C:\\tmp', pipCacheDir: 'C:\\pip' };

test('sets the isolation variables', () => {
  const env = buildEnv(dirs, { PATH: 'C:\\bin' });

  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PIP_DISABLE_PIP_VERSION_CHECK, '1');
  assert.equal(env.PIP_CACHE_DIR, dirs.pipCacheDir);
  assert.equal(env.TEMP, dirs.tempDir);
  assert.equal(env.TMP, dirs.tempDir);
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

test('does not mutate the parent environment', () => {
  const base = { PYTHONPATH: 'C:\\leak' };

  buildEnv(dirs, base);

  assert.equal(base.PYTHONPATH, 'C:\\leak');
});
