/** Machine-readable failure categories carried by {@link KillTreeError}. */
export type KillTreeErrorCode =
  /** The OS refused the operation (access denied / not permitted). */
  | 'EACCES'
  /** Survivors were still alive after the grace period and SIGKILL. */
  | 'ETIMEDOUT'
  /** A helper binary (`taskkill`, `ps`) could not be started. */
  | 'ESPAWN'
  /** A helper binary produced output that could not be understood. */
  | 'EPARSE'
  /** Any other OS-level failure. */
  | 'EFAILED'
  /** The caller's `AbortSignal` fired. */
  | 'EABORTED';

export interface KillTreeErrorOptions {
  cause?: unknown;
  /** Exit status of the helper binary, when one was involved. */
  exitCode?: number | null;
}

/** Typed error thrown for every non-"already gone" failure. */
export class KillTreeError extends Error {
  readonly code: KillTreeErrorCode;
  readonly pid: number;
  readonly exitCode: number | null | undefined;

  constructor(
    code: KillTreeErrorCode,
    pid: number,
    message: string,
    options: KillTreeErrorOptions = {}
  ) {
    super(
      message,
      Object.hasOwn(options, 'cause') ? { cause: options.cause } : undefined
    );
    this.name = 'KillTreeError';
    this.code = code;
    this.pid = pid;
    this.exitCode = options.exitCode;
  }
}

/**
 * Rejection raised when `abortSignal` fires.
 *
 * It is a {@link KillTreeError} with `code: 'EABORTED'` *and* `name:
 * 'AbortError'`, so both error-code checks and the usual
 * `error.name === 'AbortError'` check work.
 */
export class KillTreeAbortError extends KillTreeError {
  constructor(pid: number, reason?: unknown) {
    const detail = typeof reason === 'string' && reason.length > 0 ? `: ${reason}` : '';
    super('EABORTED', pid, `Terminating process tree ${pid} was aborted${detail}`);
    this.name = 'AbortError';
  }
}
