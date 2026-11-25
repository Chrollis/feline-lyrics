import type { PluginParams } from './plugin.js';

/**
 * The messages between the host (main process) and a plugin host (one
 * `utilityProcess` per plugin). The shape is the same on both sides of a
 * `MessagePort`, so the test can run the pair in one process and the real app
 * can run them in two without a second implementation.
 *
 * Every message carries `v`, and each side refuses a message that declares
 * another version: a plugin built against api 1 must not be half-understood by a
 * host that speaks something else.
 */
export const UTILITY_PROTOCOL_VERSION = 1;

export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

/** Host -> plugin host. */
export type HostCommand =
  | {
      readonly v: 1;
      readonly kind: 'activate';
      /** Absolute plugin package directory. */
      readonly directory: string;
      /** The manifest's `main`, relative to `directory`. */
      readonly main: string;
      readonly pluginId: string;
      readonly api: number;
      /**
       * Whether the plugin declares a backend face. Absent means yes, for a
       * host that predates this field; `false` is a TS-only plugin, whose
       * context has no `backend`.
       */
      readonly hasBackend?: boolean;
    }
  | {
      readonly v: 1;
      readonly kind: 'request';
      readonly seq: number;
      /** The short name, without the `<id>/` prefix. */
      readonly name: string;
      readonly params: PluginParams;
    }
  | {
      readonly v: 1;
      readonly kind: 'host-reply';
      readonly seq: number;
      readonly result?: unknown;
      readonly error?: WireError;
    }
  | { readonly v: 1; readonly kind: 'dispose' };

/** Plugin host -> host. */
export type PluginEvent =
  | {
      readonly v: 1;
      readonly kind: 'ready';
      readonly methods: readonly string[];
    }
  | {
      readonly v: 1;
      readonly kind: 'result';
      readonly seq: number;
      readonly result: unknown;
    }
  | {
      readonly v: 1;
      readonly kind: 'failure';
      readonly seq: number;
      readonly error: WireError;
    }
  | {
      readonly v: 1;
      readonly kind: 'host-call';
      readonly seq: number;
      /** The host service the plugin asks for, e.g. `pickFile`. */
      readonly method: string;
      readonly params: PluginParams;
    }
  | { readonly v: 1; readonly kind: 'fatal'; readonly error: WireError }
  | { readonly v: 1; readonly kind: 'disposed' };

/**
 * What the host needs from a transport. A `utilityProcess` bridge and the
 * in-memory pair in the tests both implement it; nothing above this interface
 * knows which one it holds.
 */
export interface PluginTransport {
  send(command: HostCommand): void;
  onMessage(listener: (event: PluginEvent) => void): () => void;
  /** Resolves once the other side can no longer answer. */
  readonly closed: Promise<void>;
  close(): void;
}

/** The plugin host's end of the same channel. */
export interface PluginHostTransport {
  send(event: PluginEvent): void;
  onMessage(listener: (command: HostCommand) => void): () => void;
  readonly closed: Promise<void>;
  close(): void;
}

export function isUtilityProtocolVersion(value: unknown): value is 1 {
  return value === UTILITY_PROTOCOL_VERSION;
}
