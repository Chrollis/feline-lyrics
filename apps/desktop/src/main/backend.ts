import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveHostPaths,
  startService,
  type HostPaths,
  type ServiceClient,
} from '@felyrics/host';
import {
  backendPaths,
  ToolchainError,
  type ToolchainPaths,
} from '@felyrics/toolchain';

function hostPaths(): HostPaths {
  return resolveHostPaths({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
  });
}

/**
 * Where the three directories live for this process. Development points at the
 * repository so the CLI and the app see the same backend; a packaged app keeps
 * its writable state under userData. Both are defaults: the settings surface is
 * meant to override them later.
 *
 * Exported because the `app://job` handler has to serve exactly the directory
 * the backend was started with, and a second copy of these rules would drift.
 */
export function resolvePaths(): ToolchainPaths {
  const host = hostPaths();

  return {
    cacheDir: host.cacheDir,
    backendRoot: host.backendRoot,
  };
}

let client: ServiceClient | null = null;
let launching: Promise<ServiceClient> | null = null;

async function launch(): Promise<ServiceClient> {
  const host = hostPaths();
  const backend = backendPaths(host.backendRoot);

  if (!existsSync(backend.venvPython)) {
    throw new ToolchainError(
      'backend/not-provisioned',
      `the python backend is not provisioned at ${backend.venvPython}; run: npm run python -- --setup`,
      { command: 'npm run python -- --setup' },
    );
  }

  return startService({
    pythonExe: backend.venvPython,
    args: [
      '-m',
      'felyrics_host',
      '--cache',
      host.cacheDir,
      '--plugin',
      'felyrics.media',
      '--plugin-dir',
      join(host.builtinPluginsRoot, 'felyrics.media'),
    ],
    cwd: host.backendRoot,
    onStderr: (line) => {
      console.error('[backend]', line);
    },
    onProtocolError: (message) => {
      console.error('[backend]', message);
    },
  });
}

/**
 * One process per app run, started on first use. A failed launch is not cached:
 * the next request retries, so fixing the backend does not need a restart.
 */
async function ensureService(): Promise<ServiceClient> {
  if (client) {
    return client;
  }

  launching ??= launch()
    .then((service) => {
      client = service;

      return service;
    })
    .finally(() => {
      launching = null;
    });

  return launching;
}

/**
 * `ping` is the liveness check, so it has to answer faster than anything else:
 * the button that awaits it sits on `asking...` until this settles, and the
 * backend may be busy inside a long synchronous decode, where the queued ping
 * waits for the whole job to finish.
 */
const PING_TIMEOUT_MS = 5_000;

export async function pingBackend(): Promise<unknown> {
  const service = await ensureService();

  return service.request('ping', {}, { timeoutMs: PING_TIMEOUT_MS });
}

/**
 * The one way to ask the backend anything. `params` stays `Record<string,
 * unknown>` on purpose: the protocol is JSON, and each surface types its own
 * answer in the bridge contract rather than here.
 *
 * A failure the backend reported arrives as a `BackendError` with its `code`
 * intact, so the caller can tell "this file has no audio stream" from "the
 * process died".
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
  const service = await ensureService();

  return service.request<T>(method, params, { timeoutMs });
}

export async function shutdownBackend(): Promise<number | null> {
  const current = client;
  client = null;

  return current ? current.close() : null;
}
