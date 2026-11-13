import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { download } from '../out/index.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'felyrics-download-'));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function respondWith(bytes, { contentLength = bytes.length } = {}) {
  const headers =
    contentLength === null ? {} : { 'content-length': String(contentLength) };

  return new Response(bytes, { headers });
}

test('writes the body to the destination', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'runtime.tar.gz');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);

    const received = await download({
      url: 'https://example.com/file',
      dest,
      fetchImpl: async () => respondWith(payload),
    });

    assert.equal(received, payload.length);
    assert.deepEqual(new Uint8Array(await readFile(dest)), payload);
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('rejects a body shorter than content-length and removes the partial file', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'runtime.tar.gz');

    await assert.rejects(
      download({
        url: 'https://example.com/file',
        dest,
        attempts: 1,
        fetchImpl: async () =>
          respondWith(new Uint8Array([1, 2, 3]), { contentLength: 1000 }),
      }),
      /truncated download/,
    );

    await assert.rejects(stat(dest));
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('rejects a tiny body when the server sends no content-length', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'runtime.tar.gz');

    await assert.rejects(
      download({
        url: 'https://example.com/file',
        dest,
        attempts: 1,
        minBytes: 64,
        fetchImpl: async () =>
          respondWith(new Uint8Array(10), { contentLength: null }),
      }),
      /below the 64-byte floor/,
    );
  });
});

test('retries a 5xx and then succeeds', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    const delays = [];
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    let calls = 0;

    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? new Response('boom', { status: 500 })
        : respondWith(payload);
    };

    const received = await download({
      url: 'https://example.test/a',
      dest,
      fetchImpl,
      retryDelay: (attempt) => {
        delays.push(attempt);
        return 1;
      },
    });

    assert.equal(received, payload.byteLength);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1]);
  });
});

test('aborts and reports a stall when no bytes arrive', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);

    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(payload.slice(0, 1));
          },
        }),
        { headers: { 'content-length': String(payload.byteLength) } },
      );

    await assert.rejects(
      download({
        url: 'https://example.test/a',
        dest,
        fetchImpl,
        idleMs: 10,
        attempts: 1,
      }),
      /download stalled/,
    );
  });
});

test('does not retry a 404', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    let calls = 0;

    const fetchImpl = async () => {
      calls += 1;
      return new Response('not found', { status: 404 });
    };

    await assert.rejects(
      download({ url: 'https://example.test/a', dest, fetchImpl }),
      /HTTP 404/,
    );
    assert.equal(calls, 1);
  });
});

test('removes the part file after the last failed attempt', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'archive.tar.gz');

    const fetchImpl = async () => new Response('boom', { status: 503 });

    await assert.rejects(
      download({
        url: 'https://example.test/a',
        dest,
        fetchImpl,
        attempts: 2,
        retryDelay: () => 1,
      }),
      /HTTP 503/,
    );
    await assert.rejects(stat(`${dest}.part`));
  });
});
