import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadOptions {
  readonly url: string;
  readonly dest: string;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly minBytes?: number;
  /** Abort when no bytes arrive for this many milliseconds. 0 disables it. */
  readonly idleMs?: number;
  /** Milliseconds to wait before the next attempt, given the failed attempt. */
  readonly retryDelay?: (attempt: number) => number;
  readonly onProgress?: (received: number, total: number | null) => void;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MIN_BYTES = 1024;
const DEFAULT_IDLE_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

class RetryableError extends Error {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultRetryDelay(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

interface AttemptOptions {
  readonly url: string;
  readonly dest: string;
  readonly fetchImpl: typeof fetch;
  readonly minBytes: number;
  readonly idleMs: number;
  readonly onProgress:
    ((received: number, total: number | null) => void) | undefined;
}

import type { FileHandle } from 'node:fs/promises';

async function attemptDownload(options: AttemptOptions): Promise<number> {
  const part = `${options.dest}.part`;
  const stallError = new Error('download stalled');
  const controller = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  let rejectStall: ((error: Error) => void) | undefined;

  // Races every wait below, so a stall stops the attempt even when the
  // transport ignores the abort signal.
  const stall = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });
  stall.catch(() => {}); // a rejection after the race is decided must not be unhandled

  const armStallTimer = () => {
    clearTimeout(stallTimer);
    if (options.idleMs > 0) {
      stallTimer = setTimeout(() => {
        controller.abort(stallError);
        rejectStall?.(stallError);
      }, options.idleMs);
    }
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let handle: FileHandle | undefined;

  try {
    armStallTimer();
    const response = await Promise.race([
      options.fetchImpl(options.url, { signal: controller.signal }),
      stall,
    ]);

    if (!response.ok) {
      const message = `HTTP ${response.status} for ${options.url}`;
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(message);
      }
      throw new Error(message);
    }

    if (!response.body) {
      throw new Error(`empty response body for ${options.url}`);
    }

    const total = Number(response.headers.get('content-length')) || 0;
    handle = await open(part, 'w');
    reader = response.body.getReader();
    let received = 0;

    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stall]);
      if (done) {
        break;
      }
      armStallTimer();
      received += value.byteLength;
      await handle.write(value);
      options.onProgress?.(received, total > 0 ? total : null);
    }

    if (total > 0 && received !== total) {
      throw new RetryableError(
        `truncated download: received ${received} of ${total} bytes`,
      );
    }
    if (total === 0 && received < options.minBytes) {
      throw new RetryableError(
        `truncated download: received ${received} bytes, below the ${options.minBytes}-byte floor`,
      );
    }

    // Windows cannot rename a file that is still open.
    await handle.close();
    handle = undefined;
    await rename(part, options.dest);
    return received;
  } catch (error) {
    if (error === stallError) {
      throw new RetryableError('download stalled');
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    await reader?.cancel().catch(() => {});
    await handle?.close();
  }
}

export async function download(options: DownloadOptions): Promise<number> {
  const {
    url,
    dest,
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    minBytes = DEFAULT_MIN_BYTES,
    idleMs = DEFAULT_IDLE_MS,
    retryDelay = defaultRetryDelay,
    onProgress,
  } = options;

  await mkdir(dirname(dest), { recursive: true });

  const part = `${dest}.part`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await attemptDownload({
        url,
        dest,
        fetchImpl,
        minBytes,
        idleMs,
        onProgress,
      });
    } catch (error) {
      lastError = error;
      await rm(part, { force: true });

      // A fetch network failure surfaces as TypeError; retry it. HTTP 4xx and
      // programming errors are not worth another attempt.
      const retryable =
        error instanceof RetryableError || error instanceof TypeError;

      if (!retryable || attempt === attempts) {
        throw error;
      }

      await sleep(retryDelay(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
