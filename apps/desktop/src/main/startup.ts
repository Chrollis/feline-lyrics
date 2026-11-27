import { mkdir, mkdtemp, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BackendError, ManifestError } from '@felyrics/host';
import {
  backendPaths,
  doctor,
  expectedMarker,
  isReady,
  provision,
  readReadyMarker,
  ToolchainError,
  type ProvisionStep,
  type ReadyMarker,
  type ResolvedMirrorConfig,
  type ToolchainPaths,
} from '@felyrics/toolchain';

import { planEnvironment } from './environment.js';

export type StartupPhase =
  | 'checking'
  | 'installing'
  | 'verifying'
  | 'ready'
  | 'failed';

/** What the progress window renders; one event, one status. */
export interface StartupStatus {
  readonly phase: StartupPhase;
  readonly title: string;
  readonly step?: ProvisionStep;
  /** The last few output lines, newest last. */
  readonly log: readonly string[];
  /** Present when `phase` is failed. */
  readonly code?: string;
  readonly message?: string;
}

const STEP_TITLES: Record<ProvisionStep, string> = {
  uv: 'Downloading uv',
  python: 'Installing Python',
  venv: 'Creating the environment',
  pth: 'Wiring import paths',
  packages: 'Installing packages',
  marker: 'Writing the ready marker',
};

/** Kept short: the window shows a tail, and the full log goes to disk. */
const LOG_TAIL = 8;

/** A download line is refreshed at most this often, so the window is not spammed. */
const PROGRESS_INTERVAL_MS = 400;

function progressTitle(
  step: 'uv' | 'python',
  received: number,
  total: number | null,
): string {
  const base = step === 'uv' ? 'Downloading uv' : 'Downloading Python';
  const size = `${(received / (1024 * 1024)).toFixed(1)} MB`;

  if (total === null || total <= 0) {
    return `${base}: ${size}`;
  }

  const percent = Math.floor((received / total) * 100);
  return `${base}: ${size} / ${(total / (1024 * 1024)).toFixed(1)} MB (${percent}%)`;
}

export interface StartupOptions {
  readonly paths: ToolchainPaths;
  readonly userDataDir: string;
  readonly hostBackendRoot: string;
  readonly builtinPluginsRoot: string;
  /** Where the uv/python/package downloads come from, mirrors first. */
  readonly mirrors: ResolvedMirrorConfig;
  /**
   * The network the app downloads with. The main process passes Electron's
   * `net.fetch`, which goes through Chromium and therefore the system proxy;
   * the global Node fetch ignores that proxy and stalls behind it.
   */
  readonly fetchImpl?: typeof fetch;
  /** Rebuild even when the marker matches. */
  readonly force?: boolean;
  readonly onStatus: (status: StartupStatus) => void;
}

/** The line the window shows, and the line a failed install writes to disk. */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (
    error instanceof ManifestError ||
    error instanceof BackendError ||
    error instanceof ToolchainError
  ) {
    return { code: error.code, message: error.message };
  }

  return {
    code: 'core/backend-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function appendLog(
  userDataDir: string,
  lines: readonly string[],
): Promise<void> {
  if (lines.length === 0) {
    return;
  }

  const directory = join(userDataDir, 'logs');

  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString();
  await appendFile(
    join(directory, 'provision.log'),
    lines.map((line) => `${stamp} ${line}\n`).join(''),
    'utf8',
  );
}

/**
 * Brings the backend to ready before the main window exists.
 *
 * The marker decides whether anything is installed, but `doctor` runs every
 * time: a marker proves a run finished, not that the venv still imports. The
 * progress window exists for the slow path; a ready backend still gets the
 * verifying step, because that is the step that can fail on a half-deleted venv.
 */
export async function runStartup(
  options: StartupOptions,
): Promise<ReadyMarker> {
  const { onStatus } = options;
  const log: string[] = [];
  const status = (next: StartupStatus): void => {
    onStatus(next);
  };
  const push = (line: string): void => {
    log.push(line);

    if (log.length > LOG_TAIL) {
      log.shift();
    }
  };
  let lastProgress = { step: 'uv' as 'uv' | 'python', title: '', at: 0 };
  // The window shows live state; the log records the phases so a stuck install
  // can be read after the fact.
  const note = (line: string): void => {
    void appendLog(options.userDataDir, [line]).catch(() => {});
  };
  const onProgress = (
    step: 'uv' | 'python',
    received: number,
    total: number | null,
  ): void => {
    const now = Date.now();
    const title = progressTitle(step, received, total);

    if (
      title === lastProgress.title ||
      (step === lastProgress.step && now - lastProgress.at < PROGRESS_INTERVAL_MS)
    ) {
      return;
    }

    lastProgress = { step, title, at: now };
    status({ phase: 'installing', title, step, log });
  };

  try {
    status({
      phase: 'checking',
      title: 'Checking the Python environment',
      log,
    });
    note('phase: checking');

    const backend = backendPaths(options.paths.backendRoot);
    // The marker is the only place the installed python version is written; a
    // first run has none, so the engine check waits for the next startup.
    const installed = await readReadyMarker(backend);
    const environment = await planEnvironment(
      options.hostBackendRoot,
      options.builtinPluginsRoot,
      installed?.python,
    );
    const marker = expectedMarker(
      environment.importPaths,
      environment.requirements,
    );
    const ready =
      options.force === true ? false : await isReady(backend, marker);

    if (!ready) {
      const tempDir = await mkdtemp(join(options.userDataDir, 'provision-'));

      try {
        await provision({
          paths: options.paths,
          tempDir,
          requirements: environment.requirements,
          importPaths: environment.importPaths,
          mirrors: options.mirrors,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.force === true ? { force: true } : {}),
          onStep: (step) => {
            lastProgress = { step: 'uv', title: '', at: 0 };
            note(`step: ${step}`);
            status({
              phase: 'installing',
              title: STEP_TITLES[step],
              step,
              log,
            });
          },
          onProgress,
          onOutput: (chunk) => {
            push(chunk.trimEnd());

            if (chunk.includes('\n')) {
              status({
                phase: 'installing',
                title: 'Installing the Python environment',
                log,
              });
            }
          },
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    status({
      phase: 'verifying',
      title: 'Verifying the environment',
      log,
    });
    note('phase: verifying');

    // The install may have picked a newer 3.12 patch than the pinned constant;
    // doctor trusts the marker for the version, not a number in the source.
    const current = await readReadyMarker(backend);
    const report = await doctor(options.paths, {
      requirements: environment.requirements,
      importPaths: environment.importPaths,
      plugins: environment.plugins,
      ...(current === null ? {} : { pythonVersion: current.python }),
    });

    if (!report.ok) {
      const failed = report.checks.find((check) => !check.ok);

      throw new BackendError(
        'core/backend-failed',
        failed === undefined
          ? 'the environment did not verify'
          : `${failed.label}: ${failed.detail}`,
      );
    }

    status({ phase: 'ready', title: 'Ready', log });
    note('phase: ready');

    const verified = await readReadyMarker(backend);

    if (verified === null) {
      throw new BackendError('core/backend-failed', 'the ready marker disappeared');
    }

    return verified;
  } catch (error) {
    const failure = describeFailure(error);

    push(`${failure.code}: ${failure.message}`);
    await appendLog(options.userDataDir, log);
    status({
      phase: 'failed',
      title: 'The Python environment is not ready',
      code: failure.code,
      message: failure.message,
      log,
    });
    throw error;
  }
}
