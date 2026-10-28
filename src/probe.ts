import { KillTreeError } from './errors.js';

/**
 * Result of a zero-signal liveness probe.
 *
 * - `alive`: the process exists and we may signal it.
 * - `denied`: the process exists but the OS denies access to it.
 * - `dead`: no such process.
 */
export type Liveness = 'alive' | 'denied' | 'dead';

export type Probe = (pid: number) => Liveness;

/**
 * Liveness via `process.kill(pid, 0)`: no signal is delivered, the call only
 * reports whether the kernel knows the pid.
 */
export const probeProcess: Probe = (pid: number): Liveness => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'denied';
    throw new KillTreeError(
      'EFAILED',
      pid,
      `Could not probe process ${pid}: ${code ?? 'unknown error'}`,
      { cause: error }
    );
  }
};
