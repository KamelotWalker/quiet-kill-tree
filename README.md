# quiet-kill-tree

Kill a process and every process it spawned, on Windows and POSIX, with one
`await` — and no error when the pid is already gone.

## Quick start

```sh
npm install quiet-kill-tree
```

```ts
import { spawn } from 'node:child_process';
import { killTree } from 'quiet-kill-tree';

// Any child your tool started: a dev server, a test runner, a CLI wrapper.
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);

await killTree(child.pid!);
console.log('the child and its descendants are gone');
```

## Why this exists

Tearing down a child process tree is where test runners and dev-server
launchers break on Windows. `tree-kill` is callback-based, so a teardown path
has to wrap it in a promise; worse, its Windows path passes `taskkill`'s
non-zero exit status straight to the callback. When the process already exited
— because it crashed, the user stopped it, or the port was busy — teardown
rejects and takes the whole run with it. That is exactly what
[`@storybook/addon-vitest` hit on Windows](https://github.com/storybookjs/storybook/issues/35277):
a gone Storybook process failed the entire Vitest run. pnpm has an open request
to [kill spawned trees at the spawn layer with `taskkill /T /F`](https://github.com/pnpm/tasks/issues/37)
instead of rediscovering them in an error handler. And running `taskkill`
yourself in a stdio server can
[leak its `SUCCESS: …` line into the JSON-RPC stream](https://github.com/microsoft/playwright-mcp/issues/1611),
which the MCP host then tries to parse as a message.

`quiet-kill-tree` is the narrow fix for that job: one promise, a typed result
for "already gone", a typed error for real failures, a grace period with
`SIGKILL` escalation, and helper processes whose output never reaches your
stdio.

## Comparison

| | quiet-kill-tree | [tree-kill](https://www.npmjs.com/package/tree-kill) | [pidtree](https://www.npmjs.com/package/pidtree) | [execa](https://www.npmjs.com/package/execa) | [fkill](https://www.npmjs.com/package/fkill) |
| --- | --- | --- | --- | --- | --- |
| Job | kill the tree of one pid | kill the tree of one pid | list the children of one pid | run and control child processes | kill by pid, name or port |
| API | `await killTree(pid, options)` | `treeKill(pid, signal?, callback)` | `await pidtree(pid)` | `execa(file, args)` + `subprocess.kill()` | `await fkill(input, options)` |
| Tree teardown for a pid you did not spawn | yes | yes | no — enumeration only | only processes it spawned (`killDescendants`, default `false`) | Windows only (`tree: true` is a Windows-only option) |
| Already-exited pid | resolves `{ killed: false, reason }` | rejects on Windows (taskkill exit 128); `ESRCH` is swallowed per pid on POSIX | n/a | n/a | throws unless `silent: true` |
| Duplicate concurrent calls | one shared in-flight promise | one walk per call | one enumeration per call | n/a | one kill per call |
| Cancellation | `abortSignal` | — | — | `cancelSignal` for the spawned process | — |
| Grace period, then force | `timeoutMs` | — | — | `forceKillAfterDelay` | `forceAfterTimeout` |
| Machine-readable error codes | `KillTreeError.code` (7 values) | — | — | typed error classes, no OS code mapping | — |
| Helper output isolation | helper stdio is piped or ignored, never inherited; covered by tests | helper output is captured, not documented as a guarantee | n/a | stdio configurable | `silent` suppresses errors, not helper output |
| Runtime dependencies | 0 | 0 | 0 | 12 | 5 |
| Module format | ESM + CJS + types | CJS, `export =` types | ESM + types | ESM + types | ESM + types |
| Version | 0.1.1 | 1.2.2 | 1.0.0 | 10.2.1 | 10.0.3 |
| Last published | 0.1.0 on 2026-10-28 | 2019-12-11 | 2026-06-08 | 2026-10-23 | 2026-01-14 |

Competitor facts were read from the npm registry and the published tarballs on
2026-10-28; the links go to each package's npm page, where the same metadata is
visible. Missing features are marked `—`, not "unsupported forever": check the
linked package before relying on this table for a decision.

Two clarifications, because they matter for an honest choice:

- `pidtree` and `execa` are not competitors for this exact job. `pidtree` gives
  you the enumeration half and leaves signalling to you; `execa` owns the whole
  subprocess lifecycle for processes it started. Pick them if that is the shape
  you need.
- `fkill` terminates by pid, process name or port and ships a CLI. Its `tree`
  option is documented as Windows-only, so on POSIX it kills the named pid, not
  its descendants. Use it for interactive "kill whatever holds port 3000"
  problems, not for deterministic tree teardown.

## Migrating from tree-kill

`tree-kill`'s API is a callback, so most codebases already wrap it:

```js
// before
const treeKill = require('tree-kill');

function stopServer(pid) {
  return new Promise((resolve, reject) => {
    treeKill(pid, 'SIGTERM', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
```

```ts
// after
import { killTree } from 'quiet-kill-tree';

async function stopServer(pid: number) {
  const result = await killTree(pid);
  if (!result.killed) {
    console.log(`already stopped: ${result.reason}`);
  }
}
```

### A gone pid stops being an error

The reason migration is worth it: on Windows, `tree-kill` hands you the
`taskkill` failure for a process that no longer exists. Callers end up matching
localized English text to tell "gone" apart from "denied":

```js
// before: fragile, locale-dependent workaround
treeKill(pid, (error) => {
  if (error && !/not found|no running instance|no tasks/i.test(error.message)) {
    reject(error);
  } else {
    resolve();
  }
});
```

```ts
// after: a value, not an exception
const { killed, reason } = await killTree(pid);
// killed: false, reason: 'not-found' | 'already-exited'
```

`killTree` decides "gone" from `taskkill`'s exit status plus a
`process.kill(pid, 0)` liveness probe, so localized output is never parsed.

### Mapping the error you used to inspect

| `tree-kill` callback | `quiet-kill-tree` |
| --- | --- |
| `error.code === 128` on Windows, process gone | resolves `{ killed: false, reason: 'already-exited' }` |
| `error.code === 'ESRCH'` | treated as already exited; `EREFUSED` is reserved for a tree that contains you |
| `error.code === 'EPERM'` / access denied | rejects `KillTreeError` with `code: 'EACCES'` |
| helper binary missing | rejects `KillTreeError` with `code: 'ESPAWN'` |
| no timeout / hang after `SIGTERM` | pass `timeoutMs`; survivors are escalated to `SIGKILL` on POSIX |

```ts
import { killTree, KillTreeError } from 'quiet-kill-tree';

try {
  await killTree(pid, { timeoutMs: 3_000 });
} catch (error) {
  if (error instanceof KillTreeError) {
    if (error.code === 'ETIMEDOUT') {
      // survivors ignored SIGTERM and SIGKILL, or a helper exceeded its budget
    } else if (error.code === 'EACCES') {
      // the OS refused to signal this process
    }
  }
  throw error;
}
```

### Windows output silence

`taskkill` prints `SUCCESS: …` and localized failure text on its own streams.
If that text reaches an inherited stdout — or your error handler logs the
`Command failed: …` message produced by `exec` — it can corrupt a JSON-RPC
transport ([playwright-mcp#1611](https://github.com/microsoft/playwright-mcp/issues/1611))
or a test reporter. `quiet-kill-tree` starts `taskkill` with
`stdio: ['ignore', 'ignore', 'pipe']` and `windowsHide: true`, discards its
stdout, and keeps at most 4 KiB of stderr to append to a generic `EFAILED`
message. Nothing is inherited from, or forwarded to, the caller's stdio; the
same rule applies to the POSIX `ps` helper.

One more difference worth knowing: `tree-kill` sends the signal to one pid at a
time through `process.kill`. `quiet-kill-tree` enumerates `ps -A -o pid=,ppid=`
first, orders children before parents, signals them bottom-up, and only then
signals the root — so a parent cannot respawn a child between two kills.

## API reference

### `killTree(pid, options?)`

```ts
function killTree(
  pid: number,
  options?: KillTreeOptions
): Promise<KillTreeResult>;
```

Terminates the process tree rooted at `pid` and resolves when the work is done
or the pid is gone.

- **`pid`** — positive integer. Must not be `process.pid`. Validated
  synchronously; invalid input throws before any work starts.
- **`options`** — optional; see the table below.
- **Returns** — a promise for `KillTreeResult`:
  - `{ pid, killed: true }` — signals were delivered (POSIX without
    `timeoutMs`), or the escalation/`taskkill` outcome was verified.
  - `{ pid, killed: false, reason: 'not-found' }` — the root pid was already
    dead before any work started.
  - `{ pid, killed: false, reason: 'already-exited' }` — the root disappeared
    before a signal could be delivered, or `taskkill` reported exit 128 and the
    liveness probe confirms it is dead.
- **Rejects** — with `KillTreeError` for real failures. A gone pid is never an
  error.

Concurrent calls for the same pid share one in-flight promise; the tree is only
walked once and the first call's options win. The entry is removed when the
promise settles, so a later call starts fresh.

#### Options

| option | type | default | platform | behavior |
| --- | --- | --- | --- | --- |
| `signal` | `KillSignal` | `'SIGTERM'` | POSIX | Signal for the first pass. Ignored on Windows. |
| `timeoutMs` | `number` | `undefined` | both | POSIX: grace period before survivors get `SIGKILL`, then a bounded wait (up to 1 s) for them to disappear. Windows: budget for `taskkill` plus the liveness check. Must be `<= 2_147_483_647`. |
| `abortSignal` | `AbortSignal` | `undefined` | both | Cancels the operation. Rejects with a `KillTreeAbortError`: `name === 'AbortError'` and `code === 'EABORTED'`. |

Without `timeoutMs`, the POSIX path delivers the first signal and returns
without waiting. With it, the call only resolves after every observed pid is
gone or `SIGKILL` failed to remove them (`ETIMEDOUT`).

#### Throws synchronously (before returning a promise)

```ts
killTree(0); // RangeError — pid must be a positive integer
killTree(1.5); // RangeError
killTree(process.pid); // RangeError — refusing to kill the current process
killTree(pid, { timeoutMs: -1 }); // RangeError
killTree(pid, { timeoutMs: 2_147_483_648 }); // RangeError — Node timer limit
killTree(pid, { signal: 'NOPE' as never }); // TypeError
killTree(pid, { abortSignal: {} as never }); // TypeError
```

### `KillTreeError`

```ts
class KillTreeError extends Error {
  readonly code: KillTreeErrorCode;
  readonly pid: number;
  readonly exitCode: number | null | undefined;
  // cause is the standard Error.cause, set when an underlying error exists
}
```

`name` is `'KillTreeError'`. Use `instanceof KillTreeError` and branch on
`code`; treat `message` as human-readable text only.

| code | meaning |
| --- | --- |
| `EACCES` | the OS refused to signal or terminate a process (access denied) |
| `ETIMEDOUT` | survivors remained after the grace period and `SIGKILL`, or a helper exceeded its budget |
| `ESPAWN` | `taskkill` / `ps` could not be started or exited non-zero |
| `EPARSE` | the process table output could not be parsed (never silently truncated) |
| `EFAILED` | any other OS-level failure |
| `EREFUSED` | refused for safety: the POSIX tree contains the calling process, or the target is PID 1 |
| `EABORTED` | `abortSignal` fired; the error's `name` is `'AbortError'` |

### `KillTreeAbortError`

```ts
class KillTreeAbortError extends KillTreeError {
  name: 'AbortError';
  code: 'EABORTED';
}
```

Both checks work, so existing `error.name === 'AbortError'` handling keeps
working:

```ts
try {
  await killTree(pid, { abortSignal: controller.signal });
} catch (error) {
  if ((error as Error).name === 'AbortError') {
    // the helper was stopped; the tree may be partially terminated
  }
}
```

### Types

```ts
type KillSignal =
  | 'SIGABRT' | 'SIGALRM' | 'SIGBUS' | 'SIGCHLD' | 'SIGCONT' | 'SIGFPE'
  | 'SIGHUP' | 'SIGILL' | 'SIGINT' | 'SIGIO' | 'SIGIOT' | 'SIGKILL'
  | 'SIGPIPE' | 'SIGPOLL' | 'SIGPROF' | 'SIGPWR' | 'SIGQUIT' | 'SIGSEGV'
  | 'SIGSTKFLT' | 'SIGSTOP' | 'SIGSYS' | 'SIGTERM' | 'SIGTRAP' | 'SIGTSTP'
  | 'SIGTTIN' | 'SIGTTOU' | 'SIGUNUSED' | 'SIGURG' | 'SIGUSR1' | 'SIGUSR2'
  | 'SIGVTALRM' | 'SIGWINCH' | 'SIGXCPU' | 'SIGXFSZ' | 'SIGBREAK'
  | 'SIGLOST' | 'SIGINFO';

type KillTreeErrorCode =
  | 'EACCES' | 'ETIMEDOUT' | 'ESPAWN' | 'EPARSE' | 'EFAILED' | 'EREFUSED'
  | 'EABORTED';

type NotKilledReason = 'not-found' | 'already-exited';

type KillTreeResult =
  | { pid: number; killed: true; reason?: undefined }
  | { pid: number; killed: false; reason: NotKilledReason };
```

`KillSignal` mirrors `NodeJS.Signals` but is declared locally, so the typings
stay usable without `@types/node` (Deno, Bun, browser-side type checks). Any
value typed as `NodeJS.Signals` is assignable to `KillSignal`.

## More examples

### Graceful stop, then force

```ts
// POSIX: SIGTERM everywhere, 3 s grace, SIGKILL for whoever is left.
await killTree(pid, { signal: 'SIGTERM', timeoutMs: 3_000 });
```

### Do not walk the same tree twice

```ts
const [a, b] = await Promise.all([killTree(pid), killTree(pid)]);
a === b; // true — one enumeration, one helper run
```

### Abort during shutdown

```ts
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  await killTree(pid, { timeoutMs: 2_000, abortSignal: controller.signal });
} catch (error) {
  if ((error as Error).name === 'AbortError') {
    // stop here; the tree may be partially terminated
  }
}
```

## When not to use this

- **You need to kill by process name or port.** Use [`fkill`](https://www.npmjs.com/package/fkill).
- **You only need the children of a pid.** Use [`pidtree`](https://www.npmjs.com/package/pidtree)
  and signal them yourself.
- **You are already adopting a subprocess framework.** [`execa`](https://www.npmjs.com/package/execa)
  can kill the processes it spawned (`killDescendants`) and gives you I/O,
  IPC and exit handling in the same dependency.
- **You need hard ownership guarantees.** Use a POSIX process group
  (`spawn(..., { detached: true })` plus `process.kill(-pgid, signal)`), a
  cgroup, a container, or a supervisor such as systemd. This library kills the
  tree it can observe at call time; it is not an ownership boundary.
- **You need a graceful Windows shutdown.** Windows has no POSIX signals.
  `taskkill /T /F` is forceful, and `signal` is ignored there. If the child
  must flush state, ask it to exit through your own IPC channel and use
  `killTree` only as the fallback.

## Safety rails

- **POSIX:** before any signal is sent, the enumerated tree is checked. If it
  contains the calling process — `killTree(process.ppid)`, `killTree(1)`, or any
  ancestor — the call rejects with `EREFUSED` and **nothing is signalled**. PID
  1 is always refused. Skipping only the caller is not an option: the rest of
  that tree could never be cleaned up safely from inside it.
- **Windows:** there is no enumeration, so ancestry cannot be checked. Killing
  an ancestor (including your own parent) terminates this process before the
  promise can settle. Only `process.pid` itself is refused, synchronously.

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

## Limitations

- **Windows cannot detect ancestry.** Do not call `killTree` on an ancestor of
  the current process on Windows: it will terminate you. POSIX rejects such a
  tree with `EREFUSED` instead.
- **`killed: true` means the signals were delivered.** Without `timeoutMs`, the
  POSIX path returns right after the first pass; a handler that ignores
  `SIGTERM` still leaves the process alive. Pass `timeoutMs` to escalate and
  verify.
- **Ownership is not promised.** A pid can be reused between your `spawn` and
  the kill; the OS offers no portable generation counter. Keep the
  `ChildProcess` handle and kill it promptly.
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
  `process.kill`. **Bun** works through its Node compatibility layer. Verified
  on Node 24 / Windows 11; Bun and Deno are not covered by CI in this repo.

## FAQ

### How do I kill a process tree in Node.js on Windows?

`await killTree(pid)` runs `taskkill /T /F /PID <pid>` with hidden, piped
stdio, then confirms the root pid is gone. If the pid already exited, the
promise resolves with `{ killed: false, reason: 'not-found' }` instead of
throwing, so a teardown path does not fail the run.

### Why does `tree-kill` fail my Vitest stack on Windows when the server is already stopped?

`tree-kill` forwards `taskkill`'s non-zero exit status to its callback, and
`taskkill` exits 128 for a process that is gone. That is the failure described
in [storybookjs/storybook#35277](https://github.com/storybookjs/storybook/issues/35277).
With `quiet-kill-tree`, check `result.killed` instead of catching an error.

### Is `quiet-kill-tree` a drop-in replacement for `tree-kill`?

No. `tree-kill` is `(pid, signal?, callback)` and CommonJS; this package is
`await killTree(pid, options)` with ESM and CJS builds. The migration section
above shows the mechanical rewrite; the behavioral change is that an
already-exited pid resolves instead of rejecting.

### Can two shutdown paths call `killTree` for the same pid at once?

Yes. The second call receives the same promise, so only one enumeration and one
helper run happen. This matters for `SIGINT` handlers racing a `finally` block.

### How do I make sure a process that ignores `SIGTERM` is really gone?

Pass `timeoutMs`. On POSIX the tree gets your `signal` first, then `SIGKILL`
after the grace period; if anything is still alive, the call rejects with
`ETIMEDOUT`. On Windows `timeoutMs` only bounds `taskkill`, which is already
forceful.

### Does it work with ESM, CommonJS, Bun and Deno?

The package ships ESM, CJS and TypeScript declarations for Node 20 and newer.
Bun works through its Node compatibility layer. Deno needs `--allow-run` and
`--allow-sys`; it is not part of this repo's CI matrix.

## CI

GitHub Actions builds and tests Node 20, 22 and 24 on Ubuntu, macOS and Windows.
Real-process integration tests verify that every pid in a Node tree disappears.
The POSIX suite also exercises `ps -A -o pid=,ppid=` and SIGKILL escalation for
a tree with ready, installed SIGTERM handlers that deliberately ignore SIGTERM.
Platform-specific integration suites run only on their matching operating
systems.

## License

MIT
