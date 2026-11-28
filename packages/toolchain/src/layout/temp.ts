import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolchainError } from '../errors.js';

const OWNER_MARKER = '.felyrics-temp';

/** Per-scratch marker carrying the pid that created the directory. */
const PID_MARKER = '.felyrics-temp-pid';

/** Scratch prefixes left directly under the base before app/cli roles split. */
const LEGACY_PREFIXES = ['felyrics-', 'provision-', 'plugin-env-'] as const;

const ROLE_NAMES = new Set(['app', 'cli']);

const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export interface ClearStaleTempOptions {
  readonly maxAgeMs?: number;
  readonly prefixes?: readonly string[];
}

export interface TempResidue {
  readonly cliRoot: string;
  readonly cleaned: string[];
  readonly legacy: string[];
}

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

async function hasOwnMarker(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });

    return entries.some((entry) => entry.name === OWNER_MARKER);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }

    throw error;
  }
}

/**
 * The shared base is owned by the same marker as a role root. Older role-aware
 * runs created `<base>/app` or `<base>/cli` without ever marking the base, so a
 * base whose only entries are marked role directories is adopted instead of
 * being rejected. Anything else without the marker still belongs to someone
 * else and is refused.
 *
 * Call this before a base cleanup or before asking `withTempDir` for a role
 * scratch root: both require an owned base.
 */
export async function ensureOwnedTempRoot(root: string): Promise<void> {
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

  if (entries.some((entry) => entry.name === OWNER_MARKER)) {
    return;
  }

  const rolesOnly = entries.every(
    (entry) => entry.isDirectory() && ROLE_NAMES.has(entry.name),
  );

  if (rolesOnly) {
    for (const entry of entries) {
      if (!(await hasOwnMarker(join(root, entry.name)))) {
        unowned(root);
      }
    }

    adoptRoot(root);
    return;
  }

  unowned(root);
}

async function makeTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
  root: string,
): Promise<T> {
  const tempDir = mkdtempSync(join(root, prefix));

  try {
    writeFileSync(join(tempDir, PID_MARKER), String(process.pid));

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

/** A pid probe is only a hint; EPERM means the process exists but is not ours. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePid(text: string): number | undefined {
  const trimmed = text.trim();

  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }

  const pid = Number(trimmed);

  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function isStaleTempEntry(
  root: string,
  name: string,
  maxAgeMs: number,
): Promise<boolean> {
  const entryPath = join(root, name);
  let pid: number | undefined;

  try {
    pid = parsePid(await readFile(join(entryPath, PID_MARKER), 'utf8'));
  } catch {
    // No pid marker (or an unreadable one): fall back to age.
  }

  if (pid !== undefined) {
    return !isProcessAlive(pid);
  }

  try {
    const info = await stat(entryPath);

    return Date.now() - info.mtimeMs > maxAgeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

/**
 * Removes scratch directories left by runs that are no longer alive. A scratch
 * with a live owner pid stays even when old; a scratch whose recorded pid is
 * dead goes immediately; a scratch without a usable pid goes only after
 * `maxAgeMs`. The ownership marker, the role directories and unrecognised
 * entries are never candidates. A missing root is a no-op; a non-empty root
 * without the marker is refused before anything is touched.
 */
export async function clearStaleTempEntries(
  root: string,
  options: ClearStaleTempOptions = {},
): Promise<string[]> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_AGE_MS;
  const prefixes = options.prefixes ?? LEGACY_PREFIXES;
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

  const removed: string[] = [];
  const candidates = entries
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name !== OWNER_MARKER &&
        name !== PID_MARKER &&
        !ROLE_NAMES.has(name) &&
        prefixes.some((prefix) => name.startsWith(prefix)),
    )
    .sort();

  for (const name of candidates) {
    if (!(await isStaleTempEntry(root, name, maxAgeMs))) {
      continue;
    }

    await rm(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }

  return removed;
}

/**
 * Reclaims both kinds of residue a CLI run can leave: role scratch under
 * `<root>/cli` and the legacy scratch directories directly under the base.
 */
export async function cleanTempResidue(root: string): Promise<TempResidue> {
  const cliRoot = tempRoleRoot(root, 'cli');
  let entries: Dirent[];

  // Reading first makes a missing or empty base a true no-op: adopting it here
  // would create a marker for a directory this call was never asked to own.
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cliRoot, cleaned: [], legacy: [] };
    }

    throw error;
  }

  if (entries.length === 0) {
    return { cliRoot, cleaned: [], legacy: [] };
  }

  // Refuse an unowned base before touching its role directory: the old order
  // cleared `<root>/cli` first and only then rejected the base.
  await ensureOwnedTempRoot(root);

  const cleaned = await clearStaleTempEntries(cliRoot);
  const legacy = await clearLegacyTempEntries(root);

  return { cliRoot, cleaned, legacy };
}
