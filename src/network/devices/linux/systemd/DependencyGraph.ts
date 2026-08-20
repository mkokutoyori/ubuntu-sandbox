export type DependencyKind =
  | 'requires'
  | 'wants'
  | 'bindsTo'
  | 'partOf'
  | 'conflicts'
  | 'after'
  | 'before';

export interface UnitNode {
  readonly name: string;
  readonly requires: readonly string[];
  readonly wants: readonly string[];
  readonly bindsTo: readonly string[];
  readonly partOf: readonly string[];
  readonly conflicts: readonly string[];
  readonly after: readonly string[];
  readonly before: readonly string[];
}

const ACTIVATION_KINDS: readonly DependencyKind[] = ['requires', 'wants', 'bindsTo'];

export function unitName(reference: string): string {
  return reference.replace(/\.service$/, '');
}

export type UnitSuffix = 'service' | 'target' | 'socket' | 'timer';

export function unitSuffix(name: string): UnitSuffix {
  return (name.match(/\.(target|socket|timer)$/)?.[1] as Exclude<UnitSuffix, 'service'>) ?? 'service';
}

export function fullUnitName(name: string): string {
  return unitSuffix(name) === 'service' ? `${unitName(name)}.service` : name;
}

export class DependencyGraph {
  private readonly nodes = new Map<string, UnitNode>();

  constructor(units: Iterable<UnitNode>) {
    for (const unit of units) {
      this.nodes.set(unitName(unit.name), this.normalize(unit));
    }
  }

  has(unit: string): boolean {
    return this.nodes.has(unitName(unit));
  }

  allUnits(): string[] {
    return [...this.nodes.keys()];
  }

  edges(unit: string, kind: DependencyKind): string[] {
    const node = this.nodes.get(unitName(unit));
    return node ? [...node[kind]] : [];
  }

  activationClosure(unit: string): Set<string> {
    const root = unitName(unit);
    const closure = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (closure.has(current)) continue;
      closure.add(current);
      const node = this.nodes.get(current);
      if (!node) continue;
      for (const kind of ACTIVATION_KINDS) {
        for (const target of node[kind]) {
          if (!closure.has(target)) stack.push(target);
        }
      }
    }
    return closure;
  }

  activeDependents(unit: string): string[] {
    const target = unitName(unit);
    const dependents: string[] = [];
    for (const [name, node] of this.nodes) {
      if (node.requires.includes(target) || node.bindsTo.includes(target) || node.partOf.includes(target)) {
        dependents.push(name);
      }
    }
    return dependents.sort();
  }

  private normalize(unit: UnitNode): UnitNode {
    return {
      name: unitName(unit.name),
      requires: unit.requires.map(unitName),
      wants: unit.wants.map(unitName),
      bindsTo: unit.bindsTo.map(unitName),
      partOf: unit.partOf.map(unitName),
      conflicts: unit.conflicts.map(unitName),
      after: unit.after.map(unitName),
      before: unit.before.map(unitName),
    };
  }
}
