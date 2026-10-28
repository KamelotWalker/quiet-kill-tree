import { killTreePosix } from './posix.js';
import { isKillSignal } from './signals.js';
import type { KillTreeOptions, KillTreeResult } from './types.js';
import { killTreeWindows } from './windows.js';

export { KillTreeAbortError, KillTreeError } from './errors.js';
export type { KillTreeErrorCode } from './errors.js';
export type { KillSignal } from './signals.js';
export type { KillTreeOptions, KillTreeResult, NotKilledReason } from './types.js';

const inflight = new Map<number, Promise<KillTreeResult>>();

function validatePid(pid: number): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new RangeError(
      `pid must be a positive integer, received ${String(pid)}`
    );
  }
  if (pid === process.pid) {
    throw new RangeError(
      `Refusing to kill the current process (pid ${pid}); use process.exit() instead`
    );
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { aborted?: unknown; addEventListener?: unknown };
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function'
  );
}

function validateOptions(options: KillTreeOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  if (options.timeoutMs !== undefined) {
    if (
      typeof options.timeoutMs !== 'number' ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 0
    ) {
      throw new RangeError(
        `timeoutMs must be a finite, non-negative number, received ${String(options.timeoutMs)}`
      );
    }
  }
  if (options.signal !== undefined && !isKillSignal(options.signal)) {
    throw new TypeError(
      `signal must be a POSIX signal name, received ${String(options.signal)}`
    );
  }
  if (options.abortSignal !== undefined && !isAbortSignal(options.abortSignal)) {
    throw new TypeError('abortSignal must be an AbortSignal');
  }
}

/**
 * Terminates the process tree rooted at `pid`.
 *
 * - Resolves with `killed: false` (never rejects) when the pid is already gone.
 * - Concurrent calls for the same pid share one in-flight promise, so the tree
 *   is only walked once; the first call's options win.
 * - Rejects with {@link KillTreeError} for real failures (permissions, helper
 *   failures, survivors after escalation).
 * - Never writes to the caller's stdout/stderr.
 */
export function killTree(
  pid: number,
  options: KillTreeOptions = {}
): Promise<KillTreeResult> {
  validatePid(pid);
  validateOptions(options);

  const pending = inflight.get(pid);
  if (pending !== undefined) return pending;

  const run = process.platform === 'win32' ? killTreeWindows : killTreePosix;
  const tracked = run(pid, options).finally(() => {
    inflight.delete(pid);
  });
  inflight.set(pid, tracked);
  return tracked;
}
