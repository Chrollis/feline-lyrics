import {
  BackendError,
  startService,
  type ServiceClient,
  type ServiceOptions,
} from '@felyrics/host';

/**
 * One backend process for the builtin plugins, and one for each user plugin.
 *
 * The split is the isolation boundary the plugin contract promises: a user
 * plugin's import of a package cannot disturb the builtin group, and stopping
 * one plugin is closing one process. The builtin group is a group on purpose --
 * those plugins ship together, share one venv, and are enabled and stopped as a
 * unit.
 */
export interface PooledPlugin {
  readonly id: string;
  readonly directory: string;
}

export interface BackendPoolOptions {
  readonly cacheDir: string;
  /** The builtin backend root; the host module and the venv live under it. */
  readonly cwd: string;
  /** The interpreter of the builtin group. */
  readonly builtinPython: string;
  readonly builtin: readonly PooledPlugin[];
  readonly user: readonly PooledPlugin[];
  /** The interpreter of one user plugin's environment, provisioned earlier. */
  readonly userPython: (id: string) => string;
  /** A test seam; the default is the real spawn. */
  readonly start?: (options: ServiceOptions) => ServiceClient;
}

function hostArgs(cacheDir: string, plugins: readonly PooledPlugin[]): string[] {
  const args = ['-m', 'felyrics_host', '--cache', cacheDir];

  for (const plugin of plugins) {
    args.push('--plugin', plugin.id, '--plugin-dir', plugin.directory);
  }

  return args;
}

export class BackendPool {
  readonly #options: BackendPoolOptions;
  readonly #start: (options: ServiceOptions) => ServiceClient;
  readonly #builtinIds: Set<string>;
  readonly #userById: Map<string, PooledPlugin>;

  #builtin: ServiceClient | null = null;
  #builtinPending: Promise<ServiceClient> | null = null;
  readonly #user = new Map<string, ServiceClient>();
  readonly #userPending = new Map<string, Promise<ServiceClient>>();

  constructor(options: BackendPoolOptions) {
    this.#options = options;
    this.#start = options.start ?? startService;
    this.#builtinIds = new Set(options.builtin.map((plugin) => plugin.id));
    this.#userById = new Map(
      options.user.map((plugin) => [plugin.id, plugin] as const),
    );
  }

  /**
   * Routes one backend call by the plugin id in its name. The lifecycle layer
   * already sent `${pluginId}/${shortName}`, so the id is the routing key and
   * the method that follows is what the backend sees.
   */
  async call<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const slash = method.indexOf('/');

    if (slash <= 0 || slash === method.length - 1) {
      throw new BackendError(
        'protocol/unknown-method',
        `"${method}" is not a plugin method name`,
      );
    }

    const id = method.slice(0, slash);
    const service = await this.#serviceFor(id);

    return service.request<T>(method, params, { timeoutMs });
  }

  async ping(timeoutMs = 5_000): Promise<unknown> {
    const service = await this.#builtinService();

    return service.request('ping', {}, { timeoutMs });
  }

  async #serviceFor(id: string): Promise<ServiceClient> {
    if (this.#builtinIds.has(id)) {
      return this.#builtinService();
    }

    if (this.#userById.has(id)) {
      return this.#userService(id);
    }

    throw new BackendError(
      'core/not-ready',
      `no backend process is configured for ${id}`,
    );
  }

  #builtinService(): Promise<ServiceClient> {
    if (this.#builtin) {
      return Promise.resolve(this.#builtin);
    }

    this.#builtinPending ??= Promise.resolve()
      .then(() => this.#start(this.#serviceOptions(this.#options.builtinPython, this.#options.builtin, 'builtin')))
      .then((service) => {
        this.#builtin = service;

        return service;
      })
      .finally(() => {
        this.#builtinPending = null;
      });

    return this.#builtinPending;
  }

  #userService(id: string): Promise<ServiceClient> {
    const running = this.#user.get(id);

    if (running) {
      return Promise.resolve(running);
    }

    const pending = this.#userPending.get(id);

    if (pending) {
      return pending;
    }

    const plugin = this.#userById.get(id)!;
    const launching = Promise.resolve()
      .then(() =>
        this.#start(
          this.#serviceOptions(this.#options.userPython(id), [plugin], id),
        ),
      )
      .then((service) => {
        this.#user.set(id, service);

        return service;
      })
      .finally(() => {
        this.#userPending.delete(id);
      });

    this.#userPending.set(id, launching);

    return launching;
  }

  #serviceOptions(
    pythonExe: string,
    plugins: readonly PooledPlugin[],
    label: string,
  ): ServiceOptions {
    return {
      pythonExe,
      args: hostArgs(this.#options.cacheDir, plugins),
      cwd: this.#options.cwd,
      onStderr: (line) => {
        console.error(`[backend:${label}]`, line);
      },
      onProtocolError: (line, error) => {
        console.error(`[backend:${label}]`, line, error.message);
      },
    };
  }

  /** Stops one user plugin's process; the next call spawns it again. */
  async stop(id: string): Promise<void> {
    const service = this.#user.get(id);

    this.#user.delete(id);

    if (service) {
      await service.close();
    }
  }

  /** Closes every process; the pool is reusable afterwards. */
  async close(): Promise<number | null> {
    const clients = [
      ...(this.#builtin === null ? [] : [this.#builtin]),
      ...this.#user.values(),
    ];

    this.#builtin = null;
    this.#user.clear();

    let code: number | null = null;

    for (const client of clients) {
      try {
        code = (await client.close()) ?? code;
      } catch (error) {
        console.error('[backend] close failed', error);
      }
    }

    return code;
  }
}
