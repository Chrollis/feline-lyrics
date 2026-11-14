export type ToolchainErrorCode =
  | 'archive/unusable'
  | 'archive/unsafe-entry'
  | 'target/unsupported'
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
  readonly status?: number;
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
