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
  UV_VERSION,
  writeReadyMarker,
} from '../../out/index.js';

const REQUIREMENTS = ['av==19.0.2', 'numpy==2.5.5'];
const PLUGIN = {
  id: 'felyrics.media',
  python: 'felyrics_media.serve:serve',
  requirements: ['av==19.0.2', 'numpy==2.5.5'],
};

async function withBackend(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-doctor-'));
  const importsDir = join(root, 'imports');
  const toolchain = {
    cacheDir: join(root, 'cache'),
    backendRoot: join(root, 'backend'),
  };
  const backend = backendPaths(toolchain.backendRoot);

  mkdirSync(importsDir, { recursive: true });
  mkdirSync(dirname(backend.uvExe), { recursive: true });
  mkdirSync(dirname(backend.venvPython), { recursive: true });
  writeFileSync(backend.uvExe, '');
  writeFileSync(backend.venvPython, '');
  mkdirSync(backend.sitePackages, { recursive: true });
  writeFileSync(
    join(backend.sitePackages, PTH_FILENAME),
    `${resolve(importsDir)}\n`,
  );
  await writeReadyMarker(backend, {
    uv: UV_VERSION,
    python: PYTHON_VERSION,
    imports: resolve(importsDir),
    requirements: REQUIREMENTS.join('\n'),
  });

  try {
    await fn(toolchain, backend, importsDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function options(importsDir, run, extra = {}) {
  return {
    run,
    requirements: REQUIREMENTS,
    importPaths: [importsDir],
    plugins: [],
    ...extra,
  };
}

function fakeRun() {
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });

    // The dependency probe prints the missing names (none here); every other
    // call is a version or an import.
    if (args[1]?.includes('importlib.metadata')) {
      return { status: 0, output: '' };
    }

    return {
      status: 0,
      output: file.endsWith('uv.exe')
        ? `uv ${UV_VERSION} (abc)`
        : `Python ${PYTHON_VERSION}`,
    };
  };

  return { calls, run };
}

function byLabel(report, label) {
  return report.checks.find((check) => check.label === label);
}

test('reports every check when the backend is healthy', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const { run } = fakeRun();

    const report = await doctor(toolchain, options(importsDir, run));

    assert.equal(report.ok, true);
    assert.deepEqual(
      report.checks.map((check) => check.label),
      ['uv', 'python', 'dependencies', 'pth', 'import', 'marker'],
    );
    assert.deepEqual(byLabel(report, 'dependencies'), {
      label: 'dependencies',
      ok: true,
      detail: 'installed: av, numpy',
    });
    assert.deepEqual(byLabel(report, 'marker'), {
      label: 'marker',
      ok: true,
      detail: 'matches',
    });
  });
});

test('imports every plugin backend by name', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const { calls, run } = fakeRun();

    const report = await doctor(
      toolchain,
      options(importsDir, run, { plugins: [PLUGIN] }),
    );

    assert.equal(report.ok, true);
    assert.deepEqual(byLabel(report, 'import felyrics.media'), {
      label: 'import felyrics.media',
      ok: true,
      detail: 'felyrics_media.serve:serve',
    });
    const pluginCall = calls.find((call) =>
      call.args[2]?.startsWith('felyrics_media'),
    );

    assert.ok(pluginCall);
  });
});

test('fails when a declared distribution is missing', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const { run: version } = fakeRun();
    const run = (file, args) =>
      args[1]?.includes('importlib.metadata')
        ? { status: 0, output: 'stable-ts' }
        : version(file, args);

    const report = await doctor(
      toolchain,
      options(importsDir, run, {
        requirements: ['stable-ts[fw]>=2'],
      }),
    );
    const dependencies = byLabel(report, 'dependencies');

    assert.equal(report.ok, false);
    assert.equal(dependencies.ok, false);
    assert.match(dependencies.detail, /missing: stable-ts/);
  });
});

test('accepts a backend with nothing to import', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const report = await doctor(
      toolchain,
      options(importsDir, fakeRun().run, { requirements: [] }),
    );

    assert.deepEqual(byLabel(report, 'dependencies'), {
      label: 'dependencies',
      ok: true,
      detail: 'none declared',
    });
  });
});

test('fails the uv check when the binary is missing', async () => {
  await withBackend(async (toolchain, backend, importsDir) => {
    rmSync(backend.uvExe);

    const report = await doctor(
      toolchain,
      options(importsDir, fakeRun().run),
    );
    const uv = byLabel(report, 'uv');

    assert.equal(report.ok, false);
    assert.equal(uv.ok, false);
    assert.match(uv.detail, /missing/);
  });
});

test('fails when the interpreter reports another version', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const run = () => ({ status: 0, output: 'Python 3.11.9' });

    const report = await doctor(toolchain, options(importsDir, run));
    const python = byLabel(report, 'python');

    assert.equal(python.ok, false);
    assert.match(python.detail, /expected 3\.12\.15/);
  });
});

test('fails when the pth points somewhere else', async () => {
  await withBackend(async (toolchain, backend, importsDir) => {
    writeFileSync(join(backend.sitePackages, PTH_FILENAME), 'C:\\elsewhere\n');

    const report = await doctor(
      toolchain,
      options(importsDir, fakeRun().run),
    );

    assert.equal(report.ok, false);
    assert.match(byLabel(report, 'pth').detail, /does not mention/);
  });
});

test('catches a host entry that does not import', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const { run: base } = fakeRun();
    const run = (file, args) =>
      args[2] === 'felyrics_host.__main__'
        ? {
            status: 1,
            output: "ModuleNotFoundError: No module named 'does_not_exist'",
          }
        : base(file, args);

    const report = await doctor(toolchain, options(importsDir, run));
    const imported = byLabel(report, 'import');

    assert.equal(report.ok, false);
    assert.equal(imported.ok, false);
    assert.match(imported.detail, /does_not_exist/);
  });
});

test('catches a plugin entry that does not import', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const { run: base } = fakeRun();
    const run = (file, args) =>
      args[2] === 'felyrics_media.serve:serve'
        ? {
            status: 1,
            output: "ModuleNotFoundError: No module named 'felyrics_media'",
          }
        : base(file, args);

    const report = await doctor(
      toolchain,
      options(importsDir, run, { plugins: [PLUGIN] }),
    );
    const imported = byLabel(report, 'import felyrics.media');

    assert.equal(report.ok, false);
    assert.equal(imported.ok, false);
    assert.match(imported.detail, /No module named 'felyrics_media'/);
  });
});

test('catches a plugin entry that is not callable', async () => {
  await withBackend(async (toolchain, _backend, importsDir) => {
    const { run: base } = fakeRun();
    const run = (file, args) =>
      args[2] === 'felyrics_media.serve:serve'
        ? { status: 1, output: 'TypeError: serve is not callable' }
        : base(file, args);

    const report = await doctor(
      toolchain,
      options(importsDir, run, { plugins: [PLUGIN] }),
    );

    assert.match(
      byLabel(report, 'import felyrics.media').detail,
      /not callable/,
    );
  });
});

test('fails when the marker records another import list', async () => {
  await withBackend(async (toolchain, backend, importsDir) => {
    await writeReadyMarker(backend, {
      uv: UV_VERSION,
      python: PYTHON_VERSION,
      imports: 'C:\\elsewhere',
      requirements: REQUIREMENTS.join('\n'),
    });

    const report = await doctor(
      toolchain,
      options(importsDir, fakeRun().run),
    );

    assert.equal(report.ok, false);
    assert.match(byLabel(report, 'marker').detail, /elsewhere/);
  });
});

test('trusts the marker for the interpreter patch', async () => {
  await withBackend(async (toolchain, backend, importsDir) => {
    await writeReadyMarker(backend, {
      uv: UV_VERSION,
      python: '3.12.16',
      imports: resolve(importsDir),
      requirements: REQUIREMENTS.join('\n'),
    });

    const patched = (file, args) => {
      if (args[1]?.includes('importlib.metadata')) {
        return { status: 0, output: '' };
      }

      return {
        status: 0,
        output: file.endsWith('uv.exe')
          ? `uv ${UV_VERSION} (abc)`
          : 'Python 3.12.16',
      };
    };

    const trusted = await doctor(
      toolchain,
      options(importsDir, patched, { pythonVersion: '3.12.16' }),
    );
    const pinned = await doctor(toolchain, options(importsDir, patched));

    assert.equal(trusted.ok, true);
    assert.equal(pinned.ok, false);
    assert.match(byLabel(pinned, 'python').detail, /3\.12\.15/);
  });
});
