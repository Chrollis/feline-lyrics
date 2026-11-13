import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runtimePaths } from '../../out/index.js';

test('derives every path from the repository root', () => {
  const root = join('C:', 'repo');
  const paths = runtimePaths(root);

  assert.equal(paths.runtimeDir, join(root, 'python'));
  assert.equal(paths.pythonExe, join(root, 'python', 'python.exe'));
  assert.equal(paths.cacheDir, join(root, 'cache'));
  assert.equal(paths.tempDir, join(root, 'cache', 'temp'));
  assert.equal(paths.pipCacheDir, join(root, 'cache', 'pip'));
  assert.equal(paths.servicesDir, join(root, 'services'));
});
