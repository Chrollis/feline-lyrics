import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { BackendPaths, ToolchainPaths } from '../layout/paths.js';

/**
 * The file name is ours, not pip's: the venv's site-packages is emptied on every
 * provisioning run by `uv venv --clear`, so nothing else writes there.
 */
export const PTH_FILENAME = 'felyrics.pth';

/**
 * Puts the services directory on the venv's import path. Python reads one path
 * per line, so the trailing newline is not decoration: without it the last line
 * would merge with whatever follows.
 *
 * The path is absolute because the venv outlives the working directory that
 * created it.
 */
export function writePth(
  toolchain: ToolchainPaths,
  backend: BackendPaths,
): string {
  const file = join(backend.sitePackages, PTH_FILENAME);

  mkdirSync(backend.sitePackages, { recursive: true });
  writeFileSync(file, `${resolve(toolchain.servicesDir)}\n`, 'utf8');

  return file;
}
