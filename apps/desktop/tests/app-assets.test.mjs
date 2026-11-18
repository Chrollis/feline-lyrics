import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  MEDIA_ORIGIN,
  mediaUrlFor,
  resolveAssetPath,
  resolveMediaPath,
} from '../src/main/app-assets.ts';

const root = join(resolve('.'), 'out', 'renderer');
const jobsRoot = join(resolve('.'), 'cache', 'jobs');
const job = 'a'.repeat(32);

test('loads index.html for the bare origin', () => {
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/`),
    join(root, 'index.html'),
  );
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/index.html`),
    join(root, 'index.html'),
  );
  assert.equal(APP_ENTRY_URL, `${APP_ORIGIN}/index.html`);
});

test('resolves a nested asset inside the root', () => {
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/assets/index-abc123.js`),
    join(root, 'assets', 'index-abc123.js'),
  );
});

test('refuses a host that is not the bundle', () => {
  assert.equal(resolveAssetPath(root, 'app://elsewhere/index.html'), null);
});

test('refuses another scheme', () => {
  assert.equal(resolveAssetPath(root, 'https://bundle/index.html'), null);
  assert.equal(resolveAssetPath(root, 'file:///C:/Windows/win.ini'), null);
});

test('leaves a dot segment the url parser already normalised inside the root', () => {
  // WHATWG URL collapses `%2e%2e` itself, so this arrives as `/secret.txt`. It
  // is a file inside the bundle, not an escape -- worth pinning because it looks
  // like the dangerous case and is not.
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/%2e%2e/secret.txt`),
    join(root, 'secret.txt'),
  );
});

test('refuses a traversal that survives the parser as a backslash', () => {
  // A segment is only collapsed when it is *exactly* `..`; `..%5c` is not, so it
  // reaches the decoder and becomes a separator once decoded.
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/..%5c..%5csecret.txt`),
    null,
  );
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/%2e%2e%5csecret.txt`),
    null,
  );
});

test('refuses a sibling directory whose name starts with the root name', () => {
  // `startsWith(base)` alone would serve this: the guard needs the separator.
  assert.equal(
    resolveAssetPath(root, `${APP_ORIGIN}/%2e%2e%5crenderer-evil/x.js`),
    null,
  );
});

test('refuses a broken escape instead of throwing', () => {
  assert.equal(resolveAssetPath(root, `${APP_ORIGIN}/%zz/index.html`), null);
  assert.equal(resolveAssetPath(root, 'not a url'), null);
});

test('names the type of every file the bundle ships', () => {
  assert.match(contentTypeFor('index.html'), /^text\/html/);
  assert.match(contentTypeFor('index-abc.js'), /^text\/javascript/);
  assert.match(contentTypeFor('index-abc.css'), /^text\/css/);
  assert.equal(contentTypeFor('logo.svg'), 'image/svg+xml');
  assert.equal(contentTypeFor('unknown.bin'), 'application/octet-stream');
  assert.equal(contentTypeFor('UPPER.HTML'), 'text/html; charset=utf-8');
});

test('the policy allows no remote code and no inline code', () => {
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /style-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|\*/);
  // The backend's PNGs live on `app://media`, so an `img` tag is blocked unless
  // the scheme is named here. The audio tag was already covered by media-src.
  assert.match(CONTENT_SECURITY_POLICY, /img-src 'self' data: app:/);
});

test('names the media type of what the backend writes', () => {
  // A media file served as `application/octet-stream` is refused by the
  // element, with no visible cause: the request succeeds, the player stays shut.
  assert.equal(contentTypeFor('audio.flac'), 'audio/flac');
  assert.equal(contentTypeFor('0001.png'), 'image/png');
  assert.equal(contentTypeFor('unknown.bin'), 'application/octet-stream');
});

test('serves a job file on the media host and nothing else', () => {
  // The shape the backend actually writes: one bucket per kind, then one job
  // directory, then the file (`services/felyrics/media/methods.py:52`, `:127`).
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames/${job}/0001.png`),
    join(jobsRoot, 'frames', job, '0001.png'),
  );
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/audio/${job}/audio.flac`),
    join(jobsRoot, 'audio', job, 'audio.flac'),
  );
});

test('refuses anything that is not one kind, one job and one file', () => {
  assert.equal(resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/`), null);
  assert.equal(resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames`), null);
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames/${job}`),
    null,
  );
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames/${job}/nested/0001.png`),
    null,
  );
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames/not-a-job-id/0001.png`),
    null,
  );
  // A kind with no bucket behind it would be a directory nobody wrote, and a
  // free-form first segment is the start of a path traversal.
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/video/${job}/0001.png`),
    null,
  );
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/${job}/0001.png`),
    null,
  );
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames/${job}/..%5csecret.txt`),
    null,
  );
  assert.equal(
    resolveMediaPath(jobsRoot, `${MEDIA_ORIGIN}/frames/${job}/%zz.png`),
    null,
  );
});

test('keeps the two hosts apart', () => {
  // The bundle host must not reach the cache, and the media host must not reach
  // the bundle: an origin that serves both would undo the separation.
  assert.equal(
    resolveAssetPath(root, `${MEDIA_ORIGIN}/frames/${job}/0001.png`),
    null,
  );
  assert.equal(resolveMediaPath(jobsRoot, `${APP_ORIGIN}/index.html`), null);
});

test('turns a backend result into the url the page may load', () => {
  assert.equal(
    mediaUrlFor(jobsRoot, join(jobsRoot, 'frames', job, '0001.png')),
    `${MEDIA_ORIGIN}/frames/${job}/0001.png`,
  );
  // Anything that is not one bucket, one job directory and one file inside it
  // has no URL; the renderer gets `null` rather than a guess that would 404
  // later -- a wrong guess is invisible, a `null` is not.
  assert.equal(
    mediaUrlFor(jobsRoot, join(jobsRoot, 'frames', job, 'deep', '0001.png')),
    null,
  );
  assert.equal(
    mediaUrlFor(jobsRoot, join(jobsRoot, 'elsewhere', job, 'x')),
    null,
  );
  assert.equal(
    mediaUrlFor(jobsRoot, join(jobsRoot, 'frames', 'not-a-job-id', 'x')),
    null,
  );
  assert.equal(mediaUrlFor(jobsRoot, join(root, 'index.html')), null);
  assert.equal(mediaUrlFor(jobsRoot, resolve('C:/Windows/win.ini')), null);
});

test('round-trips every url the bridge hands out', () => {
  const file = join(jobsRoot, 'audio', job, 'frame 1.png');
  const url = mediaUrlFor(jobsRoot, file);

  assert.ok(url);
  assert.equal(resolveMediaPath(jobsRoot, url), file);
});
