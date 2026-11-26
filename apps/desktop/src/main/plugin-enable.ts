import { BackendError, type PluginManifest } from '@felyrics/host';
import { readRequirements } from '@felyrics/toolchain';

import type { PluginSummary } from '../preload/api.js';

/**
 * What enabling a user plugin has to do before its hosts may activate it.
 *
 * The utility host is the only one implemented: a `renderer`-host plugin would
 * have to run its TS face in the window, and until that host exists the enable
 * call says so instead of starting the plugin in the wrong process. A plugin
 * without a python backend has no environment to build, so the venv step is
 * skipped rather than failing on a missing requirements file.
 */
export interface UserEnablePlan {
  readonly provision: boolean;
}

export function planUserEnable(manifest: PluginManifest): UserEnablePlan {
  if (manifest.host !== 'utility') {
    throw new BackendError(
      'core/not-ready',
      `${manifest.id} runs in the renderer, and the renderer host is not available yet`,
    );
  }

  return { provision: manifest.python !== undefined };
}

/**
 * Reads a user plugin's requirements, naming the missing file as a manifest
 * error. `readRequirements` throws ENOENT, which the IPC layer would flatten
 * into `ipc/unexpected`; the builtin path already treats a missing file as
 * `core/manifest-invalid`, and the two must read the same to the user.
 */
export function readPluginRequirements(
  id: string,
  backendDirectory: string,
  read: (directory: string) => readonly string[] = readRequirements,
): readonly string[] {
  try {
    return read(backendDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BackendError(
        'core/manifest-invalid',
        `${id}: backend/requirements.txt is missing`,
      );
    }

    throw error;
  }
}

/**
 * Runs `run` once per id; a second call while the first is in flight gets the
 * same promise. `uv venv --clear` writes one directory per id, so two enables
 * racing would have the second clear the environment the first is building.
 */
export function oncePerId<T>(
  pending: Map<string, Promise<T>>,
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  const running = pending.get(id);

  if (running !== undefined) {
    return running;
  }

  const task = run().finally(() => {
    if (pending.get(id) === task) {
      pending.delete(id);
    }
  });

  pending.set(id, task);

  return task;
}

/** What the controller needs from the app: no Electron, no globals. */
export interface UserPluginActions {
  provision(id: string, plugin: PluginManifest): Promise<void>;
  enableHost(id: string): Promise<void>;
  disableHost(id: string): Promise<void>;
  stopBackend(id: string): Promise<void>;
  list(): Promise<readonly PluginSummary[]> | readonly PluginSummary[];
}

/**
 * Enabling a user plugin is two operations with one failure story: build its
 * environment first (so a missing dependency is reported before any plugin code
 * runs), then let the host table activate it. The backend process starts on the
 * first method call, so an enabled plugin with no traffic costs no process.
 *
 * One controller per app keeps the per-id in-flight map; two windows or a
 * double-clicked button must not build the same venv twice.
 */
export class UserPluginController {
  readonly #pending = new Map<string, Promise<readonly PluginSummary[]>>();
  readonly #find: (id: string) => PluginManifest;
  readonly #actions: UserPluginActions;

  constructor(
    find: (id: string) => PluginManifest,
    actions: UserPluginActions,
  ) {
    this.#find = find;
    this.#actions = actions;
  }

  enable(id: string): Promise<readonly PluginSummary[]> {
    return oncePerId(this.#pending, id, async () => {
      const manifest = this.#find(id);

      if (planUserEnable(manifest).provision) {
        await this.#actions.provision(id, manifest);
      }

      await this.#actions.enableHost(id);

      return this.#actions.list();
    });
  }

  /** Disable first, then close the process: a closed process cannot answer. */
  async disable(id: string): Promise<readonly PluginSummary[]> {
    this.#find(id);

    // An enable that is still building the environment must settle first: its
    // `uv venv --clear` and the disable's process stop would otherwise race.
    const pending = this.#pending.get(id);

    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }

    await this.#actions.disableHost(id);
    await this.#actions.stopBackend(id);

    return this.#actions.list();
  }
}
