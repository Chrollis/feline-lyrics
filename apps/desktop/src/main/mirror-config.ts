import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  mirrorConfigDocument,
  mirrorConfigPath,
  parseMirrorConfig,
  resolveMirrorConfig,
  type ResolvedMirrorConfig,
} from '@felyrics/toolchain';

/**
 * Reads `mirrors.json` from the app's user data directory, writing the built-in
 * document on the first run.
 *
 * The file is the only way a user can redirect downloads: writing it before the
 * first install means the progress window's "Open config" always has something
 * to open, and a bad edit is a visible `mirrors/invalid` at startup rather than a
 * mystery 404 deep inside provisioning.
 */
export async function loadOrCreateMirrorConfig(
  userDataDir: string,
): Promise<ResolvedMirrorConfig> {
  const path = mirrorConfigPath(userDataDir);
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, mirrorConfigDocument(), 'utf8');

    return resolveMirrorConfig();
  }

  return resolveMirrorConfig(parseMirrorConfig(text));
}
