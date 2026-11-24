/**
 * The bridge's contract, in one place.
 *
 * Preload builds this object, the main process answers it and the renderer calls
 * it. Electron gives no static link between those three, so a hand-copied shape
 * on either side can drift silently -- a renamed method still type-checks and
 * only fails at runtime as "is not a function". Both sides import this file, so
 * the compiler sees one shape.
 *
 * Plugin answers are `unknown` on purpose: the host routes JSON and cannot know
 * a plugin's method types. The sample cards narrow the two answers they render.
 */

/** What a handler returns. A rejection would reach the renderer as a plain string. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * One plugin as the host reports it. `state` is the lifecycle state
 * (`PENDING`/`LOADING`/`ACTIVE`/`FAILED`/`UNLOADING`/`DISPOSED`); `methods` are
 * public names, `<id>/<short>`, so the renderer never assembles one.
 */
export interface PluginSummary {
  readonly id: string;
  readonly state: string;
  readonly methods: readonly string[];
  readonly commands: readonly { readonly id: string; readonly title: string }[];
}

/** What the renderer may ask a plugin. `params` is the method's JSON object. */
export interface PluginRequest {
  readonly name: string;
  readonly params?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

/** One command invocation; commands take no parameters. */
export interface PluginCommandRequest {
  readonly name: string;
  readonly timeoutMs?: number;
}

export interface FelyricsApi {
  ping(): Promise<string>;
  backendPing(): Promise<IpcResult<{ readonly pong: boolean }>>;
  plugins: {
    /** Every discovered plugin, active or not, with its public method names. */
    list(): Promise<IpcResult<readonly PluginSummary[]>>;
    request(request: PluginRequest): Promise<IpcResult<unknown>>;
    command(request: PluginCommandRequest): Promise<IpcResult<unknown>>;
  };
}
