/** One row of a process table. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
}

/**
 * Builds the kill order for `rootPid`: every descendant first (deepest last
 * child order), the root last.
 *
 * Post-order guarantees children are signalled before their parents, so a
 * parent cannot respawn or hide a child between the two signals. Cycles and
 * self-parented entries (which real process tables can contain for pid 0 or
 * after a reparenting race) are visited once and cannot loop.
 *
 * The traversal is iterative: a deeply nested or adversarial process table
 * cannot overflow the call stack.
 */
export function orderTree(
  entries: readonly ProcessEntry[],
  rootPid: number
): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.pid) || !Number.isInteger(entry.ppid)) continue;
    if (entry.pid === entry.ppid) continue;
    const siblings = childrenOf.get(entry.ppid);
    if (siblings === undefined) {
      childrenOf.set(entry.ppid, [entry.pid]);
    } else {
      siblings.push(entry.pid);
    }
  }

  const order: number[] = [];
  const visited = new Set<number>();
  const stack: { pid: number; expanded: boolean }[] = [
    { pid: rootPid, expanded: false }
  ];

  while (stack.length > 0) {
    const frame = stack.pop() as { pid: number; expanded: boolean };
    if (frame.expanded) {
      order.push(frame.pid);
      continue;
    }
    if (visited.has(frame.pid)) continue;
    visited.add(frame.pid);
    stack.push({ pid: frame.pid, expanded: true });
    const children = childrenOf.get(frame.pid);
    if (children !== undefined) {
      // Reverse order so the stack pops siblings in process-table order.
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index] as number;
        if (!visited.has(child)) stack.push({ pid: child, expanded: false });
      }
    }
  }

  return order;
}
