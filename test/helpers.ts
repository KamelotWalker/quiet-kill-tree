import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ProcessTree {
  root: number;
  pids: number[];
}

const isWindows = process.platform === 'win32';

/** Starts the tree fixture and resolves once every pid in it exists. */
export async function spawnProcessTree(count = 3, ignoreSigterm = false): Promise<ProcessTree> {
  const fixture = fileURLToPath(
    new URL('./fixtures/tree.cjs', import.meta.url)
  );
  const parent = spawn(process.execPath, [fixture, String(count), String(ignoreSigterm)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });
  if (parent.pid === undefined) throw new Error('fixture did not start');

  const pids = await new Promise<number[]>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`tree fixture did not report pids: ${buffer}`));
    }, 20_000);

    parent.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    parent.once('exit', (code) => {
      if (buffer.includes('\n')) return;
      clearTimeout(timer);
      reject(new Error(`tree fixture exited early with code ${String(code)}`));
    });
    parent.stdout?.on('data', (chunk: Uint8Array) => {
      buffer += new TextDecoder().decode(chunk);
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, newline)) as number[]);
    });
  });

  return { root: parent.pid, pids };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Polls until the pid is gone; resolves to the observed alive state. */
export async function waitForGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

/** Best-effort cleanup that does not depend on the code under test. */
export function forceKillTree(pid: number): void {
  if (!isWindows) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    return;
  }
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
    stdio: 'ignore',
    windowsHide: true
  });
}

export function forceKillAll(pids: readonly number[]): void {
  // Roots come first in the fixtures, so later pids are usually already gone.
  for (const pid of pids) {
    if (isAlive(pid)) forceKillTree(pid);
  }
}
