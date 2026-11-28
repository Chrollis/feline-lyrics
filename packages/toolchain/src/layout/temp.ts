import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolchainError } from '../errors.js';

const OWNER_MARKER = '.felyrics-temp';

/** Scratch prefixes left directly under the base before app/cli roles split. */
const LEGACY_PREFIXES = ['felyrics-', 'provision-', 'plugin-env-'] as const;

function markerPath(root: string): string {
  return join(root, OWNER_MARKER);
}

/**
 * The scratch root a role owns under the shared temp base. Two roles keep
 * separate directories so one role's startup clear cannot delete the other's
 * live provisioning scratch.
 */
export function tempRoleRoot(root: string, role: 'app' | 'cli'): string {
  return join(root, role);
}

/** Creates the marker with `wx`, so a concurrent adopter loses the race safely. */
function adoptRoot(root: string): void {
  mkdirSync(root, { recursive: true });

  try {
    writeFileSync(markerPath(root), '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

function unowned(root: string): never {
  throw new ToolchainError(
    'temp/unowned',
    `${root} is not a Felyrics temp directory; refusing to use or clear it`,
    { path: root },
  );
}

/**
 * An explicit root is shared state: it must carry our marker before a scratch
 * directory is created inside it. A missing or empty root is adopted; a
 * non-empty root without the marker belongs to someone else.
 */
async function ensureOwnedRoot(root: string): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      adoptRoot(root);
      return;
    }

    throw error;
  }

  if (entries.length === 0) {
    adoptRoot(root);
    return;
  }

  if (!entries.some((entry) => entry.name === OWNER_MARKER)) {
    unowned(root);
  }
}

async function makeTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
  root: string,
): Promise<T> {
  const tempDir = mkdtempSync(join(root, prefix));

  try {
    return await fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` with a fresh scratch directory and removes it afterwards, whether
 * `fn` succeeded, threw or was killed by an exception in between. The directory
 * is the caller's to own: nothing in the toolchain remembers it.
 *
 * `root` is where the directory is created. A caller that keeps scratch space
 * under its own `tempDir` passes that root; the default remains the OS temp
 * directory so two-argument callers keep their old behaviour. An explicit root
 * must be empty or carry our marker; an existing non-empty directory without it
 * is refused instead of polluted or deleted.
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
  root?: string,
): Promise<T> {
  if (root === undefined) {
    return makeTempDir(prefix, fn, tmpdir());
  }

  await ensureOwnedRoot(root);

  return makeTempDir(prefix, fn, root);
}

/**
 * Removes every entry under `root`, leaving the root and its ownership marker
 * in place. Startup uses this to clear residue from an interrupted operation.
 * A missing root is a no-op; an empty root is adopted; a non-empty root without
 * the marker is refused and left untouched. The marker itself is never removed.
 */
export async function clearTempDir(root: string): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  if (entries.length === 0) {
    adoptRoot(root);
    return;
  }

  if (!entries.some((entry) => entry.name === OWNER_MARKER)) {
    unowned(root);
  }

  for (const entry of entries) {
    if (entry.name === OWNER_MARKER) {
      continue;
    }

    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

/**
 * Removes scratch directories that older CLI runs left directly under the temp
 * base, before app and CLI scratch moved into role directories. Only the known
 * legacy prefixes go; the ownership marker, the role directories and anything
 * unrecognised stay. A missing or empty base is a no-op, and a non-empty base
 * without the marker is refused before anything is touched.
 */
export async function clearLegacyTempEntries(
  root: string,
): Promise<string[]> {
  let entries: Dirent[];

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  if (entries.length === 0) {
    return [];
  }

  if (!entries.some((entry) => entry.name === OWNER_MARKER)) {
    unowned(root);
  }

  const removed = entries
    .map((entry) => entry.name)
    .filter((name) =>
      LEGACY_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .sort();

  for (const name of removed) {
    await rm(join(root, name), { recursive: true, force: true });
  }

  return removed;
}
