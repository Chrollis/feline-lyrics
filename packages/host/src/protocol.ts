import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { ToolchainError } from '@felyrics/toolchain';

/**
 * The envelope both sides speak. Each side states its own version and rejects a
 * line that declares another one; a mismatch means one of the two processes is
 * not the build the other expects, which the files on disk cannot reveal.
 */
export const PROTOCOL_VERSION = 1;

/** The most one result may carry, per the plugin contract (B §4). */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * One line is one message. A backend that writes more than this without a
 * newline is refused instead of buffered: a broken plugin must not be able to
 * grow the client until it swaps.
 *
 * A line is a payload plus its envelope (`v`, `id`, `result`); the headroom is
 * fixed so a result exactly at the payload bound still fits on one line.
 */
export const MAX_LINE_CHARS = MAX_PAYLOAD_BYTES + 64 * 1024;

/**
 * Whether one value, as JSON, is larger than the payload bound. A value that
 * cannot be serialized is not a size problem; the write path refuses it later.
 */
export function exceedsPayload(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

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

/**
 * The operating system's container for one backend process tree.
 *
 * The protocol does not create one itself: a Windows Job Object is the only
 * thing here that can bind a child started by a child, and that is a platform
 * detail. The desktop app passes one in; tests pass a fake. Keeping it an
 * interface also means a machine where the platform call is unavailable can
 * still run the service, with the bounded kill as the fallback.
 */
export interface ServiceJob {
  /** Puts `pid` and the processes it starts later under this job. */
  assign(pid: number): void;
  /** Releases the job; on Windows this also kills what is still inside it. */
  close(): void | Promise<void>;
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
  /**
   * Creates the job that will own the backend's process tree. Called before
   * the spawn so no process can start outside it, except for the short window
   * until `assign()` runs right after the spawn returns.
   *
   * A factory that throws leaves the service without a job: `close()` then
   * falls back to killing the tree itself, so a missing platform library is a
   * degraded stop rather than a backend that cannot start.
   */
  readonly createJob?: () => ServiceJob;
  /** How long `close()` lets the backend exit before killing it. */
  readonly closeTimeoutMs?: number;
  /** How long `close()` waits for the process to die after the kill. */
  readonly killTimeoutMs?: number;
  /** Reports a failure while stopping; `close()` never rejects because of one. */
  readonly onStopError?: (error: Error) => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** How long a shutdown may take before the backend is killed. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** How long the kill itself may take to be observed. */
export const DEFAULT_KILL_TIMEOUT_MS = 1_000;

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
 * (`"felyrics.media/open-failed: cannot open ..."`) would leave every backend failure
 * indistinguishable from a crash by the time it reaches the renderer.
 *
 * The vocabulary belongs to the backend (`felyrics.media/open-failed`,
 * `protocol/unknown-method`, `protocol/bad-request`, `core/internal`), which is why
 * this is not a `ToolchainError`: a closed union cannot enumerate codes that a
 * new service method may invent, and a backend release must not need one.
 */
export class BackendError extends Error {
  readonly code: string;
  /** Extra context an error may carry; kept optional so a bare message still works. */
  readonly data?: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'BackendError';
    this.code = code;

    if (data !== undefined) {
      this.data = data;
    }
  }
}

/**
 * Starts one long-lived backend and speaks its line protocol.
 *
 * The process is not restarted here: a backend that dies is a state the caller
 * has to decide about, so the client only reports it.
 */
export function startService(options: ServiceOptions): ServiceClient {
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const onStopError = options.onStopError;
  const reportStopError = (error: unknown): void => {
    if (onStopError === undefined) {
      return;
    }

    try {
      onStopError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A diagnostic callback must not become the failure it was reporting.
    }
  };

  // The job exists before the process does. The assignment still happens after
  // the spawn returns -- the pid is not known before -- so a backend that
  // started a child right at startup could escape that child. The startup path
  // therefore spawns nothing until it is asked to; `taskkill /T` covers a tree
  // that was already running when the app went down, and the Job Object covers
  // a crash, which has no chance to run any fallback.
  let job: ServiceJob | undefined;

  if (options.createJob !== undefined) {
    try {
      job = options.createJob();
    } catch (error) {
      // No job is a degraded stop, not a failed start: `close()` falls back to
      // the platform's own tree kill.
      reportStopError(error);
    }
  }

  const child = spawn(options.pythonExe, [...(options.args ?? [])], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    // The POSIX fallback kills the process group, which only exists if this
    // child leads one. Windows has no equivalent step here: the Job Object
    // covers the tree there.
    detached: process.platform !== 'win32',
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
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      exitCode = code;
      resolve(code);
    });
    child.once('error', () => {
      if (exitCode === undefined) {
        exitCode = null;
      }

      resolve(null);
    });
  });

  const closeJob = (): Promise<void> => {
    const current = job;

    if (current === undefined) {
      return Promise.resolve();
    }

    job = undefined;

    try {
      return Promise.resolve(current.close()).catch((error: unknown) => {
        reportStopError(error);
      });
    } catch (error) {
      reportStopError(error);
      return Promise.resolve();
    }
  };

  if (job !== undefined && child.pid !== undefined) {
    try {
      job.assign(child.pid);
    } catch (error) {
      // The tree is not contained, but the process still runs; closing the bare
      // job releases the handle, and the fallback will do the killing.
      reportStopError(error);
      void closeJob();
    }
  }


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
  let discardingOversize = false;
  let nextId = 1;
  let closed = false;
  let closing: Promise<number | null> | undefined;

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
      // `1 <= id < nextId` means we handed that id out, so the answer is either
      // late or a second answer to a request that already finished -- both are
      // "nobody is listening any more", and the two are worth telling apart when
      // reading a log but not worth two branches here. An id of 0 or less, or one
      // at or above `nextId`, was never sent: that is the backend inventing ids.
      if (id > 0 && id < nextId) {
        emitProtocolError?.(
          line,
          new Error(`answer to id ${id}, which is no longer pending`),
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
      if (exceedsPayload(message.result)) {
        entry.reject(
          new BackendError(
            'protocol/oversize',
            `the result is larger than ${MAX_PAYLOAD_BYTES} bytes`,
          ),
        );
        return;
      }

      entry.resolve(message.result);
    }
  };

  // A chunk boundary can fall inside a character, and inside a line: decode
  // across chunks and split on the newline only after decoding.
  const absorbStdout = (text: string): void => {
    buffered += text;

    // After an oversized line, the rest of it is still on the wire. Drop it up
    // to the next newline before reading anything again.
    if (discardingOversize) {
      const newline = buffered.indexOf('\n');

      if (newline < 0) {
        buffered = '';
        return;
      }

      buffered = buffered.slice(newline + 1);
      discardingOversize = false;
    }

    let newline = buffered.indexOf('\n');

    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);

      if (line.trim() !== '') {
        handleLine(line);
      }

      newline = buffered.indexOf('\n');
    }

    if (buffered.length > MAX_LINE_CHARS) {
      emitProtocolError?.(
        buffered.slice(0, 80),
        new Error(`a line exceeded the ${MAX_LINE_CHARS}-character bound`),
      );
      failAll(
        new BackendError(
          'protocol/oversize',
          `the backend wrote a line longer than ${MAX_LINE_CHARS} characters`,
        ),
      );
      buffered = '';
      discardingOversize = true;
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
    // A spawn that failed never assigned a process, but the job handle exists
    // before the spawn: release it or the app keeps a kernel handle per retry.
    void closeJob();
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
    // The process is gone, so nothing is left to kill; this only releases the
    // job handle promptly instead of at some later close().
    void closeJob();
  });

  const waitForExit = (timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);

      timer.unref();
      void exited.then(() => finish(true));
    });

  const killProcessTree = (): void => {
    const pid = child.pid;

    if (pid === undefined) {
      return;
    }

    if (process.platform === 'win32') {
      // No job, or its close failed: `taskkill /T` walks the tree, including a
      // child spawned during the assignment window.
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      killer.on('error', reportStopError);
      killer.unref();
      return;
    }

    try {
      // The child was spawned detached, so its pid is the process group id.
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      reportStopError(error);
    }
  };

  /**
   * Stops the service within two bounds: `closeTimeoutMs` for a clean exit and
   * `killTimeoutMs` for the kill to be observed. It resolves with the exit code
   * when there is one and `null` when the process never answered; it never
   * rejects, because a quit path cannot do anything with a failure.
   */
  const stop = async (): Promise<number | null> => {
    if (!closed) {
      closed = true;
      failAll(
        new ToolchainError('backend/unavailable', 'the service is closing', {}),
      );
      child.stdin.end();
    }

    // A clean stop is worth the wait: the backend can finish what it was
    // writing instead of dying mid-line.
    if (await waitForExit(closeTimeoutMs)) {
      return exitCode ?? null;
    }

    await closeJob();
    killProcessTree();
    await waitForExit(killTimeoutMs);

    // A process that ignored the kill is still running; reporting `null` is
    // honest and keeps the quit path bounded.
    return exitCode ?? null;
  };

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
      // One stop, shared by every caller: a second close must not start a
      // second kill or wait on a promise the first one already resolved.
      if (closing === undefined) {
        closing = stop();
      }

      return closing;
    },
  };
}
