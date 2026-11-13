import { join, resolve } from 'node:path';

/**
 * The directories the embedding application owns. The toolchain never invents
 * them: the CLI passes the repository layout, the Electron main process passes
 * the application layout, and a settings page passes what the user picked.
 */
export interface ToolchainPaths {
  /** Downloaded archives and tool caches, shared by the whole application. */
  readonly cacheDir: string;
  /** Read-only sources the backend runs from. */
  readonly servicesDir: string;
  /** Where the Python backend lives: uv, the interpreter, the venv, the marker. */
  readonly backendRoot: string;
}

export interface CachePaths {
  readonly downloads: string;
  readonly uv: string;
  readonly wheels: string;
}

export interface BackendPaths {
  readonly root: string;
  readonly uvExe: string;
  readonly pythonDir: string;
  readonly venvDir: string;
  readonly venvPython: string;
  readonly sitePackages: string;
  readonly readyMarker: string;
}

/**
 * Paths inside the shared cache. The layout is ours, so the only input is the
 * root the caller chose.
 */
export function cachePaths(cacheDir: string): CachePaths {
  const root = resolve(cacheDir);

  return {
    downloads: join(root, 'downloads'),
    uv: join(root, 'uv'),
    wheels: join(root, 'wheels'),
  };
}

/**
 * Paths inside the backend root. Everything is resolved to an absolute path:
 * the venv records absolute paths, so a relative root would break the moment
 * the caller's working directory changes.
 */
export function backendPaths(backendRoot: string): BackendPaths {
  const root = resolve(backendRoot);
  const venvDir = join(root, 'venv');

  return {
    root,
    uvExe: join(root, 'uv', 'uv.exe'),
    pythonDir: join(root, 'python'),
    venvDir,
    venvPython: join(venvDir, 'Scripts', 'python.exe'),
    sitePackages: join(venvDir, 'Lib', 'site-packages'),
    readyMarker: join(root, '.ready'),
  };
}
