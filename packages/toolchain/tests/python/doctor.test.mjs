import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  backendPaths,
  doctor,
  PTH_FILENAME,
  PYTHON_VERSION,
  REQUIREMENTS_FILENAME,
  UV_VERSION,
  writeReadyMarker,
} from '../../out/index.js';

async function withBackend(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-doctor-'));
  const toolchain = {
    cacheDir: join(root, 'cache'),
    servicesDir: join(root, 'services'),
    backendRoot: join(root, 'backend'),
  };
  const backend = backendPaths(toolchain.backendRoot);

  mkdirSync(toolchain.servicesDir, { recursive: true });
  writeFileSync(
    join(toolchain.servicesDir, REQUIREMENTS_FILENAME),
    'av==19.0.2\nnumpy==2.5.5\n',
  );
  mkdirSync(dirname(backend.uvExe), { recursive: true });
  mkdirSync(dirname(backend.venvPython), { recursive: true });
  writeFileSync(backend.uvExe, '');
  writeFileSync(backend.venvPython, '');
  mkdirSync(backend.sitePackages, { recursive: true });
  writeFileSync(
    join(backend.sitePackages, PTH_FILENAME),
    `${resolve(toolchain.servicesDir)}\n`,
  );
  await writeReadyMarker(backend, {
    uv: UV_VERSION,
    python: PYTHON_VERSION,
    imports: resolve(toolchain.servicesDir),
    requirements: 'av==19.0.2\nnumpy==2.5.5',
  });

  try {
    await fn(toolchain, backend);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeRun(output = '') {
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });

    return {
      status: 0,
      output:
        output ||
        (file.endsWith('uv.exe')
          ? `uv ${UV_VERSION} (abc)`
          : `Python ${PYTHON_VERSION}`),
    };
  };

  return { calls, run };
}

function byLabel(report, label) {
  return report.checks.find((check) => check.label === label);
}

test('reports every check when the backend is healthy', async () => {
  await withBackend(async (toolchain) => {
    const { run } = fakeRun();

    const report = await doctor(toolchain, { run });

    assert.equal(report.ok, true);
    assert.deepEqual(
      report.checks.map((check) => check.label),
      ['uv', 'python', 'dependencies', 'pth', 'import', 'marker'],
    );
    assert.deepEqual(byLabel(report, 'dependencies'), {
      label: 'dependencies',
      ok: true,
      detail: 'av, numpy',
    });
    assert.deepEqual(byLabel(report, 'marker'), {
      label: 'marker',
      ok: true,
      detail: 'matches',
    });
  });
});

test('fails when a declared dependency cannot be imported', async () => {
  await withBackend(async (toolchain) => {
    const { run: version } = fakeRun();
    const run = (file, args) =>
      args[0] === '-c'
        ? { status: 1, output: "ModuleNotFoundError: No module named 'av'" }
        : version(file, args);

    const report = await doctor(toolchain, { run });
    const dependencies = byLabel(report, 'dependencies');

    assert.equal(report.ok, false);
    assert.equal(dependencies.ok, false);
    assert.match(dependencies.detail, /No module named 'av'/);
  });
});

test('accepts a backend with nothing to import', async () => {
  await withBackend(async (toolchain) => {
    const report = await doctor(toolchain, {
      run: fakeRun().run,
      requirements: [],
    });

    assert.deepEqual(byLabel(report, 'dependencies'), {
      label: 'dependencies',
      ok: true,
      detail: 'none declared',
    });
  });
});

test('fails the uv check when the binary is missing', async () => {
  await withBackend(async (toolchain, backend) => {
    rmSync(backend.uvExe);

    const report = await doctor(toolchain, { run: fakeRun().run });
    const uv = byLabel(report, 'uv');

    assert.equal(report.ok, false);
    assert.equal(uv.ok, false);
    assert.match(uv.detail, /missing/);
  });
});

test('fails when the interpreter reports another version', async () => {
  await withBackend(async (toolchain) => {
    const run = () => ({ status: 0, output: 'Python 3.11.9' });

    const report = await doctor(toolchain, { run });
    const python = byLabel(report, 'python');

    assert.equal(python.ok, false);
    assert.match(python.detail, /expected 3\.12\.15/);
  });
});

test('fails when the pth points somewhere else', async () => {
  await withBackend(async (toolchain, backend) => {
    writeFileSync(join(backend.sitePackages, PTH_FILENAME), 'C:\\elsewhere\n');

    const report = await doctor(toolchain, { run: fakeRun().run });

    assert.equal(report.ok, false);
    assert.match(byLabel(report, 'pth').detail, /does not mention/);
  });
});

test('catches a backend package that does not import', async () => {
  await withBackend(async (toolchain) => {
    const { run: base } = fakeRun();
    const run = (file, args) =>
      args[1]?.includes('felyrics_host.__main__')
        ? {
            status: 1,
            output: "ModuleNotFoundError: No module named 'does_not_exist'",
          }
        : base(file, args);

    const report = await doctor(toolchain, { run });
    const imported = byLabel(report, 'import');

    assert.equal(report.ok, false);
    assert.equal(imported.ok, false);
    assert.match(imported.detail, /does_not_exist/);
  });
});

test('fails when the marker records another import list', async () => {
  await withBackend(async (toolchain, backend) => {
    await writeReadyMarker(backend, {
      uv: UV_VERSION,
      python: PYTHON_VERSION,
      imports: 'C:\\elsewhere',
      requirements: 'av==19.0.2\nnumpy==2.5.5',
    });

    const report = await doctor(toolchain, { run: fakeRun().run });

    assert.equal(report.ok, false);
    assert.match(byLabel(report, 'marker').detail, /elsewhere/);
  });
});
