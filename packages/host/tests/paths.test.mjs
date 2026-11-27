import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { resolveHostPaths } from '../dist/index.js';

function devInputs() {
  return {
    packaged: false,
    appPath: join(resolve('.'), 'apps', 'desktop'),
    resourcesPath: resolve('unused-resources'),
    userData: resolve('user-data'),
  };
}

function devRepo() {
  return resolve(devInputs().appPath, '..', '..');
}

test('development paths hang off the checkout', () => {
  const inputs = devInputs();
  const paths = resolveHostPaths(inputs);
  const repo = devRepo();

  assert.deepEqual(paths, {
    cacheDir: join(repo, 'cache'),
    tempDir: join(repo, '.temp'),
    backendRoot: join(repo, 'python'),
    pluginEnvsRoot: join(repo, 'python', 'plugin-envs'),
    hostBackendRoot: join(repo, 'packages', 'host', 'backend'),
    builtinPluginsRoot: join(repo, 'plugins'),
    userPluginsRoot: join(inputs.userData, 'plugins'),
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
    tempDir: join(userData, 'temp'),
    backendRoot: join(userData, 'backend'),
    pluginEnvsRoot: join(userData, 'backend', 'plugin-envs'),
    hostBackendRoot: join(resources, 'host', 'backend'),
    builtinPluginsRoot: join(resources, 'plugins'),
    userPluginsRoot: join(userData, 'plugins'),
  });
});

test('a backendRoot override moves the venv root and the plugin environments', () => {
  const backendRoot = resolve('custom-backend');
  const paths = resolveHostPaths(devInputs(), { backendRoot });
  const repo = devRepo();

  assert.equal(paths.backendRoot, backendRoot);
  assert.equal(paths.pluginEnvsRoot, join(backendRoot, 'plugin-envs'));
  assert.equal(paths.hostBackendRoot, join(repo, 'packages', 'host', 'backend'));
  assert.equal(paths.builtinPluginsRoot, join(repo, 'plugins'));
});

test('a cacheDir override leaves the other roots alone', () => {
  const cacheDir = resolve('custom-cache');
  const paths = resolveHostPaths(devInputs(), { cacheDir });
  const repo = devRepo();

  assert.equal(paths.cacheDir, cacheDir);
  assert.equal(paths.backendRoot, join(repo, 'python'));
  assert.equal(paths.tempDir, join(repo, '.temp'));
});

test('a tempDir override leaves the other roots alone', () => {
  const tempDir = resolve('custom-temp');
  const paths = resolveHostPaths(devInputs(), { tempDir });
  const repo = devRepo();

  assert.equal(paths.tempDir, tempDir);
  assert.equal(paths.cacheDir, join(repo, 'cache'));
  assert.equal(paths.backendRoot, join(repo, 'python'));
});

test('a userPluginsRoot override leaves the venv under the backend root', () => {
  const userPluginsRoot = resolve('custom-plugins');
  const paths = resolveHostPaths(devInputs(), { userPluginsRoot });
  const repo = devRepo();

  assert.equal(paths.userPluginsRoot, userPluginsRoot);
  assert.equal(paths.backendRoot, join(repo, 'python'));
  assert.equal(paths.pluginEnvsRoot, join(repo, 'python', 'plugin-envs'));
});
