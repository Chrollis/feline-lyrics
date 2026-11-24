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
