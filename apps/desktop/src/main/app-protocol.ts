import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';

import {
  APP_SCHEME,
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  resolveAssetPath,
} from './app-assets.js';

/**
 * Must run before `app.whenReady()`: Electron freezes the scheme registry at
 * startup, so a scheme registered late is treated as an opaque, unprivileged one
 * and the page loses modules, fetch and its own CSP semantics.
 *
 * `standard` gives the URL normal rules (an origin, relative paths, `..`
 * collapsing); `secure` puts it on the same footing as https for the APIs that
 * refuse to run on an insecure origin.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Serve `root` over `app://bundle/`.
 *
 * The file is read here and handed back with an explicit `Content-Type` plus the
 * policy header. Letting `net.fetch(file://...)` do it would be shorter, but a
 * `.js` answered as `application/octet-stream` makes `<script type="module">`
 * fail with a mime error that points nowhere near the cause.
 */
export function serveAppProtocol(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAssetPath(root, request.url);

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
        'Content-Type': contentTypeFor(file),
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      },
    });
  });
}
