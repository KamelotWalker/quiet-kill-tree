import { describe, expect, it } from 'vitest';
import { killTree } from '../src/index.js';
import { KillTreeError } from '../src/errors.js';
import type { KillSignal } from '../src/signals.js';

describe('killTree argument validation', () => {
  const invalidPids: [string, unknown][] = [
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string', '1234'],
    ['null', null],
    ['undefined', undefined]
  ];

  for (const [label, pid] of invalidPids) {
    it(`throws RangeError for a ${label} pid`, () => {
      expect(() => killTree(pid as number)).toThrowError(RangeError);
    });
  }

  it('refuses to kill the current process', () => {
    expect(() => killTree(process.pid)).toThrowError(RangeError);
    expect(() => killTree(process.pid)).toThrowError(/current process/);
  });

  it('rejects an unknown signal name', () => {
    expect(() => killTree(1, { signal: 'SIGBOGUS' as never })).toThrowError(
      TypeError
    );
  });

  it('accepts every NodeJS.Signals member at the type level', () => {
    // Compile-time assertion: a NodeJS.Signals value must need no cast.
    const nodeSignal: NodeJS.Signals = 'SIGKILL';
    const signal: KillSignal = nodeSignal;
    expect(signal).toBe('SIGKILL');
  });

  it('rejects a negative or non-finite timeout', () => {
    expect(() => killTree(1, { timeoutMs: -1 })).toThrowError(RangeError);
    expect(() => killTree(1, { timeoutMs: Number.NaN })).toThrowError(RangeError);
    expect(() =>
      killTree(1, { timeoutMs: Number.POSITIVE_INFINITY })
    ).toThrowError(RangeError);
  });

  it('rejects a timeout above the Node timer limit', () => {
    expect(() => killTree(1, { timeoutMs: 2_147_483_648 })).toThrowError(
      RangeError
    );
    expect(() =>
      killTree(1, { timeoutMs: Number.MAX_SAFE_INTEGER })
    ).toThrowError(/largest timer delay/);
  });

  it('drops the in-flight entry after a rejection', async () => {
    const controller = new AbortController();
    controller.abort();
    const first = killTree(42_424, { abortSignal: controller.signal });
    await expect(first).rejects.toMatchObject({ code: 'EABORTED' });

    const second = killTree(42_424, { abortSignal: controller.signal });
    expect(second).not.toBe(first);
    await expect(second).rejects.toMatchObject({ code: 'EABORTED' });
  });

  it('rejects a non-object options bag and a bogus abort signal', () => {
    expect(() => killTree(1, null as never)).toThrowError(TypeError);
    expect(() =>
      killTree(1, { abortSignal: {} as AbortSignal })
    ).toThrowError(TypeError);
  });

  it('returns a promise before doing any work', () => {
    const controller = new AbortController();
    controller.abort();
    const pending = killTree(42_424, { abortSignal: controller.signal });
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'EABORTED',
      pid: 42_424
    });
  });

  it('exposes a typed error class', () => {
    const error = new KillTreeError('EACCES', 7, 'nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('KillTreeError');
    expect(error.code).toBe('EACCES');
    expect(error.pid).toBe(7);
  });
});
