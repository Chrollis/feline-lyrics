import { BackendError, type DiscoveredPlugin } from '@felyrics/host';

/** The slice of `PluginHosts` this module needs, so the boot rule is testable. */
export interface PluginEnabler {
  enable(id: string): Promise<void>;
}

/** The slice of `PluginHosts` the shutdown needs. */
export interface PluginShutdown {
  list(): readonly { readonly id: string; readonly state: string }[];
  disable(id: string): Promise<void>;
}

/**
 * Starts the builtin plugins whose TS face lives in a utility process.
 *
 * A builtin plugin that fails to activate fails the startup: the app has no
 * media backend to offer, so opening the window would only show dead buttons.
 * A user plugin is not enabled here, and a manifest problem is a discovery
 * issue (shown as FAILED), not a startup failure.
 */
export async function enableBuiltinHosts(
  hosts: PluginEnabler,
  plugins: readonly DiscoveredPlugin[],
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.root !== 'builtin' || plugin.manifest.host !== 'utility') {
      continue;
    }

    try {
      await hosts.enable(plugin.manifest.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BackendError(
        'core/backend-failed',
        `${plugin.manifest.id}: ${message}`,
      );
    }
  }
}

/**
 * Stops every host that is still running.
 *
 * A retry must not fork a second utility process for a plugin whose first one
 * is still alive: the old process keeps the Python backend busy and the new
 * one would sit behind it. A failed stop is tolerated because the retry is
 * what the user asked for; the child dies with the app if it never answers.
 */
export async function shutdownHosts(hosts: PluginShutdown): Promise<void> {
  for (const plugin of hosts.list()) {
    if (plugin.state !== 'ACTIVE' && plugin.state !== 'LOADING') {
      continue;
    }

    try {
      await hosts.disable(plugin.id);
    } catch {
      // The retry still gets a fresh table; the old child exits with the app.
    }
  }
}

/** The table this module starts and stops; `PluginHosts` satisfies it. */
export interface PluginTable extends PluginEnabler, PluginShutdown {}

/**
 * Replaces the host table: stop the previous hosts first, then start the new
 * ones. Doing it in this order is what keeps one enable from leaving the
 * previous utility process running.
 *
 * A failure half-way through the new table closes what it already started:
 * otherwise the child of the first plugin would be alive but unreachable, and
 * the next shutdown would not know about it.
 */
export async function restartBuiltinHosts<Hosts extends PluginTable>(
  previous: PluginShutdown | undefined,
  plugins: readonly DiscoveredPlugin[],
  create: () => Hosts,
): Promise<Hosts> {
  if (previous !== undefined) {
    await shutdownHosts(previous);
  }

  const next = create();

  try {
    await enableBuiltinHosts(next, plugins);
  } catch (error) {
    await shutdownHosts(next);
    throw error;
  }

  return next;
}
