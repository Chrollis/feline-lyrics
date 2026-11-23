import { extname, resolve, sep } from 'node:path';

/**
 * The renderer is served from a real origin instead of `file://`.
 *
 * `file://` has no origin to speak of, so a Content-Security-Policy on it is
 * either ignored or has to trust everything. A custom standard scheme gives the
 * page an origin (`app://bundle`), which makes a policy mean something, keeps
 * `fetch`, ES modules, history and storage on their normal paths, and matches
 * what a packaged app would do on the other platforms.
 *
 * The scheme is registered as privileged in `main/index.ts`, before the app is
 * ready -- that call has to happen early, so the pure part lives here.
 */
export const APP_SCHEME = 'app';

export const APP_HOST = 'bundle';

export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** What the window loads in a packaged run. */
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * The backend writes its results into the cache, outside the bundle, so they
 * need an origin of their own. A second host on the same scheme keeps one
 * handler and one policy: `app://job/<job>/<file>` can only reach a file inside
 * one job directory, and the page keeps its `'self'`.
 */
export const JOB_HOST = 'job';

export const JOB_ORIGIN = `${APP_SCHEME}://${JOB_HOST}`;

/** Job directories are `uuid4().hex`, so this is exactly what may be served. */
const JOB_ID = /^[0-9a-f]{32}$/;

/**
 * No inline script, no inline style, no remote code. `connect-src 'self'` is
 * enough because the backend is reached over IPC, not HTTP.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: app:",
  "media-src 'self' app:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  // What the backend writes today. A media file without its type is not a
  // "download that fails to render": `<audio>` refuses the source outright,
  // because `application/octet-stream` is not a media type it will play.
  '.flac': 'audio/flac',
};

export function contentTypeFor(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Map an `app://` URL to a file inside `root`, or `null` when it must not be
 * served.
 *
 * `null` is the only failure this function has: the caller turns it into a 404,
 * because telling a page which of its requests were "outside the root" is a map
 * of the disk. The browser already normalises a literal `..` in a URL, so the
 * cases that reach here are the encoded ones (`%2e%2e`) and the host must be
 * checked too -- `app://other/x` is a different origin, not a path.
 */
export function resolveAssetPath(root: string, url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) {
    return null;
  }

  let pathname: string;

  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    // A lone `%` or a broken escape is not a path, and letting the throw escape
    // would turn one bad request into an unhandled rejection in the handler.
    return null;
  }

  if (pathname === '' || pathname === '/') {
    pathname = '/index.html';
  }

  // Windows accepts both separators, so a `\` in a decoded path is a separator
  // here even though the URL spec would treat it as an ordinary character.
  const target = resolve(root, `.${pathname.replaceAll('\\', '/')}`);
  const base = resolve(root);

  // `startsWith(base)` alone would accept a sibling directory whose name begins
  // with the root's name (`renderer-evil` next to `renderer`).
  if (target !== base && !target.startsWith(base + sep)) {
    return null;
  }

  return target;
}

/**
 * Map an `app://job/<job>/<file>` URL to a file inside one job directory, or
 * `null` when it must not be served.
 *
 * Exactly two segments are allowed -- a job id and one file name -- because that
 * is the shape the backend writes. The renderer never gets to name a path, only
 * a job and a file inside it. That keeps the job origin from becoming a way to
 * read the cache, or the disk.
 */
export function resolveJobPath(jobsRoot: string, url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== JOB_HOST) {
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
