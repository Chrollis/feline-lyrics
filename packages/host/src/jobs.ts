import { resolve, sep } from 'node:path';

/**
 * The job origin: the host writes results into the cache, so the renderer needs
 * an address for them that is not the page origin. `app://job/<job>/<file>` can
 * only reach one file inside one job directory.
 *
 * The URL shape belongs to the host, not to the app: the backend produces these
 * URLs (`ctx.jobUrl`), so their parser lives beside the job allocation.
 */
export const JOB_SCHEME = 'app';

export const JOB_HOST = 'job';

export const JOB_ORIGIN = `${JOB_SCHEME}://${JOB_HOST}`;

/** Job directories are `uuid4().hex`, so this is exactly what may be served. */
export const JOB_ID = /^[0-9a-f]{32}$/;

/**
 * Maps `app://job/<job>/<file>` to a path under `jobsRoot`.
 *
 * Exactly two segments are allowed -- a job id and one file name -- because that
 * is the shape the backend writes. The renderer never gets to name a path, only
 * a job and a file inside it. That keeps the job origin from becoming a way to
 * read the cache, or the disk.
 */
export function resolveJobFile(
  jobsRoot: string,
  url: string,
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

  if (segments.length !== 2) {
    return null;
  }

  const [job, file] = segments as [string, string];

  if (!JOB_ID.test(job) || file === '..') {
    return null;
  }

  const target = resolve(jobsRoot, job, file);
  const base = resolve(jobsRoot);

  if (!target.startsWith(base + sep)) {
    return null;
  }

  return target;
}
