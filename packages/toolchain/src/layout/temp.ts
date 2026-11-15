import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `fn` with a fresh scratch directory and removes it afterwards, whether
 * `fn` succeeded, threw or was killed by an exception in between. The directory
 * is the caller's to own: nothing in the toolchain remembers it.
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));

  try {
    return await fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
