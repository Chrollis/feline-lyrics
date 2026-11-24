import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIREMENTS_FILENAME = 'requirements.txt';

/**
 * One requirement per line, exactly as pip reads it. Blank lines and comments
 * are dropped; everything else is kept verbatim, so a pin stays a pin.
 */
export function readRequirements(directory: string): string[] {
  const file = join(directory, REQUIREMENTS_FILENAME);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);

  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * The distribution name a requirement line installs, canonical per PEP 503:
 * `stable-ts[fw]>=2` -> `stable-ts`, `My_Pkg.Name` -> `my-pkg-name`.
 *
 * The distribution name is what `importlib.metadata` answers for; the import
 * name is the plugin's business, because its entry module imports whatever it
 * needs. A line that names no single distribution (an option, a direct URL, a
 * local path) answers `''`, and the caller does not check it.
 */
export function requirementName(requirement: string): string {
  const line = requirement.trim();
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(line)?.[0];

  if (name === undefined) {
    return '';
  }

  // A direct reference (`name @ https://...`) or a local path is installed from
  // somewhere no index knows, so its metadata is still there but the name alone
  // would not say what was installed.
  if (line.includes('://') || line.startsWith('.') || line.startsWith('/')) {
    return '';
  }

  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * The marker's view of the requirement list: the installed set is only valid for
 * the list it was installed from, so a changed file must invalidate the marker.
 * Plain joined text rather than a hash -- it is short and a human can read the
 * difference straight out of `.ready`.
 */
export function requirementsFingerprint(
  requirements: readonly string[],
): string {
  return requirements.join('\n');
}
