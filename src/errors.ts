/**
 * Machine-readable failure categories carried by {@link KillTreeError}.
 *
 * @example
 * ```ts
 * import type { KillTreeErrorCode } from 'quiet-kill-tree';
 *
 * function isRetryable(code: KillTreeErrorCode): boolean {
 *   return code === 'ETIMEDOUT' || code === 'ESPAWN' || code === 'EFAILED';
 * }
 * ```
 */
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
  /** The tree was refused for safety (it contains the caller, or is PID 1). */
  | 'EREFUSED'
  /** The caller's `AbortSignal` fired. */
  | 'EABORTED';

/** Optional fields accepted by the {@link KillTreeError} constructor. */
export interface KillTreeErrorOptions {
  /** Underlying error, exposed as the standard `Error.cause`. */
  cause?: unknown;
  /** Exit status of the helper binary, when one was involved. */
  exitCode?: number | null;
}

/**
 * Typed error thrown for every failure other than "the pid is already gone".
 *
 * Branch on {@link KillTreeError.code}; `message` is human-readable text and
 * may contain localized output from a helper binary.
 *
 * @example
 * ```ts
 * import { killTree, KillTreeError } from 'quiet-kill-tree';
 *
 * try {
 *   await killTree(pid, { timeoutMs: 2_000 });
 * } catch (error) {
 *   if (error instanceof KillTreeError && error.code === 'ETIMEDOUT') {
 *     console.error(`tree ${error.pid} survived SIGKILL`);
 *   }
 * }
 * ```
 */
export class KillTreeError extends Error {
  /** Machine-readable failure category. */
  readonly code: KillTreeErrorCode;
  /** Pid this call was asked to terminate. */
  readonly pid: number;
  /** Exit status of the helper binary (`taskkill`, `ps`), when one ran. */
  readonly exitCode: number | null | undefined;

  /**
   * @param code - Failure category, exposed unchanged as `code`.
   * @param pid - Target pid reported by this error.
   * @param message - Human-readable description; do not parse it.
   * @param options - Optional standard `cause` and the helper's `exitCode`.
   * @example
   * ```ts
   * const error = new KillTreeError('EACCES', 4242, 'Access denied', { exitCode: 5 });
   * error.code; // 'EACCES'
   * ```
   */
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
 *
 * @example
 * ```ts
 * import { killTree, KillTreeAbortError } from 'quiet-kill-tree';
 *
 * const controller = new AbortController();
 * controller.abort();
 *
 * try {
 *   await killTree(pid, { abortSignal: controller.signal });
 * } catch (error) {
 *   if (error instanceof KillTreeAbortError) {
 *     console.log('cancelled', error.code); // 'EABORTED'
 *   }
 * }
 * ```
 */
export class KillTreeAbortError extends KillTreeError {
  /**
   * @param pid - Pid whose termination was cancelled.
   * @param reason - Value of `AbortSignal.reason`, appended to the message
   *   when it is a non-empty string.
   * @example
   * ```ts
   * const error = new KillTreeAbortError(4242, 'shutdown');
   * error.name; // 'AbortError'
   * ```
   */
  constructor(pid: number, reason?: unknown) {
    const detail = typeof reason === 'string' && reason.length > 0 ? `: ${reason}` : '';
    super('EABORTED', pid, `Terminating process tree ${pid} was aborted${detail}`);
    this.name = 'AbortError';
  }
}
