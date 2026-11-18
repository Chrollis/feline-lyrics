import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { download, withTempDir } from '../../out/index.js';

function respondWith(bytes, { contentLength = bytes.length } = {}) {
  const headers =
    contentLength === null ? {} : { 'content-length': String(contentLength) };

  return new Response(bytes, { headers });
}

test('rejects a cancelled download without retrying it', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'uv.zip');
    let calls = 0;

    await assert.rejects(
      download({
        url: 'https://example.com/file',
        dest,
        minBytes: 1,
        attempts: 3,
        signal: AbortSignal.abort(new Error('the user cancelled the setup')),
        fetchImpl: async () => {
          calls += 1;

          return respondWith(new Uint8Array([1, 2, 3]));
        },
      }),
      (error) => {
        // The code is the stable half: a caller branches on it, not on a message.
        assert.equal(error.code, 'download/cancelled');
        assert.equal(error.message, 'the download was cancelled');
        assert.equal(error.context.url, 'https://example.com/file');
        assert.equal(error.cause.message, 'the user cancelled the setup');
        return true;
      },
    );

    // A cancellation is a decision, not a stall: nothing is even requested.
    assert.equal(calls, 0);
    await assert.rejects(stat(dest));
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('stops a streaming download when the caller aborts', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'uv.zip');
    const controller = new AbortController();
    let calls = 0;

    // A body that never finishes: only the abort can end this.
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const pending = download({
      url: 'https://example.com/file',
      dest,
      minBytes: 1,
      attempts: 3,
      idleMs: 400,
      signal: controller.signal,
      fetchImpl: async () => {
        calls += 1;

        return new Response(body);
      },
    });

    setTimeout(() => {
      controller.abort(new Error('the user cancelled the setup'));
    }, 20);

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'download/cancelled');
      assert.equal(error.cause.message, 'the user cancelled the setup');
      return true;
    });
    assert.equal(calls, 1);
  });
});

test('stops even when the transport ignores the abort', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'uv.zip');
    const controller = new AbortController();
    let sent = 0;

    // A transport that never looks at its signal: it keeps producing chunks
    // until it is told to stop, which is what a misbehaving mock or a socket
    // that ignores the close looks like. Without the loop's own check these
    // bytes are written and renamed into place, so the cancelled file wins.
    const body = new ReadableStream({
      pull(stream) {
        if (sent >= 200) {
          return;
        }
        sent += 1;
        stream.enqueue(new Uint8Array(1024).fill(sent));
      },
    });
    const started = Date.now();

    const pending = download({
      url: 'https://example.com/file',
      dest,
      minBytes: 1,
      attempts: 3,
      idleMs: 5_000,
      signal: controller.signal,
      fetchImpl: async () => new Response(body),
    });

    setTimeout(() => {
      controller.abort(new Error('cancelled while the body streamed'));
    }, 20);

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'download/cancelled');
      assert.equal(error.cause.message, 'cancelled while the body streamed');
      return true;
    });

    // The stall timer is 5 s, so a run that took longer than 1 s means the loop
    // only stopped because of the timer, not because of the caller.
    assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
    await assert.rejects(stat(dest));
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('stops a backoff when the caller aborts during it', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'uv.zip');
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();

    const pending = download({
      url: 'https://example.com/file',
      dest,
      minBytes: 1,
      attempts: 3,
      retryDelay: () => 5_000,
      signal: controller.signal,
      fetchImpl: async () => {
        calls += 1;

        return new Response('busy', { status: 503 });
      },
    });

    setTimeout(() => {
      controller.abort(new Error('cancelled during the backoff'));
    }, 20);

    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'download/cancelled');
      assert.equal(error.cause.message, 'cancelled during the backoff');
      return true;
    });

    // One 5 s backoff would dwarf this; the abort has to cut it short.
    assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
    assert.equal(calls, 1);
    await assert.rejects(stat(dest));
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('writes the body to the destination', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'runtime.tar.gz');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);

    const received = await download({
      url: 'https://example.com/file',
      dest,
      minBytes: 1,
      fetchImpl: async () => respondWith(payload),
    });

    assert.equal(received, payload.length);
    assert.deepEqual(new Uint8Array(await readFile(dest)), payload);
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('rejects a body shorter than content-length and removes the partial file', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'runtime.tar.gz');

    await assert.rejects(
      download({
        url: 'https://example.com/file',
        dest,
        minBytes: 1,
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
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'runtime.tar.gz');

    await assert.rejects(
      download({
        url: 'https://example.com/file',
        dest,
        minBytes: 64,
        attempts: 1,
        fetchImpl: async () =>
          respondWith(new Uint8Array(10), { contentLength: null }),
      }),
      /below the 64-byte floor/,
    );
  });
});

test('retries a 5xx and then succeeds', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
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
      minBytes: 1,
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
  await withTempDir('felyrics-download-', async (dir) => {
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
        minBytes: 1,
        fetchImpl,
        idleMs: 10,
        attempts: 1,
      }),
      /download stalled/,
    );
  });
});

test('does not retry a 404', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    let calls = 0;

    const fetchImpl = async () => {
      calls += 1;
      return new Response('not found', { status: 404 });
    };

    await assert.rejects(
      download({ url: 'https://example.test/a', dest, minBytes: 1, fetchImpl }),
      /HTTP 404/,
    );
    assert.equal(calls, 1);
  });
});

test('removes the part file after the last failed attempt', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'archive.tar.gz');

    const fetchImpl = async () => new Response('boom', { status: 503 });

    await assert.rejects(
      download({
        url: 'https://example.test/a',
        dest,
        minBytes: 1,
        fetchImpl,
        attempts: 2,
        retryDelay: () => 1,
      }),
      /HTTP 503/,
    );
    await assert.rejects(stat(`${dest}.part`));
  });
});

test('keeps the download error when cleaning up the partial file fails', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    let calls = 0;

    const fetchImpl = async () => {
      calls += 1;
      return new Response('boom', { status: 503 });
    };

    await assert.rejects(
      download({
        url: 'https://example.test/a',
        dest,
        minBytes: 1,
        fetchImpl,
        attempts: 2,
        retryDelay: () => 1,
        removePartial: async () => {
          throw new Error('EBUSY: resource busy or locked');
        },
      }),
      /HTTP 503/,
    );

    // The cleanup failure neither stopped the retry nor replaced the cause.
    assert.equal(calls, 2);
  });
});

test('does not retry a TypeError that carries no cause', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    let calls = 0;

    const fetchImpl = async () => {
      calls += 1;
      throw new TypeError('programmer error');
    };

    await assert.rejects(
      download({
        url: 'https://example.test/a',
        dest,
        minBytes: 1,
        fetchImpl,
        attempts: 3,
        retryDelay: () => 1,
      }),
      /programmer error/,
    );
    assert.equal(calls, 1);
  });
});

test('retries a TypeError that carries a cause, the shape fetch uses', async () => {
  await withTempDir('felyrics-download-', async (dir) => {
    const dest = join(dir, 'archive.tar.gz');
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    let calls = 0;

    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', {
          cause: new Error('ECONNRESET'),
        });
      }
      return respondWith(payload);
    };

    const received = await download({
      url: 'https://example.test/a',
      dest,
      minBytes: 1,
      fetchImpl,
      retryDelay: () => 1,
    });

    assert.equal(received, payload.byteLength);
    assert.equal(calls, 2);
  });
});
