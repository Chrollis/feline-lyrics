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
  isReady,
  provision,
  PTH_FILENAME,
  PYTHON_VERSION,
  TARGETS,
  UV_VERSION,
} from '../../out/index.js';

// The uv archive fixture: a zip whose only entry is uv.exe. The payload does not
// matter, downloadUv only checks that the entry exists.
const ZIP_WITH_UV =
  'UEsDBBQAAAAIAMhsbl2Z+4AoQgAAAEAAAAAGAAAAdXYuZXhlY2RiZmFlY+fg5OLm4eXjFxAUEhYRFROXkJSSlpGVk1dQVFJWUVVT19DU0tbR1dM3MDQyNjE1M7ewtLK2sbWzdwAAUEsBAhQAFAAAAAgAyGxuXZn7gChCAAAAQAAAAAYAAAAAAAAAAAAAAAAAAAAAAHV2LmV4ZVBLBQYAAAAAAQABADQAAABmAAAAAAA=';

const target = TARGETS['win32-x64'];

// The downloader is not the subject here: a stub keeps these tests offline.
const PYTHON = {
  release: {
    tag: '20261021',
    version: PYTHON_VERSION,
    asset: 'python.tar.gz',
    url: 'https://example.invalid/python.tar.gz',
  },
  pythonPath: join('C:', 'fake', 'python.exe'),
};
const fakeEnsure = async () => PYTHON;

async function withPaths(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-provision-'));
  const paths = {
    cacheDir: join(root, 'cache'),
    imports: join(root, 'imports'),
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
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run,
      target,
      fetchImpl: zipResponse,
    });

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['venv', 'pip'],
    );
    assert.equal(marker.imports, resolve(paths.imports));

    const backend = backendPaths(paths.backendRoot);

    assert.deepEqual(JSON.parse(readFileSync(backend.readyMarker, 'utf8')), {
      uv: marker.uv,
      python: marker.python,
      imports: marker.imports,
      requirements: 'av==15.0.0',
    });
    assert.equal(
      readFileSync(join(backend.sitePackages, PTH_FILENAME), 'utf8'),
      `${resolve(paths.imports)}\n`,
    );
    assert.ok(existsSync(backend.uvExe));
  });
});

test('skips pip when nothing is declared', async () => {
  await withPaths(async (paths, tempDir) => {
    const { calls, run } = fakeRun();

    await provision({
      paths,
      tempDir,
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run,
      target,
      fetchImpl: zipResponse,
    });

    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ['venv'],
    );
  });
});

test('does nothing when the marker already matches', async () => {
  await withPaths(async (paths, tempDir) => {
    const first = fakeRun();

    await provision({
      paths,
      tempDir,
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run: first.run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const second = fakeRun();

    await provision({
      paths,
      tempDir,
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
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
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run: fakeRun().run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const forced = fakeRun();

    await provision({
      paths,
      tempDir,
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run: forced.run,
      target,
      force: true,
      // The fixture is below MIN_DOWNLOAD_BYTES, so the archive is not treated
      // as cached and is fetched again; this test is about the steps.
      fetchImpl: zipResponse,
    });

    assert.equal(forced.calls.length, 1);
  });
});

test('drops the marker before rebuilding, so a killed run cannot look ready', async () => {
  await withPaths(async (paths, tempDir) => {
    await provision({
      paths,
      tempDir,
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run: fakeRun().run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const backend = backendPaths(paths.backendRoot);

    assert.equal(existsSync(backend.readyMarker), true);

    // `uv venv --clear` has already emptied the venv when this fails: the old
    // marker would keep claiming a directory that no longer holds an interpreter.
    const { run } = fakeRun((args) => (args[0] === 'venv' ? 1 : 0));

    await assert.rejects(
      provision({
        paths,
        tempDir,
        requirements: [],
        importPaths: [paths.imports],
      ensurePython: fakeEnsure,
        run,
        target,
        force: true,
        fetchImpl: zipResponse,
      }),
    );

    assert.equal(existsSync(backend.readyMarker), false);
    assert.equal(
      await isReady(backend, {
        uv: UV_VERSION,
        python: PYTHON_VERSION,
        imports: resolve(paths.imports),
        requirements: '',
      }),
      false,
    );
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
        importPaths: [paths.imports],
      ensurePython: fakeEnsure,
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

test('re-provisions when the import list moved', async () => {
  await withPaths(async (paths, tempDir) => {
    await provision({
      paths,
      tempDir,
      requirements: [],
      importPaths: [paths.imports],
      ensurePython: fakeEnsure,
      run: fakeRun().run,
      target,
      fetchImpl: zipResponse,
    });
    markVenvReady(paths);

    const moved = {
      ...paths,
      imports: join(paths.backendRoot, '..', 'imports-elsewhere'),
    };
    const second = fakeRun();

    await provision({
      paths: moved,
      tempDir,
      requirements: [],
      importPaths: [moved.imports],
      ensurePython: fakeEnsure,
      run: second.run,
      target,
      fetchImpl: zipResponse,
    });

    assert.equal(second.calls.length, 1);
  });
});
