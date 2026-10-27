export interface ExternalDataBytes {
    readonly path: string;
    readonly bytes: Uint8Array;
}

/** A graph held in memory; external weights must be passed as bytes too. */
export interface ModelBytes {
    readonly bytes: Uint8Array;
    readonly externalData?: readonly ExternalDataBytes[];
}

/** A graph on disk; ORT reads it and its external weights itself. */
export interface ModelPath {
    readonly path: string;
}

export type ModelSource = ModelBytes | ModelPath;

export interface ModelSpec {
    readonly id: string;
    readonly sessions: Readonly<Record<string, ModelSource>>;
    readonly executionProviders?: readonly string[];
    readonly settings?: Readonly<Record<string, string>>;
}
