import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ToolchainError } from '../errors.js';
import {
  backendPaths,
  type BackendPaths,
  type ToolchainPaths,
} from '../layout/paths.js';
import type { ResolvedMirrorConfig } from '../mirrors.js';
import { writePth } from './pth.js';
import {
  markerMatches,
  readReadyMarker,
  writeReadyMarker,
  type ReadyMarker,
} from './ready.js';
import {
  createVenv,
  installPackages,
  type RunUv,
  type UvContext,
} from './uv.js';

/**
 * One plugin's own environment: a venv beside the builtin one, built from the
 * same uv and the same interpreter, with the plugin's backend directory and the
 * host backend on its `.pth`.
 *
 * The interpreter is shared on purpose. A second copy of CPython per plugin
 * would buy isolation the process boundary already provides, at ~40 MB and an
 * extra download per plugin. The venv is still separate, so requirements cannot
 * collide.
 */
export interface PluginEnvironmentOptions {
  /** The shared layout: the uv binary and the builtin venv live here. */
  readonly paths: ToolchainPaths;
  /** Where plugin environments are kept; one subdirectory per id. */
  readonly envRoot: string;
  readonly id: string;
  /** The host backend plus the plugin's own `backend` directory. */
  readonly importPaths: readonly string[];
  readonly requirements: readonly string[];
  /** A caller-owned scratch directory for uv; shared with the builtin run. */
  readonly tempDir: string;
  readonly mirrors?: ResolvedMirrorConfig;
  readonly run?: RunUv;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly signal?: AbortSignal;
}

export interface PluginEnvironment {
  readonly root: string;
  readonly paths: BackendPaths;
  readonly python: string;
}

/** The layout of one plugin's environment; useful before provisioning it. */
export function pluginEnvironmentPaths(
  envRoot: string,
  id: string,
): BackendPaths {
  return backendPaths(join(resolve(envRoot), id));
}

function markerFor(options: PluginEnvironmentOptions): ReadyMarker {
  const imports = options.importPaths.map((directory) => resolve(directory));

  return {
    // Empty means "whatever this run settled on". A plugin environment has no
    // doctor step of its own, so the marker only has to decide "the same inputs
    // built this venv"; the versions are not compared.
    uv: '',
    python: '',
    imports: imports.join('\n'),
    requirements: options.requirements.join('\n'),
  };
}

/**
 * Builds or reuses the venv for one plugin. Idempotent: a marker that matches
 * the same imports and requirements returns without running uv, which is what
 * makes "disable, then enable again" cheap.
 */
export async function provisionPluginEnvironment(
  options: PluginEnvironmentOptions,
): Promise<PluginEnvironment> {
  const root = join(resolve(options.envRoot), options.id);
  const paths = backendPaths(root);
  const expected = markerFor(options);

  if (
    existsSync(paths.venvPython) &&
    markerMatches(await readReadyMarker(paths), expected)
  ) {
    return { root, paths, python: paths.venvPython };
  }

  const shared = backendPaths(options.paths.backendRoot);

  if (!existsSync(shared.uvExe)) {
    throw new Error(`uv executable not found at ${shared.uvExe}`);
  }

  if (!existsSync(shared.venvPython)) {
    throw new Error(
      `the builtin interpreter is not ready at ${shared.venvPython}`,
    );
  }

  const context: UvContext = {
    paths: options.paths,
    tempDir: options.tempDir,
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  await mkdir(root, { recursive: true });
  // The builtin venv's interpreter is the base for this one; uv resolves the
  // real CPython behind it, so no second download is involved.
  await createVenv(context, shared.venvPython, paths.venvDir);

  try {
    await installPackages(context, options.requirements, {
      pythonExecutable: paths.venvPython,
      ...(options.mirrors === undefined
        ? {}
        : { indexes: options.mirrors.packages }),
    });

    writePth(paths, options.importPaths);
    await writeReadyMarker(paths, expected);
  } catch (error) {
    // The venv itself is worth keeping: `--clear` replaces it next time, and
    // deleting a directory the next run will overwrite only risks a lock on
    // Windows. The marker stays absent, so a failed run never looks ready.
    throw error instanceof ToolchainError
      ? error
      : new ToolchainError(
          'uv/venv-failed',
          `the environment for ${options.id} was not completed`,
          { reason: String(error) },
        );
  }

  return { root, paths, python: paths.venvPython };
}
