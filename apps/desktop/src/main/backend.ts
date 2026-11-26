import { app } from 'electron';
import { join } from 'node:path';

import {
  BackendError,
  resolveHostPaths,
  type HostPaths,
} from '@felyrics/host';

import { backendPaths, type ToolchainPaths } from '@felyrics/toolchain';

import { BackendPool, type PooledPlugin } from './backend-pool.js';

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

let pool: BackendPool | null = null;

export interface BackendPlugins {
  readonly host: HostPaths;
  readonly builtin: readonly PooledPlugin[];
  readonly user: readonly PooledPlugin[];
}

/**
 * Hands the discovered plugins to the pool. Called after discovery, before the
 * first request; a call with no pool is a bug, not a state to retry.
 */
export function configureBackends(plugins: BackendPlugins): void {
  pool = new BackendPool({
    cacheDir: plugins.host.cacheDir,
    cwd: plugins.host.backendRoot,
    builtinPython: backendPaths(plugins.host.backendRoot).venvPython,
    builtin: plugins.builtin,
    user: plugins.user,
    userPython: (id) =>
      backendPaths(join(plugins.host.pluginEnvsRoot, id)).venvPython,
  });
}

function requirePool(): BackendPool {
  if (pool === null) {
    throw new BackendError(
      'core/not-ready',
      'the backend pool is not configured yet',
    );
  }

  return pool;
}

/**
 * `ping` is the liveness check, so it has to answer faster than anything else:
 * the button that awaits it sits on `asking...` until this settles, and the
 * backend may be busy inside a long synchronous decode, where the queued ping
 * waits for the whole job to finish.
 */
const PING_TIMEOUT_MS = 5_000;

export async function pingBackend(): Promise<unknown> {
  return requirePool().ping(PING_TIMEOUT_MS);
}

/**
 * The one way to ask a backend anything. The plugin id in `method` picks the
 * process: the builtin group, or the user plugin's own environment.
 *
 * `timeoutMs` is required on purpose. A default here would be a second opinion
 * about how long a method may take, held in a file that knows nothing about the
 * method: a legitimately slow call would fail at the toolchain's default, the
 * backend would keep working, and nothing would say which number to change. With
 * it required, a new call site has to name its budget in the same line that
 * names the method.
 */
export async function callBackend<T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  return requirePool().call<T>(method, params, timeoutMs);
}

export async function shutdownBackend(): Promise<number | null> {
  const current = pool;
  pool = null;

  return current === null ? null : current.close();
}

/** Stops the process of one user plugin after its hosts are disabled. */
export async function stopPluginBackend(id: string): Promise<void> {
  if (pool !== null) {
    await pool.stop(id);
  }
}
