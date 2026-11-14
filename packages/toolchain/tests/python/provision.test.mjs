import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  backendPaths,
  provision,
  PTH_FILENAME,
  TARGETS,
} from '../../out/index.js';

// The uv archive fixture: a zip whose only entry is uv.exe. The payload does not
// matter, downloadUv only checks that the entry exists.
const ZIP_WITH_UV =
  'UEsDBBQAAAAIAMhsbl2Z+4AoQgAAAEAAAAAGAAAAdXYuZXhlY2RiZmFlY+fg5OLm4eXjFxAUEhYRFROXkJSSlpGVk1dQVFJWUVVT19DU0tbR1dM3MDQyNjE1M7ewtLK2sbWzdwAAUEsBAhQAFAAAAAgAyGxuXZn7gChCAAAAQAAAAAYAAAAAAAAAAAAAAAAAAAAAAHV2LmV4ZVBLBQYAAAAAAQABADQAAABmAAAAAAA=';

const target = TARGETS['win32-x64'];

async function withPaths(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-provision-'));
  const paths = {
    cacheDir: join(root, 'cache'),
    servicesDir: join(root, 'services'),
    backendRoot: join(root, 'backend'),
  };
  const tempDir = join(root, 'tmp');
  mkdirSync(tempDir, { recursive: true });

  try {
    await fn(paths, tempDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function zipResponse() {
  const bytes = Buffer.from(ZIP_WITH_UV, 'base64');

  return Promise.resolve(
    new Response(new Uint8Array(bytes), {
      headers: { 'content-length': String(bytes.byteLength) },
    }),
  );
}

function fakeRun(decide = () => 0) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    const status = decide(args);

    return { status, stdout: '', stderr: status === 0 ? '' : 'error: failed' };
  };

  return { calls, run };
}

/** `uv venv` is faked, so the venv python has to be created by hand. */
function markVenvReady(paths) {
  const backend = backendPaths(paths.backendRoot);

  mkdirSync(dirname(backend.venvPython), { recursive: true });
  writeFileSync(backend.venvPython, '');
}

test('provisions in the order that leaves the marker last', async () => {
  await withPaths(async (paths, tempDir) => {
    const { calls, run } = fakeRun();

    const marker = await provision({
      paths,
      tempDir,
      requirements: ['av==15.0.0'],
      run,
      target,
      fetchImpl: zipResponse,
    });

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['python', 'venv', 'pip'],
    );
    assert.equal(marker.services, resolve(paths.servicesDir));

    const backend = backendPaths(paths.backendRoot);

    assert.deepEqual(JSON.parse(readFileSync(backend.readyMarker, 'utf8')), {
      uv: marker.uv,
      python: marker.python,
      services: marker.services,
    });
    assert.equal(
      readFileSync(join(backend.sitePackages, PTH_FILENAME), 'utf8'),
      `${resolve(paths.servicesDir)}\n`,
    );
    assert.ok(existsSync(backend.uvExe));
  });
});

test('skips pip when nothing is declared', async () => {
  await withPaths(async (paths, tempDir) => {
    const { calls, run } = fakeRun();

    await provision({ paths, tempDir, run, target, fetchImpl: zipResponse });

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['python', 'venv'],
    );
  });
});

test('does nothing when the marker already matches', async () => {
  await withPaths(async (paths, tempDir) => {
    const first = fakeRun();

    await provision({
      paths,
      tempDir,
      run: first.run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const second = fakeRun();

    await provision({
      paths,
      tempDir,
      run: second.run,
      target,
      fetchImpl: () => {
        throw new Error('must not download again');
      },
    });

    assert.equal(second.calls.length, 0);
  });
});

test('force rebuilds even when the marker matches', async () => {
  await withPaths(async (paths, tempDir) => {
    await provision({
      paths,
      tempDir,
      run: fakeRun().run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const forced = fakeRun();

    await provision({
      paths,
      tempDir,
      run: forced.run,
      target,
      force: true,
      // The fixture is below MIN_DOWNLOAD_BYTES, so the archive is not treated
      // as cached and is fetched again; this test is about the steps.
      fetchImpl: zipResponse,
    });

    assert.equal(forced.calls.length, 2);
  });
});

test('leaves no marker when a step fails', async () => {
  await withPaths(async (paths, tempDir) => {
    const { run } = fakeRun((args) => (args[0] === 'pip' ? 1 : 0));

    await assert.rejects(
      provision({
        paths,
        tempDir,
        requirements: ['av'],
        run,
        target,
        fetchImpl: zipResponse,
      }),
      (error) => error.code === 'uv/packages-failed',
    );

    assert.equal(
      existsSync(backendPaths(paths.backendRoot).readyMarker),
      false,
    );
  });
});

test('re-provisions when the services directory moved', async () => {
  await withPaths(async (paths, tempDir) => {
    await provision({
      paths,
      tempDir,
      run: fakeRun().run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const moved = {
      ...paths,
      servicesDir: join(paths.backendRoot, '..', 'services-elsewhere'),
    };
    const second = fakeRun();

    await provision({
      paths: moved,
      tempDir,
      run: second.run,
      target,
      fetchImpl: zipResponse,
    });

    assert.equal(second.calls.length, 2);
  });
});
