export type LyricoreErrorCode =
    | 'invalid-time'
    | 'invalid-time-level'
    | 'invalid-time-span'
    | 'invalid-char-cell'
    | 'invalid-lyrics-line'
    | 'invalid-lyrics-meta'
    | 'invalid-check'
    | 'invalid-seg-piece'
    | 'invalid-seg-run'
    | 'invalid-edit'
    | 'invalid-line-index'
    | 'invalid-cell-index'
    | 'invalid-lyrics-file'
    | 'invalid-style-run'
    | 'invalid-inserted-object'
    | 'invalid-style-def'
    | 'invalid-style-book'
    | 'invalid-project-file';

export interface LyricoreErrorContext {
    readonly expected?: string;
    readonly actual?: string;
}

export class LyricoreError extends Error {
    readonly code: LyricoreErrorCode;
    readonly context: LyricoreErrorContext;

    constructor(
        code: LyricoreErrorCode,
        message: string,
        context: LyricoreErrorContext = {},
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'LyricoreError';
        this.code = code;
        this.context = context;
    }
}
