import type { KillSignal } from './signals.js';
import { isKillSignal } from './signals.js';
import type { KillTreeOptions, KillTreeResult } from './types.js';

/** Runs one termination pass for `pid` on the current platform. */
export type KillTreeRunner = (
  pid: number,
  options: KillTreeOptions,
  /** Publishes the pids this run will signal, so later calls can escalate. */
  publishTargets: (targets: readonly number[]) => void
) => Promise<KillTreeResult>;

/** Delivers `options.signal` to pids a still-running run of `pid` observed. */
export type KillTreeEscalator = (
  pid: number,
  targets: readonly number[],
  options: KillTreeOptions
) => Promise<KillTreeResult>;

export interface KillTreeHooks {
  run: KillTreeRunner;
  escalate: KillTreeEscalator;
  /**
   * Whether two different signal names describe two different requests.
   *
   * `true` on POSIX, where `SIGTERM` and `SIGKILL` are distinct actions.
   * `false` on Windows, where `signal` is ignored and `taskkill /F` already
   * performs the only termination the API offers, so every call has the same
   * strength.
   */
  distinctSignals: boolean;
}

/** Signal a call gets when it names none. */
export const DEFAULT_SIGNAL: KillSignal = 'SIGTERM';

/** Largest delay a Node timer accepts; larger values would overflow to 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

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
    if (options.timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `timeoutMs must be <= ${MAX_TIMEOUT_MS} (Node's largest timer delay), received ${String(options.timeoutMs)}`
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

interface InflightEntry {
  promise: Promise<KillTreeResult>;
  /** Signal the entry's caller asked for; the entry's strength. */
  signal: KillSignal;
  /** Pids the entry's run observed, shared with later escalations. */
  targets: number[];
}

/**
 * Decides whether `requested` must be delivered on top of the run that is
 * already in flight.
 *
 * - Same signal: the request is already covered.
 * - `SIGKILL` in flight: nothing is stronger, and it must never be downgraded,
 *   so the request joins it.
 * - Otherwise a different signal is a different action and is honoured.
 * - On Windows signals are ignored, so every request has the same strength.
 */
function needsEscalation(
  distinctSignals: boolean,
  inflightSignal: KillSignal,
  requested: KillSignal
): boolean {
  if (!distinctSignals) return false;
  if (inflightSignal === 'SIGKILL') return false;
  return requested !== inflightSignal;
}

/**
 * Builds a `killTree` implementation around platform hooks.
 *
 * Concurrent calls for one pid share a single in-flight promise as long as the
 * later call asks for nothing new. A later call that names a different signal
 * while the in-flight run has not reached `SIGKILL` yet gets its own escalation
 * run: the requested signal is delivered to the tree the in-flight run
 * observed. An in-flight `SIGKILL` is never downgraded, and on Windows every
 * call is equally forceful, so those calls simply join it.
 */
export function createKillTree(
  hooks: KillTreeHooks
): (pid: number, options?: KillTreeOptions) => Promise<KillTreeResult> {
  const inflight = new Map<number, InflightEntry>();

  return function killTree(
    pid: number,
    options: KillTreeOptions = {}
  ): Promise<KillTreeResult> {
    validatePid(pid);
    validateOptions(options);

    const requested = options.signal ?? DEFAULT_SIGNAL;
    const pending = inflight.get(pid);

    if (
      pending !== undefined &&
      !needsEscalation(hooks.distinctSignals, pending.signal, requested)
    ) {
      return pending.promise;
    }

    const targets: number[] = pending === undefined ? [] : [...pending.targets];
    const publish = (pids: readonly number[]): void => {
      targets.length = 0;
      targets.push(...pids);
    };

    const promise = (
      pending === undefined
        ? hooks.run(pid, options, publish)
        : hooks.escalate(pid, targets, { ...options, signal: requested })
    ).finally(() => {
      // An escalation replaces the entry it was derived from; an older run
      // settling late must not delete the newer entry.
      if (inflight.get(pid) === entry) inflight.delete(pid);
    });

    const entry: InflightEntry = { promise, signal: requested, targets };
    inflight.set(pid, entry);
    return promise;
  };
}
