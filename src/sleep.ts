import { KillTreeAbortError } from './errors.js';

/** Cross-runtime timer handle (`NodeJS.Timeout` in Node, number elsewhere). */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * `setTimeout` as a promise that rejects with an abort error and clears its
 * timer when `signal` fires.
 */
export function sleep(
  ms: number,
  pid: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new KillTreeAbortError(pid, signal.reason));
  }

  return new Promise<void>((resolve, reject) => {
    let timer: TimerHandle | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new KillTreeAbortError(pid, signal?.reason));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
