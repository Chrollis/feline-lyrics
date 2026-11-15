// uv ships one archive per platform, so the filename is data, not a constant.
// Only Windows x64 is supported for now; the other rows keep a port from having
// to rediscover the asset names.
import { ToolchainError } from '../errors.js';

export type TargetKey =
  | 'win32-x64'
  | 'win32-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64';

export interface PlatformTarget {
  readonly uvFilename: string;
  /** How uv packs that file; `extractZip` only understands the zip form. */
  readonly archive: 'zip' | 'tar.gz';
}

export const TARGETS: Readonly<Record<TargetKey, PlatformTarget>> = {
  'win32-x64': {
    uvFilename: 'uv-x86_64-pc-windows-msvc.zip',
    archive: 'zip',
  },
  'win32-arm64': {
    uvFilename: 'uv-aarch64-pc-windows-msvc.zip',
    archive: 'zip',
  },
  'darwin-x64': {
    uvFilename: 'uv-x86_64-apple-darwin.tar.gz',
    archive: 'tar.gz',
  },
  'darwin-arm64': {
    uvFilename: 'uv-aarch64-apple-darwin.tar.gz',
    archive: 'tar.gz',
  },
  'linux-x64': {
    uvFilename: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    archive: 'tar.gz',
  },
  'linux-arm64': {
    uvFilename: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    archive: 'tar.gz',
  },
};

/** Platforms the toolchain actually runs on; the rest of the table is future data. */
export const SUPPORTED_TARGETS: readonly TargetKey[] = ['win32-x64'];

export const UV_VERSION = '0.13.8';

/**
 * uv brings its own Python build, so no system Python takes part. 0.13.8 lists
 * 3.12.15 among its managed builds; a newer patch would need a uv upgrade,
 * because the downloadable list is frozen per uv release.
 */
export const PYTHON_VERSION = '3.12.15';

/** The USTC mirror carries both GitHub releases we need, uv and the Python builds. */
export const UV_DOWNLOAD_BASE =
  'https://mirrors.ustc.edu.cn/github-release/astral-sh/uv';

/**
 * python-build-standalone releases. Order matters: the mirror is tried first
 * because it is fast from China, but it proxies GitHub on demand, so a tag it
 * has not cached yet fails and the next entry takes over.
 */
export const PYTHON_INSTALL_MIRRORS: readonly [string, ...string[]] = [
  'https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone',
  'https://github.com/astral-sh/python-build-standalone/releases/download',
];

/**
 * The exact CPython build, pinned so an updated uv manifest cannot swap it
 * under us. uv 0.13.8 resolves 3.12.15 to this build; an older one is not in
 * its manifest at all.
 */
export const PYTHON_BUILD = '20261021';

export const PACKAGE_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';

export const MIN_DOWNLOAD_BYTES = 1024 ** 2;

export function uvDownloadUrl(filename: string): string {
  return `${UV_DOWNLOAD_BASE}/${UV_VERSION}/${filename}`;
}

/**
 * The target this process runs on. `SUPPORTED_TARGETS` is checked first, so a
 * table row we know the filename of does not silently start running.
 */
export function currentTarget(): PlatformTarget {
  const key = `${process.platform}-${process.arch}`;

  if (!SUPPORTED_TARGETS.includes(key as TargetKey)) {
    throw new ToolchainError(
      'target/unsupported',
      `the toolchain has no uv asset for ${key}`,
      { target: key },
    );
  }

  return TARGETS[key as TargetKey];
}
