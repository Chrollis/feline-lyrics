import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { ToolchainError } from '../errors.js';

/**
 * The envelope both sides speak. Each side states its own version and rejects a
 * line that declares another one; a mismatch means one of the two processes is
 * not the build the other expects, which the files on disk cannot reveal.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Reads the version the other side reported, out of an error's open `data`.
 *
 * Anything that is not a number is "the backend did not say": guessing here
 * would put a made-up version in front of a person who is debugging a mismatch.
 */
function declaredVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }

  const value = (data as { declared?: unknown }).declared;

  return typeof value === 'number' ? value : undefined;
}

export interface ServiceMessage {
  readonly v?: number;
  readonly id?: number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly data?: unknown;
  };
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
  /**
   * The deadline for a request that does not name its own. There is no "wait
   * forever" option on purpose: a request without a deadline is a request that
   * can hang the caller for as long as the process lives.
   */
  readonly defaultTimeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
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

  // Registered before anything can exit. `close()` used to add its own listener
  // after checking a flag, so an exit landing between the check and the
  // registration left that promise pending forever -- the process was gone and
  // nothing was going to call back.
  //
  // `error` is part of it because a failed spawn (ENOENT on a missing python.exe)
  // emits `error` and never `exit`: waiting only for `exit` would hang the quit
  // path on exactly the machine where the backend is broken.
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });

  // One decoder per stream: a decoder holds the bytes of a half-received
  // character, so sharing it would let a partial stderr write swallow the head
  // of the next stdout line.
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const pending = new Map<number, Pending>();
  const emitStderr = options.onStderr;
  const defaultTimeoutMs =
    options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const emitProtocolError = options.onProtocolError;
  let buffered = '';
  let nextId = 1;
  let closed = false;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);

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

    // A receiver cannot answer in a version it does not know, so a mismatch is
    // reported as it stands. The request it belongs to still fails here rather
    // than hanging until its deadline.
    if (message.v !== PROTOCOL_VERSION) {
      const declared = message.v === undefined ? 'none' : String(message.v);
      const detail = `the backend answered with protocol version ${declared}, this client speaks ${PROTOCOL_VERSION}`;

      emitProtocolError?.(line, new Error(detail));

      const staleId = message.id;

      if (typeof staleId === 'number') {
        const stale = pending.get(staleId);

        if (stale !== undefined) {
          pending.delete(staleId);
          clearTimeout(stale.timer);
          stale.reject(
            new ToolchainError('backend/version-mismatch', detail, {
              expected: PROTOCOL_VERSION,
              ...(typeof message.v === 'number' ? { declared: message.v } : {}),
            }),
          );
        }
      }

      return;
    }

    const id = message.id;

    // The request is left to its own deadline: we cannot identify which one a
    // non-numeric id belongs to, and guessing (`String(id)`) would accept a
    // backend that breaks the protocol. The caller sees `backend/timeout`,
    // which is at least bounded.
    if (typeof id !== 'number') {
      emitProtocolError?.(line, new Error('the line carries no numeric id'));
      return;
    }

    const entry = pending.get(id);

    if (entry === undefined) {
      // An answer to a request we stopped waiting for is our own doing, not the
      // backend breaking the protocol: the diagnostic must not point at them.
      // `id < nextId` means we handed that id out, so the answer is either late
      // or a duplicate; anything at or above `nextId` was never sent, and that
      // is the backend inventing an id.
      if (id < nextId) {
        emitProtocolError?.(
          line,
          new Error(`late answer to id ${id}, which already gave up waiting`),
        );
        return;
      }

      emitProtocolError?.(
        line,
        new Error(`no request is waiting for id ${id}, which was never sent`),
      );
      return;
    }

    pending.delete(id);

    clearTimeout(entry.timer);

    // `error: null` means "no error" -- and this branch runs inside the stdout
    // `data` callback, where a throw is an uncaught exception that takes the
    // whole app down, so every shape has to be checked before it is read.
    if (message.error !== undefined && message.error !== null) {
      const failure: unknown = message.error;
      const {
        code,
        message: text,
        data,
      } = (typeof failure === 'object' ? failure : {}) as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };

      // The code is the contract, so a malformed one must not become a new
      // backend code by accident. This request is identified, so it can be
      // failed here instead of waiting out its deadline.
      if (typeof code !== 'string' || code === '' || typeof text !== 'string') {
        entry.reject(
          new ToolchainError(
            'backend/protocol',
            'the backend answered with an error object that has no code and message',
            { command: entry.method },
          ),
        );
        return;
      }

      // The backend saying "your version is not mine" is the same condition as
      // this side spotting a foreign answer, so the caller gets one code for it,
      // with the same two fields in both directions. `data` carries the versions
      // as numbers because the sentence above stops being parseable once it is
      // translated.
      if (code === 'protocol/version-mismatch') {
        const declared = declaredVersion(data);

        entry.reject(
          new ToolchainError('backend/version-mismatch', text, {
            command: entry.method,
            expected: PROTOCOL_VERSION,
            ...(declared === undefined ? {} : { declared }),
          }),
        );
        return;
      }

      entry.reject(new BackendError(code, text));
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
        const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
        const timer = setTimeout(() => {
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
        timer.unref();

        pending.set(id, {
          method,
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });

        child.stdin.write(
          `${JSON.stringify({ v: PROTOCOL_VERSION, id, method, params })}\n`,
        );
      });
    },

    close(): Promise<number | null> {
      if (!closed) {
        closed = true;
        child.stdin.end();
      }

      // `exited` already exists, so nothing can be missed between the decision to
      // wait and the wait starting.
      return exited;
    },
  };
}
