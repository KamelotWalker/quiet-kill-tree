import { KillTreeAbortError } from './errors.js';

/** Throws when the signal is already aborted. */
export function throwIfAborted(pid: number, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new KillTreeAbortError(pid, signal.reason);
  }
}

/**
 * Settles like `promise`, but rejects with a {@link KillTreeAbortError} as soon
 * as `signal` fires — even when `promise` never settles (for example a helper
 * process that hangs).
 */
export function abortable<T>(
  promise: Promise<T>,
  pid: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new KillTreeAbortError(pid, signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = (): void => {
      settle(() => reject(new KillTreeAbortError(pid, signal.reason)));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
    // Covers an abort that lands between the pre-check and addEventListener.
    if (signal.aborted) onAbort();
  });
}
