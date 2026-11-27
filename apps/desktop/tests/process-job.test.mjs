import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { startService } from '@felyrics/host';

import { createProcessJob } from '../src/main/process-job.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'job-tree.mjs');
const windowsOnly = { skip: process.platform !== 'win32' };

function isAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }

    throw error;
  }
}

async function until(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time');
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  'kills the child spawned after assignment when the job closes',
  windowsOnly,
  async () => {
    const job = createProcessJob();
    const tree = spawn(process.execPath, [fixture], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: tree.stdout });

    try {
      job.assign(tree.pid);

      const childPid = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('the fixture did not report its child'));
        }, 5_000);

        lines.once('line', (line) => {
          clearTimeout(timer);
          resolve(Number(line));
        });

        // The child is spawned after assignment, so it is only inside the job
        // if the job owns the parent at that moment.
        tree.stdin.write('spawn\n');
      });

      assert.ok(isAlive(tree.pid));
      assert.ok(isAlive(childPid));

      job.close();

      await until(() => !isAlive(tree.pid) && !isAlive(childPid));
      // The handle is closed once; a second close is a no-op rather than a
      // second CloseHandle on a handle that is already gone.
      job.close();
    } finally {
      lines.close();

      if (tree.exitCode === null) {
        try {
          tree.kill('SIGKILL');
        } catch {
          // The job already killed it.
        }
      }
    }
  },
);

test('refuses an assignment after the job is closed', windowsOnly, () => {
  const job = createProcessJob();

  job.close();
  assert.throws(() => job.assign(process.pid), /already closed/);
});

test(
  'a job close that kills the backend is not a stop failure',
  windowsOnly,
  async () => {
    const stopErrors = [];
    const client = startService({
      pythonExe: process.execPath,
      // Resumed stdin plus a live timer: EOF does not end this backend, so the
      // only thing that can stop it is the job.
      args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'],
      createJob: createProcessJob,
      closeTimeoutMs: 100,
      killTimeoutMs: 500,
      onStopError: (error) => stopErrors.push(error),
    });

    const code = await client.close();

    assert.ok(code === null || typeof code === 'number');
    // The job already killed the process; the fallback taskkill races a pid
    // that is gone and must not turn that into a stop failure.
    assert.deepEqual(stopErrors, []);
  },
);
