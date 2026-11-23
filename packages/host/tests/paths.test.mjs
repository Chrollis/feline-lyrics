import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { resolveHostPaths } from '../dist/index.js';

test('development paths hang off the checkout', () => {
  const appPath = join(resolve('.'), 'apps', 'desktop');
  const userData = resolve('user-data');
  const paths = resolveHostPaths({
    packaged: false,
    appPath,
    resourcesPath: resolve('unused-resources'),
    userData,
  });
  const repo = resolve(appPath, '..', '..');

  assert.deepEqual(paths, {
    cacheDir: join(repo, 'cache'),
    backendRoot: join(repo, 'python'),
    servicesDir: join(repo, 'services'),
    builtinPluginsRoot: join(repo, 'plugins'),
    userPluginsRoot: join(userData, 'plugins'),
  });
});

test('packaged paths split resources from writable state', () => {
  const userData = resolve('user-data');
  const resources = resolve('resources');
  const paths = resolveHostPaths({
    packaged: true,
    appPath: resolve('app.asar'),
    resourcesPath: resources,
    userData,
  });

  assert.deepEqual(paths, {
    cacheDir: join(userData, 'cache'),
    backendRoot: join(userData, 'backend'),
    servicesDir: join(resources, 'services'),
    builtinPluginsRoot: join(resources, 'plugins'),
    userPluginsRoot: join(userData, 'plugins'),
  });
});
