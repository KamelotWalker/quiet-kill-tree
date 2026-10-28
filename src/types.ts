import type { KillSignal } from './signals.js';

/** Why a call resolved with `killed: false`. */
export type NotKilledReason = 'not-found' | 'already-exited';

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

export type KillTreeResult =
  | { pid: number; killed: true; reason?: undefined }
  | { pid: number; killed: false; reason: NotKilledReason };
