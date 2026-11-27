/**
 * The app's quit gate.
 *
 * Electron starts quitting as soon as the `before-quit` handlers return, so the
 * first request is held while the plugin hosts and the backend close. Those
 * stops are bounded per service, not as a whole: N plugins each get their own
 * disposal timeout, so a stuck plugin could otherwise leave the process alive
 * without a window. This controller puts one deadline around the whole stop,
 * and a second quit request skips the wait entirely.
 */

export interface QuitControllerOptions {
  /** Stops every plugin host normally; may reject. */
  readonly shutdownPlugins: () => Promise<void>;
  /** Stops every backend normally; runs after the plugin hosts; may reject. */
  readonly shutdownBackend: () => Promise<unknown>;
  /** The deadline's last resort: closes utility children without waiting. */
  readonly forceClosePlugins: () => void;
  /** Asks Electron to continue a normal quit. */
  readonly quit: () => void;
  /** Terminates the process; used only on the forced path. */
  readonly exit: (code: number) => void;
  readonly log: (message: string, error?: unknown) => void;
  readonly timeoutMs?: number;
}

export interface QuitController {
  beforeQuit(event: { preventDefault(): void }): void;
}

export const DEFAULT_QUIT_TIMEOUT_MS = 5_000;

type QuitState = 'running' | 'stopping' | 'ready' | 'exited';

export function createQuitController(
  options: QuitControllerOptions,
): QuitController {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;

  let state: QuitState = 'running';
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A call, not an inline comparison: `state` can change while a stop is
  // awaited, and TypeScript would otherwise narrow the later check away.
  const exited = (): boolean => state === 'exited';

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /** The forced path: exactly one exit, whatever asked for it. */
  const force = (): void => {
    if (state === 'ready' || state === 'exited') {
      return;
    }

    state = 'exited';
    clearTimer();

    try {
      options.forceClosePlugins();
    } catch (error) {
      options.log('[bootstrap] forced plugin close failed', error);
    }

    try {
      options.exit(0);
    } catch (error) {
      options.log('[bootstrap] exit failed', error);
    }
  };

  const shutdown = async (): Promise<void> => {
    try {
      await options.shutdownPlugins();
    } catch (error) {
      options.log('[bootstrap] plugin shutdown failed', error);
    }

    if (exited()) {
      return;
    }

    try {
      await options.shutdownBackend();
    } catch (error) {
      options.log('[bootstrap] backend shutdown failed', error);
    }

    if (exited()) {
      return;
    }

    clearTimer();
    state = 'ready';

    try {
      options.quit();
    } catch (error) {
      options.log('[bootstrap] quit failed', error);
    }
  };

  return {
    beforeQuit(event) {
      if (state === 'ready') {
        return;
      }

      event.preventDefault();

      if (state === 'exited') {
        return;
      }

      if (state === 'stopping') {
        force();
        return;
      }

      state = 'stopping';

      timer = setTimeout(() => {
        timer = undefined;

        if (state !== 'stopping') {
          return;
        }

        options.log(`shutdown did not finish within ${timeoutMs} ms`);
        force();
      }, timeoutMs);

      void shutdown();
    },
  };
}
