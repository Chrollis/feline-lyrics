import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ToolchainPaths } from '../layout/paths.js';
import { backendPaths, type BackendPaths } from '../layout/paths.js';
import { PTH_FILENAME } from './pth.js';
import { isReady, readReadyMarker } from './ready.js';
import {
  readRequirements,
  REQUIREMENTS_FILENAME,
  requirementModule,
  requirementsFingerprint,
} from './requirements.js';
import { PYTHON_VERSION, UV_VERSION } from './target.js';

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

export interface DoctorOptions {
  readonly run?: RunBinary;
  /** Defaults to `services/requirements.txt`; tests pass a list instead. */
  readonly requirements?: readonly string[];
  /**
   * Directories the `.pth` must name. Defaults to `servicesDir`, where the
   * backend sources lived before the host/plugin split.
   */
  readonly importPaths?: readonly string[];
}

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

/**
 * Importing is the only honest test of "is this installed": `uv pip list` reports
 * what the metadata claims, while an import runs the code the backend will run.
 */
function checkDependencies(
  backend: BackendPaths,
  requirements: readonly string[],
  run: RunBinary,
): DoctorCheck {
  const modules = [...new Set(requirements.map(requirementModule))];

  if (modules.length === 0) {
    return { label: 'dependencies', ok: true, detail: 'none declared' };
  }

  if (!existsSync(backend.venvPython)) {
    return {
      label: 'dependencies',
      ok: false,
      detail: `missing ${backend.venvPython}`,
    };
  }

  const result = run(backend.venvPython, [
    '-c',
    `import ${modules.join(', ')}`,
  ]);

  if (result.error || result.status !== 0) {
    return {
      label: 'dependencies',
      ok: false,
      detail: failureDetail(result) ?? result.error ?? 'import failed',
    };
  }

  return { label: 'dependencies', ok: true, detail: modules.join(', ') };
}

/**
 * The `.pth` check only proves a line of text; this runs the line. Importing the
 * entry point also runs the imports it declares at module level (the media
 * methods register there), so one command covers "the package resolves" and
 * "what it pulls in still loads".
 */
function checkImport(backend: BackendPaths, run: RunBinary): DoctorCheck {
  if (!existsSync(backend.venvPython)) {
    return {
      label: 'import',
      ok: false,
      detail: `missing ${backend.venvPython}`,
    };
  }

  const result = run(backend.venvPython, ['-c', 'import felyrics_host.__main__']);

  if (result.error || result.status !== 0) {
    return {
      label: 'import',
      ok: false,
      detail: failureDetail(result) ?? result.error ?? 'import failed',
    };
  }

  return { label: 'import', ok: true, detail: 'felyrics_host.__main__' };
}

/**
 * Answers "can this backend be used right now", not "should it be rebuilt".
 * The marker alone cannot: it is a file, so it can be copied, rolled back or
 * moved with the repository. Running the binaries and reading the `.pth` is the
 * only check that notices a directory that survived but no longer works.
 */
export async function doctor(
  toolchain: ToolchainPaths,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const backend = backendPaths(toolchain.backendRoot);
  const imports = (options.importPaths ?? [toolchain.servicesDir]).map(
    (directory) => resolve(directory),
  );
  const run = options.run ?? runBinary;
  const checks: DoctorCheck[] = [];
  let requirements: readonly string[] = [];

  checks.push(
    checkVersion('uv', backend.uvExe, ['--version'], UV_VERSION, run),
    checkVersion(
      'python',
      backend.venvPython,
      ['--version'],
      PYTHON_VERSION,
      run,
    ),
  );

  if (options.requirements) {
    requirements = options.requirements;
    checks.push(checkDependencies(backend, requirements, run));
  } else {
    try {
      requirements = readRequirements(toolchain.servicesDir);
      checks.push(checkDependencies(backend, requirements, run));
    } catch {
      checks.push({
        label: 'dependencies',
        ok: false,
        detail: `missing ${join(toolchain.servicesDir, REQUIREMENTS_FILENAME)}`,
      });
    }
  }

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

  checks.push(checkImport(backend, run));

  const marker = await readReadyMarker(backend);
  const matches = await isReady(backend, {
    uv: UV_VERSION,
    python: PYTHON_VERSION,
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
