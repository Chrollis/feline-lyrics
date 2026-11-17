import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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

export interface ServiceClient {
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  close(): Promise<number | null>;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
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

    if (message.error) {
      entry.reject(
        new Error(`${message.error.code}: ${message.error.message}`),
      );
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

  child.stdin.on('error', (error: Error) => {
    closed = true;
    failAll(error);
  });

  child.on('error', (error: Error) => {
    closed = true;
    failAll(error);
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

    failAll(new Error(`the service exited with code ${code ?? 'null'}`));
  });

  return {
    request<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      if (closed) {
        return Promise.reject(new Error('the service is closed'));
      }

      const id = nextId;

      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
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
