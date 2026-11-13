const DENIED = new Set([
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'VIRTUAL_ENV',
]);

export interface EnvDirs {
  readonly tempDir: string;
  readonly pipCacheDir: string;
}

export function buildEnv(
  dirs: EnvDirs,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;

    const upper = key.toUpperCase();

    if (upper.startsWith('PIP_') || DENIED.has(upper)) {
      continue;
    }

    env[key] = value;
  }

  env.PYTHONNOUSERSITE = '1';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_CACHE_DIR = dirs.pipCacheDir;
  env.TEMP = dirs.tempDir;
  env.TMP = dirs.tempDir;

  return env;
}
