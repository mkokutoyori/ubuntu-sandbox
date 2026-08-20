import { DependencyGraph, unitName } from '@/network/devices/linux/systemd/DependencyGraph';

export interface OrderingResult {
  readonly order: string[];
  readonly cycle: string[] | null;
}

export function orderUnits(units: readonly string[], graph: DependencyGraph): OrderingResult {
  const members = new Set(units.map(unitName));
  const predecessors = new Map<string, Set<string>>();
  for (const unit of members) predecessors.set(unit, new Set());

  for (const unit of members) {
    for (const target of graph.edges(unit, 'after')) {
      if (members.has(target)) predecessors.get(unit)!.add(target);
    }
    for (const target of graph.edges(unit, 'before')) {
      if (members.has(target)) predecessors.get(target)!.add(unit);
    }
  }

  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < members.size) {
    const ready = [...members]
      .filter((u) => !placed.has(u) && [...predecessors.get(u)!].every((p) => placed.has(p)))
      .sort();
    if (ready.length === 0) {
      return { order, cycle: findCycle(members, predecessors, placed) };
    }
    const next = ready[0];
    order.push(next);
    placed.add(next);
  }
  return { order, cycle: null };
}

function findCycle(
  members: Set<string>, predecessors: Map<string, Set<string>>, placed: Set<string>,
): string[] {
  const remaining = [...members].filter((u) => !placed.has(u));
  const inStack = new Set<string>();
  const path: string[] = [];

  const walk = (node: string): string[] | null => {
    inStack.add(node);
    path.push(node);
    for (const pred of predecessors.get(node)!) {
      if (placed.has(pred)) continue;
      if (inStack.has(pred)) {
        return path.slice(path.indexOf(pred));
      }
      const found = walk(pred);
      if (found) return found;
    }
    inStack.delete(node);
    path.pop();
    return null;
  };

  for (const node of remaining) {
    const found = walk(node);
    if (found) return found;
  }
  return remaining.sort();
}
