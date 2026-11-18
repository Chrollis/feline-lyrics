import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  backendPaths,
  startService,
  ToolchainError,
  type ServiceClient,
  type ToolchainPaths,
} from '@felyrics/toolchain';

/**
 * Where the three directories live for this process. Development points at the
 * repository so the CLI and the app see the same backend; a packaged app keeps
 * its writable state under userData. Both are defaults: the settings surface is
 * meant to override them later.
 */
function resolvePaths(): ToolchainPaths {
  if (app.isPackaged) {
    const userData = app.getPath('userData');

    return {
      cacheDir: join(userData, 'cache'),
      backendRoot: join(userData, 'backend'),
      servicesDir: join(process.resourcesPath, 'services'),
    };
  }

  const repoRoot = resolve(app.getAppPath(), '..', '..');

  return {
    cacheDir: join(repoRoot, 'cache'),
    backendRoot: join(repoRoot, 'python'),
    servicesDir: join(repoRoot, 'services'),
  };
}

let client: ServiceClient | null = null;
let launching: Promise<ServiceClient> | null = null;

async function launch(): Promise<ServiceClient> {
  const paths = resolvePaths();
  const backend = backendPaths(paths.backendRoot);

  if (!existsSync(backend.venvPython)) {
    throw new ToolchainError(
      'backend/not-provisioned',
      `the python backend is not provisioned at ${backend.venvPython}; run: npm run python -- --setup`,
      { command: 'npm run python -- --setup' },
    );
  }

  return startService({
    pythonExe: backend.venvPython,
    args: ['-m', 'felyrics', '--cache', paths.cacheDir],
    cwd: paths.servicesDir,
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
 * process died". `timeoutMs` bounds the wait, because a method that silently
 * takes minutes (decoding a large video) would otherwise leave the renderer
 * waiting with no way to tell it from a hang.
 */
export async function callBackend<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const service = await ensureService();

  return service.request<T>(
    method,
    params,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

export async function shutdownBackend(): Promise<number | null> {
  const current = client;
  client = null;

  return current ? current.close() : null;
}
