import { createKillTree } from './kill-tree.js';
import { escalateTreePosix, killTreePosix } from './posix.js';
import type { KillTreeOptions, KillTreeResult } from './types.js';
import { killTreeWindows } from './windows.js';

export { KillTreeAbortError, KillTreeError } from './errors.js';
export type { KillTreeErrorCode } from './errors.js';
export type { KillSignal } from './signals.js';
export type { KillTreeOptions, KillTreeResult, NotKilledReason } from './types.js';

const impl =
  process.platform === 'win32'
    ? createKillTree({
        distinctSignals: false,
        run: (pid, options) => killTreeWindows(pid, options),
        escalate: (pid, _targets, options) => killTreeWindows(pid, options)
      })
    : createKillTree({
        distinctSignals: true,
        run: (pid, options, publishTargets) =>
          killTreePosix(pid, options, undefined, publishTargets),
        escalate: (pid, targets, options) =>
          escalateTreePosix(pid, targets, options)
      });

/**
 * Terminates the process tree rooted at `pid`.
 *
 * - Resolves with `killed: false` (never rejects) when the pid is already gone.
 * - Concurrent calls for the same pid share one in-flight promise, so the tree
 *   is walked once. A later call that names a different signal while the
 *   in-flight run has not reached `SIGKILL` gets its own escalation run: the
 *   requested signal is delivered to the union of a fresh walk and the pids the
 *   in-flight run observed, so reparented or orphaned survivors are not lost. A
 *   `SIGKILL` escalation only resolves once every pid in that union is gone. An
 *   in-flight `SIGKILL` is never downgraded — later calls join it — and on
 *   Windows every call is equally forceful, so later calls join the in-flight
 *   helper run there too.
 * - Rejects with {@link KillTreeError} for real failures (permissions, helper
 *   failures, survivors after escalation).
 * - Never writes to the caller's stdout/stderr.
 *
 * @param pid - Root of the tree; a positive integer other than
 *   `process.pid`.
 * @param options - Signal, grace period and cancellation. See
 *   {@link KillTreeOptions}.
 * @returns A promise for the outcome: `killed: true` when signals were
 *   delivered or termination was verified, or `killed: false` with a
 *   {@link NotKilledReason} when the pid was already gone.
 * @throws {RangeError} Synchronously, before any work, when `pid` is not a
 *   positive integer or equals `process.pid`.
 * @throws {RangeError} Synchronously when `timeoutMs` is negative,
 *   non-finite, or larger than 2_147_483_647 (Node's largest timer delay).
 * @throws {TypeError} Synchronously when `signal` is not a POSIX signal name
 *   or `abortSignal` is not an `AbortSignal`.
 * @throws {KillTreeError} Asynchronously for `EACCES`, `ETIMEDOUT`, `ESPAWN`,
 *   `EPARSE`, `EFAILED`, `EREFUSED` and `EABORTED` failures.
 * @example
 * ```ts
 * import { killTree } from 'quiet-kill-tree';
 *
 * const result = await killTree(server.pid, { timeoutMs: 3_000 });
 * if (!result.killed) console.log(`already stopped: ${result.reason}`);
 * ```
 */
export function killTree(
  pid: number,
  options: KillTreeOptions = {}
): Promise<KillTreeResult> {
  return impl(pid, options);
}
