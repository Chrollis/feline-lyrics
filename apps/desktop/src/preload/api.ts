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
 * a plugin's method types.
 */

/** What a handler returns. A rejection would reach the renderer as a plain string. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** Context the error carried, e.g. the code a plugin error was replaced with. */
      readonly data?: unknown;
    };

/**
 * One plugin as the host reports it. `state` is the lifecycle state
 * (`PENDING`/`LOADING`/`ACTIVE`/`FAILED`/`UNLOADING`/`DISPOSED`); `methods` are
 * public names, `<id>/<short>`, so the renderer never assembles one.
 */
export interface PluginSummary {
  readonly id: string;
  readonly state: string;
  readonly methods: readonly string[];
  /** True for a plugin that ships with the app; it cannot be uninstalled. */
  readonly builtin?: boolean;
  /** Present when the plugin failed before it could register. */
  readonly message?: string;
}

/** What the renderer may ask a plugin. `params` is the method's JSON object. */
export interface PluginRequest {
  readonly name: string;
  readonly params?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface FelyricsApi {
  ping(): Promise<string>;
  backendPing(): Promise<IpcResult<{ readonly pong: boolean }>>;
  plugins: {
    /** Every discovered plugin, active or not, with its public method names. */
    list(): Promise<IpcResult<readonly PluginSummary[]>>;
    request(request: PluginRequest): Promise<IpcResult<unknown>>;
    /** Provisions a user plugin's environment, then enables it. */
    enable(id: string): Promise<IpcResult<readonly PluginSummary[]>>;
    /** Stops the plugin's hosts and its backend process. */
    disable(id: string): Promise<IpcResult<readonly PluginSummary[]>>;
    /** Opens the user plugin directory in the file manager. */
    folder(): Promise<IpcResult<string>>;
    /** Copies a picked plugin package into the user root; it starts PENDING. */
    install(): Promise<IpcResult<readonly PluginSummary[]>>;
  };
}
