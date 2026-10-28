# quiet-kill-tree

Promise-based, silent, idempotent process-tree termination for Windows and POSIX.

```ts
import { killTree } from 'quiet-kill-tree';

const result = await killTree(child.pid);
// { pid: 1234, killed: true }
```

- **Promise API** — no callbacks, no `tree-kill`-style `(pid, signal, callback)`.
- **Silent** — helper processes (`taskkill`, `ps`) run with piped/ignored stdio
  and `windowsHide`; the library never writes to your stdout/stderr, so it cannot
  corrupt JSON-RPC streams or test reporter output.
- **Idempotent** — concurrent calls for the same pid share one in-flight promise.
  A pid that is already gone resolves with `killed: false` and a reason instead
  of throwing.
- **Typed failures** — permission, timeout and helper failures reject with
  `KillTreeError` carrying a machine-readable `code`; localized `taskkill`
  messages are never parsed.
- **Zero runtime dependencies**, ESM + CJS + TypeScript types, Node >= 20.

## Install

```sh
npm install quiet-kill-tree
```

## API

```ts
function killTree(pid: number, options?: KillTreeOptions): Promise<KillTreeResult>;

interface KillTreeOptions {
  /** POSIX signal for the first pass. Default: 'SIGTERM'. Ignored on Windows. */
  signal?: KillSignal;
  /**
   * POSIX: grace period before survivors get SIGKILL.
   * Windows: budget for taskkill + the follow-up liveness check.
   * Must be <= 2_147_483_647 (Node's largest timer delay).
   */
  timeoutMs?: number;
  /** Cancels the operation with an AbortError-named KillTreeError. */
  abortSignal?: AbortSignal;
}

type KillTreeResult =
  | { pid: number; killed: true; reason?: undefined }
  | { pid: number; killed: false; reason: 'not-found' | 'already-exited' };
```

`KillSignal` is the same value set as `NodeJS.Signals`, declared locally so the
typings do not require `@types/node` (Deno, Bun, browser-side type checks).

### Errors

```ts
import { killTree, KillTreeError } from 'quiet-kill-tree';

try {
  await killTree(pid, { timeoutMs: 5_000 });
} catch (error) {
  if (error instanceof KillTreeError) {
    // 'EACCES' | 'ETIMEDOUT' | 'ESPAWN' | 'EPARSE' | 'EFAILED' | 'EABORTED'
    console.error(error.code, error.pid, error.exitCode);
  }
}
```

| code | meaning |
| --- | --- |
| `EACCES` | the OS refused to signal/terminate a process (access denied) |
| `ETIMEDOUT` | survivors remained after the grace period and `SIGKILL`, or a helper exceeded its budget |
| `ESPAWN` | `taskkill` / `ps` could not be started or exited non-zero |
| `EPARSE` | the process table output could not be parsed (never silently truncated) |
| `EFAILED` | any other OS-level failure |
| `EREFUSED` | refused for safety: the POSIX tree contains the calling process, or the target is PID 1 |
| `EABORTED` | `abortSignal` fired; the error's `name` is `'AbortError'` |

### Invalid arguments

`killTree` validates synchronously, before any work:

```ts
killTree(0); // RangeError
killTree(1.5); // RangeError
killTree(process.pid); // RangeError — refusing to kill the current process
killTree(pid, { timeoutMs: -1 }); // RangeError
killTree(pid, { signal: 'NOPE' as never }); // TypeError
killTree(pid, { timeoutMs: 2_147_483_648 }); // RangeError (Node timer limit)
```

## Examples

### Clean up after a test server

```ts
import { spawn } from 'node:child_process';
import { killTree } from 'quiet-kill-tree';

const server = spawn('node', ['server.js'], { stdio: 'ignore' });

try {
  await runTests();
} finally {
  await killTree(server.pid!);
}
```

### Graceful stop, then force

```ts
// POSIX: SIGTERM everywhere, 3s grace, SIGKILL for whoever is left.
await killTree(pid, { signal: 'SIGTERM', timeoutMs: 3_000 });
```

### Do not kill a tree that is already being cleaned up

```ts
const [a, b] = await Promise.all([killTree(pid), killTree(pid)]);
a === b; // true — one walk, one taskkill/ps run
```

### Abort on shutdown

```ts
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  await killTree(pid, { timeoutMs: 2_000, abortSignal: controller.signal });
} catch (error) {
  if ((error as Error).name === 'AbortError') {
    // the helper was stopped; the target tree may be partially terminated
  }
}
```

## Safety rails

- **POSIX:** before any signal is sent, the enumerated tree is checked. If it
  contains the calling process — `killTree(process.ppid)`, `killTree(1)`, or any
  ancestor — the call rejects with `EREFUSED` and **nothing is signalled**. PID 1
  is always refused. Skipping only the caller is not an option: the rest of that
  tree could never be cleaned up safely from inside it.
- **Windows:** there is no enumeration, so ancestry cannot be checked. Killing an
  ancestor (including your own parent) terminates this process before the promise
  can settle. Only `process.pid` itself is refused, synchronously.

## How it works

**Windows** — `taskkill /T /F /PID <pid>` with `windowsHide`, `stdio: ['ignore',
'ignore', 'pipe']`, then a bounded `process.kill(pid, 0)` check. "Not found" is
decided by a liveness probe, never by parsing taskkill's localized text.

**POSIX** — descendants are read from `ps -A -o pid=,ppid=`, ordered children
before parents, signalled bottom-up (parent last, so it cannot respawn a child
in between), then the root. With `timeoutMs`, survivors get `SIGKILL` after the
grace period and the call only resolves once every observed pid is gone. An
abort during enumeration kills the owned `ps` helper and rejects before the
tree is signalled. The process lister and signaler are injectable internally
(`src/posix.ts`), so the whole POSIX cascade is unit-tested on any host.

## Comparison with `tree-kill`

`tree-kill` (1.2.2, last published 2019, ~45M downloads/week) is the package this
one targets: it is callback-based, has no abort/timeout support, and callers have
reported Windows races where a gone pid rejects the whole call
([storybookjs/storybook#35277](https://github.com/storybookjs/storybook/issues/35277)).

| | quiet-kill-tree | tree-kill |
| --- | --- | --- |
| API | `Promise<KillTreeResult>` | callback `(pid, signal, cb)` |
| Already-dead pid | resolves `killed: false` + reason | rejects with an `Error` |
| Concurrent duplicate calls | one shared promise | one walk per call |
| Cancellation | `AbortSignal` | — |
| Grace period + escalation | `timeoutMs` | — |
| Typed error codes | `KillTreeError.code` | — |
| Output silence | guaranteed, tested | not controlled |
| Runtime deps | 0 | 0 |
| Types | bundled, ESM + CJS | `@types/tree-kill` |

`pidtree` and `execa` solve neighboring problems (enumeration; a full subprocess
layer). If you want tree cleanup without adopting a subprocess framework, this
package is the narrow option.

## Limitations

- **Windows cannot detect ancestry.** Do not call `killTree` on an ancestor of
  the current process on Windows: it will terminate you. POSIX rejects such a
  tree with `EREFUSED` instead.
- **`killed: true` means the signals were delivered.** Without `timeoutMs`, the
  POSIX path returns right after the first pass; a handler that ignores `SIGTERM`
  still leaves the process alive. Pass `timeoutMs` to escalate and verify.
- **Ownership is not promised.** A pid can be reused between your `spawn` and the
  kill; the OS offers no portable generation counter. Keep the `ChildProcess`
  handle and kill it promptly.
- **Windows is always forceful.** `taskkill /T /F` has no graceful signal;
  `signal` is ignored and `timeoutMs` only bounds the helper.
- **Windows cannot verify grandchildren individually.** `taskkill /T` walks the
  tree; the library verifies only the root pid afterwards, so a grandchild that
  escaped enumeration is not detected.
- **POSIX needs `ps` on `PATH`.** Containers without `procps` reject with
  `ESPAWN`; there is no `/proc` fallback.
- **Orphans are out of reach.** On POSIX, once a child's parent exits it is
  reparented and no longer discoverable from the original pid. Enumerate before
  the parent dies (that is what this library does) or use a process group /
  cgroup for hard guarantees.
- **Zombies look alive.** A terminated but unreaped child still answers
  `kill(pid, 0)`; the POSIX grace check can report `ETIMEDOUT` until its parent
  reaps it. Reap your own children.
- **Deno** requires `--allow-run` (for `taskkill`/`ps`) and `--allow-sys` for
  `process.kill`. **Bun** works through its Node compatibility layer. Verified on
  Node 24 / Windows 11; Bun and Deno are not covered by CI in this repo.

## CI

GitHub Actions builds and tests Node 20, 22 and 24 on Ubuntu, macOS and Windows.
Real-process integration tests verify that every pid in a Node tree disappears.
The POSIX suite also exercises `ps -A -o pid=,ppid=` and SIGKILL escalation for
a tree with ready, installed SIGTERM handlers that deliberately ignore SIGTERM.
Platform-specific integration suites run only on their matching operating systems.

## License

MIT
