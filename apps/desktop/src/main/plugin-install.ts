import { cp, mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  BackendError,
  loadManifest,
  type PluginManifest,
} from '@felyrics/host';

export interface InstallDeps {
  readonly load?: typeof loadManifest;
  readonly copy?: typeof cp;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies a plugin package into the user root.
 *
 * `loadManifest` runs first, so a broken or mistyped package is refused before
 * anything is written; the directory name must equal the id, which is the same
 * rule discovery enforces. An existing directory is never replaced: upgrading a
 * plugin is a separate decision, not a silent overwrite.
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

  const target = join(pluginsRoot, manifest.id);

  if (await exists(target)) {
    throw new BackendError(
      'core/backend-failed',
      `${manifest.id} is already installed at ${target}`,
    );
  }

  await mkdir(pluginsRoot, { recursive: true });
  await copy(source, target, { recursive: true });

  // Return the manifest of the copied package: its `directory` must point at
  // the installed copy, not at the folder the user picked (which may move).
  return load(target);
}
