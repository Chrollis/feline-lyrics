import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ToolchainError } from '@felyrics/toolchain';

import { BackendError, startService } from '../dist/index.js';

// A fake backend: it answers like the felyrics backend, and can misbehave on
// request. `中` is data here, not an identifier.
const FIXTURE = `
import { createInterface } from 'node:readline';

const reply = (body) => JSON.stringify({ v: 1, ...body }) + '\\n';

const lines = createInterface({ input: process.stdin });

// A backend that ignores EOF: only the kill path can stop it, so close() has to
// fall back instead of waiting forever.
if (process.argv.includes('--ignore-eof')) {
  setInterval(() => {}, 1_000);
}

// A backend that speaks another version: the client must not read the rest of
// the line as if the format were the one it knows.
if (process.argv.includes('--stale-version')) {
  for await (const raw of lines) {
    process.stdout.write(
      JSON.stringify({ v: 2, id: JSON.parse(raw).id, result: {} }) + '\\n',
    );
  }

  process.exit(0);
}

for await (const raw of lines) {
  const request = JSON.parse(raw);

  if (request.method === 'die') {
    process.exit(3);
  }

  if (request.method === 'badcode') {
    process.stdout.write(
      reply({
        id: request.id,
        error: { code: 7, message: 'the code is not a string' },
      }),
    );
    continue;
  }

  if (request.method === 'refuseversion') {
    process.stdout.write(
      reply({
        id: request.id,
        error: {
          code: 'protocol/version-mismatch',
          message:
            'this backend speaks protocol version 1, the request declared none',
          data: { declared: 2, expected: 1 },
        },
      }),
    );
    continue;
  }

  if (request.method === 'nullerror') {
    process.stdout.write(
      reply({
        id: request.id,
        error: null,
        result: { ok: true },
      }),
    );
    continue;
  }

  if (request.method === 'ghost') {
    process.stdout.write(reply({ id: 99, result: { ghost: true } }));
    continue;
  }

  if (request.method === 'twice') {
    const line = reply({ id: request.id, result: { once: true } });

    process.stdout.write(line);
    process.stdout.write(line);
    continue;
  }

  if (request.method === 'slowreply') {
    setTimeout(() => {
      process.stdout.write(reply({ id: request.id, result: { late: true } }));
    }, 200);
    continue;
  }

  if (request.method === 'hang') {
    continue;
  }

  if (request.method === 'log') {
    process.stderr.write('diagnostic 中\\n');
  }

  if (request.method === 'garbage') {
    process.stdout.write('not json\\n');
  }

  if (request.method === 'fail') {
    process.stdout.write(
      reply({
        id: request.id,
        error: { code: 'felyrics.media/open-failed', message: 'cannot open the file' },
      }),
    );
    continue;
  }

  if (request.method === 'split') {
    const bytes = Buffer.from(
      reply({ id: request.id, result: { text: '中' } }),
    );
    const at = bytes.indexOf(0xe4) + 1;

    process.stdout.write(bytes.subarray(0, at));
    setTimeout(() => process.stdout.write(bytes.subarray(at)), 10);
    continue;
  }

  if (request.method === 'cross') {
    const bytes = Buffer.from('diagnostic 中\\n');
    const at = bytes.indexOf(0xe4) + 1;

    process.stderr.write(bytes.subarray(0, at));
    process.stdout.write(
      reply({ id: request.id, result: { text: '中' } }),
    );
    setTimeout(() => process.stderr.write(bytes.subarray(at)), 10);
    continue;
  }

  if (request.method === 'huge') {
    process.stdout.write(
      reply({ id: request.id, result: { text: 'x'.repeat(1024 * 1024 + 1) } }),
    );
    continue;
  }

  process.stdout.write(
    reply({ id: request.id, result: { method: request.method } }),
  );
}
`;

async function withService(options, fn) {
  const { extraArgs = [], ...rest } = options;
  const dir = mkdtempSync(join(tmpdir(), 'felyrics-service-'));
  const file = join(dir, 'service.mjs');

  writeFileSync(file, FIXTURE);

  const client = startService({
    pythonExe: process.execPath,
    args: [file, ...extraArgs],
    ...rest,
  });

  try {
    await fn(client);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met in time');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('pairs each response with its own request', async () => {
  await withService({}, async (client) => {
    const [alpha, beta] = await Promise.all([
      client.request('alpha'),
      client.request('beta'),
    ]);

    assert.deepEqual(alpha, { method: 'alpha' });
    assert.deepEqual(beta, { method: 'beta' });
  });
});

test('decodes a character split across two chunks', async () => {
  await withService({}, async (client) => {
    const result = await client.request('split');

    assert.equal(result.text, '中');
    assert.doesNotMatch(JSON.stringify(result), /\ufffd/);
  });
});

test('keeps a half-received stderr character out of the protocol channel', async () => {
  const chunks = [];
  const protocolErrors = [];

  await withService(
    {
      onStderr: (chunk) => chunks.push(chunk),
      onProtocolError: (line) => protocolErrors.push(line),
    },
    async (client) => {
      const result = await client.request('cross');

      assert.equal(result.text, '中');
      await until(() => chunks.join('').includes('中'));
      assert.match(chunks.join(''), /diagnostic 中/);
      assert.doesNotMatch(JSON.stringify(result), /\ufffd/);
      assert.deepEqual(protocolErrors, []);
    },
  );
});

test('rejects the pending request when the process exits', async () => {
  await withService({}, async (client) => {
    const error = await client.request('die').then(
      () => null,
      (reason) => reason,
    );

    assert.ok(error instanceof ToolchainError);
    assert.equal(error.code, 'backend/unavailable');
    assert.equal(error.context.status, 3);
    assert.match(error.message, /exited with code 3/);
  });
});

test('refuses to queue a request once the process is gone', async () => {
  await withService({}, async (client) => {
    await assert.rejects(client.request('die'));

    await assert.rejects(client.request('alpha'), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'backend/unavailable');
      assert.equal(error.context.command, 'alpha');
      return true;
    });
  });
});

test('gives up on a request the backend never answers', async () => {
  await withService({}, async (client) => {
    await assert.rejects(
      client.request('hang', {}, { timeoutMs: 50 }),
      (error) => {
        assert.ok(error instanceof ToolchainError);
        assert.equal(error.code, 'backend/timeout');
        assert.equal(error.context.command, 'hang');
        assert.match(error.message, /within 50 ms/);
        return true;
      },
    );
    // The timeout only stops the wait: the process is still usable afterwards.
    assert.deepEqual(await client.request('alpha'), { method: 'alpha' });
  });
});

test('refuses an answer from another protocol version', async () => {
  const rejected = [];

  await withService(
    {
      extraArgs: ['--stale-version'],
      onProtocolError: (line, error) => rejected.push(error),
    },
    async (client) => {
      await assert.rejects(client.request('alpha'), (error) => {
        assert.ok(error instanceof ToolchainError);
        assert.equal(error.code, 'backend/version-mismatch');
        assert.equal(error.context.declared, 2);
        assert.equal(error.context.expected, 1);
        assert.match(error.message, /protocol version 2/);
        return true;
      });
    },
  );

  // The line is also reported unreadable, so a log shows the stray answer even
  // if no request was waiting for it.
  assert.equal(rejected.length, 1);
});

test('reports a version the backend refuses like a version it answers with', async () => {
  await withService({}, async (client) => {
    await assert.rejects(client.request('refuseversion'), (error) => {
      assert.ok(error instanceof ToolchainError);
      // One condition, one code for the caller: which side noticed is an
      // implementation detail, and both say "ask the other process its version".
      assert.equal(error.code, 'backend/version-mismatch');
      assert.equal(error.context.expected, 1);
      assert.equal(error.context.command, 'refuseversion');
      // The direction where the backend refused us now carries the number too,
      // so a renderer never has to read it out of the English sentence.
      assert.equal(error.context.declared, 2);
      return true;
    });
  });
});

test('calls a late answer late instead of a protocol error', async () => {
  const reported = [];

  await withService(
    { onProtocolError: (line, error) => reported.push(error.message) },
    async (client) => {
      await assert.rejects(
        client.request('slowreply', {}, { timeoutMs: 50 }),
        (error) => error.code === 'backend/timeout',
      );

      // The answer arrives 150 ms after we stopped waiting for it.
      await until(() => reported.length > 0);
    },
  );

  assert.equal(reported.length, 1);
  // The wording matters: the backend kept its promise, we stopped listening, and
  // a diagnostic that blames them sends the next reader the wrong way.
  assert.match(reported[0], /answer to id 1, which is no longer pending/);
});

test('calls a second answer to the same id late, not unasked', async () => {
  const reported = [];

  await withService(
    { onProtocolError: (line, error) => reported.push(error.message) },
    async (client) => {
      assert.deepEqual(await client.request('twice'), { once: true });
      await until(() => reported.length > 0);
    },
  );

  assert.equal(reported.length, 1);
  // We did send id 1, so the second answer is ours to explain; a diagnostic
  // saying "nobody asked for 1" would send the next reader after the backend.
  assert.match(reported[0], /answer to id 1, which is no longer pending/);
});

test('does not blame a late answer for an id it never sent', async () => {
  const reported = [];

  await withService(
    { onProtocolError: (line, error) => reported.push(error.message) },
    async (client) => {
      await assert.rejects(
        client.request('ghost', {}, { timeoutMs: 50 }),
        (error) => error.code === 'backend/timeout',
      );
    },
  );

  assert.equal(reported.length, 1);
  assert.match(reported[0], /never sent/);
});

test('keeps diagnostics off the protocol channel', async () => {
  const chunks = [];
  const protocolErrors = [];

  await withService(
    {
      onStderr: (chunk) => chunks.push(chunk),
      onProtocolError: (line) => protocolErrors.push(line),
    },
    async (client) => {
      await client.request('log');
      await until(() => chunks.join('').includes('diagnostic'));

      assert.match(chunks.join(''), /diagnostic 中/);
      assert.deepEqual(protocolErrors, []);
    },
  );
});

test('reports a line that is not a response', async () => {
  const lines = [];

  await withService(
    { onProtocolError: (line) => lines.push(line) },
    async (client) => {
      await client.request('garbage');
      await until(() => lines.length > 0);

      assert.deepEqual(lines, ['not json']);
    },
  );
});

test('keeps the backend error code when a request fails', async () => {
  await withService({}, async (client) => {
    const error = await client.request('fail').then(
      () => null,
      (reason) => reason,
    );

    assert.ok(error instanceof BackendError);
    assert.equal(error.code, 'felyrics.media/open-failed');
    assert.equal(error.message, 'cannot open the file');
  });
});

test('refuses a result over the payload bound', async () => {
  await withService({}, async (client) => {
    const error = await client.request('huge').then(
      () => null,
      (reason) => reason,
    );

    assert.ok(error instanceof BackendError);
    assert.equal(error.code, 'protocol/oversize');
  });
});

test('refuses to invent a backend code out of a malformed error', async () => {
  await withService({}, async (client) => {
    await assert.rejects(client.request('badcode'), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'backend/protocol');
      assert.equal(error.context.command, 'badcode');
      return true;
    });
    // The client is a wire reader, not a crash: the next request still works.
    assert.deepEqual(await client.request('alpha'), { method: 'alpha' });
  });
});

test('close resolves even after the process has already exited', async () => {
  await withService({}, async (client) => {
    await assert.rejects(client.request('die'));

    assert.equal(await client.close(), 3);
    assert.equal(await client.close(), 3);
  });
});

test('treats a null error field as "no error"', async () => {
  await withService({}, async (client) => {
    // `{ "error": null }` used to be destructured and throw inside the stdout
    // callback, which is an uncaught exception in the parent process.
    assert.deepEqual(await client.request('nullerror'), { ok: true });
  });
});

test('gives every request a deadline by default', async () => {
  await withService({ defaultTimeoutMs: 50 }, async (client) => {
    await assert.rejects(client.request('hang'), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'backend/timeout');
      assert.match(error.message, /within 50 ms/);
      return true;
    });
  });
});

test('close resolves when the interpreter never started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'felyrics-service-'));
  const client = startService({
    pythonExe: join(dir, 'no-such-python.exe'),
  });

  try {
    await assert.rejects(client.request('ping'), (error) => {
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'backend/unavailable');
      return true;
    });
    // `error` arrives instead of `exit`, so a close that only waited for `exit`
    // would hang the quit path on a machine with a broken install.
    assert.equal(await client.close(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close waits for the exit code', async () => {
  await withService({}, async (client) => {
    assert.equal(await client.close(), 0);
  });
});

test('kills a backend that ignores EOF within the close deadline', async () => {
  const stopErrors = [];

  await withService(
    {
      extraArgs: ['--ignore-eof'],
      closeTimeoutMs: 100,
      killTimeoutMs: 5_000,
      onStopError: (error) => stopErrors.push(error),
    },
    async (client) => {
      const pending = client.request('hang');
      const started = Date.now();
      const [error, code] = await Promise.all([
        pending.then(
          () => null,
          (reason) => reason,
        ),
        client.close(),
      ]);
      const elapsed = Date.now() - started;

      // The pending request hears why it will never be answered, and close
      // returns a code or null instead of hanging on a process that ignores
      // stdin.
      assert.ok(error instanceof ToolchainError);
      assert.equal(error.code, 'backend/unavailable');
      assert.match(error.message, /the service is closing/);
      assert.ok(elapsed < 5_000, `close took ${elapsed} ms`);
      assert.ok(code === null || typeof code === 'number');
      assert.deepEqual(stopErrors, []);
    },
  );
});

test('assigns the job the spawned pid and closes it once', async () => {
  const assigned = [];
  let closed = 0;

  const job = {
    assign(pid) {
      assigned.push(pid);
    },
    close() {
      closed += 1;
    },
  };

  await withService({ createJob: () => job }, async (client) => {
    assert.deepEqual(await client.request('alpha'), { method: 'alpha' });
    assert.equal(assigned.length, 1);
    assert.ok(Number.isInteger(assigned[0]) && assigned[0] > 0);
    assert.equal(closed, 0);

    await client.close();
    assert.equal(closed, 1);

    // The shutdown path and the finally block both close; the job must hear it
    // once.
    await client.close();
    assert.equal(closed, 1);
  });
});

test('reports a job factory failure and still serves', async () => {
  const stopErrors = [];

  await withService(
    {
      createJob: () => {
        throw new Error('koffi is missing');
      },
      onStopError: (error) => stopErrors.push(error),
    },
    async (client) => {
      assert.deepEqual(await client.request('alpha'), { method: 'alpha' });
      assert.equal(stopErrors.length, 1);
      assert.match(stopErrors[0].message, /koffi is missing/);

      // A missing job is a degraded stop, not a failed start.
      assert.equal(await client.close(), 0);
      assert.equal(stopErrors.length, 1);
    },
  );
});

test('reports an assignment failure once and keeps serving', async () => {
  const stopErrors = [];
  let closed = 0;

  const job = {
    assign() {
      throw new Error('assign failed');
    },
    close() {
      closed += 1;
    },
  };

  await withService(
    { createJob: () => job, onStopError: (error) => stopErrors.push(error) },
    async (client) => {
      assert.deepEqual(await client.request('alpha'), { method: 'alpha' });
      assert.equal(stopErrors.length, 1);
      assert.match(stopErrors[0].message, /assign failed/);
      assert.equal(closed, 1);

      assert.deepEqual(await client.request('beta'), { method: 'beta' });
      assert.equal(await client.close(), 0);
      assert.equal(closed, 1);
    },
  );
});

test('reports a tree kill that returns false', async () => {
  const stopErrors = [];

  await withService(
    {
      extraArgs: ['--ignore-eof'],
      closeTimeoutMs: 50,
      killTimeoutMs: 50,
      killTree: async (pid) => {
        // Kill the fixture directly so a failing fake does not leak it; the
        // report is about the fake's answer, not about the process still
        // running.
        process.kill(pid, 'SIGKILL');

        return false;
      },
      onStopError: (error) => stopErrors.push(error),
    },
    async (client) => {
      const started = Date.now();
      const code = await client.close();
      const elapsed = Date.now() - started;

      assert.ok(code === null || typeof code === 'number');
      assert.equal(stopErrors.length, 1);
      assert.match(stopErrors[0].message, /tree kill failed/);
      assert.ok(elapsed < 2_000, `close took ${elapsed} ms`);
    },
  );
});

test('reports a tree kill that throws', async () => {
  const stopErrors = [];

  await withService(
    {
      extraArgs: ['--ignore-eof'],
      closeTimeoutMs: 50,
      killTimeoutMs: 50,
      killTree: async (pid) => {
        process.kill(pid, 'SIGKILL');

        throw new Error('taskkill failed');
      },
      onStopError: (error) => stopErrors.push(error),
    },
    async (client) => {
      const code = await client.close();

      assert.ok(code === null || typeof code === 'number');
      assert.equal(stopErrors.length, 1);
      assert.match(stopErrors[0].message, /taskkill failed/);
    },
  );
});

test('reports a tree kill that never finishes', async () => {
  const stopErrors = [];

  await withService(
    {
      extraArgs: ['--ignore-eof'],
      closeTimeoutMs: 50,
      killTimeoutMs: 50,
      killTree: async (pid) => {
        process.kill(pid, 'SIGKILL');

        await new Promise(() => {});
      },
      onStopError: (error) => stopErrors.push(error),
    },
    async (client) => {
      const started = Date.now();
      const code = await client.close();
      const elapsed = Date.now() - started;

      assert.ok(code === null || typeof code === 'number');
      assert.equal(stopErrors.length, 1);
      assert.match(stopErrors[0].message, /did not finish within 50 ms/);
      assert.ok(elapsed < 2_000, `close took ${elapsed} ms`);
    },
  );
});
