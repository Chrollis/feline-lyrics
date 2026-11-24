/**
 * The TypeScript surface a plugin is written against.
 *
 * This is the v0 subset the media plugin needs: identity, the api it declared,
 * the public methods and commands it registers, a host service (the file
 * picker), and one way to reach the plugin's own backend. Workers and storage
 * arrive with the host that can enforce them; declaring them earlier would let
 * a plugin compile against something nothing can honour.
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

/** What the host may pick for the plugin; the plugin never sees the dialog. */
export interface PickFileOptions {
  /** The file kinds the picker offers. `any` shows no filter. */
  readonly kind: 'audio' | 'video' | 'any';
}

/** Services the host runs on the plugin's behalf. */
export interface PluginHostServices {
  /** The chosen path, or `null` when the user cancelled. */
  pickFile(options: PickFileOptions): Promise<string | null>;
  /**
   * The plugin's own backend, when the host routes calls for it. The plugin
   * never gets to name a plugin id: the route is bound to the caller.
   */
  backend?: PluginBackend;
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
  /**
   * The plugin's own backend, or `undefined` for a plugin whose manifest
   * declares no backend face. The host never synthesizes a broken one: asking
   * for a route that cannot exist is a plugin bug, not a runtime error to
   * carry.
   */
  readonly backend?: PluginBackend;
  /** Host-owned work the plugin may ask for. */
  readonly host: PluginHostServices;
}
