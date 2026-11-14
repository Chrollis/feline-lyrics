import { resolve } from 'node:path';

import type { ToolchainPaths } from '../layout/paths.js';
import { backendPaths } from '../layout/paths.js';
import { writePth } from './pth.js';
import { isReady, writeReadyMarker, type ReadyMarker } from './ready.js';
import {
  PYTHON_VERSION,
  UV_VERSION,
  currentTarget,
  type PlatformTarget,
} from './target.js';
import {
  createVenv,
  downloadUv,
  installPackages,
  installPython,
  type RunUv,
  type UvContext,
} from './uv.js';

export interface ProvisionOptions {
  readonly paths: ToolchainPaths;
  /** Scratch directory for uv; the caller creates and removes it. */
  readonly tempDir: string;
  /** Exact requirement strings, already read from the services manifest. */
  readonly requirements?: readonly string[];
  /** Rebuild even when the marker says the backend is ready. */
  readonly force?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly run?: RunUv;
  readonly target?: PlatformTarget;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly signal?: AbortSignal;
}

/**
 * Brings the backend to the state the marker records, in the only order that is
 * safe to interrupt: the marker is written last, so a killed run leaves a
 * backend that the next run rebuilds instead of trusting.
 *
 * Nothing is cleaned up on failure: the shared cache stays usable input, and
 * `uv venv --clear` / the versioned download directories make a rerun overwrite
 * the half-finished parts.
 */
export async function provision(
  options: ProvisionOptions,
): Promise<ReadyMarker> {
  const backend = backendPaths(options.paths.backendRoot);
  const marker: ReadyMarker = {
    uv: UV_VERSION,
    python: PYTHON_VERSION,
    services: resolve(options.paths.servicesDir),
  };

  if (!options.force && (await isReady(backend, marker))) {
    return marker;
  }

  const ctx: UvContext = {
    paths: options.paths,
    tempDir: options.tempDir,
    ...(options.run ? { run: options.run } : {}),
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  await downloadUv(ctx, options.target ?? currentTarget(), {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  await installPython(ctx);
  await createVenv(ctx);
  writePth(options.paths, backend);
  await installPackages(ctx, options.requirements ?? []);
  await writeReadyMarker(backend, marker);

  return marker;
}
