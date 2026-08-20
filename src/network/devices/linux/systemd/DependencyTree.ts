import { DependencyGraph, fullUnitName } from '@/network/devices/linux/systemd/DependencyGraph';

const CHILD_KINDS = ['requires', 'bindsTo', 'wants'] as const;

export function renderDependencyTree(root: string, graph: DependencyGraph): string {
  const lines = [fullUnitName(root)];
  const visited = new Set([root]);
  const walk = (unit: string, prefix: string): void => {
    const children = childrenOf(unit, graph);
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      lines.push(`● ${prefix}${last ? '└─' : '├─'}${fullUnitName(child)}`);
      if (!visited.has(child)) {
        visited.add(child);
        walk(child, `${prefix}${last ? '  ' : '│ '}`);
      }
    });
  };
  walk(root, '');
  return lines.join('\n');
}

function childrenOf(unit: string, graph: DependencyGraph): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kind of CHILD_KINDS) {
    for (const dep of graph.edges(unit, kind)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        out.push(dep);
      }
    }
  }
  return out;
}
