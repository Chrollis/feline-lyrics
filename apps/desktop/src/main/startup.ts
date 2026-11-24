import { mkdir, mkdtemp, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BackendError, ManifestError } from '@felyrics/host';
import {
  backendPaths,
  doctor,
  expectedMarker,
  isReady,
  provision,
  type ProvisionStep,
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

export interface StartupOptions {
  readonly paths: ToolchainPaths;
  readonly userDataDir: string;
  readonly hostBackendRoot: string;
  readonly builtinPluginsRoot: string;
  /** Rebuild even when the marker matches. */
  readonly force?: boolean;
  readonly onStatus: (status: StartupStatus) => void;
}

/** The line the window shows, and the line a failed install writes to disk. */
function describe(error: unknown): { code: string; message: string } {
  if (error instanceof ManifestError || error instanceof BackendError) {
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
export async function runStartup(options: StartupOptions): Promise<void> {
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

  try {
    status({
      phase: 'checking',
      title: 'Checking the Python environment',
      log,
    });

    const environment = await planEnvironment(
      options.hostBackendRoot,
      options.builtinPluginsRoot,
    );
    const backend = backendPaths(options.paths.backendRoot);
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
          ...(options.force === true ? { force: true } : {}),
          onStep: (step) => {
            status({
              phase: 'installing',
              title: STEP_TITLES[step],
              step,
              log,
            });
          },
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

    const report = await doctor(options.paths, {
      requirements: environment.requirements,
      importPaths: environment.importPaths,
      plugins: environment.plugins,
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
  } catch (error) {
    const failure = describe(error);

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
