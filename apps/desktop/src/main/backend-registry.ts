import { BackendError, type HostPaths } from '@felyrics/host';

/**
 * The one live backend pool, kept apart from the Electron paths so it can be
 * tested without an app object.
 *
 * `configureBackends` closes the previous pool before it installs the next one:
 * a retry rebuilds the pool, and the processes the old pool may have started
 * (a builtin group, a user plugin) have to die with it, not wait for the app to
 * exit.
 */

export interface BackendPlugin {
  readonly id: string;
  readonly directory: string;
}

export interface BackendPlugins {
  readonly host: Pick<HostPaths, 'cacheDir' | 'backendRoot' | 'pluginEnvsRoot'>;
  readonly builtin: readonly BackendPlugin[];
  readonly user: readonly BackendPlugin[];
}

export interface BackendService {
  ping(timeoutMs: number): Promise<unknown>;
  call<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T>;
  stop(id: string): Promise<void>;
  close(): Promise<number | null>;
}

export type BackendFactory = (plugins: BackendPlugins) => BackendService;

let service: BackendService | null = null;

export async function configureBackends(
  plugins: BackendPlugins,
  create: BackendFactory,
): Promise<void> {
  await shutdownBackend();
  service = create(plugins);
}

function requireService(): BackendService {
  if (service === null) {
    throw new BackendError(
      'core/not-ready',
      'the backend pool is not configured yet',
    );
  }

  return service;
}

/**
 * `ping` is the liveness check, so it has to answer faster than anything else:
 * the button that awaits it sits on `asking...` until this settles, and the
 * backend may be busy inside a long synchronous decode, where the queued ping
 * waits for the whole job to finish.
 */
const PING_TIMEOUT_MS = 5_000;

export async function pingBackend(): Promise<unknown> {
  return requireService().ping(PING_TIMEOUT_MS);
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
  return requireService().call<T>(method, params, timeoutMs);
}

export async function shutdownBackend(): Promise<number | null> {
  const current = service;
  service = null;

  return current === null ? null : current.close();
}

/** Stops the process of one user plugin after its hosts are disabled. */
export async function stopPluginBackend(id: string): Promise<void> {
  if (service !== null) {
    await service.stop(id);
  }
}
