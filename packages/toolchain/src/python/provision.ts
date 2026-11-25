import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { execa } from 'execa';

import type { ToolchainPaths } from '../layout/paths.js';
import { backendPaths } from '../layout/paths.js';
import { DEFAULT_MIRRORS, type ResolvedMirrorConfig } from '../mirrors.js';
import {
  ensurePython,
  type EnsurePythonOptions,
  type InstalledPython,
} from './download-python.js';
import { writePth } from './pth.js';
import { requirementsFingerprint } from './requirements.js';
import {
  isReady,
  readReadyMarker,
  writeReadyMarker,
  type ReadyMarker,
} from './ready.js';
import {
  PYTHON_SHORT_VERSION,
  UV_VERSION,
  currentTarget,
  type PlatformTarget,
} from './target.js';
import {
  createVenv,
  downloadUv,
  installPackages,
  type RunUv,
  type UvContext,
} from './uv.js';

/** What the progress window can label; one step per visible phase. */
export type ProvisionStep =
  | 'uv'
  | 'python'
  | 'venv'
  | 'pth'
  | 'packages'
  | 'marker';

export interface ProvisionOptions {
  readonly paths: ToolchainPaths;
  /** Scratch directory for uv; the caller creates and removes it. */
  readonly tempDir: string;
  /**
   * Exact requirement strings, already read from the plugin manifests. They are
   * required, not optional: an omitted list silently means "no dependencies",
   * which builds a venv whose only symptom is a failing `import av` in --doctor.
   */
  readonly requirements: readonly string[];
  /**
   * Directories written into the venv's `.pth`: the host backend and the Python
   * half of every plugin provisioned into this venv. The toolchain cannot derive
   * them -- the caller knows where its checkouts live.
   */
  readonly importPaths: readonly string[];
  /** Rebuild even when the marker says the backend is ready. */
  readonly force?: boolean;
  /**
   * Where the interpreter archive comes from. Omitted means the built-in
   * official sources; the application passes the user's `mirrors.json` once
   * the startup path reads it.
   */
  readonly mirrors?: ResolvedMirrorConfig;
  /** Which python series to install; the pinned 3.12 by default. */
  readonly pythonSeries?: string;
  /** Tests replace the downloader; production uses the real one. */
  readonly ensurePython?: (
    options: EnsurePythonOptions,
  ) => Promise<InstalledPython>;
  readonly fetchImpl?: typeof fetch;
  readonly run?: RunUv;
  readonly target?: PlatformTarget;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Called before each phase, so a window can name what is happening. */
  readonly onStep?: (step: ProvisionStep) => void;
  /**
   * Bytes of the current download. A window shows this instead of guessing why
   * a mirrored archive takes minutes; `total` is null when the server does not
   * send a length.
   */
  readonly onProgress?: (
    step: 'uv' | 'python',
    received: number,
    total: number | null,
  ) => void;
  readonly signal?: AbortSignal;
  /** Reads the downloaded uv's own version; a seam for tests. */
  readonly readUvVersion?: (exe: string) => Promise<string>;
}

/**
 * The marker a run with these inputs would write.
 *
 * Both the pre-check and `provision` itself derive it here, because two copies
 * of "what makes a backend ready" drift the moment one of the four inputs gains
 * a field.
 */
/**
 * The version the downloaded binary reports. The source follows `latest`, so the
 * marker must name what actually landed, not the version this build hoped for.
 */
async function readUvVersion(
  exe: string,
  read: ((exe: string) => Promise<string>) | undefined,
): Promise<string> {
  if (read !== undefined) {
    return read(exe);
  }

  try {
    const result = await execa(exe, ['--version']);
    const version = /^uv\s+(\S+)/.exec(result.stdout.trim())?.[1];

    return version ?? UV_VERSION;
  } catch {
    return UV_VERSION;
  }
}

export function expectedMarker(
  importPaths: readonly string[],
  requirements: readonly string[],
  python = '',
  uv = '',
): ReadyMarker {
  return {
    // '' means "the version the last install picked": the uv source follows
    // `latest`, so the pre-check cannot know it without downloading.
    uv,
    // '' means "the version the archive carries"; the pre-check does not know
    // it without downloading, and a real version is written after the install.
    python,
    imports: importPaths.map((directory) => resolve(directory)).join('\n'),
    requirements: requirementsFingerprint(requirements),
  };
}

/**
 * Brings the backend to the state the marker records, in the only order that is
 * safe to interrupt: the marker is written last, so a killed run leaves a
 * backend that the next run rebuilds instead of trusting.
 *
 * Nothing else is cleaned up on failure: the shared cache stays usable input, and
 * `uv venv --clear` / the versioned download directories make a rerun overwrite
 * the half-finished parts. The one exception is the marker itself, which is
 * removed the moment a rebuild starts -- it is the file that would otherwise lie
 * about the result.
 */
export async function provision(
  options: ProvisionOptions,
): Promise<ReadyMarker> {
  const backend = backendPaths(options.paths.backendRoot);
  const requirements = options.requirements;
  const marker = expectedMarker(options.importPaths, requirements);
  const step = options.onStep ?? (() => {});

  if (!options.force && (await isReady(backend, marker))) {
    // The pre-check does not know which 3.12 patch the install picked; the
    // marker on disk does, so hand that one back.
    return (await readReadyMarker(backend)) ?? marker;
  }

  // From here on this directory is being rebuilt, so the marker must stop
  // claiming it is usable right now. Waiting for the success path to overwrite
  // it is not the same thing: `uv venv --clear` empties the venv early, and a
  // crash after that would leave the old marker beside a broken interpreter,
  // which `isReady` only checks for existence.
  await rm(backend.readyMarker, { force: true });

  const ctx: UvContext = {
    paths: options.paths,
    tempDir: options.tempDir,
    ...(options.run ? { run: options.run } : {}),
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  step('uv');
  await downloadUv(ctx, options.target ?? currentTarget(), {
    ...(options.mirrors ? { sources: options.mirrors.uv } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onProgress
      ? {
          onProgress: (received: number, total: number | null) =>
            options.onProgress!('uv', received, total),
        }
      : {}),
  });
  step('python');
  const install = options.ensurePython ?? ensurePython;
  const installed = await install({
    config: options.mirrors ?? DEFAULT_MIRRORS,
    destination: backend.root,
    cacheDir: options.paths.cacheDir,
    series: options.pythonSeries ?? PYTHON_SHORT_VERSION,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress
      ? {
          onProgress: (received: number, total: number | null) =>
            options.onProgress!('python', received, total),
        }
      : {}),
  });
  const installedMarker = expectedMarker(
    options.importPaths,
    requirements,
    installed.release.version,
    await readUvVersion(backend.uvExe, options.readUvVersion),
  );
  step('venv');
  await createVenv(ctx, installed.pythonPath);
  step('pth');
  writePth(backend, options.importPaths);
  step('packages');
  await installPackages(ctx, requirements, {
    ...(options.mirrors ? { indexes: options.mirrors.packages } : {}),
  });
  step('marker');
  await writeReadyMarker(backend, installedMarker);

  return installedMarker;
}
