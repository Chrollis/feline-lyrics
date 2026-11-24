import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  loadManifest,
  ManifestError,
  type PluginManifest,
} from './manifest.js';

/**
 * Plugin discovery: two roots, one level, directory name equals plugin id.
 *
 * Discovery never imports plugin code. It reads manifests, so a broken manifest
 * is refused before anything from the plugin can run; `enable` (a later step)
 * owns the hooks and the teardown.
 */
export interface DiscoveryOptions {
  /** The python the backend will run, as `major.minor`; enables the engine check. */
  readonly pythonVersion?: string;
}

/** Lists the candidate plugin directories under each root, one level deep. */
export async function discoverPluginDirectories(
  roots: readonly string[],
): Promise<string[]> {
  const directories: string[] = [];

  for (const root of roots) {
    let entries;

    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // A missing root is not an error: a fresh install has no user plugins.
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        directories.push(join(root, entry.name));
      }
    }
  }

  return directories.sort();
}

/**
 * Loads every plugin under the given roots.
 *
 * A duplicate id is refused rather than letting one root shadow the other: the
 * user must not be able to replace a builtin plugin by installing a package
 * with its id.
 */
export async function discoverPlugins(
  roots: readonly string[],
  options: DiscoveryOptions = {},
): Promise<PluginManifest[]> {
  const manifests: PluginManifest[] = [];
  const byId = new Map<string, PluginManifest>();

  for (const directory of await discoverPluginDirectories(roots)) {
    const manifest = await loadManifest(directory, options);
    const previous = byId.get(manifest.id);

    if (previous !== undefined) {
      throw new ManifestError(
        'core/duplicate-id',
        `plugin ${manifest.id} is declared by both ${previous.directory} and ${manifest.directory}`,
        [
          {
            path: 'directory',
            message: `${previous.directory} and ${manifest.directory}`,
          },
        ],
      );
    }

    byId.set(manifest.id, manifest);
    manifests.push(manifest);
  }

  return manifests;
}
