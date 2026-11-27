// A process tree for the job object test: the parent waits on stdin and spawns
// its child only when the test says so, which proves the child inherits a job
// that was assigned after the parent had already started.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

if (process.argv.includes('--child')) {
  // The grandchild is the process that would escape a plain taskkill of the
  // parent if the job object did not own the tree.
  setInterval(() => {}, 1_000);
} else {
  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    if (line === 'spawn') {
      const child = spawn(process.execPath, [process.argv[1], '--child'], {
        stdio: 'ignore',
      });

      process.stdout.write(`${String(child.pid)}\n`);
    }
  }
}
