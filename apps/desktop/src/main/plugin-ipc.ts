import { BackendError } from '@felyrics/host';
import { ToolchainError } from '@felyrics/toolchain';

import type { IpcResult } from '../preload/api.js';

/**
 * The IPC edge: one place that validates what the renderer sends and one place
 * that maps an error into the shape the renderer can read. Both are pure, so
 * they are tested without an Electron process; `index.ts` only wires them to
 * `ipcMain` and the live plugin hosts.
 */
export async function asResult<T>(
  run: () => Promise<T>,
): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof ToolchainError || error instanceof BackendError
          ? error.code
          : 'ipc/unexpected',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A request the renderer may send; `timeoutMs` is left to the host default. */
export interface PluginCall {
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

/** A command invocation; commands take no parameters. */
export interface PluginCommandCall {
  readonly name: string;
  readonly timeoutMs?: number;
}

export function parsePluginCall(value: unknown): PluginCall {
  if (typeof value !== 'object' || value === null) {
    throw new BackendError('protocol/bad-request', 'request must be an object');
  }

  const { name, params, timeoutMs } = value as {
    name?: unknown;
    params?: unknown;
    timeoutMs?: unknown;
  };

  if (typeof name !== 'string') {
    throw new BackendError('protocol/bad-request', 'name must be a string');
  }

  const answer = params ?? {};

  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new BackendError('protocol/bad-request', 'params must be an object');
  }

  return {
    name,
    params: answer as Record<string, unknown>,
    ...(timeoutMs === undefined ? {} : { timeoutMs: positive(timeoutMs) }),
  };
}

export function parsePluginCommand(value: unknown): PluginCommandCall {
  if (typeof value !== 'object' || value === null) {
    throw new BackendError('protocol/bad-request', 'request must be an object');
  }

  const { name, timeoutMs } = value as {
    name?: unknown;
    timeoutMs?: unknown;
  };

  if (typeof name !== 'string') {
    throw new BackendError('protocol/bad-request', 'name must be a string');
  }

  return {
    name,
    ...(timeoutMs === undefined ? {} : { timeoutMs: positive(timeoutMs) }),
  };
}

function positive(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new BackendError(
      'protocol/bad-request',
      'timeoutMs must be a positive number',
    );
  }

  return value;
}
