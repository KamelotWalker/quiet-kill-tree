/**
 * Signals accepted by {@link KillTreeOptions.signal}.
 *
 * The union mirrors `NodeJS.Signals` so the public typings stay usable without
 * `@types/node` (Deno, Bun, browser type-checking), while any value typed as
 * `NodeJS.Signals` is assignable to it.
 *
 * @example
 * ```ts
 * import { killTree } from 'quiet-kill-tree';
 *
 * await killTree(pid, { signal: 'SIGINT' });
 * ```
 */
export type KillSignal =
  | 'SIGABRT'
  | 'SIGALRM'
  | 'SIGBUS'
  | 'SIGCHLD'
  | 'SIGCONT'
  | 'SIGFPE'
  | 'SIGHUP'
  | 'SIGILL'
  | 'SIGINT'
  | 'SIGIO'
  | 'SIGIOT'
  | 'SIGKILL'
  | 'SIGPIPE'
  | 'SIGPOLL'
  | 'SIGPROF'
  | 'SIGPWR'
  | 'SIGQUIT'
  | 'SIGSEGV'
  | 'SIGSTKFLT'
  | 'SIGSTOP'
  | 'SIGSYS'
  | 'SIGTERM'
  | 'SIGTRAP'
  | 'SIGTSTP'
  | 'SIGTTIN'
  | 'SIGTTOU'
  | 'SIGUNUSED'
  | 'SIGURG'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGVTALRM'
  | 'SIGWINCH'
  | 'SIGXCPU'
  | 'SIGXFSZ'
  | 'SIGBREAK'
  | 'SIGLOST'
  | 'SIGINFO';

const KILL_SIGNALS: Record<KillSignal, true> = {
  SIGABRT: true,
  SIGALRM: true,
  SIGBUS: true,
  SIGCHLD: true,
  SIGCONT: true,
  SIGFPE: true,
  SIGHUP: true,
  SIGILL: true,
  SIGINT: true,
  SIGIO: true,
  SIGIOT: true,
  SIGKILL: true,
  SIGPIPE: true,
  SIGPOLL: true,
  SIGPROF: true,
  SIGPWR: true,
  SIGQUIT: true,
  SIGSEGV: true,
  SIGSTKFLT: true,
  SIGSTOP: true,
  SIGSYS: true,
  SIGTERM: true,
  SIGTRAP: true,
  SIGTSTP: true,
  SIGTTIN: true,
  SIGTTOU: true,
  SIGUNUSED: true,
  SIGURG: true,
  SIGUSR1: true,
  SIGUSR2: true,
  SIGVTALRM: true,
  SIGWINCH: true,
  SIGXCPU: true,
  SIGXFSZ: true,
  SIGBREAK: true,
  SIGLOST: true,
  SIGINFO: true
};

/** Runtime guard for {@link KillSignal} values coming from untyped callers. */
export function isKillSignal(value: unknown): value is KillSignal {
  return typeof value === 'string' && Object.hasOwn(KILL_SIGNALS, value);
}
