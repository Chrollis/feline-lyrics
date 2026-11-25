import { resolve, sep } from 'node:path';

/**
 * The job origin: the host writes results into the cache, so the renderer needs
 * an address for them that is not the page origin. `app://job/<plugin>/<job>/<file>`
 * can only reach one file inside one plugin's job directory.
 *
 * The URL shape belongs to the host, not to the app: the backend produces these
 * URLs (`ctx.jobUrl`), so their parser lives beside the job allocation. The
 * plugin segment is the owner: two plugins can hand out `<hex>` names without
 * agreeing on a shared namespace, and the resolver only serves ids the app has
 * actually discovered.
 */
export const JOB_SCHEME = 'app';

export const JOB_HOST = 'job';

export const JOB_ORIGIN = `${JOB_SCHEME}://${JOB_HOST}`;

/** Job directories are `uuid4().hex`, so this is exactly what may be served. */
export const JOB_ID = /^[0-9a-f]{32}$/;

/** The same charset the manifest derives ids from: kebab segments, dot-joined. */
export const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Maps `app://job/<plugin>/<job>/<file>` to a path under `jobsRoot`.
 *
 * Exactly three segments are allowed -- a discovered plugin id, a job id and
 * one file name -- because that is the shape the backend writes. The renderer
 * never gets to name a path, only a plugin, a job and a file inside it. That
 * keeps the job origin from becoming a way to read the cache, or the disk. Dot
 * files are refused as well: the host's own markers (`.kind`) live beside the
 * results and are not part of the contract.
 */
export function resolveJobFile(
  jobsRoot: string,
  url: string,
  pluginIds: ReadonlySet<string>,
): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${JOB_SCHEME}:` || parsed.host !== JOB_HOST) {
    return null;
  }

  let pathname: string;

  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }

  const segments = pathname
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments.length !== 3) {
    return null;
  }

  const [plugin, job, file] = segments as [string, string, string];

  if (
    !PLUGIN_ID.test(plugin) ||
    !pluginIds.has(plugin) ||
    !JOB_ID.test(job) ||
    file.startsWith('.')
  ) {
    return null;
  }

  const target = resolve(jobsRoot, plugin, job, file);
  const base = resolve(jobsRoot);

  if (!target.startsWith(base + sep)) {
    return null;
  }

  return target;
}
