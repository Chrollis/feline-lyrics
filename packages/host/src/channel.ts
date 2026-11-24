import type { PluginEvent, PluginTransport } from './utility-protocol.js';

/**
 * The slice of Electron's `UtilityProcess` this file uses.
 *
 * Declaring it here keeps `@felyrics/host` free of a runtime `electron`
 * dependency: the app passes the real object in, the tests pass a fake, and the
 * lifecycle above never learns which one it holds.
 */
export interface UtilityChild {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  off(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  kill(): boolean;
}

export interface UtilityChannelOptions {
  /** Starts one utility process; the app closes over `utilityProcess.fork`. */
  readonly fork: () => UtilityChild;
}

/**
 * One `MessagePort`-style channel to a utility process.
 *
 * `close()` is called both by a normal unload and by the crash path, so it must
 * be idempotent; `closed` resolves exactly once, on exit or on close.
 */
export function createUtilityChannel(
  options: UtilityChannelOptions,
): PluginTransport {
  const child = options.fork();
  const listeners = new Set<(event: PluginEvent) => void>();

  let markClosed: () => void = () => {};
  let closed = false;

  const finish = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    listeners.clear();
    markClosed();
  };

  const closedPromise = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  child.on('message', (message) => {
    for (const listener of listeners) {
      listener(message as PluginEvent);
    }
  });
  child.on('exit', finish);

  return {
    send(event) {
      if (!closed) {
        child.postMessage(event);
      }
    },
    onMessage(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    get closed() {
      return closedPromise;
    },
    close() {
      if (!closed) {
        child.kill();
      }

      finish();
    },
  };
}
