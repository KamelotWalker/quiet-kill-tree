import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { killTree } from '../../src/index.js';
import { runTaskkill } from '../../src/windows.js';

// Runs inside a fresh node process with piped stdio. The test asserts that
// stdout/stderr stay empty, so this file must never print anything itself.
const resultPath = process.argv[2] as string;

async function main(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore', windowsHide: true }
  );
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  const pid = child.pid as number;

  const first = killTree(pid, { timeoutMs: 5000 });
  const second = killTree(pid, { timeoutMs: 5000 });
  const [a, b] = await Promise.all([first, second]);
  const again = await killTree(pid);

  // A helper that must write a SUCCESS/ERROR message of its own: nothing of it
  // may reach this process's stdio.
  const helperExitCode =
    process.platform === 'win32'
      ? (await runTaskkill(pid, 5000, undefined)).exitCode
      : null;

  writeFileSync(
    resultPath,
    JSON.stringify({ a, b, again, shared: first === second, helperExitCode })
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  writeFileSync(resultPath, JSON.stringify({ error: String(error) }));
  process.exit(1);
});
