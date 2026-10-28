import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyTaskkill,
  killTreeWindows,
  runTaskkill
} from '../src/windows.js';
import type { TaskkillOutcome, WindowsDeps } from '../src/windows.js';
import { KillTreeError } from '../src/errors.js';
import type { Liveness } from '../src/probe.js';
import type { ProcessEntry } from '../src/tree.js';

const ok: TaskkillOutcome = { exitCode: 0, stderr: '' };
const notFound: TaskkillOutcome = {
  exitCode: 128,
  stderr: 'ERROR: The process "4242" not found.\n'
};
const accessDenied: TaskkillOutcome = {
  exitCode: 128,
  stderr:
    'ERROR: The process with PID 4 could not be terminated.\r\nReason: Erişim engellendi.\r\n'
};

describe('classifyTaskkill', () => {
  it('treats exit 0 plus a dead pid as killed', () => {
    expect(classifyTaskkill(42, ok, 'dead')).toEqual({ pid: 42, killed: true });
  });

  it('rejects when taskkill reports success but the pid is still alive', () => {
    expect(() => classifyTaskkill(42, ok, 'alive')).toThrowError(
      expect.objectContaining({ code: 'ETIMEDOUT', pid: 42 })
    );
  });

  it('treats exit 128 plus a dead pid as already-exited', () => {
    expect(classifyTaskkill(4242, notFound, 'dead')).toEqual({
      pid: 4242,
      killed: false,
      reason: 'already-exited'
    });
  });

  it('maps exit 128 plus a denied pid to EACCES regardless of localized text', () => {
    try {
      classifyTaskkill(4, accessDenied, 'denied');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(KillTreeError);
      expect((error as KillTreeError).code).toBe('EACCES');
      expect((error as KillTreeError).exitCode).toBe(128);
      expect((error as KillTreeError).pid).toBe(4);
    }
  });

  it('maps exit 128 plus a live pid to EFAILED', () => {
    expect(() => classifyTaskkill(42, notFound, 'alive')).toThrowError(
      expect.objectContaining({ code: 'EFAILED', exitCode: 128 })
    );
  });

  it('maps a generic failure plus a denied pid to EACCES', () => {
    const outcome = { exitCode: 1, stderr: 'Access is denied.' };
    expect(() => classifyTaskkill(42, outcome, 'denied')).toThrowError(
      expect.objectContaining({ code: 'EACCES', exitCode: 1 })
    );
  });

  it('keeps the last stderr line only as a message detail for EFAILED', () => {
    const outcome = {
      exitCode: 1,
      stderr: 'line one\r\nERROR: something failed\r\n'
    };
    try {
      classifyTaskkill(42, outcome, 'alive');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as KillTreeError).code).toBe('EFAILED');
      expect((error as KillTreeError).message).toContain('ERROR: something failed');
      expect((error as KillTreeError).message).not.toContain('line one');
    }
  });

  it('handles a killed helper (null exit code)', () => {
    expect(() =>
      classifyTaskkill(42, { exitCode: null, stderr: '' }, 'alive')
    ).toThrowError(expect.objectContaining({ code: 'EFAILED', exitCode: null }));
  });
});

interface FakeDeps extends WindowsDeps {
  taskkillCalls: { pid: number; timeoutMs: number | undefined }[];
  clock: () => number;
}

function createDeps(options: {
  entries: ProcessEntry[];
  /** Liveness reported before taskkill runs. */
  before?: Liveness;
  /** Liveness reported after taskkill returns. */
  state: Liveness;
  outcome: TaskkillOutcome;
}): FakeDeps {
  let clock = 0;
  let probed = false;
  const taskkillCalls: { pid: number; timeoutMs: number | undefined }[] = [];
  return {
    taskkillCalls,
    runTaskkill: async (pid, timeoutMs) => {
      taskkillCalls.push({ pid, timeoutMs });
      return options.outcome;
    },
    probe: () => {
      if (!probed) {
        probed = true;
        return options.before ?? 'alive';
      }
      return options.state;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    clock: () => clock
  };
}

describe('killTreeWindows', () => {
  it('returns not-found without spawning taskkill for a dead pid', async () => {
    const deps = createDeps({
      entries: [],
      before: 'dead',
      state: 'dead',
      outcome: ok
    });

    const result = await killTreeWindows(4242, {}, deps);

    expect(result).toEqual({ pid: 4242, killed: false, reason: 'not-found' });
    expect(deps.taskkillCalls).toEqual([]);
  });

  it('passes the pid and timeout budget to the taskkill runner', async () => {
    const deps = createDeps({
      entries: [],
      state: 'dead',
      outcome: ok
    });

    await killTreeWindows(77, { timeoutMs: 400 }, deps);

    expect(deps.taskkillCalls).toEqual([{ pid: 77, timeoutMs: 400 }]);
  });

  it('resolves killed when taskkill succeeds and the pid disappears', async () => {
    const deps = createDeps({
      entries: [],
      state: 'dead',
      outcome: ok
    });

    await expect(killTreeWindows(77, {}, deps)).resolves.toEqual({
      pid: 77,
      killed: true
    });
    expect(deps.clock()).toBe(0);
  });

  it('stops polling once the verification budget is exhausted', async () => {
    const deps = createDeps({
      entries: [],
      state: 'alive',
      outcome: ok
    });

    await expect(
      killTreeWindows(77, { timeoutMs: 100 }, deps)
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(deps.clock()).toBeGreaterThanOrEqual(100);
    expect(deps.clock()).toBeLessThan(1000);
  });

  it('accepts the largest timer-safe timeout and forwards it unchanged', async () => {
    const deps = createDeps({
      entries: [],
      state: 'dead',
      outcome: ok
    });

    await expect(
      killTreeWindows(77, { timeoutMs: 2_147_483_647 }, deps)
    ).resolves.toEqual({ pid: 77, killed: true });
    expect(deps.taskkillCalls).toEqual([
      { pid: 77, timeoutMs: 2_147_483_647 }
    ]);
  });

  it('rejects with an abort error before doing any work', async () => {
    const deps = createDeps({
      entries: [],
      state: 'alive',
      outcome: ok
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      killTreeWindows(77, { abortSignal: controller.signal }, deps)
    ).rejects.toMatchObject({ name: 'AbortError', code: 'EABORTED' });
    expect(deps.taskkillCalls).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('runTaskkill (real helper)', () => {
  it('refuses to start for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort('nope');

    await expect(
      runTaskkill(999_999, undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError', code: 'EABORTED' });
  });

  it('does not overflow the timer for the largest accepted timeout', async () => {
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
    const pid = exited.pid as number;
    const emitWarning = vi.spyOn(process, 'emitWarning');

    try {
      const outcome = await runTaskkill(pid, 2_147_483_647, undefined);
      expect(outcome.exitCode).toBe(128);
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });

  it('reports exit code 128 for a pid that no longer exists', async () => {
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true
    });
    await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
    const pid = exited.pid as number;

    const outcome = await runTaskkill(pid, 10_000, undefined);

    expect(outcome.exitCode).toBe(128);
    expect(typeof outcome.stderr).toBe('string');
  });

  it('kills a live process and returns exit code 0', async () => {
    const victim = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', windowsHide: true }
    );
    const pid = victim.pid as number;
    const exited = new Promise<void>((resolve) => victim.once('exit', () => resolve()));

    const outcome = await runTaskkill(pid, 10_000, undefined);
    await exited;

    expect(outcome.exitCode).toBe(0);
    expect(() => process.kill(pid, 0)).toThrowError(
      expect.objectContaining({ code: 'ESRCH' })
    );
  });
});
