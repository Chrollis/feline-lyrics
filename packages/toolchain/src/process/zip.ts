import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import StreamZip from 'node-stream-zip';

import { ToolchainError } from '../errors.js';

const DRIVE_LETTER = /^[a-z]:/i;

function toPosix(name: string): string {
  return name.replace(/\\/g, '/');
}

/**
 * Says why an entry name cannot be trusted, or null when it is a plain
 * relative path. Zip names are not paths yet: they come from the archive.
 */
export function unsafeReason(entry: string): string | null {
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

export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * An opened archive. The indirection exists so tests can hand in entries
 * without building a zip file for every case.
 */
export interface ZipArchive {
  entries(): Promise<readonly ZipEntry[]>;
  read(entry: ZipEntry, destFile: string): Promise<void>;
  close(): Promise<void>;
}

export type OpenZip = (archive: string) => Promise<ZipArchive>;

function isFileSystemError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/**
 * A broken archive is ours to report; a broken disk is not. The caller drops a
 * cached archive on `archive/*`, so telling the two apart decides whether a
 * download is repeated.
 */
function archiveError(archive: string, error: unknown): Error {
  if (error instanceof ToolchainError) {
    return error;
  }

  if (isFileSystemError(error)) {
    return error as Error;
  }

  const detail = error instanceof Error ? error.message : String(error);

  return new ToolchainError(
    'archive/unusable',
    `could not read ${archive} as a zip archive: ${detail}`,
    { archive },
    { cause: error },
  );
}

/**
 * Opens the archive for reading. Entry names are validated in this module, not
 * by the library, so every refusal carries the same code and the same context.
 */
export async function openZip(archive: string): Promise<ZipArchive> {
  const zip = new StreamZip.async({
    file: archive,
    skipEntryNameValidation: true,
  });

  return {
    async entries() {
      const all = await zip.entries();
      return Object.values(all).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
      }));
    },

    async read(entry, destFile) {
      await zip.extract(entry.name, destFile);
    },

    async close() {
      await zip.close();
    },
  };
}

/**
 * The public entry points own the error boundary: whatever an `OpenZip`
 * implementation throws becomes `archive/unusable`, unless it is a disk error.
 */
async function openArchive(
  archive: string,
  open: OpenZip,
): Promise<ZipArchive> {
  try {
    return await open(archive);
  } catch (error) {
    throw archiveError(archive, error);
  }
}

async function readEntries(
  zip: ZipArchive,
  archive: string,
): Promise<readonly ZipEntry[]> {
  try {
    return await zip.entries();
  } catch (error) {
    throw archiveError(archive, error);
  }
}

async function readEntry(
  zip: ZipArchive,
  archive: string,
  entry: ZipEntry,
  destFile: string,
): Promise<void> {
  try {
    await zip.read(entry, destFile);
  } catch (error) {
    throw archiveError(archive, error);
  }
}

/** Lists the entry names without writing anything. */
export async function listEntries(
  archive: string,
  open: OpenZip = openZip,
): Promise<string[]> {
  const zip = await openArchive(archive, open);

  try {
    const entries = await readEntries(zip, archive);
    return entries.map((entry) => entry.name);
  } finally {
    await zip.close();
  }
}

/**
 * Lists the archive, refuses every name that could escape the destination, and
 * only then writes. The two passes exist so a traversal attempt is visible
 * before a single byte lands on disk.
 */
export async function extractZip(
  archive: string,
  destDir: string,
  open: OpenZip = openZip,
): Promise<string[]> {
  const zip = await openArchive(archive, open);

  try {
    const entries = await readEntries(zip, archive);

    for (const entry of entries) {
      const reason = unsafeReason(entry.name);

      if (reason !== null) {
        throw new ToolchainError(
          'archive/unsafe-entry',
          `refusing to extract the archive: entry "${entry.name}" is ${reason}`,
          { archive, entry: entry.name, reason },
        );
      }
    }

    // The check passed, so this is the first point allowed to touch the disk.
    await mkdir(destDir, { recursive: true });

    for (const entry of entries) {
      const parts = toPosix(entry.name)
        .split('/')
        .filter((part) => part.length > 0 && part !== '.');

      if (parts.length === 0) {
        continue;
      }

      const target = join(destDir, ...parts);

      if (entry.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }

      await mkdir(dirname(target), { recursive: true });
      await readEntry(zip, archive, entry, target);
    }

    return entries.map((entry) => entry.name);
  } finally {
    await zip.close();
  }
}
