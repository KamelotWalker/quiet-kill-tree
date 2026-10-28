import type { KillSignal } from './signals.js';

/**
 * Why a call resolved with `killed: false`.
 *
 * - `'not-found'`: the root pid was already dead before any work started.
 * - `'already-exited'`: the root disappeared before a signal could be
 *   delivered.
 *
 * @example
 * ```ts
 * import { killTree } from 'quiet-kill-tree';
 *
 * const result = await killTree(pid);
 * if (!result.killed && result.reason === 'not-found') {
 *   console.log('nothing to clean up');
 * }
 * ```
 */
export type NotKilledReason = 'not-found' | 'already-exited';

/**
 * Options accepted by `killTree`.
 *
 * @example
 * ```ts
 * import { killTree } from 'quiet-kill-tree';
 *
 * const controller = new AbortController();
 * await killTree(pid, {
 *   signal: 'SIGTERM',
 *   timeoutMs: 3_000,
 *   abortSignal: controller.signal
 * });
 * ```
 */
export interface KillTreeOptions {
  /**
   * Signal sent to each process on POSIX. Defaults to `SIGTERM`.
   *
   * Ignored on Windows, where `taskkill /T /F` always terminates forcefully.
   */
  signal?: KillSignal;
  /**
   * Grace period in milliseconds before survivors are escalated to `SIGKILL`.
   *
   * POSIX: when omitted, signals are delivered and the call returns without
   * waiting. When set, survivors receive `SIGKILL` after the grace period.
   *
   * Windows: bounds how long `taskkill` and the follow-up liveness check may
   * take; a helper that exceeds the budget is abandoned with `ETIMEDOUT`.
   *
   * Must be <= 2147483647 (Node's largest timer delay); larger values throw a
   * `RangeError` synchronously instead of overflowing to a 1 ms timer.
   */
  timeoutMs?: number;
  /** Cancels the operation; rejects with an `AbortError`-named `KillTreeError`. */
  abortSignal?: AbortSignal;
}

/**
 * Outcome of a `killTree` call.
 *
 * A discriminated union: narrow on `killed` before reading `reason`.
 *
 * @example
 * ```ts
 * import { killTree } from 'quiet-kill-tree';
 *
 * const result = await killTree(pid);
 * if (result.killed) {
 *   console.log(`tree ${result.pid} terminated`);
 * } else {
 *   console.log(`tree ${result.pid} was already gone (${result.reason})`);
 * }
 * ```
 */
export type KillTreeResult =
  | { pid: number; killed: true; reason?: undefined }
  | { pid: number; killed: false; reason: NotKilledReason };
