import { describe, expect, it } from 'vitest';
import { orderTree, type ProcessEntry } from '../src/tree.js';

describe('orderTree', () => {
  it('orders a chain deepest-first and puts the root last', () => {
    const entries: ProcessEntry[] = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 }
    ];

    const order = orderTree(entries, 10);

    expect(order).toEqual([12, 11, 10]);
  });

  it('places every child before its parent and drops unrelated subtrees', () => {
    const entries: ProcessEntry[] = [
      { pid: 100, ppid: 1 },
      { pid: 101, ppid: 100 },
      { pid: 102, ppid: 100 },
      { pid: 103, ppid: 101 },
      { pid: 104, ppid: 102 },
      { pid: 200, ppid: 1 },
      { pid: 201, ppid: 200 }
    ];

    const order = orderTree(entries, 100);

    expect(new Set(order)).toEqual(new Set([100, 101, 102, 103, 104]));
    expect(order.at(-1)).toBe(100);
    for (const entry of entries) {
      const parentIndex = order.indexOf(entry.ppid);
      const childIndex = order.indexOf(entry.pid);
      if (parentIndex !== -1 && childIndex !== -1) {
        expect(childIndex).toBeLessThan(parentIndex);
      }
    }
  });

  it('returns only the root when the root is absent from the table', () => {
    expect(orderTree([{ pid: 2, ppid: 1 }], 999)).toEqual([999]);
  });

  it('visits a pid once when the table contains a cycle', () => {
    const entries: ProcessEntry[] = [
      { pid: 5, ppid: 6 },
      { pid: 6, ppid: 5 }
    ];

    const order = orderTree(entries, 5);

    expect(order).toEqual([6, 5]);
  });

  it('ignores self-parented and non-integer rows', () => {
    const entries = [
      { pid: 7, ppid: 7 },
      { pid: 8, ppid: 7 },
      { pid: Number.NaN, ppid: 7 },
      { pid: 9.5, ppid: 7 }
    ] as ProcessEntry[];

    expect(orderTree(entries, 7)).toEqual([8, 7]);
  });

  it('handles a 20k-deep table without overflowing the stack', () => {
    const entries: ProcessEntry[] = [{ pid: 1, ppid: 0 }];
    for (let pid = 2; pid <= 20_000; pid += 1) {
      entries.push({ pid, ppid: pid - 1 });
    }

    const order = orderTree(entries, 1);

    expect(order).toHaveLength(20_000);
    expect(order[0]).toBe(20_000);
    expect(order.at(-1)).toBe(1);
  });
});
