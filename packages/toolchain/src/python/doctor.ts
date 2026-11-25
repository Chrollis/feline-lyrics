import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ToolchainPaths } from '../layout/paths.js';
import { backendPaths, type BackendPaths } from '../layout/paths.js';
import { PTH_FILENAME } from './pth.js';
import { isReady, readReadyMarker } from './ready.js';
import { requirementName, requirementsFingerprint } from './requirements.js';
import { PYTHON_SHORT_VERSION, UV_VERSION } from './target.js';

/** One line of the report: what was checked, whether it held, and why. */
export interface DoctorCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface BinaryRun {
  readonly status: number | null;
  /** stdout and stderr merged: both uv and python answer on either stream. */
  readonly output: string;
  readonly error?: string;
}

export type RunBinary = (file: string, args: readonly string[]) => BinaryRun;

/**
 * What a doctor run needs from one plugin: enough to check that the environment
 * can load it, without asking the toolchain to parse a manifest.
 */
export interface PluginDoctorSpec {
  readonly id: string;
  /** The `module:attribute` the loader will call; absent for a non-python backend. */
  readonly python?: string;
  /** Requirement lines this plugin adds to the shared environment. */
  readonly requirements: readonly string[];
}

export interface DoctorOptions {
  readonly run?: RunBinary;
  /** Requirement lines the venv must satisfy; the caller owns where they live. */
  readonly requirements: readonly string[];
  /** Directories the `.pth` must name; the caller owns the checkout layout. */
  readonly importPaths: readonly string[];
  /** The plugins whose backends share this environment. */
  readonly plugins: readonly PluginDoctorSpec[];
  /**
   * The interpreter version the marker recorded. The pinned 3.12 is only the
   * fallback for a first run; an install that followed a newer 3.12 patch must
   * not be reported as wrong by a constant.
   */
  readonly pythonVersion?: string;
}

const HOST_ENTRY = 'felyrics_host.__main__';

function runBinary(file: string, args: readonly string[]): BinaryRun {
  const result = spawnSync(file, [...args], { encoding: 'utf8' });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    ...(result.error ? { error: result.error.message } : {}),
  };
}

/**
 * The last non-empty line of a failed run: a traceback ends with the reason, and
 * the whole traceback would swamp a one-line report.
 */
function failureDetail(result: BinaryRun): string | undefined {
  const lines = result.output.split('\n').filter((line) => line.trim() !== '');

  return lines.at(-1);
}

function checkVersion(
  label: string,
  file: string,
  args: readonly string[],
  expected: string,
  run: RunBinary,
): DoctorCheck {
  if (!existsSync(file)) {
    return { label, ok: false, detail: `missing ${file}` };
  }

  const result = run(file, args);

  if (result.error || result.status !== 0) {
    return {
      label,
      ok: false,
      detail: result.output || result.error || 'did not run',
    };
  }

  if (!result.output.includes(expected)) {
    return {
      label,
      ok: false,
      detail: `expected ${expected}, got "${result.output}"`,
    };
  }

  return {
    label,
    ok: true,
    detail: result.output.split('\n')[0] ?? result.output,
  };
}

function checkSeries(
  label: string,
  file: string,
  series: string,
  run: RunBinary,
): DoctorCheck {
  if (!existsSync(file)) {
    return { label, ok: false, detail: `missing ${file}` };
  }

  const result = run(file, ['--version']);

  if (result.error || result.status !== 0) {
    return {
      label,
      ok: false,
      detail: result.output || result.error || 'did not run',
    };
  }

  if (!new RegExp(`Python ${series}\\.`).test(result.output)) {
    return {
      label,
      ok: false,
      detail: `expected ${series}.x, got "${result.output}"`,
    };
  }

  return {
    label,
    ok: true,
    detail: result.output.split('\n')[0] ?? result.output,
  };
}

/**
 * Asks the installed metadata, not the import system: the distribution name is
 * what `pip install` recorded, and `stable-ts` installs `stable_ts`, so importing
 * guessed import names would report a healthy environment as broken.
 */
function checkDependencies(
  backend: BackendPaths,
  requirements: readonly string[],
  run: RunBinary,
): DoctorCheck {
  const names = [
    ...new Set(requirements.map(requirementName).filter((name) => name !== '')),
  ];

  if (names.length === 0) {
    return { label: 'dependencies', ok: true, detail: 'none declared' };
  }

  if (!existsSync(backend.venvPython)) {
    return {
      label: 'dependencies',
      ok: false,
      detail: `missing ${backend.venvPython}`,
    };
  }

  const script = [
    'import importlib.metadata as metadata, sys',
    'missing = []',
    'for name in sys.argv[1:]:',
    '    try:',
    '        metadata.version(name)',
    '    except metadata.PackageNotFoundError:',
    '        missing.append(name)',
    "print(','.join(missing))",
  ].join('\n');
  const result = run(backend.venvPython, ['-c', script, ...names]);

  if (result.error || result.status !== 0) {
    return {
      label: 'dependencies',
      ok: false,
      detail: failureDetail(result) ?? result.error ?? 'metadata lookup failed',
    };
  }

  const missing = result.output
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  if (missing.length > 0) {
    return {
      label: 'dependencies',
      ok: false,
      detail: `missing: ${missing.join(', ')}`,
    };
  }

  return { label: 'dependencies', ok: true, detail: `installed: ${names.join(', ')}` };
}

/**
 * Importing is the only honest test of "is this installed": the marker and the
 * package list describe what was written, while an import runs the code the
 * backend will run. The attribute is checked too, because a manifest can name a
 * `serve` that the module forgot to define.
 */
function checkImport(
  label: string,
  backend: BackendPaths,
  target: string,
  run: RunBinary,
): DoctorCheck {
  if (!existsSync(backend.venvPython)) {
    return {
      label,
      ok: false,
      detail: `missing ${backend.venvPython}`,
    };
  }

  const [module] = target.split(':');

  if (module === undefined || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(module)) {
    return { label, ok: false, detail: `invalid target ${target}` };
  }

  const script = [
    'import importlib, sys',
    'module_name, _, attribute = sys.argv[1].partition(":")',
    'module = importlib.import_module(module_name)',
    'if attribute:',
    '    value = getattr(module, attribute)',
    '    if not callable(value):',
    '        raise TypeError(f"{attribute} is not callable")',
  ].join('\n');
  const result = run(backend.venvPython, ['-c', script, target]);

  if (result.error || result.status !== 0) {
    return {
      label,
      ok: false,
      detail: failureDetail(result) ?? result.error ?? 'import failed',
    };
  }

  return { label, ok: true, detail: target };
}

/**
 * Answers "can this backend be used right now", not "should it be rebuilt".
 * The marker alone cannot: it is a file, so it can be copied, rolled back or
 * moved with the repository. Running the binaries and reading the `.pth` is the
 * only check that notices a directory that survived but no longer works.
 */
export async function doctor(
  toolchain: ToolchainPaths,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const backend = backendPaths(toolchain.backendRoot);
  const imports = options.importPaths.map((directory) => resolve(directory));
  const run = options.run ?? runBinary;
  const checks: DoctorCheck[] = [];
  const requirements = options.requirements;
  const marker = await readReadyMarker(backend);
  // The marker is the record of what was installed, so its python wins over a
  // constant: a 3.12.16 install must not be reported as a broken 3.12.15.
  const pythonVersion = options.pythonVersion ?? marker?.python;
  // Same reasoning as python: the uv source follows `latest`, so the marker's
  // record beats the constant when one exists.
  const uvVersion = marker?.uv ?? UV_VERSION;

  checks.push(checkVersion('uv', backend.uvExe, ['--version'], uvVersion, run));

  if (pythonVersion === undefined) {
    checks.push(checkSeries('python', backend.venvPython, PYTHON_SHORT_VERSION, run));
  } else {
    checks.push(
      checkVersion('python', backend.venvPython, ['--version'], pythonVersion, run),
    );
  }

  checks.push(checkDependencies(backend, requirements, run));

  const pth = join(backend.sitePackages, PTH_FILENAME);

  if (!existsSync(pth)) {
    checks.push({ label: 'pth', ok: false, detail: `missing ${pth}` });
  } else {
    const lines = readFileSync(pth, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const missing = imports.filter((directory) => !lines.includes(directory));

    if (missing.length > 0) {
      checks.push({
        label: 'pth',
        ok: false,
        detail: `does not mention ${missing.join(', ')}`,
      });
    } else {
      checks.push({ label: 'pth', ok: true, detail: imports.join(', ') });
    }
  }

  checks.push(checkImport('import', backend, HOST_ENTRY, run));

  for (const plugin of options.plugins) {
    if (plugin.python !== undefined) {
      checks.push(
        checkImport(`import ${plugin.id}`, backend, plugin.python, run),
      );
    }
  }

  const matches = await isReady(backend, {
    uv: uvVersion,
    python: pythonVersion ?? '',
    imports: imports.join('\n'),
    requirements: requirementsFingerprint(requirements),
  });

  checks.push({
    label: 'marker',
    ok: matches,
    detail: matches
      ? 'matches'
      : marker === null
        ? 'missing'
        : JSON.stringify(marker),
  });

  return { ok: checks.every((check) => check.ok), checks };
}
