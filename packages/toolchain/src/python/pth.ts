import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { BackendPaths } from '../layout/paths.js';

/**
 * The file name is ours, not pip's: the venv's site-packages is emptied on every
 * provisioning run by `uv venv --clear`, so nothing else writes there.
 */
export const PTH_FILENAME = 'felyrics.pth';

/**
 * Puts the backend directories on the venv's import path: the host itself, and
 * the Python half of every plugin that was provisioned into this venv. Python
 * reads one path per line, so the trailing newline is not decoration: without
 * it the last line would merge with whatever follows.
 *
 * The paths are absolute because the venv outlives the working directory that
 * created it.
 */
export function writePth(
  backend: BackendPaths,
  importPaths: readonly string[],
): string {
  const file = join(backend.sitePackages, PTH_FILENAME);
  const lines = importPaths.map((directory) => resolve(directory));

  mkdirSync(backend.sitePackages, { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  return file;
}
