import { BackendError, type DiscoveredPlugin } from '@felyrics/host';

/** The slice of `PluginHosts` this module needs, so the boot rule is testable. */
export interface PluginEnabler {
  enable(id: string): Promise<void>;
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
