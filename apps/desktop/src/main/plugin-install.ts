import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BackendError,
  loadManifest,
  type PluginManifest,
} from '@felyrics/host';

export interface InstallDeps {
  readonly load?: typeof loadManifest;
  readonly copy?: typeof cp;
  readonly knownIds?: ReadonlySet<string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    // A permission error means something is there that the app cannot see;
    // treating it as "free" would copy over it.
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Copies a plugin package into the user root.
 *
 * `loadManifest` runs first, so a broken or mistyped package is refused before
 * anything is written; the directory name must equal the id, which is the same
 * rule discovery enforces. An existing directory is never replaced: upgrading a
 * plugin is a separate decision, not a silent overwrite.
 *
 * The copy lands in a sibling staging directory and is renamed into place, so a
 * failed copy or a refused duplicate id never leaves half a plugin behind.
 */
export async function installPluginDirectory(
  source: string,
  pluginsRoot: string,
  deps: InstallDeps = {},
): Promise<PluginManifest> {
  const load = deps.load ?? loadManifest;
  const copy = deps.copy ?? cp;
  const manifest = await load(source);

  if (basename(source) !== manifest.id) {
    throw new BackendError(
      'core/identity-mismatch',
      `${basename(source)} must be the directory name of ${manifest.id}`,
    );
  }

  if (deps.knownIds?.has(manifest.id)) {
    throw new BackendError(
      'core/duplicate-id',
      `${manifest.id} is already loaded`,
    );
  }

  const target = join(pluginsRoot, manifest.id);

  if (await exists(target)) {
    throw new BackendError(
      'core/backend-failed',
      `${manifest.id} is already installed at ${target}`,
    );
  }

  await mkdir(pluginsRoot, { recursive: true });

  const staging = `${target}.installing-${randomUUID().slice(0, 8)}`;

  try {
    await copy(source, staging, { recursive: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  // Return the manifest of the copied package: its `directory` must point at
  // the installed copy, not at the folder the user picked (which may move).
  return load(target);
}
