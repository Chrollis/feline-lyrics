/**
 * The bridge's contract, in one place.
 *
 * Preload builds this object, the main process answers it and the renderer calls
 * it. Electron gives no static link between those three, so a hand-copied shape
 * on either side can drift silently -- a renamed method still type-checks and
 * only fails at runtime as "is not a function". Both sides import this file, so
 * the compiler sees one shape.
 */

/** What a handler returns. A rejection would reach the renderer as a plain string. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface FelyricsApi {
  ping(): Promise<string>;
  backendPing(): Promise<IpcResult<{ readonly pong: boolean }>>;
}
