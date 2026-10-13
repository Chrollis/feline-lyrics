export type StemalignErrorCode =
    | 'invalid-pcm'
    | 'invalid-option'
    | 'unsupported-layout'
    | 'model-invalid'
    | 'session-create-failed'
    | 'session-released'
    | 'log-level-too-late'
    | 'release-failed'
    | 'missing-setting'
    | 'setting-mismatch'
    | 'unknown-tensor'
    | 'unsupported-dtype'
    | 'cancelled';

export interface StemalignErrorContext {
    readonly modelId?: string;
    readonly session?: string;
    readonly tensor?: string;
    readonly expected?: string;
    readonly actual?: string;
}

export class StemalignError extends Error {
    constructor(
        readonly code: StemalignErrorCode,
        message: string,
        readonly context: StemalignErrorContext = {},
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'StemalignError';
    }
}
