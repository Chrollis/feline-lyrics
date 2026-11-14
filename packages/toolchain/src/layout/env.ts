const DENIED = new Set([
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'VIRTUAL_ENV',
]);

function copyEnv(
  base: NodeJS.ProcessEnv,
  drop: (upper: string) => boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;

    if (!drop(key.toUpperCase())) {
      env[key] = value;
    }
  }

  return env;
}

export interface EnvDirs {
  readonly tempDir: string;
  readonly pipCacheDir: string;
}

export function buildEnv(
  dirs: EnvDirs,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = copyEnv(
    base,
    (upper) => upper.startsWith('PIP_') || DENIED.has(upper),
  );

  env.PYTHONNOUSERSITE = '1';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_CACHE_DIR = dirs.pipCacheDir;
  env.TEMP = dirs.tempDir;
  env.TMP = dirs.tempDir;

  return env;
}

export interface UvEnvDirs {
  readonly tempDir: string;
  readonly cacheDir: string;
  readonly pythonInstallDir: string;
  readonly installMirror: string;
  readonly packageIndex: string;
}

/**
 * The environment every uv command runs in. Mirrors and directories are
 * injected rather than read from the process, so a user's own UV_* settings
 * cannot redirect where the backend is installed.
 */
export function buildUvEnv(
  dirs: UvEnvDirs,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = copyEnv(
    base,
    (upper) =>
      upper.startsWith('UV_') || upper.startsWith('PIP_') || DENIED.has(upper),
  );

  env.UV_NO_CONFIG = '1';
  env.UV_CACHE_DIR = dirs.cacheDir;
  env.UV_PYTHON_INSTALL_DIR = dirs.pythonInstallDir;
  env.UV_PYTHON_INSTALL_MIRROR = dirs.installMirror;
  env.UV_PYTHON_PREFERENCE = 'only-managed';
  env.UV_PYTHON_DOWNLOADS = 'manual';
  env.UV_DEFAULT_INDEX = dirs.packageIndex;
  env.TEMP = dirs.tempDir;
  env.TMP = dirs.tempDir;

  return env;
}
