import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Removes a partial file. The caller swallows whatever it throws. */
export type RemovePartial = (path: string) => Promise<void>;

export interface DownloadOptions {
  readonly url: string;
  readonly dest: string;
  /**
   * The floor a body must reach when the server sends no content-length.
   * Required on purpose: a forgotten floor silently turns the only remaining
   * integrity check into "more than a few bytes arrived".
   */
  readonly minBytes: number;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  /** Abort when no bytes arrive for this many milliseconds. 0 disables it. */
  readonly idleMs?: number;
  /** Milliseconds to wait before the next attempt, given the failed attempt. */
  readonly retryDelay?: (attempt: number) => number;
  readonly onProgress?: (received: number, total: number | null) => void;
  /** Replaces the partial-file cleanup; a seam for tests. */
  readonly removePartial?: RemovePartial;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_IDLE_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

class RetryableError extends Error {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultRemovePartial: RemovePartial = (path) => rm(path, { force: true });

function defaultRetryDelay(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/**
 * The only place that decides "this failure is the transport's, not ours".
 * Node reports a transport failure as `TypeError: fetch failed` with the
 * socket error in `cause`; a TypeError without a cause is a bug in the code
 * that called us, and retrying it would flatten the stack for nothing.
 */
async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(url, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw new RetryableError('download stalled');
    }
    if (error instanceof TypeError && error.cause !== undefined) {
      throw new RetryableError(`fetch failed: ${String(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
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
      fetchOnce(options.fetchImpl, options.url, controller.signal),
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
    // A close failure here would replace the error on its way out.
    await handle?.close().catch(() => {});
  }
}

export async function download(options: DownloadOptions): Promise<number> {
  const {
    url,
    dest,
    minBytes,
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    idleMs = DEFAULT_IDLE_MS,
    retryDelay = defaultRetryDelay,
    onProgress,
    removePartial = defaultRemovePartial,
  } = options;

  if (attempts < 1) {
    throw new Error('attempts must be at least 1');
  }

  await mkdir(dirname(dest), { recursive: true });

  const part = `${dest}.part`;

  // The loop is the only exit: it returns the size or throws. A `for (;;)`
  // keeps that true without a trailing throw nobody can reach.
  for (let attempt = 1; ; attempt += 1) {
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
      // Cleanup is a courtesy. If it fails, the caller must still see the
      // download failure that caused it.
      await removePartial(part).catch(() => {});

      // Only `fetchOnce` and the body checks produce RetryableError, so any
      // other error is ours and a retry would only flatten its stack.
      if (!(error instanceof RetryableError) || attempt >= attempts) {
        throw error;
      }

      await sleep(retryDelay(attempt));
    }
  }
}
