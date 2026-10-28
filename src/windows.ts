import { spawn } from 'node:child_process';
import { KillTreeAbortError, KillTreeError } from './errors.js';
import { probeProcess, type Liveness, type Probe } from './probe.js';
import { sleep as defaultSleep, throwIfAborted } from './sleep.js';
import type { KillTreeOptions, KillTreeResult } from './types.js';

/** Raw observation of one `taskkill` run. */
export interface TaskkillOutcome {
  exitCode: number | null;
  stderr: string;
}

export type TaskkillRunner = (
  pid: number,
  timeoutMs: number | undefined,
  abortSignal: AbortSignal | undefined
) => Promise<TaskkillOutcome>;

export interface WindowsDeps {
  runTaskkill: TaskkillRunner;
  probe: Probe;
  sleep: (ms: number, pid: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

const MAX_HELPER_STDERR = 4096;
const VERIFY_MS = 1000;
const POLL_MS = 25;

/**
 * Runs `taskkill /T /F /PID <pid>` with `windowsHide`, stdout discarded and
 * stderr captured. Nothing is ever inherited from, or forwarded to, the
 * caller's stdio.
 */
export const runTaskkill: TaskkillRunner = (pid, timeoutMs, abortSignal) => {
  if (abortSignal?.aborted === true) {
    return Promise.reject(new KillTreeAbortError(pid, abortSignal.reason));
  }

  return new Promise<TaskkillOutcome>((resolve, reject) => {
    const child = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false
    });
    const decoder = new TextDecoder();
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const onAbort = (): void => {
      settle(() => {
        child.kill();
        reject(new KillTreeAbortError(pid, abortSignal?.reason));
      });
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle(() => {
          child.kill();
          reject(
            new KillTreeError(
              'ETIMEDOUT',
              pid,
              `"taskkill" did not finish within ${timeoutMs}ms`
            )
          );
        });
      }, Math.max(0, timeoutMs));
    }

    child.stderr?.on('data', (chunk: Uint8Array) => {
      if (stderr.length < MAX_HELPER_STDERR) {
        stderr += decoder.decode(chunk, { stream: true });
      }
    });
    child.once('error', (error: Error) => {
      settle(() => {
        reject(
          new KillTreeError(
            'ESPAWN',
            pid,
            `Could not start "taskkill": ${error.message}`,
            { cause: error }
          )
        );
      });
    });
    child.once('close', (code: number | null) => {
      settle(() => resolve({ exitCode: code, stderr }));
    });
  });
};

export const defaultWindowsDeps: WindowsDeps = {
  runTaskkill,
  probe: probeProcess,
  sleep: defaultSleep,
  now: () => Date.now()
};

/**
 * Maps a finished `taskkill` run plus the *post-run* liveness of the root pid
 * to a result or a typed error.
 *
 * Termination is decided by the exit status together with `process.kill(pid,
 * 0)`, never by the (localized) text taskkill prints. The captured stderr is
 * only used as an informational suffix on generic failures.
 */
export function classifyTaskkill(
  pid: number,
  outcome: TaskkillOutcome,
  state: Liveness
): KillTreeResult {
  const { exitCode, stderr } = outcome;

  if (exitCode === 0) {
    if (state === 'dead') return { pid, killed: true };
    throw new KillTreeError(
      'ETIMEDOUT',
      pid,
      `"taskkill" reported success but process ${pid} is still running`
    );
  }

  if (exitCode === 128) {
    if (state === 'dead') return { pid, killed: false, reason: 'already-exited' };
    if (state === 'denied') {
      throw new KillTreeError(
        'EACCES',
        pid,
        `Access denied while terminating the process tree of ${pid}`,
        { exitCode }
      );
    }
    throw new KillTreeError(
      'EFAILED',
      pid,
      `"taskkill" could not terminate the process tree of ${pid}`,
      { exitCode }
    );
  }

  if (state === 'denied') {
    throw new KillTreeError(
      'EACCES',
      pid,
      `Access denied while terminating the process tree of ${pid}`,
      { exitCode }
    );
  }

  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  throw new KillTreeError(
    'EFAILED',
    pid,
    `"taskkill" failed for process ${pid} with exit code ${String(exitCode)}${
      detail === '' ? '' : `: ${detail.slice(0, 300)}`
    }`,
    { exitCode }
  );
}

/**
 * Windows implementation: `taskkill /T /F`, then a bounded liveness check. A
 * liveness probe is used for "not found" detection so localized taskkill error
 * text never matters.
 */
export async function killTreeWindows(
  pid: number,
  options: KillTreeOptions = {},
  deps: WindowsDeps = defaultWindowsDeps
): Promise<KillTreeResult> {
  throwIfAborted(pid, options.abortSignal);

  const startedAt = deps.now();
  if (deps.probe(pid) === 'dead') {
    return { pid, killed: false, reason: 'not-found' };
  }

  const outcome = await deps.runTaskkill(pid, options.timeoutMs, options.abortSignal);

  const verifyBudget =
    options.timeoutMs === undefined
      ? VERIFY_MS
      : Math.max(
          0,
          Math.min(VERIFY_MS, startedAt + options.timeoutMs - deps.now())
        );
  const deadline = deps.now() + verifyBudget;
  let state = deps.probe(pid);
  while (state !== 'dead' && deps.now() < deadline) {
    await deps.sleep(Math.min(POLL_MS, Math.max(1, deadline - deps.now())), pid, options.abortSignal);
    state = deps.probe(pid);
  }

  return classifyTaskkill(pid, outcome, state);
}
