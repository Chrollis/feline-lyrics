import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ToolchainError } from '../errors.js';

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
  /**
   * Cancels the download, including one already streaming. A cancel is not a
   * failure to retry: the loop stops on the first attempt that sees it aborted.
   */
  readonly signal?: AbortSignal;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_IDLE_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

class RetryableError extends Error {}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sleeps unless the caller cancels first. The retry backoff is the last place a
 * cancellation could hide, for up to `MAX_BACKOFF_MS`, and a cancel button that
 * needs half a minute reads as a broken button.
 */
async function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    return;
  }

  let wake: (() => void) | undefined;

  try {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        // A zero-argument listener: the event carries nothing we need, and
        // `resolve` itself is not an `EventListener`.
        const onAbort = (): void => {
          resolve();
        };

        wake = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    // The timer keeps running when the abort wins; only the listener must go.
    if (wake !== undefined) {
      signal.removeEventListener('abort', wake);
    }
  }
}

const defaultRemovePartial: RemovePartial = (path) => rm(path, { force: true });

/**
 * The error a cancelled download fails with. The code is stable so a caller can
 * tell "the user gave up" from "the network failed"; the caller's own abort
 * reason rides along as `cause`, where it belongs, instead of replacing it.
 */
function cancelled(signal: AbortSignal, url: string): ToolchainError {
  const cause = signal.reason instanceof Error ? signal.reason : undefined;

  return new ToolchainError(
    'download/cancelled',
    'the download was cancelled',
    { url },
    cause === undefined ? undefined : { cause },
  );
}

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
  readonly signal: AbortSignal | undefined;
}

async function attemptDownload(options: AttemptOptions): Promise<number> {
  const part = `${options.dest}.part`;
  const stallError = new Error('download stalled');
  const controller = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  let rejectStall: ((error: Error) => void) | undefined;

  // The caller's cancellation reaches this attempt through the same signal the
  // stall timer aborts, so every wait below stops for either reason.
  const forwardAbort = () => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal?.aborted) {
    forwardAbort();
  }

  // Races every wait below, so a stall stops the attempt even when the
  // transport ignores the abort signal.
  const stall = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });
  stall.catch(() => {}); // a rejection after the race is decided must not be unhandled

  // The caller's cancel needs its own race: a transport that never ends its
  // body parks the loop inside `reader.read()`, where no check of ours can run
  // until the idle timer fires.
  let stopOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    stopOnAbort = () => {
      const reason = options.signal?.reason;

      reject(reason instanceof Error ? reason : new Error('cancelled'));
    };
    if (options.signal?.aborted === true) {
      stopOnAbort();
    } else {
      options.signal?.addEventListener('abort', stopOnAbort, { once: true });
    }
  });
  aborted.catch(() => {});

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
      const { done, value } = await Promise.race([
        reader.read(),
        stall,
        aborted,
      ]);
      // A transport may ignore the abort and keep handing out bytes. This check
      // is the only thing that stops the loop, and it runs before the write so a
      // cancelled download can never reach the rename below.
      if (options.signal?.aborted) {
        throw cancelled(options.signal, options.url);
      }
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
    options.signal?.removeEventListener('abort', forwardAbort);
    if (stopOnAbort !== undefined) {
      options.signal?.removeEventListener('abort', stopOnAbort);
    }
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
    signal,
  } = options;

  if (attempts < 1) {
    throw new Error('attempts must be at least 1');
  }

  await mkdir(dirname(dest), { recursive: true });

  const part = `${dest}.part`;

  // The loop is the only exit: it returns the size or throws. A `for (;;)`
  // keeps that true without a trailing throw nobody can reach.
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) {
      throw cancelled(signal, url);
    }

    try {
      return await attemptDownload({
        url,
        dest,
        fetchImpl,
        minBytes,
        idleMs,
        onProgress,
        signal,
      });
    } catch (error) {
      // Cleanup is a courtesy. If it fails, the caller must still see the
      // download failure that caused it.
      await removePartial(part).catch(() => {});

      // A cancellation is a decision, not a hiccup: retrying it would ignore the
      // caller for two more backoffs, and the stall message would be a lie.
      if (signal?.aborted) {
        throw cancelled(signal, url);
      }

      // Only `fetchOnce` and the body checks produce RetryableError, so any
      // other error is ours and a retry would only flatten its stack.
      if (!(error instanceof RetryableError) || attempt >= attempts) {
        throw error;
      }

      // A cancel that arrives during the backoff must not wait it out.
      await sleepUnlessAborted(retryDelay(attempt), signal);
      if (signal?.aborted) {
        throw cancelled(signal, url);
      }
    }
  }
}
