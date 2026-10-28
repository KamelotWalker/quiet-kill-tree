import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

/**
 * Bundles the fixture (which imports the real source) and runs it in a child
 * node process. Everything the library writes to stdout/stderr would land in
 * this test's pipes, so empty pipes prove the "silent" contract end to end.
 */
it(
  'writes nothing to stdout or stderr, even on repeated calls',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quiet-kill-tree-'));
    const outfile = join(dir, 'silent-run.mjs');
    const resultPath = join(dir, 'result.json');
    const entry = fileURLToPath(
      new URL('./fixtures/silent-run.ts', import.meta.url)
    );

    try {
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        logLevel: 'silent'
      });

      const child = spawn(process.execPath, [outfile, resultPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Uint8Array) => {
        stdout += new TextDecoder().decode(chunk);
      });
      child.stderr?.on('data', (chunk: Uint8Array) => {
        stderr += new TextDecoder().decode(chunk);
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        child.once('close', (code) => resolve(code));
      });

      let result: unknown;
      try {
        result = JSON.parse(await readFile(resultPath, 'utf8'));
      } catch (error) {
        throw new Error(
          `fixture produced no result (exit ${String(exitCode)}): ${String(error)}\nstdout: ${stdout}\nstderr: ${stderr}`
        );
      }

      expect(stdout).toBe('');
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);
      expect(result).toMatchObject({
        shared: true,
        a: { pid: expect.any(Number), killed: true },
        b: { pid: expect.any(Number), killed: true },
        again: { killed: false, reason: 'not-found' },
        helperExitCode: process.platform === 'win32' ? 128 : null
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000
);
