import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { backendPaths, cachePaths } from '../../out/index.js';

test('lays the cache out under the root the caller chose', () => {
  const paths = cachePaths('data/cache');
  const root = resolve('data/cache');

  assert.equal(paths.downloads, join(root, 'downloads'));
  assert.equal(paths.uv, join(root, 'uv'));
  assert.equal(paths.wheels, join(root, 'wheels'));
});

test('lays the backend out under the root the caller chose', () => {
  const paths = backendPaths('data/backend');
  const root = resolve('data/backend');

  assert.equal(paths.root, root);
  assert.equal(paths.uvExe, join(root, 'uv', 'uv.exe'));
  assert.equal(paths.pythonDir, join(root, 'python'));
  assert.equal(paths.venvPython, join(root, 'venv', 'Scripts', 'python.exe'));
  assert.equal(paths.sitePackages, join(root, 'venv', 'Lib', 'site-packages'));
  assert.equal(paths.readyMarker, join(root, '.ready'));
});

test('keeps an absolute root as it is', () => {
  const root = join('C:', 'felyrics', 'backend');

  assert.equal(backendPaths(root).root, resolve(root));
});
