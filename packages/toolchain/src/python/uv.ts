import { existsSync, statSync } from 'node:fs';
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
import { extractZip } from '../process/zip.js';
import { download } from './download.js';
import {
  MIN_DOWNLOAD_BYTES,
  PYTHON_VERSION,
  PYTHON_INSTALL_MIRROR,
  PACKAGE_INDEX_URL,
  UV_VERSION,
  uvDownloadUrl,
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

function runOptions(ctx: UvContext): UvRunOptions {
  return {
    env: uvEnv(ctx),
    ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

export function uvEnv(ctx: UvContext): NodeJS.ProcessEnv {
  const backend = backendPaths(ctx.paths.backendRoot);

  return buildUvEnv({
    tempDir: ctx.tempDir,
    cacheDir: cachePaths(ctx.paths.cacheDir).uv,
    pythonInstallDir: backend.pythonDir,
    installMirror: PYTHON_INSTALL_MIRROR,
    packageIndex: PACKAGE_INDEX_URL,
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

  if (!hasCachedArchive(archive)) {
    await download({
      url: uvDownloadUrl(target.uvFilename),
      dest: archive,
      minBytes: MIN_DOWNLOAD_BYTES,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  if (!existsSync(backend.uvExe)) {
    await extractZip(archive, dirname(backend.uvExe));
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

export async function installPython(ctx: UvContext): Promise<void> {
  const backend = backendPaths(ctx.paths.backendRoot);
  const run = ctx.run ?? runUv;
  const args = [
    'python',
    'install',
    PYTHON_VERSION,
    '--no-bin',
    '--no-registry',
  ];

  const result = await run(backend.uvExe, args, runOptions(ctx));

  if (result.status !== 0) {
    throw failure('uv/install-failed', 'python install', result);
  }
}

/**
 * Rebuilds the venv from scratch. `--clear` is deliberate: provisioning is an
 * all-or-nothing operation, and a venv left over from an older layout or an
 * older dependency set must not survive.
 */
export async function createVenv(ctx: UvContext): Promise<void> {
  const backend = backendPaths(ctx.paths.backendRoot);
  const run = ctx.run ?? runUv;
  const args = ['venv', backend.venvDir, '--python', PYTHON_VERSION, '--clear'];

  const result = await run(backend.uvExe, args, runOptions(ctx));

  if (result.status !== 0) {
    throw failure('uv/venv-failed', 'venv', result);
  }
}

/** Installs exact requirement strings into the venv; an empty list is a no-op. */
export async function installPackages(
  ctx: UvContext,
  requirements: readonly string[],
): Promise<void> {
  if (requirements.length === 0) {
    return;
  }

  const backend = backendPaths(ctx.paths.backendRoot);
  const run = ctx.run ?? runUv;
  const args = [
    'pip',
    'install',
    '--python',
    backend.venvPython,
    ...requirements,
  ];

  const result = await run(backend.uvExe, args, runOptions(ctx));

  if (result.status !== 0) {
    throw failure('uv/packages-failed', 'pip install', result);
  }
}
