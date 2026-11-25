import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { execa } from 'execa';

import { ToolchainError } from '../errors.js';
import { buildUvEnv } from '../layout/env.js';
import {
  backendPaths,
  cachePaths,
  type ToolchainPaths,
} from '../layout/paths.js';
import { DEFAULT_MIRRORS } from '../mirrors.js';
import { extractZip } from '../process/zip.js';
import { download } from './download.js';
import {
  MIN_DOWNLOAD_BYTES,
  PYTHON_BUILD,
  UV_VERSION,
  type PlatformTarget,
} from './target.js';

export interface UvRunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly signal?: AbortSignal;
}

export interface UvResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunUv = (
  uvExe: string,
  args: readonly string[],
  options: UvRunOptions,
) => Promise<UvResult>;

/**
 * What every uv command needs. `tempDir` is owned by the caller: it creates the
 * directory and deletes it, the toolchain only points uv at it.
 */
export interface UvContext {
  readonly paths: ToolchainPaths;
  readonly tempDir: string;
  readonly run?: RunUv;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly signal?: AbortSignal;
}

/**
 * Exported so the streaming contract can be tested without a real uv: hand it
 * another executable and the same arguments.
 */
export async function runUv(
  uvExe: string,
  args: readonly string[],
  options: UvRunOptions,
): Promise<UvResult> {
  // On Windows a missing executable is not reported as a spawn error: the OS
  // runs it and exits with status 1, so `failed` is true but there is no
  // `exitCode === undefined` to detect. The existence check is therefore ours.
  // It stays a plain Error: a missing uv.exe is a broken installation, not a
  // provisioning step we branch on with a `uv/*` code.
  if (!existsSync(uvExe)) {
    throw new Error(`uv executable not found at ${uvExe}`);
  }

  const child = execa(uvExe, [...args], {
    reject: false,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const decode = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  // A chunk boundary can fall inside a multi-byte character. Decoding runs
  // across chunks so a split character is emitted once, not twice broken.
  const forward =
    (stream: 'stdout' | 'stderr') =>
    (chunk: Buffer): void => {
      const text = decode[stream].write(chunk);

      if (text.length > 0) {
        options.onOutput?.(text, stream);
      }
    };

  child.stdout?.on('data', forward('stdout'));
  child.stderr?.on('data', forward('stderr'));

  const result = await child;

  // Whatever the decoder still holds is flushed here; a genuinely truncated
  // sequence becomes U+FFFD, which is the honest output.
  for (const stream of ['stdout', 'stderr'] as const) {
    const rest = decode[stream].end();

    if (rest.length > 0) {
      options.onOutput?.(rest, stream);
    }
  }

  return {
    status: result.exitCode ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

type UvFailureCode =
  'uv/install-failed' | 'uv/venv-failed' | 'uv/packages-failed';

function failure(
  code: UvFailureCode,
  command: string,
  result: UvResult,
): ToolchainError {
  const how =
    result.status === null
      ? 'was killed'
      : `exited with status ${result.status}`;
  const tail = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

  return new ToolchainError(
    code,
    `uv ${command} ${how}${tail === undefined ? '' : `: ${tail}`}`,
    {
      command: `uv ${command}`,
      ...(result.status === null ? {} : { status: result.status }),
    },
  );
}

function runOptions(
  ctx: UvContext,
  installMirror: string = DEFAULT_MIRRORS.python[0]!,
  packageIndex: string = DEFAULT_MIRRORS.packages[0]!,
): UvRunOptions {
  return {
    env: uvEnv(ctx, installMirror, packageIndex),
    ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

export function uvEnv(
  ctx: UvContext,
  installMirror: string = DEFAULT_MIRRORS.python[0]!,
  packageIndex: string = DEFAULT_MIRRORS.packages[0]!,
): NodeJS.ProcessEnv {
  const backend = backendPaths(ctx.paths.backendRoot);

  return buildUvEnv({
    tempDir: ctx.tempDir,
    cacheDir: cachePaths(ctx.paths.cacheDir).uv,
    pythonInstallDir: backend.pythonDir,
    installMirror,
    pythonBuild: PYTHON_BUILD,
    packageIndex,
  });
}

/** Where the uv archive is cached. The version is part of the path. */
export function uvArchivePath(
  cacheDir: string,
  target: PlatformTarget,
): string {
  return join(
    cachePaths(cacheDir).downloads,
    'uv',
    UV_VERSION,
    target.uvFilename,
  );
}

function hasCachedArchive(file: string): boolean {
  try {
    return statSync(file).size >= MIN_DOWNLOAD_BYTES;
  } catch {
    return false;
  }
}

export interface DownloadUvOptions {
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (received: number, total: number | null) => void;
  /**
   * URL templates for the uv zip, tried in order. Omitted means the built-in
   * official source; the app passes the user's `mirrors.json` list.
   */
  readonly sources?: readonly string[];
}

/**
 * Tries one URL per source until one download completes.
 *
 * `download` already retries the same URL through transient failures; this is
 * the layer above it, for sources that answer 404 (a mirror that only keeps the
 * newest tag) or refuse the request outright. Cancellation is not a fallback.
 */
async function fetchFirst(
  urls: readonly string[],
  attempt: (url: string) => Promise<unknown>,
): Promise<void> {
  let last: unknown;

  for (const url of urls) {
    try {
      await attempt(url);

      return;
    } catch (error) {
      if (
        error instanceof ToolchainError &&
        error.code === 'download/cancelled'
      ) {
        throw error;
      }

      last = error;
    }
  }

  if (last instanceof Error) {
    throw last;
  }

  throw new ToolchainError('download/failed', 'no uv source is configured', {});
}

/**
 * Downloads and unpacks the uv binary. Both steps are skipped when their result
 * is already there: re-extracting a running uv.exe fails on Windows.
 */
export async function downloadUv(
  ctx: UvContext,
  target: PlatformTarget,
  options: DownloadUvOptions = {},
): Promise<string> {
  if (target.archive !== 'zip') {
    throw new ToolchainError(
      'target/unsupported',
      `cannot unpack ${target.uvFilename}: only zip archives are supported`,
      { target: target.uvFilename },
    );
  }

  const backend = backendPaths(ctx.paths.backendRoot);
  const archive = uvArchivePath(ctx.paths.cacheDir, target);
  const templates = options.sources ?? DEFAULT_MIRRORS.uv;
  const urls = templates.map((source) =>
    source.replaceAll('{asset}', target.uvFilename),
  );

  const fetchArchive = () =>
    fetchFirst(urls, (url) =>
      download({
        url,
        dest: archive,
        minBytes: MIN_DOWNLOAD_BYTES,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    );

  if (!hasCachedArchive(archive)) {
    await fetchArchive();
  }

  if (!existsSync(backend.uvExe)) {
    try {
      await extractZip(archive, dirname(backend.uvExe));
    } catch (error) {
      // The cache is disposable input, so a damaged archive must heal itself
      // instead of failing every later run. Size is the only cheap test we have
      // (`hasCachedArchive`), and it cannot tell a truncated download from a
      // good one -- the unpack is the first place that can.
      if (
        !(error instanceof ToolchainError) ||
        error.code !== 'archive/unusable'
      ) {
        throw error;
      }

      await rm(archive, { force: true });
      await fetchArchive();
      await extractZip(archive, dirname(backend.uvExe));
    }
  }

  if (!existsSync(backend.uvExe)) {
    throw new ToolchainError(
      'uv/missing-binary',
      `the uv archive ${archive} does not contain uv.exe`,
      { archive, entry: 'uv.exe' },
    );
  }

  return backend.uvExe;
}

/**
 * Rebuilds the venv from scratch with the interpreter the downloader unpacked.
 * `--clear` is deliberate: provisioning is an all-or-nothing operation, and a
 * venv left over from an older layout or an older dependency set must not
 * survive. `--python` takes the absolute path, so uv does not go looking for a
 * managed 3.12 it may have installed earlier under another version.
 */
export async function createVenv(
  ctx: UvContext,
  pythonExecutable: string,
): Promise<void> {
  const backend = backendPaths(ctx.paths.backendRoot);
  const run = ctx.run ?? runUv;
  const args = ['venv', backend.venvDir, '--python', pythonExecutable, '--clear'];

  const result = await run(backend.uvExe, args, runOptions(ctx));

  if (result.status !== 0) {
    throw failure('uv/venv-failed', 'venv', result);
  }
}

export interface InstallPackagesOptions {
  /**
   * Package indexes, primary first. Each one is a separate `uv pip install`
   * run: uv resolves against every index it is given at once, which is not a
   * fallback and can mix packages from two mirrors. Omitted means the built-in
   * official index; the app passes the user's list.
   */
  readonly indexes?: readonly string[];
}

/** Installs exact requirement strings into the venv; an empty list is a no-op. */
export async function installPackages(
  ctx: UvContext,
  requirements: readonly string[],
  options: InstallPackagesOptions = {},
): Promise<void> {
  if (requirements.length === 0) {
    return;
  }

  const backend = backendPaths(ctx.paths.backendRoot);
  const run = ctx.run ?? runUv;
  const indexes = options.indexes ?? DEFAULT_MIRRORS.packages;
  const args = [
    'pip',
    'install',
    '--python',
    backend.venvPython,
    ...requirements,
  ];
  let last: ToolchainError | undefined;

  for (const index of indexes) {
    const result = await run(
      backend.uvExe,
      args,
      runOptions(ctx, undefined, index),
    );

    if (result.status === 0) {
      return;
    }

    last = failure('uv/packages-failed', 'pip install', result);

    if (ctx.signal?.aborted === true) {
      break;
    }
  }

  if (last !== undefined) {
    throw last;
  }

  throw new ToolchainError(
    'uv/packages-failed',
    'no package index is configured',
    { command: 'uv pip install' },
  );
}
