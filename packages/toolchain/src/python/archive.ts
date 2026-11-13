import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// One line per member and the runtime archive holds a few thousand files.
const MAX_LISTING_BYTES = 16 * 1024 * 1024;

const DRIVE_LETTER = /^[a-z]:/i;

/**
 * The archive itself is at fault: tar exited non-zero or a member name tried to
 * escape. provision() drops the cached file on this error, because the next run
 * decides whether to download by the file's existence alone.
 */
export class UnusableArchiveError extends Error {}

function toPosix(entry: string): string {
  return entry.replace(/\\/g, '/');
}

function unsafeReason(entry: string): string | null {
  const posix = toPosix(entry);

  if (DRIVE_LETTER.test(posix)) {
    return 'a drive-letter path';
  }

  if (posix.startsWith('/')) {
    return 'an absolute path';
  }

  if (posix.split('/').includes('..')) {
    return 'a parent-directory traversal';
  }

  return null;
}

interface TarResult {
  readonly stdout: string;
  readonly status: number;
  readonly stderr: string;
}

/**
 * Runs tar and returns its exit status. A spawn failure or a killed process is
 * thrown here, because that says nothing about the archive: the caller must
 * keep it for the next run.
 */
function runTar(
  tar: string,
  args: readonly string[],
  spawn: typeof spawnSync,
  maxBuffer = 1024 * 1024,
): TarResult {
  const result = spawn(tar, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === null) {
    throw new Error(`tar was killed by ${result.signal ?? 'a signal'}`);
  }

  return {
    stdout: result.stdout ?? '',
    status: result.status,
    stderr: result.stderr ?? '',
  };
}

function stderrDetail(result: TarResult): string {
  const detail = result.stderr.trim();

  return detail.length > 0 ? `: ${detail}` : '';
}

/**
 * Reads the member names without writing anything. The names come from the
 * archive and are not trusted: callers must validate them themselves.
 */
export function listArchive(
  tar: string,
  archive: string,
  spawn: typeof spawnSync = spawnSync,
): string[] {
  const result = runTar(tar, ['-tf', archive], spawn, MAX_LISTING_BYTES);

  if (result.status !== 0) {
    throw new UnusableArchiveError(
      `tar -tf could not list the archive (exit ${result.status})${stderrDetail(result)}`,
    );
  }

  return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * Lists the archive, refuses every name that could escape the destination, and
 * only then lets tar write. The two passes exist so a traversal attempt is
 * visible before a single byte lands on disk.
 *
 * Names only: link targets are not inspected here, which is enough for the
 * Python runtime archive because its Windows build carries no links.
 */
export function extract(
  tar: string,
  archive: string,
  destDir: string,
  spawn: typeof spawnSync = spawnSync,
): string[] {
  const entries = listArchive(tar, archive, spawn);

  for (const entry of entries) {
    const reason = unsafeReason(entry);

    if (reason !== null) {
      throw new UnusableArchiveError(
        `refusing to extract the archive: entry "${entry}" is ${reason}`,
      );
    }
  }

  // The check passed, so this is the first point allowed to touch the disk.
  mkdirSync(destDir, { recursive: true });

  const result = runTar(tar, ['-xf', archive, '-C', destDir], spawn);

  if (result.status !== 0) {
    throw new UnusableArchiveError(
      `tar -xf could not extract the archive (exit ${result.status})${stderrDetail(result)}`,
    );
  }

  return entries;
}
