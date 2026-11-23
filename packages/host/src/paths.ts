import { join, resolve } from 'node:path';

/**
 * The directories the host owns. The embedding application decides them once and
 * hands the same layout to everything that needs it, so the app, the backend and
 * the plugin roots cannot drift apart.
 */
export interface HostPaths {
  /** Downloaded archives and job output, shared by the whole application. */
  readonly cacheDir: string;
  /** Where the Python interpreter and the venv live. */
  readonly backendRoot: string;
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
 * Development points at the checkout so the CLI and the app see the same
 * backend; a packaged app keeps its writable state under userData and reads the
 * bundled resources next to the executable.
 */
export function resolveHostPaths(inputs: HostPathInputs): HostPaths {
  if (inputs.packaged) {
    const userData = resolve(inputs.userData);
    const resources = resolve(inputs.resourcesPath);

    return {
      cacheDir: join(userData, 'cache'),
      backendRoot: join(userData, 'backend'),
      builtinPluginsRoot: join(resources, 'plugins'),
      userPluginsRoot: join(userData, 'plugins'),
    };
  }

  // `appPath` is the application package, not the repository: two levels up.
  const repoRoot = resolve(inputs.appPath, '..', '..');

  return {
    cacheDir: join(repoRoot, 'cache'),
    backendRoot: join(repoRoot, 'python'),
    builtinPluginsRoot: join(repoRoot, 'plugins'),
    userPluginsRoot: join(resolve(inputs.userData), 'plugins'),
  };
}
