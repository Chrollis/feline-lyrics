import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `fn` with a fresh scratch directory and removes it afterwards, whether
 * `fn` succeeded, threw or was killed by an exception in between. The directory
 * is the caller's to own: nothing in the toolchain remembers it.
 *
 * `root` is where the directory is created. A caller that keeps scratch space
 * under its own `tempDir` passes that root; the default remains the OS temp
 * directory so two-argument callers keep their old behaviour.
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
  root: string = tmpdir(),
): Promise<T> {
  mkdirSync(root, { recursive: true });
  const tempDir = mkdtempSync(join(root, prefix));

  try {
    return await fn(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
