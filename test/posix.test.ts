import { describe, expect, it } from 'vitest';
import {
  defaultPosixDeps,
  killTreePosix,
  listProcessesWithPs,
  parseProcessList
} from '../src/posix.js';
import type { PosixDeps } from '../src/posix.js';
import { KillTreeAbortError, KillTreeError } from '../src/errors.js';
import type { KillSignal } from '../src/signals.js';
import type { ProcessEntry } from '../src/tree.js';

interface WorldOptions {
  entries: ProcessEntry[];
  /** Pids that ignore SIGTERM (and, unless listed, also ignore SIGKILL). */
  ignoreSigterm?: number[];
  ignoreSigkill?: number[];
  denied?: number[];
  /** Throw a typed error from the process lister. */
  listerError?: Error;
}

interface World {
  deps: PosixDeps;
  signals: { pid: number; signal: KillSignal }[];
  clock: () => number;
  alive: (pid: number) => boolean;
}

function createWorld(options: WorldOptions): World {
  const ignoreSigterm = new Set(options.ignoreSigterm ?? []);
  const ignoreSigkill = new Set(options.ignoreSigkill ?? []);
  const denied = new Set(options.denied ?? []);
  const alive = new Set(options.entries.map((entry) => entry.pid));
  const signals: { pid: number; signal: KillSignal }[] = [];
  let clock = 0;

  const deps: PosixDeps = {
    listProcesses: async () => {
      if (options.listerError !== undefined) throw options.listerError;
      return options.entries;
    },
    signalProcess: (pid, signal) => {
      if (denied.has(pid)) {
        const error = new Error('operation not permitted');
        (error as NodeJS.ErrnoException).code = 'EPERM';
        throw error;
      }
      if (!alive.has(pid)) {
        const error = new Error('no such process');
        (error as NodeJS.ErrnoException).code = 'ESRCH';
        throw error;
      }
      signals.push({ pid, signal });
      if (signal === 'SIGTERM' && ignoreSigterm.has(pid)) return;
      if (signal === 'SIGKILL' && ignoreSigkill.has(pid)) return;
      alive.delete(pid);
    },
    probe: (pid) => {
      if (!alive.has(pid)) return 'dead';
      return denied.has(pid) ? 'denied' : 'alive';
    },
    sleep: async (ms, pid, signal) => {
      clock += ms;
      if (signal?.aborted === true) {
        throw new KillTreeAbortError(pid, signal.reason);
      }
    },
    now: () => clock
  };

  return {
    deps,
    signals,
    clock: () => clock,
    alive: (pid) => alive.has(pid)
  };
}

const tree: ProcessEntry[] = [
  { pid: 100, ppid: 1 },
  { pid: 101, ppid: 100 },
  { pid: 102, ppid: 100 },
  { pid: 103, ppid: 101 },
  { pid: 900, ppid: 1 }
];

describe('parseProcessList', () => {
  it('parses padded ps output and ignores blank lines', () => {
    const output =
      '    1     0\n   42     1\r\n\n  100    42\n\n';

    expect(parseProcessList(output)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 42, ppid: 1 },
      { pid: 100, ppid: 42 }
    ]);
  });

  it('rejects unparsable lines instead of silently shrinking the tree', () => {
    expect(() => parseProcessList('    1     0\nPID PPID\n')).toThrowError(
      KillTreeError
    );
    try {
      parseProcessList('    1     0\nweird\n');
    } catch (error) {
      expect((error as KillTreeError).code).toBe('EPARSE');
    }
  });

  it('refuses to enumerate with a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort('stop');

    await expect(listProcessesWithPs(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      code: 'EABORTED'
    });
  });

  it('rejects an empty table', () => {
    try {
      parseProcessList('   \n\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as KillTreeError).code).toBe('EPARSE');
    }
  });
});

describe('killTreePosix', () => {
  it('signals descendants bottom-up and the root last, with SIGTERM by default', async () => {
    const world = createWorld({ entries: tree });

    const result = await killTreePosix(100, {}, world.deps);

    expect(result).toEqual({ pid: 100, killed: true });
    expect(world.signals.map((entry) => entry.pid)).toEqual([103, 101, 102, 100]);
    expect(world.signals.every((entry) => entry.signal === 'SIGTERM')).toBe(true);
    expect(world.signals.some((entry) => entry.pid === 900)).toBe(false);
  });

  it('uses the caller-provided signal', async () => {
    const world = createWorld({ entries: tree });

    await killTreePosix(100, { signal: 'SIGINT' }, world.deps);

    expect(world.signals.every((entry) => entry.signal === 'SIGINT')).toBe(true);
  });

  it('reports not-found without enumerating when the root is already gone', async () => {
    const world = createWorld({ entries: tree, listerError: new Error('never') });

    const result = await killTreePosix(555, {}, world.deps);

    expect(result).toEqual({ pid: 555, killed: false, reason: 'not-found' });
    expect(world.signals).toEqual([]);
  });

  it('reports already-exited when the tree disappears before the signals land', async () => {
    const entries: ProcessEntry[] = [{ pid: 200, ppid: 1 }];
    const signals: KillSignal[] = [];
    const deps: PosixDeps = {
      listProcesses: async () => entries,
      signalProcess: () => {
        const error = new Error('no such process');
        (error as NodeJS.ErrnoException).code = 'ESRCH';
        throw error;
      },
      probe: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls === 1 ? 'alive' : 'dead';
        };
      })(),
      sleep: async () => {},
      now: () => 0
    };

    const result = await killTreePosix(200, {}, deps);

    expect(result).toEqual({ pid: 200, killed: false, reason: 'already-exited' });
    expect(signals).toEqual([]);
  });

  it('does not wait when no timeout is given', async () => {
    const world = createWorld({ entries: tree, ignoreSigterm: [103] });

    const result = await killTreePosix(100, {}, world.deps);

    expect(result.killed).toBe(true);
    expect(world.clock()).toBe(0);
  });

  it('escalates only the survivors to SIGKILL after the grace period', async () => {
    const world = createWorld({ entries: tree, ignoreSigterm: [102, 103] });

    const result = await killTreePosix(100, { timeoutMs: 500 }, world.deps);

    expect(result).toEqual({ pid: 100, killed: true });
    expect(world.signals).toEqual([
      { pid: 103, signal: 'SIGTERM' },
      { pid: 101, signal: 'SIGTERM' },
      { pid: 102, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGTERM' },
      { pid: 103, signal: 'SIGKILL' },
      { pid: 102, signal: 'SIGKILL' }
    ]);
    expect(world.alive(100)).toBe(false);
  });

  it('honours a zero grace period (immediate escalation)', async () => {
    const world = createWorld({ entries: tree, ignoreSigterm: [100] });

    const result = await killTreePosix(100, { timeoutMs: 0 }, world.deps);

    expect(result.killed).toBe(true);
    expect(world.signals.at(-1)).toEqual({ pid: 100, signal: 'SIGKILL' });
  });

  it('rejects with ETIMEDOUT when a pid survives SIGKILL', async () => {
    const world = createWorld({
      entries: tree,
      ignoreSigterm: [102],
      ignoreSigkill: [102]
    });

    await expect(
      killTreePosix(100, { timeoutMs: 100 }, world.deps)
    ).rejects.toMatchObject({ name: 'KillTreeError', code: 'ETIMEDOUT', pid: 100 });
  });

  it('rejects with EACCES when a pid cannot be signalled', async () => {
    const world = createWorld({ entries: tree, denied: [102] });

    await expect(killTreePosix(100, {}, world.deps)).rejects.toMatchObject({
      name: 'KillTreeError',
      code: 'EACCES',
      pid: 100
    });
  });

  it('rejects with EACCES when a survivor needs SIGKILL but cannot be touched', async () => {
    const world = createWorld({ entries: tree, ignoreSigterm: [102] });
    const deps: PosixDeps = {
      ...world.deps,
      signalProcess: (pid, signal) => {
        if (pid === 102 && signal === 'SIGKILL') {
          const error = new Error('operation not permitted');
          (error as NodeJS.ErrnoException).code = 'EPERM';
          throw error;
        }
        world.deps.signalProcess(pid, signal);
      }
    };

    await expect(killTreePosix(100, { timeoutMs: 100 }, deps)).rejects.toMatchObject({
      code: 'EACCES'
    });
  });

  it('re-wraps lister failures with the target pid and original code', async () => {
    const listerError = new KillTreeError('ESPAWN', 0, '"ps" exited with code 1');
    const world = createWorld({ entries: tree, listerError });

    await expect(killTreePosix(100, {}, world.deps)).rejects.toMatchObject({
      name: 'KillTreeError',
      code: 'ESPAWN',
      pid: 100
    });
  });

  it('wraps unexpected lister failures as EFAILED', async () => {
    const world = createWorld({ entries: tree, listerError: new Error('boom') });

    await expect(killTreePosix(100, {}, world.deps)).rejects.toMatchObject({
      code: 'EFAILED',
      pid: 100
    });
  });

  it('rejects with an abort error for a pre-aborted signal', async () => {
    const world = createWorld({ entries: tree });
    const controller = new AbortController();
    controller.abort('stop');

    await expect(
      killTreePosix(100, { abortSignal: controller.signal }, world.deps)
    ).rejects.toMatchObject({ name: 'AbortError', code: 'EABORTED', pid: 100 });
    expect(world.signals).toEqual([]);
  });

  it('aborts during the grace period', async () => {
    const world = createWorld({
      entries: tree,
      ignoreSigterm: [101, 102, 103, 100]
    });
    const controller = new AbortController();
    const deps: PosixDeps = {
      ...world.deps,
      sleep: async (ms, pid, signal) => {
        await world.deps.sleep(ms, pid, signal);
        controller.abort('enough');
      }
    };

    await expect(
      killTreePosix(100, { timeoutMs: 10_000, abortSignal: controller.signal }, deps)
    ).rejects.toMatchObject({ name: 'AbortError', code: 'EABORTED' });
  });

  it('aborts during enumeration and signals nothing', async () => {
    const world = createWorld({ entries: tree });
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const deps: PosixDeps = {
      ...world.deps,
      listProcesses: (signal) => {
        received = signal;
        return new Promise((resolve) => {
          queueMicrotask(() => {
            controller.abort('cancel');
            resolve(tree);
          });
        });
      }
    };

    await expect(
      killTreePosix(100, { abortSignal: controller.signal }, deps)
    ).rejects.toMatchObject({ name: 'AbortError', code: 'EABORTED', pid: 100 });
    expect(received).toBe(controller.signal);
    expect(world.signals).toEqual([]);
  });

  it('rejects an abort even when the lister never settles', async () => {
    const world = createWorld({ entries: tree });
    const controller = new AbortController();
    const never = new Promise<readonly ProcessEntry[]>(() => {});

    const pending = killTreePosix(
      100,
      { abortSignal: controller.signal },
      { ...world.deps, listProcesses: () => never }
    );
    controller.abort('stop');

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'EABORTED',
      pid: 100
    });
    expect(world.signals).toEqual([]);
  });

  it('refuses a tree that contains the current process', async () => {
    const entries: ProcessEntry[] = [
      { pid: process.pid, ppid: 500 },
      { pid: 500, ppid: 1 }
    ];
    const world = createWorld({ entries });

    await expect(killTreePosix(500, {}, world.deps)).rejects.toMatchObject({
      name: 'KillTreeError',
      code: 'EREFUSED',
      pid: 500
    });
    expect(world.signals).toEqual([]);
  });

  it('refuses PID 1 without enumerating or signalling', async () => {
    const world = createWorld({ entries: tree });

    await expect(killTreePosix(1, {}, world.deps)).rejects.toMatchObject({
      name: 'KillTreeError',
      code: 'EREFUSED',
      pid: 1
    });
    expect(world.signals).toEqual([]);
  });

  it('never signals an unrelated pid', async () => {
    const world = createWorld({ entries: tree });

    await killTreePosix(100, { timeoutMs: 50 }, world.deps);

    expect(world.signals.some((entry) => entry.pid === 900)).toBe(false);
    expect(world.signals.some((entry) => entry.pid === 1)).toBe(false);
  });

  it('exposes a default dependency set', () => {
    expect(typeof defaultPosixDeps.listProcesses).toBe('function');
    expect(typeof defaultPosixDeps.signalProcess).toBe('function');
    expect(defaultPosixDeps.now()).toBeGreaterThan(0);
  });
});
