import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  PYTHON_SHORT_VERSION,
  TARGETS,
  backendPaths,
  cachePaths,
} from '../../out/index.js';

const WINDOWS = TARGETS['win32-x64'];
const LINUX = TARGETS['linux-x64'];

test('lays the cache out under the root the caller chose', () => {
  const paths = cachePaths('data/cache');
  const root = resolve('data/cache');

  assert.equal(paths.downloads, join(root, 'downloads'));
  assert.equal(paths.uv, join(root, 'uv'));
  assert.equal(paths.wheels, join(root, 'wheels'));
});

test('lays the backend out under the root the caller chose', () => {
  const paths = backendPaths('data/backend', WINDOWS);
  const root = resolve('data/backend');

  assert.equal(paths.root, root);
  assert.equal(paths.uvExe, join(root, 'uv', 'uv.exe'));
  assert.equal(paths.pythonDir, join(root, 'python'));
  assert.equal(paths.venvPython, join(root, 'venv', 'Scripts', 'python.exe'));
  assert.equal(paths.sitePackages, join(root, 'venv', 'Lib', 'site-packages'));
  assert.equal(paths.readyMarker, join(root, '.ready'));
});

test('reads the platform names from the target row', () => {
  const root = resolve('data/backend');
  const linux = backendPaths(root, LINUX);

  assert.equal(linux.uvExe, join(root, 'uv', 'uv'));
  assert.equal(linux.venvPython, join(root, 'venv', 'bin', 'python'));
  assert.equal(
    linux.sitePackages,
    join(root, 'venv', 'lib', `python${PYTHON_SHORT_VERSION}`, 'site-packages'),
  );
});

test('keeps an absolute root as it is', () => {
  const root = join('C:', 'felyrics', 'backend');

  assert.equal(backendPaths(root, WINDOWS).root, resolve(root));
});
