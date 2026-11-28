import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { ServiceJob } from '@felyrics/host';
import { createProcessJob } from './process-job.js';

export interface SelfTestRequest {
  readonly mode: 'packaged-koffi';
  readonly dir: string;
}

const MODE_FLAG = '--self-test=packaged-koffi';
const DIR_FLAG = '--self-test-dir=';
const KILL_TIMEOUT_MS = 5_000;

/**
 * Recognises the internal packaged smoke arguments. Any other self-test mode is
 * refused instead of silently starting the normal app. A mode without a writable
 * absolute directory is a broken invocation, so it throws rather than returning
 * null and launching the GUI.
 */
export function parseSelfTestArgs(
  argv: readonly string[],
): SelfTestRequest | null {
  if (!argv.includes(MODE_FLAG)) {
    const unknown = argv.find((argument) => argument.startsWith('--self-test='));

    if (unknown !== undefined) {
      throw new Error(`unknown self-test mode: ${unknown}`);
    }

    return null;
  }

  const dirArgument = argv.find((argument) => argument.startsWith(DIR_FLAG));
  const dir = dirArgument?.slice(DIR_FLAG.length) ?? '';

  if (dir.length === 0 || !isAbsolute(dir)) {
    throw new Error(`${DIR_FLAG}<directory> must name an absolute path`);
  }

  return { mode: 'packaged-koffi', dir };
}

function writeResult(dir: string, text: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.txt'), text, 'utf8');

    return text === 'packaged koffi ok';
  } catch (error) {
    console.error(`[self-test] cannot write the result under ${dir}`, error);

    return false;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    promise.then(
      (value) => finish(value),
      () => finish(undefined),
    );
  });
}

/**
 * Loads koffi through the packaged Electron resolution, creates a job, assigns a
 * child that would otherwise outlive us, closes the job, and requires the child
 * to exit. Runs only when the app was launched with the self-test arguments.
 */
export async function runPackagedKoffiSmoke(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return writeResult(
      dir,
      'packaged koffi failed: the packaged smoke only runs on Windows',
    );
  }

  let job: ServiceJob | undefined;
  let child: ChildProcess | undefined;
  let pid: number | undefined;

  try {
    job = createProcessJob();

    const command = process.env.ComSpec ?? 'cmd.exe';
    child = spawn(command, ['/d', '/s', '/c', 'ping -n 30 127.0.0.1'], {
      stdio: 'ignore',
      windowsHide: true,
    });

    if (child.pid === undefined) {
      throw new Error('the ping child has no pid');
    }

    pid = child.pid;

    // Attach before assign/close so an early exit is observed rather than lost.
    const exited = new Promise<boolean>((resolve) => {
      child?.once('exit', () => resolve(true));
      child?.once('error', () => resolve(false));
    });

    job.assign(pid);

    if (child.exitCode !== null) {
      throw new Error('the ping child exited before the job closed');
    }

    job.close();

    const killed = await withTimeout(exited, KILL_TIMEOUT_MS);

    if (killed !== true) {
      throw new Error('the ping child did not exit after the job closed');
    }

    return writeResult(dir, 'packaged koffi ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return writeResult(dir, `packaged koffi failed: ${message}`);
  } finally {
    try {
      job?.close();
    } catch (error) {
      console.error('[self-test] job close failed', error);
    }

    if (child !== undefined && child.exitCode === null) {
      if (pid !== undefined) {
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (error) {
          console.error('[self-test] taskkill failed', error);
        }
      }

      child.kill();
    }
  }
}
