import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { ToolchainError } from '../errors.js';

export interface ServiceMessage {
  readonly id?: number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ServiceOptions {
  /** The backend's interpreter: the venv python, never a system one. */
  readonly pythonExe: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Diagnostics arrive here; the protocol channel stays clean. */
  readonly onStderr?: (chunk: string) => void;
  /** A line on stdout that is not a response we can route. */
  readonly onProtocolError?: (line: string, error: Error) => void;
}

export interface ServiceRequestOptions {
  /**
   * Give up after this long. A timeout stops waiting, not the backend: the
   * request may still finish server-side, which is why the caller retries a
   * method that is safe to repeat, never one that writes.
   */
  readonly timeoutMs?: number;
}

export interface ServiceClient {
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: ServiceRequestOptions,
  ): Promise<T>;
  close(): Promise<number | null>;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: NodeJS.Timeout;
}

/**
 * A failure the backend reported, with the protocol's `code` kept as a field.
 *
 * The code is the part a caller branches on, so folding it into the message
 * (`"media/open-failed: cannot open ..."`) would leave every backend failure
 * indistinguishable from a crash by the time it reaches the renderer.
 *
 * The vocabulary belongs to the backend (`media/open-failed`,
 * `method/not-found`, `protocol/invalid-request`, `internal/error`), which is why
 * this is not a `ToolchainError`: the toolchain cannot enumerate codes that a new
 * service method may invent, and a backend release must not need a toolchain one.
 */
export class BackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }
}

/**
 * Starts one long-lived backend and speaks its line protocol.
 *
 * The process is not restarted here: a backend that dies is a state the caller
 * has to decide about, so the client only reports it.
 */
export function startService(options: ServiceOptions): ServiceClient {
  const child = spawn(options.pythonExe, [...(options.args ?? [])], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // One decoder per stream: a decoder holds the bytes of a half-received
  // character, so sharing it would let a partial stderr write swallow the head
  // of the next stdout line.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const pending = new Map<number, Pending>();
  const emitStderr = options.onStderr;
  const emitProtocolError = options.onProtocolError;
  let buffered = '';
  let nextId = 1;
  let closed = false;
  let exitCode: number | null = null;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }

      entry.reject(error);
    }

    pending.clear();
  };

  const handleLine = (line: string): void => {
    let message: ServiceMessage;

    try {
      message = JSON.parse(line) as ServiceMessage;
    } catch (error) {
      emitProtocolError?.(line, error as Error);
      return;
    }

    const id = message.id;

    if (typeof id !== 'number') {
      emitProtocolError?.(line, new Error('the line carries no numeric id'));
      return;
    }

    const entry = pending.get(id);

    if (entry === undefined) {
      emitProtocolError?.(
        line,
        new Error(`no request is waiting for id ${id}`),
      );
      return;
    }

    pending.delete(id);

    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }

    if (message.error) {
      entry.reject(new BackendError(message.error.code, message.error.message));
    } else {
      entry.resolve(message.result);
    }
  };

  // A chunk boundary can fall inside a character, and inside a line: decode
  // across chunks and split on the newline only after decoding.
  const absorbStdout = (text: string): void => {
    buffered += text;

    let newline = buffered.indexOf('\n');

    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);

      if (line.trim() !== '') {
        handleLine(line);
      }

      newline = buffered.indexOf('\n');
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    absorbStdout(stdoutDecoder.write(chunk));
  });

  child.stderr.on('data', (chunk: Buffer) => {
    emitStderr?.(stderrDecoder.write(chunk));
  });

  // A closed pipe or a process that never started is our side of the wire: the
  // renderer still needs a code to branch on, so these are `backend/unavailable`
  // rather than the native error the filesystem happened to produce.
  child.stdin.on('error', (error: Error) => {
    closed = true;
    failAll(
      new ToolchainError(
        'backend/unavailable',
        `the backend stdin is closed: ${error.message}`,
        {},
        { cause: error },
      ),
    );
  });

  child.on('error', (error: Error) => {
    closed = true;
    failAll(
      new ToolchainError(
        'backend/unavailable',
        `the backend process failed to start: ${error.message}`,
        {},
        { cause: error },
      ),
    );
  });

  child.on('exit', (code: number | null) => {
    closed = true;
    exitCode = code;

    // Flush what each decoder still holds, so a diagnostic that ends inside a
    // character is shown as a replacement character instead of vanishing.
    absorbStdout(stdoutDecoder.end());

    const tail = stderrDecoder.end();

    if (tail !== '') {
      emitStderr?.(tail);
    }

    failAll(
      new ToolchainError(
        'backend/unavailable',
        `the service exited with code ${code ?? 'null'}`,
        code === null ? {} : { status: code },
      ),
    );
  });

  return {
    request<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
      options: ServiceRequestOptions = {},
    ): Promise<T> {
      if (closed) {
        return Promise.reject(
          new ToolchainError('backend/unavailable', 'the service is closed', {
            command: method,
          }),
        );
      }

      const id = nextId;

      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        const { timeoutMs } = options;
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                if (!pending.delete(id)) {
                  return;
                }

                reject(
                  new ToolchainError(
                    'backend/timeout',
                    `the backend did not answer ${method} within ${timeoutMs} ms`,
                    { command: method },
                  ),
                );
              }, timeoutMs);

        // A pending timer must not be what keeps the app alive on quit.
        timer?.unref();

        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          ...(timer === undefined ? {} : { timer }),
        });

        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },

    close(): Promise<number | null> {
      if (closed) {
        return Promise.resolve(exitCode);
      }

      closed = true;
      child.stdin.end();

      return new Promise((resolve) => {
        child.once('exit', (code) => resolve(code));
      });
    },
  };
}
