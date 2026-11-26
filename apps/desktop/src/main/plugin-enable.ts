import { BackendError, type PluginManifest } from '@felyrics/host';

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
