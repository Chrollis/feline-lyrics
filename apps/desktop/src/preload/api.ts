/**
 * The bridge's contract, in one place.
 *
 * Preload builds this object, the main process answers it and the renderer calls
 * it. Electron gives no static link between those three, so a hand-copied shape
 * on either side can drift silently -- a renamed method still type-checks and
 * only fails at runtime as "is not a function". Both sides import this file, so
 * the compiler sees one shape.
 *
 * The result types mirror what the media plugin returns. They are declared here
 * rather than derived from the host because the host only sees `unknown`: the
 * protocol is JSON, and the shape of an answer is the contract between the
 * plugin and this bridge.
 */

/** What a handler returns. A rejection would reach the renderer as a plain string. */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** `media/probe`: what is in the file, without decoding it. */
export interface AudioInfo {
  readonly sample_rate: number;
  readonly layout: string;
  readonly channels: number;
  readonly duration: number;
  readonly codec: string;
}

/**
 * `felyrics.media/decode`: the written file plus what it actually contains.
 *
 * `url` is where the page may load the file from (`app://job/<job>/audio.flac`);
 * the host builds it, so no surface has to derive an origin from a path.
 */
export interface DecodedAudio {
  readonly url: string;
  readonly sample_rate: number;
  readonly layout: string;
  readonly channels: number;
  readonly frames: number;
  readonly duration: number;
}

/** `felyrics.media/video-probe`: the video stream parameters, without decoding a frame. */
export interface VideoInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration: number;
  readonly codec: string;
}

/**
 * One still: what was asked for, where it really sits, and where the page may
 * load it from. The `url` is `app://job/<job>/<name>`; there is no second path
 * the renderer could be tempted to use.
 */
export interface FrameFile {
  readonly index: number;
  readonly requested: number;
  readonly at: number;
  readonly url: string;
}

/**
 * `video/frames`: `dir` is empty when the batch asked for nothing, because a
 * request that produces no still is not allowed to hand back a directory and
 * make the caller delete it.
 */
export interface FrameBatch {
  readonly dir: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: readonly FrameFile[];
}

export interface DecodeRequest {
  readonly path: string;
  readonly rate?: number;
  readonly layout?: string;
}

export interface FrameRequest {
  readonly path: string;
  readonly start?: number;
  readonly step?: number;
  readonly count?: number;
  readonly width?: number;
}

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
  media: {
    /** Opens the native picker; `null` when the user cancels. */
    pick(): Promise<IpcResult<string | null>>;
    probe(path: string): Promise<IpcResult<AudioInfo>>;
    decode(request: DecodeRequest): Promise<IpcResult<DecodedAudio>>;
  };
  video: {
    pick(): Promise<IpcResult<string | null>>;
    probe(path: string): Promise<IpcResult<VideoInfo>>;
    frames(request: FrameRequest): Promise<IpcResult<FrameBatch>>;
  };
}
