import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function tarCandidates(): string[] {
  const candidates = ['tar'];

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    candidates.push(join(systemRoot, 'System32', 'tar.exe'));
  }

  return candidates;
}

export function findTar(spawn: typeof spawnSync = spawnSync): string | null {
  for (const candidate of tarCandidates()) {
    const result = spawn(candidate, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });

    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
}

export function requireTar(spawn: typeof spawnSync = spawnSync): string {
  const found = findTar(spawn);

  if (found === null) {
    throw new Error(
      'no tar executable found; Windows 10 1803+ ships bsdtar in System32',
    );
  }

  return found;
}
