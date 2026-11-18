/**
 * The bridge's contract, in one place.
 *
 * Preload builds this object, the main process answers it and the renderer calls
 * it. Electron gives no static link between those three, so a hand-copied shape
 * on either side can drift silently -- a renamed method still type-checks and
 * only fails at runtime as "is not a function". Both sides import this file, so
 * the compiler sees one shape.
 *
 * The result types mirror what `services/felyrics/media/methods.py` returns. They
 * are declared here rather than derived from the toolchain because the toolchain
 * only sees `unknown`: the protocol is JSON, and the shape of an answer is the
 * contract between the backend and this bridge.
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

/** `media/decode`: the written file plus what it actually contains. */
export interface DecodedAudio {
  readonly path: string;
  readonly sample_rate: number;
  readonly layout: string;
  readonly channels: number;
  readonly frames: number;
  readonly duration: number;
}

/** `video/probe`: the video stream parameters, without decoding a frame. */
export interface VideoInfo {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration: number;
  readonly codec: string;
}

/** One still: where it is, what was asked for, and where it really sits. */
export interface FrameFile {
  readonly index: number;
  readonly requested: number;
  readonly at: number;
  readonly path: string;
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

export interface FelyricsApi {
  ping(): Promise<string>;
  backendPing(): Promise<IpcResult<{ readonly pong: boolean }>>;
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
