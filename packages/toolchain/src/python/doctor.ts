import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ToolchainPaths } from '../layout/paths.js';
import { backendPaths } from '../layout/paths.js';
import { PTH_FILENAME } from './pth.js';
import { isReady, readReadyMarker } from './ready.js';
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
}

function runBinary(file: string, args: readonly string[]): BinaryRun {
  const result = spawnSync(file, [...args], { encoding: 'utf8' });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    ...(result.error ? { error: result.error.message } : {}),
  };
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
  const services = resolve(toolchain.servicesDir);
  const run = options.run ?? runBinary;
  const checks: DoctorCheck[] = [];

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

  const pth = join(backend.sitePackages, PTH_FILENAME);

  if (!existsSync(pth)) {
    checks.push({ label: 'pth', ok: false, detail: `missing ${pth}` });
  } else if (!readFileSync(pth, 'utf8').includes(services)) {
    checks.push({
      label: 'pth',
      ok: false,
      detail: `does not mention ${services}`,
    });
  } else {
    checks.push({ label: 'pth', ok: true, detail: services });
  }

  const marker = await readReadyMarker(backend);
  const matches = await isReady(backend, {
    uv: UV_VERSION,
    python: PYTHON_VERSION,
    services,
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
