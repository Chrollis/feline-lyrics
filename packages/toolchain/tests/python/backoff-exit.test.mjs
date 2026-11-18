import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { withTempDir } from '../../out/index.js';

// Its own file on purpose: this test starts a child process, and a child process
// is not available everywhere. Keeping it here means an environment that forbids
// spawning reports one failing file that is entirely about spawning, instead of
// dragging seventeen unrelated download tests down with it.

test('leaves no timer behind when a backoff is cancelled', async () => {
  await withTempDir('felyrics-backoff-', async (dir) => {
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, '..', '..', 'out', 'index.js'),
    ).href;
    const scriptPath = join(dir, 'cancel-backoff.mjs');

    // A child process, because the symptom is "the event loop does not empty":
    // in this process the test runner owns timers of its own.
    await writeFile(
      scriptPath,
      `import { download } from ${JSON.stringify(moduleUrl)};

const controller = new AbortController();

setTimeout(() => {
  controller.abort(new Error('cancel'));
}, 20);

await download({
  url: 'https://example.com/file',
  dest: ${JSON.stringify(join(dir, 'uv.zip'))},
  minBytes: 1,
  attempts: 3,
  retryDelay: () => 5_000,
  signal: controller.signal,
  fetchImpl: async () => new Response('busy', { status: 503 }),
}).catch(() => {});
`,
    );

    const started = Date.now();
    const child = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const elapsed = Date.now() - started;

    assert.equal(child.status, 0, child.stderr);
    // The 5 s backoff must not outlive the cancel it lost against.
    assert.ok(elapsed < 2_000, `the child took ${elapsed} ms to exit`);
  });
});
