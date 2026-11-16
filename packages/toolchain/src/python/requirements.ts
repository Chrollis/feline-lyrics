import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIREMENTS_FILENAME = 'requirements.txt';

/**
 * One requirement per line, exactly as pip reads it. Blank lines and comments
 * are dropped; everything else is kept verbatim, so a pin stays a pin.
 */
export function readRequirements(servicesDir: string): string[] {
  const file = join(servicesDir, REQUIREMENTS_FILENAME);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);

  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The import name of a requirement: `av==19.0.2` -> `av`, `numpy` -> `numpy`.
 * Version bounds, extras and environment markers are cut off. A distribution
 * whose import name differs from its package name would need a mapping table,
 * and there is none yet.
 */
export function requirementModule(requirement: string): string {
  return requirement.split(/[<>=!~[ ;]/)[0] ?? requirement;
}
