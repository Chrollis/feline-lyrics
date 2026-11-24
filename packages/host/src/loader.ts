import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  loadManifest,
  ManifestError,
  type ManifestIssue,
  type PluginManifest,
} from './manifest.js';
import { BackendError } from './protocol.js';

/**
 * Plugin discovery: two roots, one level, directory name equals plugin id.
 *
 * A broken manifest must not take the whole app down: it is reported as an
 * issue and the remaining plugins still load. A user plugin may never shadow a
 * builtin one, so on a duplicate id the builtin is kept and the copy is reported.
 */
export type PluginRootKind = 'builtin' | 'user';

export interface PluginRoot {
  readonly path: string;
  readonly kind: PluginRootKind;
}

export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly root: PluginRootKind;
}

/** A directory that could not become a plugin; the app shows it as failed. */
export interface DiscoveryIssue {
  readonly directory: string;
  readonly root: PluginRootKind;
  readonly code: string;
  readonly message: string;
  readonly issues: readonly ManifestIssue[];
}

export interface DiscoveryResult {
  readonly plugins: readonly DiscoveredPlugin[];
  readonly issues: readonly DiscoveryIssue[];
}

export interface DiscoveryOptions {
  /** The python the backend will run, as `major.minor`; enables the engine check. */
  readonly pythonVersion?: string;
}

/** Lists the candidate plugin directories under one root, one level deep. */
export async function discoverPluginDirectories(
  root: PluginRoot,
): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    // A root that does not exist yet is normal: a fresh install has no user
    // plugins. Any other failure is a fact the caller must report, not hide.
    if (isMissing(error)) {
      return [];
    }

    throw new BackendError(
      'core/backend-failed',
      `cannot list ${root.path}: ${describe(error)}`,
    );
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(root.path, entry.name))
    .sort();
}

/**
 * Loads every plugin under the given roots.
 *
 * Builtin roots are processed first, so a user copy of a builtin id is refused
 * without depending on the order the caller passed.
 */
export async function discoverPlugins(
  roots: readonly PluginRoot[],
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const ordered = [...roots].sort(
    (left, right) => rank(left.kind) - rank(right.kind),
  );
  const plugins: DiscoveredPlugin[] = [];
  const issues: DiscoveryIssue[] = [];
  const byId = new Map<string, DiscoveredPlugin>();

  for (const root of ordered) {
    let directories: string[];

    try {
      directories = await discoverPluginDirectories(root);
    } catch (error) {
      issues.push(rootIssue(root, error));
      continue;
    }

    for (const directory of directories) {
      let manifest;

      try {
        manifest = await loadManifest(directory, options);
      } catch (error) {
        if (error instanceof ManifestError) {
          issues.push({
            directory,
            root: root.kind,
            code: error.code,
            message: error.message,
            issues: error.issues,
          });
        } else {
          issues.push({
            directory,
            root: root.kind,
            code: 'core/backend-failed',
            message: `cannot read ${directory}: ${describe(error)}`,
            issues: [],
          });
        }

        continue;
      }

      const existing = byId.get(manifest.id);

      if (existing !== undefined) {
        issues.push({
          directory,
          root: root.kind,
          code: 'core/duplicate-id',
          message: `${manifest.id} is already loaded from ${existing.manifest.directory}`,
          issues: [],
        });
        continue;
      }

      const plugin: DiscoveredPlugin = { manifest, root: root.kind };

      byId.set(manifest.id, plugin);
      plugins.push(plugin);
    }
  }

  return { plugins, issues };
}

function rank(kind: PluginRootKind): number {
  return kind === 'builtin' ? 0 : 1;
}

/** The id a failed directory would have had, for the plugin list. */
export function issueId(issue: DiscoveryIssue): string {
  return basename(issue.directory);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;

  return code === 'ENOENT' || code === 'ENOTDIR';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rootIssue(root: PluginRoot, error: unknown): DiscoveryIssue {
  return {
    directory: root.path,
    root: root.kind,
    code: error instanceof BackendError ? error.code : 'core/backend-failed',
    message: describe(error),
    issues: [],
  };
}
