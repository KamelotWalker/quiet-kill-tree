import { describe, expect, it } from 'vitest';
import { killTree } from '../src/index.js';
import { listProcessesWithPs } from '../src/posix.js';
import { forceKillAll, isAlive, spawnProcessTree, waitForGone } from './helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('killTree integration (POSIX)', () => {
  it('enumerates the real process table using ps -A -o pid=,ppid=', async () => {
    const entries = await listProcessesWithPs();
    expect(entries).toContainEqual({ pid: process.pid, ppid: process.ppid });
  });

  it('kills a real node parent, children and grandchildren until every pid is ESRCH', async () => {
    const tree = await spawnProcessTree(3);
    try {
      expect(tree.pids).toHaveLength(7);
      for (const pid of tree.pids) expect(isAlive(pid)).toBe(true);
      await expect(killTree(tree.root)).resolves.toEqual({ pid: tree.root, killed: true });
      for (const pid of tree.pids) {
        expect(await waitForGone(pid), `pid ${pid} must disappear`).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      }
    } finally {
      forceKillAll(tree.pids);
    }
  }, 30_000);

  it('escalates to SIGKILL after timeoutMs when the real tree ignores SIGTERM', async () => {
    const tree = await spawnProcessTree(2, true);
    try {
      expect(tree.pids).toHaveLength(5);
      for (const pid of tree.pids) expect(isAlive(pid)).toBe(true);
      const started = performance.now();
      await expect(killTree(tree.root, { timeoutMs: 200 })).resolves.toEqual({
        pid: tree.root, killed: true
      });
      // Handshakes ensure the SIGTERM handlers are installed before killTree.
      // The ignored first signal must consume the grace period before SIGKILL.
      expect(performance.now() - started).toBeGreaterThanOrEqual(190);
      for (const pid of tree.pids) {
        expect(await waitForGone(pid), `pid ${pid} must disappear after escalation`).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      }
    } finally {
      forceKillAll(tree.pids);
    }
  }, 30_000);
});
