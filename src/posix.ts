import { spawn } from 'node:child_process';
import { abortable, throwIfAborted } from './abort.js';
import { KillTreeAbortError, KillTreeError } from './errors.js';
import { probeProcess, type Probe } from './probe.js';
import type { KillSignal } from './signals.js';
import { sleep as defaultSleep } from './sleep.js';
import { orderTree, type ProcessEntry } from './tree.js';
import type { KillTreeOptions, KillTreeResult } from './types.js';

/**
 * Enumerates the process table as `{ pid, ppid }` rows. The signal, when given,
 * must stop the enumeration (and any helper process) as soon as it fires.
 */
export type ProcessLister = (abortSignal?: AbortSignal) => Promise<readonly ProcessEntry[]>;

export interface PosixDeps {
  listProcesses: ProcessLister;
  signalProcess: (pid: number, signal: KillSignal) => void;
  probe: Probe;
  sleep: (ms: number, pid: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
}

const PS_ARGS = ['-A', '-o', 'pid=,ppid='];
const MAX_HELPER_STDERR = 4096;
const POLL_MS = 50;
const SIGKILL_SETTLE_MS = 1000;

/**
 * Parses `ps -A -o pid=,ppid=` output.
 *
 * Blank lines are ignored; any other unparsable line is an `EPARSE` failure
 * instead of silently shrinking the tree (a truncated tree would leak
 * processes without telling the caller).
 */
export function parseProcessList(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^(\d+)\s+(\d+)$/.exec(trimmed);
    if (match === null) {
      throw new KillTreeError(
        'EPARSE',
        0,
        `Unexpected "ps" output: ${JSON.stringify(trimmed.slice(0, 120))}`
      );
    }
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  if (entries.length === 0) {
    throw new KillTreeError('EPARSE', 0, '"ps" returned an empty process table');
  }
  return entries;
}

/** Default POSIX enumerator: `ps -A -o pid=,ppid=` with piped stdio. */
export const listProcessesWithPs: ProcessLister = (abortSignal) => {
  return new Promise<readonly ProcessEntry[]>((resolve, reject) => {
    if (abortSignal?.aborted === true) {
      reject(new KillTreeAbortError(0, abortSignal.reason));
      return;
    }

    const child = spawn('ps', PS_ARGS, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const decoder = new TextDecoder();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      child.kill();
      reject(new KillTreeAbortError(0, abortSignal?.reason));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    // Covers an abort that lands between the pre-check and addEventListener.
    // The cast defeats the control-flow narrowing of the earlier check.
    if ((abortSignal as { aborted: boolean } | undefined)?.aborted === true) {
      onAbort();
    }

    child.stdout?.on('data', (chunk: Uint8Array) => {
      stdout += decoder.decode(chunk, { stream: true });
    });
    child.stderr?.on('data', (chunk: Uint8Array) => {
      if (stderr.length < MAX_HELPER_STDERR) {
        stderr += decoder.decode(chunk, { stream: true });
      }
    });
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      reject(
        new KillTreeError('ESPAWN', 0, `Could not run "ps": ${error.message}`, {
          cause: error
        })
      );
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      stdout += decoder.decode();
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 512);
        reject(
          new KillTreeError(
            'ESPAWN',
            0,
            `"ps" exited with code ${String(code)}${detail === '' ? '' : `: ${detail}`}`,
            { exitCode: code }
          )
        );
        return;
      }
      try {
        resolve(parseProcessList(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
};

export const defaultPosixDeps: PosixDeps = {
  listProcesses: listProcessesWithPs,
  signalProcess: (pid, signal) => {
    process.kill(pid, signal);
  },
  probe: probeProcess,
  sleep: defaultSleep,
  now: () => Date.now()
};

function permissionError(pid: number, targets: readonly number[]): KillTreeError {
  const list = targets.join(', ');
  const noun = targets.length === 1 ? 'process' : 'processes';
  return new KillTreeError(
    'EACCES',
    pid,
    `Not permitted to signal ${noun} ${list} in the tree of ${pid}`
  );
}

function probeAll(
  pids: readonly number[],
  probe: Probe
): { survivors: number[]; denied: number[] } {
  const survivors: number[] = [];
  const denied: number[] = [];
  for (const pid of pids) {
    const state = probe(pid);
    if (state === 'dead') continue;
    survivors.push(pid);
    if (state === 'denied') denied.push(pid);
  }
  return { survivors, denied };
}

async function enumerateTree(
  pid: number,
  deps: PosixDeps,
  abortSignal: AbortSignal | undefined
): Promise<readonly ProcessEntry[]> {
  try {
    return await deps.listProcesses(abortSignal);
  } catch (error) {
    if (error instanceof KillTreeAbortError) {
      throw new KillTreeAbortError(pid);
    }
    if (error instanceof KillTreeError) {
      throw new KillTreeError(
        error.code,
        pid,
        `Could not enumerate the process tree of ${pid}: ${error.message}`,
        error.exitCode === undefined
          ? { cause: error }
          : { cause: error, exitCode: error.exitCode }
      );
    }
    throw new KillTreeError(
      'EFAILED',
      pid,
      `Could not enumerate the process tree of ${pid}`,
      { cause: error }
    );
  }
}

/**
 * POSIX implementation: enumerate descendants, signal them bottom-up, then the
 * root. With `timeoutMs`, survivors are escalated to `SIGKILL` after the grace
 * period and the call only resolves once every observed pid is gone.
 */
export async function killTreePosix(
  pid: number,
  options: KillTreeOptions = {},
  deps: PosixDeps = defaultPosixDeps
): Promise<KillTreeResult> {
  throwIfAborted(pid, options.abortSignal);

  if (pid === 1) {
    throw new KillTreeError(
      'EREFUSED',
      pid,
      'Refusing to kill PID 1: its tree contains the whole system'
    );
  }

  if (deps.probe(pid) === 'dead') {
    return { pid, killed: false, reason: 'not-found' };
  }

  const entries = await abortable(
    enumerateTree(pid, deps, options.abortSignal),
    pid,
    options.abortSignal
  );
  throwIfAborted(pid, options.abortSignal);

  const order = orderTree(entries, pid);
  if (order.includes(process.pid)) {
    throw new KillTreeError(
      'EREFUSED',
      pid,
      `Refusing to kill the tree of ${pid}: it contains the current process (${process.pid})`
    );
  }
  const signal = options.signal ?? 'SIGTERM';

  const send = (
    targets: readonly number[],
    name: KillSignal
  ): { delivered: number; denied: number[] } => {
    let delivered = 0;
    const denied: number[] = [];
    for (const target of targets) {
      try {
        deps.signalProcess(target, name);
        delivered += 1;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
        if (code === 'ESRCH') continue;
        if (code === 'EPERM' || code === 'EACCES') {
          denied.push(target);
          continue;
        }
        throw new KillTreeError(
          'EFAILED',
          target,
          `Could not send ${name} to process ${target}: ${code ?? 'unknown error'}`,
          { cause: error }
        );
      }
    }
    return { delivered, denied };
  };

  const first = send(order, signal);
  if (first.denied.length > 0) throw permissionError(pid, first.denied);

  if (options.timeoutMs === undefined) {
    return first.delivered > 0
      ? { pid, killed: true }
      : { pid, killed: false, reason: 'already-exited' };
  }

  const deadline = deps.now() + options.timeoutMs;
  while (deps.now() < deadline) {
    if (probeAll(order, deps.probe).survivors.length === 0) break;
    const remaining = Math.max(1, deadline - deps.now());
    await deps.sleep(
      Math.min(POLL_MS, remaining),
      pid,
      options.abortSignal
    );
  }

  let { survivors, denied } = probeAll(order, deps.probe);
  if (denied.length > 0) throw permissionError(pid, denied);

  if (survivors.length > 0) {
    const escalated = send(survivors, 'SIGKILL');
    if (escalated.denied.length > 0) {
      throw permissionError(pid, escalated.denied);
    }

    const settleDeadline = deps.now() + SIGKILL_SETTLE_MS;
    while (deps.now() < settleDeadline) {
      ({ survivors, denied } = probeAll(order, deps.probe));
      if (survivors.length === 0) break;
      const remaining = Math.max(1, settleDeadline - deps.now());
      await deps.sleep(
        Math.min(POLL_MS, remaining),
        pid,
        options.abortSignal
      );
    }

    ({ survivors } = probeAll(order, deps.probe));
    if (survivors.length > 0) {
      throw new KillTreeError(
        'ETIMEDOUT',
        pid,
        `Processes still alive after SIGKILL: ${survivors.join(', ')}`
      );
    }
  }

  return first.delivered > 0
    ? { pid, killed: true }
    : { pid, killed: false, reason: 'already-exited' };
}
