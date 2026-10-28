import { describe, expect, it } from 'vitest';
import { killTree } from '../src/index.js';
import { KillTreeError } from '../src/errors.js';
import {
  forceKillAll,
  isAlive,
  spawnProcessTree,
  waitForGone
} from './helpers.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('killTree integration (Windows)', () => {
  it(
    'kills a real node tree so that every pid is gone',
    async () => {
      const tree = await spawnProcessTree(3);
      try {
        expect(tree.pids.length).toBe(7); // root + 3 children + 3 grandchildren
        for (const pid of tree.pids) {
          expect(isAlive(pid), `pid ${pid} should be running before the kill`).toBe(
            true
          );
        }

        const result = await killTree(tree.root);

        expect(result).toEqual({ pid: tree.root, killed: true });
        for (const pid of tree.pids) {
          expect(
            await waitForGone(pid),
            `pid ${pid} should be gone after killTree`
          ).toBe(true);
        }
      } finally {
        forceKillAll(tree.pids);
      }
    },
    30_000
  );

  it(
    'shares one in-flight promise for concurrent calls on the same pid',
    async () => {
      const tree = await spawnProcessTree(2);
      try {
        const first = killTree(tree.root, { timeoutMs: 5000 });
        const second = killTree(tree.root, { timeoutMs: 5000 });

        expect(second).toBe(first);

        const [a, b] = await Promise.all([first, second]);
        expect(a).toEqual({ pid: tree.root, killed: true });
        expect(b).toBe(a);
        for (const pid of tree.pids) {
          expect(await waitForGone(pid)).toBe(true);
        }

        const third = killTree(tree.root);
        expect(third).not.toBe(first);
        await expect(third).resolves.toEqual({
          pid: tree.root,
          killed: false,
          reason: 'not-found'
        });
      } finally {
        forceKillAll(tree.pids);
      }
    },
    30_000
  );

  it(
    'resolves with not-found for a pid that already exited',
    async () => {
      const tree = await spawnProcessTree(1);
      forceKillAll(tree.pids);
      for (const pid of tree.pids) {
        expect(await waitForGone(pid)).toBe(true);
      }

      const result = await killTree(tree.root);

      expect(result).toEqual({
        pid: tree.root,
        killed: false,
        reason: 'not-found'
      });
    },
    30_000
  );

  it(
    'rejects with EACCES instead of swallowing access-denied failures',
    async () => {
      let state: string;
      try {
        process.kill(4, 0);
        state = 'alive';
      } catch (error) {
        state = (error as NodeJS.ErrnoException).code === 'EPERM' ? 'denied' : 'dead';
      }
      expect(state, 'pid 4 must exist to exercise the access-denied path').not.toBe(
        'dead'
      );

      try {
        await killTree(4);
        // Only reachable when running with enough privileges to touch pid 4.
        expect(state).toBe('alive');
      } catch (error) {
        expect(error).toBeInstanceOf(KillTreeError);
        const expectedCode = state === 'denied' ? 'EACCES' : 'EFAILED';
        expect((error as KillTreeError).code).toBe(expectedCode);
        expect((error as KillTreeError).pid).toBe(4);
      }
    },
    30_000
  );
});
