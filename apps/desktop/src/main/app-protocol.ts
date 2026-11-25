import { protocol } from 'electron';

import {
  APP_SCHEME,
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  resolveAssetPath,
} from './app-assets.js';
import { answerAppRequest, type AppRoots } from './app-response.js';

export type { AppRoots };

/**
 * Must run before `app.whenReady()`: Electron freezes the scheme registry at
 * startup, so a scheme registered late is treated as an opaque, unprivileged one
 * and the page loses modules, fetch and its own CSP semantics.
 *
 * `standard` gives the URL normal rules (an origin, relative paths, `..`
 * collapsing); `secure` puts it on the same footing as https for the APIs that
 * refuse to run on an insecure origin; `stream` is what lets `<audio>`/`<video>`
 * play a resource from this scheme -- without it Chromium refuses to stream
 * media over a custom protocol, which looks like a silent, unplayable track
 * while images from the same origin load fine.
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
        stream: true,
      },
    },
  ]);
}

const ASSETS = {
  resolveAssetPath,
  contentTypeFor,
  contentSecurityPolicy: CONTENT_SECURITY_POLICY,
};

/**
 * Serve both roots over the `app` scheme: `app://bundle/` for the page and its
 * assets, `app://job/<plugin>/<job>/<file>` for the files the host allocates.
 *
 * The file is read in `answerAppRequest` and handed back with an explicit
 * `Content-Type` plus the policy header. Letting `net.fetch(file://...)` do it
 * would be shorter, but a `.js` answered as `application/octet-stream` makes
 * `<script type="module">` fail with a mime error that points nowhere near the
 * cause.
 */
export function serveAppProtocol(roots: AppRoots): void {
  protocol.handle(APP_SCHEME, (request) =>
    answerAppRequest(roots, request.url, ASSETS),
  );
}
