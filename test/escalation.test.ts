import { describe, expect, it } from 'vitest';
import { createKillTree } from '../src/kill-tree.js';
import type { KillTreeHooks } from '../src/kill-tree.js';
import type { KillTreeOptions, KillTreeResult } from '../src/types.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RunCall {
  pid: number;
  options: KillTreeOptions;
  publish: (targets: readonly number[]) => void;
  settle: Deferred<KillTreeResult>;
}

interface EscalationCall {
  pid: number;
  targets: readonly number[];
  options: KillTreeOptions;
  settle: Deferred<KillTreeResult>;
}

function createHarness(distinctSignals = true) {
  const runs: RunCall[] = [];
  const escalations: EscalationCall[] = [];

  const hooks: KillTreeHooks = {
    distinctSignals,
    run: (pid, options, publish) => {
      const settle = deferred<KillTreeResult>();
      runs.push({ pid, options, publish, settle });
      return settle.promise;
    },
    escalate: (pid, targets, options) => {
      const settle = deferred<KillTreeResult>();
      escalations.push({ pid, targets, options, settle });
      return settle.promise;
    }
  };

  return { killTree: createKillTree(hooks), runs, escalations };
}

describe('killTree in-flight coordination', () => {
  it('shares one promise while the requested signal stays the same', async () => {
    const harness = createHarness();

    const first = harness.killTree(100);
    harness.runs[0]?.publish([101, 100]);
    const second = harness.killTree(100, { timeoutMs: 10 });

    expect(second).toBe(first);
    expect(harness.runs).toHaveLength(1);

    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    await expect(second).resolves.toEqual({ pid: 100, killed: true });
  });

  it('honours a SIGKILL request that lands during a SIGTERM run', async () => {
    const harness = createHarness();

    const term = harness.killTree(100);
    harness.runs[0]?.publish([103, 101, 100]);
    const kill = harness.killTree(100, { signal: 'SIGKILL' });

    expect(kill).not.toBe(term);
    expect(harness.runs).toHaveLength(1);
    expect(harness.escalations).toHaveLength(1);
    expect(harness.escalations[0]?.targets).toEqual([103, 101, 100]);
    expect(harness.escalations[0]?.options.signal).toBe('SIGKILL');

    harness.escalations[0]?.settle.resolve({ pid: 100, killed: true });
    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });

    await expect(kill).resolves.toEqual({ pid: 100, killed: true });
    await expect(term).resolves.toEqual({ pid: 100, killed: true });
  });

  it('honours a different graceful signal instead of dropping it', async () => {
    const harness = createHarness();

    const interrupted = harness.killTree(100, { signal: 'SIGINT' });
    const terminated = harness.killTree(100);

    expect(terminated).not.toBe(interrupted);
    expect(harness.escalations[0]?.options.signal).toBe('SIGTERM');

    harness.escalations[0]?.settle.resolve({ pid: 100, killed: true });
    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    await Promise.all([interrupted, terminated]);
  });

  it('never downgrades an in-flight SIGKILL', async () => {
    const harness = createHarness();

    const kill = harness.killTree(100, { signal: 'SIGKILL' });
    const term = harness.killTree(100);

    expect(term).toBe(kill);
    expect(harness.escalations).toHaveLength(0);

    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    await expect(term).resolves.toEqual({ pid: 100, killed: true });
  });

  it('shares the escalation for repeated requests of the escalated signal', async () => {
    const harness = createHarness();

    harness.killTree(100);
    harness.runs[0]?.publish([100]);
    const kill = harness.killTree(100, { signal: 'SIGKILL' });
    const alsoKill = harness.killTree(100, { signal: 'SIGKILL' });

    expect(alsoKill).toBe(kill);
    expect(harness.escalations).toHaveLength(1);

    harness.escalations[0]?.settle.resolve({ pid: 100, killed: true });
    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    await Promise.all([kill, alsoKill]);
  });

  it('keeps the newer entry when the older run settles late', async () => {
    const harness = createHarness();

    const term = harness.killTree(100);
    harness.runs[0]?.publish([100]);
    const kill = harness.killTree(100, { signal: 'SIGKILL' });

    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    await term;

    const again = harness.killTree(100, { signal: 'SIGKILL' });
    expect(again).toBe(kill);
    expect(harness.escalations).toHaveLength(1);

    harness.escalations[0]?.settle.resolve({ pid: 100, killed: true });
    await expect(again).resolves.toEqual({ pid: 100, killed: true });
  });

  it('joins the in-flight run on Windows, where every call is equally forceful', async () => {
    const harness = createHarness(false);

    const first = harness.killTree(100);
    const kill = harness.killTree(100, { signal: 'SIGKILL' });

    expect(kill).toBe(first);
    expect(harness.escalations).toHaveLength(0);

    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    await expect(kill).resolves.toEqual({ pid: 100, killed: true });
  });

  it('drops the entry when an escalation rejects', async () => {
    const harness = createHarness();

    harness.killTree(100);
    const kill = harness.killTree(100, { signal: 'SIGKILL' });
    harness.escalations[0]?.settle.reject(new Error('boom'));
    await expect(kill).rejects.toThrow('boom');

    harness.runs[0]?.settle.resolve({ pid: 100, killed: true });
    const fresh = harness.killTree(100, { signal: 'SIGKILL' });
    expect(fresh).not.toBe(kill);
    expect(harness.runs).toHaveLength(2);
    harness.runs[1]?.settle.resolve({ pid: 100, killed: true });
    await expect(fresh).resolves.toEqual({ pid: 100, killed: true });
  });
});
