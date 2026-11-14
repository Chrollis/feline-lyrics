import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  buildUvEnv,
  createVenv,
  downloadUv,
  installPackages,
  installPython,
  runUv,
  TARGETS,
  ToolchainError,
  uvArchivePath,
  uvEnv,
} from '../../out/index.js';

// Two tiny zips built with Compress-Archive: one holds uv.exe, the other only
// hello.txt. Only the entry names matter here, not the payload.
const ZIP_WITH_UV =
  'UEsDBBQAAAAIAMhsbl2Z+4AoQgAAAEAAAAAGAAAAdXYuZXhlY2RiZmFlY+fg5OLm4eXjFxAUEhYRFROXkJSSlpGVk1dQVFJWUVVT19DU0tbR1dM3MDQyNjE1M7ewtLK2sbWzdwAAUEsBAhQAFAAAAAgAyGxuXZn7gChCAAAAQAAAAAYAAAAAAAAAAAAAAAAAAAAAAHV2LmV4ZVBLBQYAAAAAAQABADQAAABmAAAAAAA=';
const ZIP_WITHOUT_UV =
  'UEsDBBQAAAAIAMhsbl2sKpPYBAAAAAIAAAAJAAAAaGVsbG8udHh0y8gEAFBLAQIUABQAAAAIAMhsbl2sKpPYBAAAAAIAAAAJAAAAAAAAAAAAAAAAAAAAAABoZWxsby50eHRQSwUGAAAAAAEAAQA3AAAAKwAAAAAA';

const target = TARGETS['win32-x64'];

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-uv-'));
  const ctx = {
    paths: {
      cacheDir: join(root, 'cache'),
      servicesDir: join(root, 'services'),
      backendRoot: join(root, 'backend'),
    },
    tempDir: join(root, 'tmp'),
  };

  try {
    await fn(ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeRun({ status = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return { status, stdout, stderr };
  };

  return { calls, run };
}

function zipResponse(base64) {
  const bytes = Buffer.from(base64, 'base64');

  return new Response(new Uint8Array(bytes), {
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

test('points uv at the backend, the shared cache and the mirrors', () => {
  const root = join(tmpdir(), 'felyrics-uv-env');
  const ctx = {
    paths: {
      cacheDir: join(root, 'cache'),
      servicesDir: join(root, 'services'),
      backendRoot: join(root, 'backend'),
    },
    tempDir: join(root, 'tmp'),
  };
  const env = uvEnv(ctx);

  assert.equal(env.UV_CACHE_DIR, join(root, 'cache', 'uv'));
  assert.equal(env.UV_PYTHON_INSTALL_DIR, join(root, 'backend', 'python'));
  assert.equal(env.UV_NO_CONFIG, '1');
  assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed');
  assert.equal(env.UV_PYTHON_DOWNLOADS, 'manual');
  assert.match(env.UV_PYTHON_INSTALL_MIRROR, /ustc\.edu\.cn/);
  assert.match(env.UV_DEFAULT_INDEX, /tsinghua/);
  assert.equal(env.TEMP, join(root, 'tmp'));
});

test('drops inherited uv, pip and python settings', () => {
  const env = buildUvEnv(
    {
      tempDir: 'temp',
      cacheDir: 'cache',
      pythonInstallDir: 'python',
      installMirror: 'mirror',
      packageIndex: 'index',
    },
    {
      PATH: 'keep',
      UV_PYTHON_INSTALL_DIR: 'evil',
      UV_CACHE_DIR: 'evil',
      PIP_INDEX_URL: 'evil',
      PYTHONPATH: 'evil',
      VIRTUAL_ENV: 'evil',
    },
  );

  assert.equal(env.PATH, 'keep');
  assert.equal(env.UV_PYTHON_INSTALL_DIR, 'python');
  assert.equal(env.UV_CACHE_DIR, 'cache');
  assert.equal('PYTHONPATH' in env, false);
  assert.equal('VIRTUAL_ENV' in env, false);
  assert.equal('PIP_INDEX_URL' in env, false);
});

test('installs the pinned interpreter without writing outside the backend', async () => {
  await withRoot(async (ctx) => {
    const { calls, run } = fakeRun();

    await installPython({ ...ctx, run });

    assert.equal(calls.length, 1);
    const [call] = calls;

    assert.equal(call.file, join(ctx.paths.backendRoot, 'uv', 'uv.exe'));
    assert.deepEqual(call.args, [
      'python',
      'install',
      '3.12.15',
      '--no-bin',
      '--no-registry',
    ]);
    assert.equal(
      call.options.env.UV_PYTHON_INSTALL_DIR,
      join(ctx.paths.backendRoot, 'python'),
    );
  });
});

test('reports a failed python install with the last stderr line', async () => {
  await withRoot(async (ctx) => {
    const { run } = fakeRun({
      status: 1,
      stderr: 'hint: try upgrading uv\n  error: no download found\n',
    });

    await assert.rejects(installPython({ ...ctx, run }), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'uv/install-failed');
      assert.equal(error.context.status, 1);
      assert.equal(error.context.command, 'uv python install');
      assert.match(error.message, /no download found/);
      assert.doesNotMatch(error.message, /hint:/);

      return true;
    });
  });
});

test('reports a killed command without inventing a status', async () => {
  await withRoot(async (ctx) => {
    const { run } = fakeRun({ status: null });

    await assert.rejects(installPython({ ...ctx, run }), (error) => {
      assert.equal(error.code, 'uv/install-failed');
      assert.match(error.message, /was killed/);
      assert.equal('status' in error.context, false);

      return true;
    });
  });
});

test('rebuilds the venv from the installed interpreter', async () => {
  await withRoot(async (ctx) => {
    const { calls, run } = fakeRun();

    await createVenv({ ...ctx, run });

    const [call] = calls;

    assert.deepEqual(call.args, [
      'venv',
      join(ctx.paths.backendRoot, 'venv'),
      '--python',
      '3.12.15',
      '--clear',
    ]);
  });
});

test('reports a failed venv rebuild', async () => {
  await withRoot(async (ctx) => {
    const { run } = fakeRun({ status: 2, stderr: 'error: no interpreter' });

    await assert.rejects(createVenv({ ...ctx, run }), (error) => {
      assert.equal(error.code, 'uv/venv-failed');
      assert.equal(error.context.status, 2);

      return true;
    });
  });
});

test('installs the declared requirements into the venv python', async () => {
  await withRoot(async (ctx) => {
    const { calls, run } = fakeRun();

    await installPackages({ ...ctx, run }, ['av==15.0.0', 'numpy']);

    const [call] = calls;

    assert.deepEqual(call.args, [
      'pip',
      'install',
      '--python',
      join(ctx.paths.backendRoot, 'venv', 'Scripts', 'python.exe'),
      'av==15.0.0',
      'numpy',
    ]);
  });
});

test('does nothing when there are no requirements', async () => {
  await withRoot(async (ctx) => {
    const { calls, run } = fakeRun();

    await installPackages({ ...ctx, run }, []);

    assert.equal(calls.length, 0);
  });
});

test('reports a failed package install', async () => {
  await withRoot(async (ctx) => {
    const { run } = fakeRun({ status: 1, stderr: 'error: no solution' });

    await assert.rejects(installPackages({ ...ctx, run }, ['av']), (error) => {
      assert.equal(error.code, 'uv/packages-failed');
      assert.equal(error.context.command, 'uv pip install');

      return true;
    });
  });
});

test('keeps each uv version in its own cache directory', () => {
  assert.equal(
    uvArchivePath('cache', target),
    join(resolve('cache'), 'downloads', 'uv', '0.13.8', target.uvFilename),
  );
});

test('refuses a target it cannot unpack', async () => {
  await withRoot(async (ctx) => {
    await assert.rejects(
      downloadUv(ctx, TARGETS['darwin-x64']),
      (error) => error.code === 'target/unsupported',
    );
  });
});

test('downloads and unpacks uv into the backend', async () => {
  await withRoot(async (ctx) => {
    const uvExe = await downloadUv(ctx, target, {
      fetchImpl: async () => zipResponse(ZIP_WITH_UV),
    });

    assert.equal(uvExe, join(ctx.paths.backendRoot, 'uv', 'uv.exe'));
    assert.ok(existsSync(uvExe));
    assert.ok(existsSync(uvArchivePath(ctx.paths.cacheDir, target)));
  });
});

test('reports an archive that does not contain uv.exe', async () => {
  await withRoot(async (ctx) => {
    await assert.rejects(
      downloadUv(ctx, target, {
        fetchImpl: async () => zipResponse(ZIP_WITHOUT_UV),
      }),
      (error) => error.code === 'uv/missing-binary',
    );
  });
});

test('decodes a character split across two chunks', async () => {
  // Writes the three bytes of U+4E2D as 0xE4 then 0xB8 0xAD, so the character
  // straddles two chunks on purpose.
  const script =
    'process.stdout.write(Buffer.from([0xe4]));' +
    'process.stdout.write(Buffer.from([0xb8,0xad]));';
  const chunks = [];

  const result = await runUv(process.execPath, ['-e', script], {
    env: process.env,
    onOutput: (chunk, stream) => {
      if (stream === 'stdout') chunks.push(chunk);
    },
  });

  assert.equal(result.status, 0);
  assert.equal(chunks.join(''), '中');
  assert.doesNotMatch(chunks.join(''), /\ufffd/);
});

test('turns a non-zero exit into a result, not a rejection', async () => {
  const result = await runUv(process.execPath, ['-e', 'process.exit(3)'], {
    env: process.env,
  });

  assert.equal(result.status, 3);
});

test('leaves a spawn failure as the native error', async () => {
  await assert.rejects(
    runUv(join(tmpdir(), 'definitely-missing-uv.exe'), [], {
      env: process.env,
    }),
    (error) => !(error instanceof ToolchainError),
  );
});
