import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  resolveAssetPath,
} from '../src/main/app-assets.ts';

const root = join(resolve('.'), 'out', 'renderer');

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
});
