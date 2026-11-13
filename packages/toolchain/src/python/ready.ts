import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { BackendPaths } from '../layout/paths.js';

/**
 * What a completed provisioning run leaves behind. Written last, so a partial
 * run never looks ready.
 */
export interface ReadyMarker {
  readonly uv: string;
  readonly python: string;
  /** The services directory the .pth points at, as an absolute path. */
  readonly services: string;
}

function isReadyMarker(value: unknown): value is ReadyMarker {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.uv === 'string' &&
    typeof record.python === 'string' &&
    typeof record.services === 'string'
  );
}

/** Reads the marker; a missing or broken file means "not ready", not an error. */
export async function readReadyMarker(
  paths: BackendPaths,
): Promise<ReadyMarker | null> {
  let text: string;

  try {
    text = await readFile(paths.readyMarker, 'utf8');
  } catch {
    return null;
  }

  try {
    const value: unknown = JSON.parse(text);
    return isReadyMarker(value) ? value : null;
  } catch {
    return null;
  }
}

export function markerMatches(
  marker: ReadyMarker | null,
  expected: ReadyMarker,
): boolean {
  return (
    marker !== null &&
    marker.uv === expected.uv &&
    marker.python === expected.python &&
    marker.services === expected.services
  );
}

/**
 * Cheap: the marker says the last run finished, the two paths say nobody
 * deleted the pieces underneath it. Whether the venv actually works is a
 * question for `--doctor`.
 */
export async function isReady(
  paths: BackendPaths,
  expected: ReadyMarker,
): Promise<boolean> {
  if (!existsSync(paths.uvExe) || !existsSync(paths.venvPython)) {
    return false;
  }

  return markerMatches(await readReadyMarker(paths), expected);
}

/**
 * The commit point. A direct write is enough: if it is cut short, the marker
 * is unreadable and the next run provisions again, which is the safe failure.
 */
export async function writeReadyMarker(
  paths: BackendPaths,
  marker: ReadyMarker,
): Promise<void> {
  await mkdir(dirname(paths.readyMarker), { recursive: true });
  await writeFile(
    paths.readyMarker,
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8',
  );
}
