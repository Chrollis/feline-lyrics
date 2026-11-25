export type ToolchainErrorCode =
  | 'archive/unusable'
  | 'archive/unsafe-entry'
  | 'target/unsupported'
  | 'download/cancelled'
  | 'download/failed'
  | 'mirrors/invalid'
  | 'backend/not-provisioned'
  | 'backend/unavailable'
  | 'backend/timeout'
  | 'backend/protocol'
  | 'backend/version-mismatch'
  | 'uv/missing-binary'
  | 'uv/install-failed'
  | 'uv/venv-failed'
  | 'uv/packages-failed';

export interface ToolchainErrorContext {
  readonly archive?: string;
  readonly entry?: string;
  readonly reason?: string;
  readonly target?: string;
  readonly command?: string;
  readonly url?: string;
  readonly status?: number;
  /** A dotted path into a configuration file, e.g. `sources.uv[1]`. */
  readonly path?: string;
  /**
   * The protocol version the other side stated, when it stated one. `message` is
   * English fallback text, so anything a caller has to render must arrive as a
   * field: a version number parsed back out of a sentence breaks on translation.
   */
  readonly declared?: number;
  /** The protocol version this side speaks. */
  readonly expected?: number;
}

/**
 * A failure the toolchain itself detected and callers branch on: the code is
 * the stable identifier, the message is for humans, the context is for logs.
 * Failures we do not expect (a spawn error, an inaccessible disk) stay native.
 */
export class ToolchainError extends Error {
  readonly code: ToolchainErrorCode;
  readonly context: ToolchainErrorContext;

  constructor(
    code: ToolchainErrorCode,
    message: string,
    context: ToolchainErrorContext = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolchainError';
    this.code = code;
    this.context = context;
  }
}
