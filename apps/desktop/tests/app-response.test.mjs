// `answerAppRequest` is the whole `app://` behaviour minus the Electron
// registration: status codes, headers and which files are reachable.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  resolveAssetPath,
} from '../src/main/app-assets.ts';
import { answerAppRequest } from '../src/main/app-response.ts';

const ASSETS = {
  resolveAssetPath,
  contentTypeFor,
  contentSecurityPolicy: CONTENT_SECURITY_POLICY,
};

const JOB = '0123456789abcdef0123456789abcdef';

async function roots() {
  const root = await mkdtemp(join(tmpdir(), 'felyrics-app-'));
  const rendererRoot = join(root, 'renderer');
  const jobsRoot = join(root, 'jobs');

  await mkdir(join(jobsRoot, JOB), { recursive: true });
  await mkdir(rendererRoot, { recursive: true });
  await writeFile(join(rendererRoot, 'index.html'), '<!doctype html>');
  await writeFile(join(rendererRoot, 'app.js'), 'export {}');
  await writeFile(join(jobsRoot, JOB, 'pixel.png'), 'png');
  await writeFile(join(jobsRoot, JOB, '.kind'), 'frames');

  return { rendererRoot, jobsRoot };
}

test('serves a renderer asset with its type and the policy header', async () => {
  const response = await answerAppRequest(
    await roots(),
    'app://bundle/app.js',
    ASSETS,
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('Content-Type'),
    'text/javascript; charset=utf-8',
  );
  assert.match(
    response.headers.get('Content-Security-Policy') ?? '',
    /default-src 'self'/,
  );
  assert.equal(await response.text(), 'export {}');
});

test('answers a missing renderer file with 404', async () => {
  const response = await answerAppRequest(
    await roots(),
    'app://bundle/missing.js',
    ASSETS,
  );

  assert.equal(response.status, 404);
});

test('serves one job file', async () => {
  const response = await answerAppRequest(
    await roots(),
    `app://job/${JOB}/pixel.png`,
    ASSETS,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
});

test('does not serve a job marker or a nested path', async () => {
  const app = await roots();

  assert.equal(
    (await answerAppRequest(app, `app://job/${JOB}/.kind`, ASSETS)).status,
    404,
  );
  assert.equal(
    (await answerAppRequest(app, `app://job/${JOB}/nested/pixel.png`, ASSETS))
      .status,
    404,
  );
});

test('does not let a job url escape its directory', async () => {
  const app = await roots();

  assert.equal(
    (
      await answerAppRequest(
        app,
        `app://job/${JOB}/..%2f..%2fsecret.txt`,
        ASSETS,
      )
    ).status,
    404,
  );
});

test('answers another host with 404', async () => {
  const response = await answerAppRequest(
    await roots(),
    `app://other/${JOB}`,
    ASSETS,
  );

  assert.equal(response.status, 404);
});
