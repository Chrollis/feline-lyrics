import { join, resolve } from 'node:path';

import { defaultSettings } from '@felyrics/toolchain';

/**
 * The directories the host owns. The embedding application decides them once and
 * hands the same layout to everything that needs it, so the app, the backend and
 * the plugin roots cannot drift apart.
 */
export interface HostPaths {
  /** Downloaded archives and job output, shared by the whole application. */
  readonly cacheDir: string;
  /** Scratch space for one operation; the app clears it at startup. */
  readonly tempDir: string;
  /** Where the Python interpreter and the venv live. */
  readonly backendRoot: string;
  /** One environment per user plugin, beside the builtin venv. */
  readonly pluginEnvsRoot: string;
  /**
   * The python half of the host itself. It is a native dependency, not a plugin:
   * the loader never scans for it, and provisioning puts it on the `.pth` beside
   * the plugin backends.
   */
  readonly hostBackendRoot: string;
  /** Plugins that ship with the application, read-only. */
  readonly builtinPluginsRoot: string;
  /** Plugins the user installed, writable. */
  readonly userPluginsRoot: string;
}

/**
 * What the embedding process knows and the host must not discover for itself:
 * Electron answers all four, and a test can supply a checkout instead.
 */
export interface HostPathInputs {
  readonly packaged: boolean;
  /** The application directory; in development it is `apps/desktop`. */
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly userData: string;
}

/**
 * The writable roots a user may move through `settings.json`. The resource
 * roots are not here: they come from the installation and cannot be moved.
 */
export interface HostPathOverrides {
  readonly backendRoot?: string;
  readonly cacheDir?: string;
  readonly tempDir?: string;
  readonly userPluginsRoot?: string;
}

/**
 * Development points at the checkout so the CLI and the app see the same
 * backend; a packaged app keeps its writable state under userData and reads the
 * bundled resources next to the executable.
 *
 * The writable roots come from the same defaults the settings document fills,
 * so the two libraries cannot disagree; an override replaces one root without
 * touching the resource locations.
 */
export function resolveHostPaths(
  inputs: HostPathInputs,
  overrides: HostPathOverrides = {},
): HostPaths {
  // `appPath` is the application package, not the repository: two levels up.
  const repoRoot = resolve(inputs.appPath, '..', '..');
  const resources = resolve(inputs.resourcesPath);
  const defaults = defaultSettings({
    packaged: inputs.packaged,
    userData: inputs.userData,
    repoRoot,
  });
  const backendRoot = resolve(overrides.backendRoot ?? defaults.backendRoot);

  return {
    cacheDir: resolve(overrides.cacheDir ?? defaults.cacheDir),
    tempDir: resolve(overrides.tempDir ?? defaults.tempDir),
    backendRoot,
    pluginEnvsRoot: join(backendRoot, 'plugin-envs'),
    hostBackendRoot: inputs.packaged
      ? join(resources, 'host', 'backend')
      : join(repoRoot, 'packages', 'host', 'backend'),
    builtinPluginsRoot: inputs.packaged
      ? join(resources, 'plugins')
      : join(repoRoot, 'plugins'),
    userPluginsRoot: resolve(
      overrides.userPluginsRoot ?? defaults.userPluginsRoot,
    ),
  };
}
