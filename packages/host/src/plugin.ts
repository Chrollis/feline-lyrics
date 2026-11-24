/**
 * The TypeScript surface a plugin is written against.
 *
 * This is the v0 subset the media plugin needs: identity, the api it declared,
 * one way to register a public method, and one way to reach the plugin's own
 * backend. The loader and the lifecycle (`onDispose`, workers, storage) arrive
 * with the host that can enforce them; declaring them earlier would let a
 * plugin compile against something nothing can honour.
 */

/** The JSON object every method receives. */
export type PluginParams = Readonly<Record<string, unknown>>;

/** A handler registered on the plugin's public table. */
export type PluginMethod = (params: PluginParams) => unknown | Promise<unknown>;

/** A button the host draws; commands take no parameters. */
export type PluginCommand = () => unknown | Promise<unknown>;

export interface BackendCallOptions {
  /** How long the host waits for this call, in integer milliseconds. */
  readonly timeoutMs?: number;
}

/** The plugin's only route to its own backend methods. */
export interface PluginBackend {
  call(
    name: string,
    params: PluginParams,
    options?: BackendCallOptions,
  ): Promise<unknown>;
}

/** What `activate(ctx)` receives. */
export interface PluginContext {
  /** The derived id, for example `felyrics.media`. */
  readonly pluginId: string;
  /** The `felyrics.api` the manifest declared. */
  readonly api: number;
  /** Registers a public method under its short name. */
  method(name: string, handler: PluginMethod): void;
  /** Registers a command the host draws as a button. */
  command(id: string, handler: PluginCommand): void;
  /** Runs after the last request, newest first. */
  onDispose(handler: () => unknown | Promise<unknown>): void;
  readonly backend: PluginBackend;
}
