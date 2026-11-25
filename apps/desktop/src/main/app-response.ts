import { readFile } from 'node:fs/promises';

import { JOB_HOST, resolveJobFile } from '@felyrics/host';

/** The two roots the `app` scheme serves. They never overlap on disk. */
export interface AppRoots {
  /** The built renderer; served as `app://bundle/`. */
  readonly rendererRoot: string;
  /** The host's job directories; served as `app://job/<plugin>/<job>/<file>`. */
  readonly jobsRoot: string;
  /** The ids a job URL may name; discovery fills this before requests arrive. */
  readonly pluginIds: ReadonlySet<string>;
}

/** The bundle-side pieces, injected so this module stays importable in tests. */
export interface AppAssets {
  resolveAssetPath(root: string, url: string): string | null;
  contentTypeFor(file: string): string;
  readonly contentSecurityPolicy: string;
}

/**
 * Answers one `app://` request. Kept apart from the Electron registration so the
 * status codes and headers can be asserted without starting the app.
 */
export async function answerAppRequest(
  roots: AppRoots,
  url: string,
  assets: AppAssets,
): Promise<Response> {
  let host: string;

  try {
    host = new URL(url).host;
  } catch {
    return new Response('not found', { status: 404 });
  }

  const file =
    host === JOB_HOST
      ? resolveJobFile(roots.jobsRoot, url, roots.pluginIds)
      : assets.resolveAssetPath(roots.rendererRoot, url);

  if (file === null) {
    return new Response('not found', { status: 404 });
  }

  let body: Buffer;

  try {
    body = await readFile(file);
  } catch {
    // Missing and unreadable are the same answer here: the page asked for a
    // file that is not there. A 500 would make a stale build look like a bug
    // in the handler.
    return new Response('not found', { status: 404 });
  }

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': assets.contentTypeFor(file),
      'Content-Security-Policy': assets.contentSecurityPolicy,
    },
  });
}
