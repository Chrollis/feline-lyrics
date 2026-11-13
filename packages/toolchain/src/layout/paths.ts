import { join } from 'node:path';

export interface RuntimePaths {
  readonly root: string;
  readonly runtimeDir: string;
  readonly pythonExe: string;
  readonly cacheDir: string;
  readonly pipCacheDir: string;
  readonly servicesDir: string;
}

export function runtimePaths(root: string): RuntimePaths {
  const runtimeDir = join(root, 'python');
  const cacheDir = join(root, 'cache');

  return {
    root,
    runtimeDir,
    pythonExe: join(runtimeDir, 'python.exe'),
    cacheDir,
    pipCacheDir: join(cacheDir, 'pip'),
    servicesDir: join(root, 'services'),
  };
}
