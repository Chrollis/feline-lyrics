import { BackendError } from '@felyrics/host';

/**
 * One startup run and the signal that can stop it. `work` is the original
 * promise: it rejects on timeout, so a caller must consume it even when Retry
 * only waits for `settled`.
 */
export interface StartupAttempt<T> {
  readonly controller: AbortController;
  readonly work: Promise<T>;
  readonly settled: Promise<void>;
}

/**
 * Starts the work immediately with a fresh signal. `settled` never rejects: it
 * answers "is the old attempt done?" without repeating its error.
 */
export function beginStartup<T>(
  work: (signal: AbortSignal) => Promise<T>,
): StartupAttempt<T> {
  const controller = new AbortController();
  const result = work(controller.signal);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  return { controller, work: result, settled };
}

/**
 * Soft deadline: rejects when `work` outlives `timeoutMs` and lets `onTimeout`
 * cancel it, so the caller can retry instead of waiting forever.
 */
export function withDeadline<T>(
  work: Promise<T>,
  onTimeout: () => void,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Abort first: the rejection must not land before the work has been told
      // to stop, or a retry could race the work this deadline is failing.
      onTimeout();
      reject(new BackendError('core/timeout', 'the startup did not finish'));
    }, timeoutMs);

    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Aborts an attempt and waits, bounded, for its work to settle. A false answer
 * means Retry must not clear the scratch or start another provision yet: the old
 * work is still touching the same backend root.
 */
export async function settleStartup<T>(
  attempt: StartupAttempt<T>,
  timeoutMs: number,
): Promise<boolean> {
  attempt.controller.abort();

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);

    timer.unref?.();
    void attempt.settled.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
