import { app } from 'electron';
import { join, resolve } from 'node:path';

import {
  resolveHostPaths,
  type HostPathInputs,
  type HostPaths,
} from '@felyrics/host';

import {
  assertWritableRoots,
  backendPaths,
  defaultSettings,
  loadSettings,
  resolveSettingsPath,
  type Settings,
  type SettingsInputs,
  type ToolchainPaths,
} from '@felyrics/toolchain';

import { BackendPool } from './backend-pool.js';
import {
  configureBackends as configure,
  type BackendPlugins,
  type BackendService,
} from './backend-registry.js';
import { createProcessJob } from './process-job.js';

/** The resolved layout, replaced after every settings load. */
let current: HostPaths | null = null;

function hostPathInputs(): HostPathInputs {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
  };
}

function settingsInputs(): SettingsInputs {
  const inputs = hostPathInputs();

  return {
    packaged: inputs.packaged,
    userData: inputs.userData,
    repoRoot: resolve(inputs.appPath, '..', '..'),
  };
}

/**
 * Reads `settings.json` and caches the layout it describes. Called before
 * provisioning, and again on Retry, so an edited file is picked up without a
 * restart.
 */
export async function loadHostPaths(): Promise<HostPaths> {
  const inputs = hostPathInputs();
  const settingsInputsValue = settingsInputs();
  const file = resolveSettingsPath(settingsInputsValue);
  const settings = await loadSettings(file);
  const defaults = defaultSettings(settingsInputsValue);
  const merged: Required<Settings> = {
    backendRoot: settings.backendRoot ?? defaults.backendRoot,
    cacheDir: settings.cacheDir ?? defaults.cacheDir,
    tempDir: settings.tempDir ?? defaults.tempDir,
    userPluginsRoot: settings.userPluginsRoot ?? defaults.userPluginsRoot,
  };

  assertWritableRoots(merged, file, inputs.userData);
  current = resolveHostPaths(inputs, merged);

  return current;
}

/**
 * Where the four directories live for this process. Development points at the
 * repository so the CLI and the app see the same backend; a packaged app keeps
 * its writable state under userData. Before the first settings load these are
 * the build-kind defaults.
 *
 * Exported because the plugin hosts and the `app://job` handler have to serve
 * exactly the directories the backend was started with, and a second copy of
 * these rules would drift.
 */
export function hostPaths(): HostPaths {
  if (current !== null) {
    return current;
  }

  return resolveHostPaths(hostPathInputs());
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
    // On Windows every backend gets a job; its tree dies with the handle even
    // when this process cannot run `taskkill`. Other platforms rely on the
    // process group the service creates for itself.
    ...(process.platform === 'win32'
      ? { createJob: createProcessJob }
      : {}),
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
