import { app } from 'electron';
import { join } from 'node:path';

import { resolveHostPaths, type HostPaths } from '@felyrics/host';

import { backendPaths, type ToolchainPaths } from '@felyrics/toolchain';

import { BackendPool } from './backend-pool.js';
import {
  configureBackends as configure,
  type BackendPlugins,
  type BackendService,
} from './backend-registry.js';

/**
 * Where the four directories live for this process. Development points at the
 * repository so the CLI and the app see the same backend; a packaged app keeps
 * its writable state under userData. Both are defaults: the settings surface is
 * meant to override them later.
 *
 * Exported because the plugin hosts and the `app://job` handler have to serve
 * exactly the directories the backend was started with, and a second copy of
 * these rules would drift.
 */
export function hostPaths(): HostPaths {
  return resolveHostPaths({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
  });
}

/** The two directories the toolchain half still needs. */
export function resolvePaths(): ToolchainPaths {
  const host = hostPaths();

  return {
    cacheDir: host.cacheDir,
    backendRoot: host.backendRoot,
  };
}

function createPool(plugins: BackendPlugins): BackendService {
  return new BackendPool({
    cacheDir: plugins.host.cacheDir,
    cwd: plugins.host.backendRoot,
    builtinPython: backendPaths(plugins.host.backendRoot).venvPython,
    builtin: plugins.builtin,
    user: plugins.user,
    userPython: (id) =>
      backendPaths(join(plugins.host.pluginEnvsRoot, id)).venvPython,
  });
}

/**
 * Hands the discovered plugins to the pool. Called after discovery, before the
 * first request. The previous pool is closed first: a retry must not leave the
 * processes it started behind.
 */
export async function configureBackends(
  plugins: BackendPlugins,
): Promise<void> {
  await configure(plugins, createPool);
}

export {
  addUserBackend,
  callBackend,
  pingBackend,
  shutdownBackend,
  stopPluginBackend,
} from './backend-registry.js';
export type { BackendPlugins, BackendService } from './backend-registry.js';
