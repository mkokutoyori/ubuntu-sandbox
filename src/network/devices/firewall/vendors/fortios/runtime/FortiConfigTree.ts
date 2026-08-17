import { pathKey, type FortiTableSpec } from '../schema/types';
import { FortiObject } from './FortiObject';
import { FortiTable } from './FortiTable';

export type FortiNode = FortiTable | FortiObject;

export class FortiConfigTree {
  private readonly tables = new Map<string, FortiTable>();
  private readonly singletons = new Map<string, FortiObject>();

  constructor(private readonly specs: ReadonlyMap<string, FortiTableSpec>) {}

  spec(path: readonly string[]): FortiTableSpec | undefined {
    return this.specs.get(pathKey(path));
  }

  specPaths(): readonly string[][] {
    return [...this.specs.values()]
      .sort((a, b) => a.renderOrder - b.renderOrder)
      .map(s => [...s.path]);
  }

  branchNames(prefix: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    for (const spec of this.specs.values()) {
      if (spec.path.length <= prefix.length) continue;
      if (!prefix.every((word, i) => spec.path[i] === word)) continue;
      seen.add(spec.path[prefix.length]);
    }
    return [...seen].sort();
  }

  node(path: readonly string[]): FortiNode | undefined {
    const spec = this.spec(path);
    if (!spec) return undefined;
    return spec.kind === 'table' ? this.table(spec) : this.singleton(spec);
  }

  table(spec: FortiTableSpec): FortiTable {
    const key = pathKey(spec.path);
    let table = this.tables.get(key);
    if (!table) {
      table = new FortiTable(spec);
      this.tables.set(key, table);
    }
    return table;
  }

  singleton(spec: FortiTableSpec): FortiObject {
    const key = pathKey(spec.path);
    let object = this.singletons.get(key);
    if (!object) {
      object = new FortiObject(spec, key);
      this.singletons.set(key, object);
    }
    return object;
  }

  existingTable(path: readonly string[]): FortiTable | undefined {
    return this.tables.get(pathKey(path));
  }

  populatedPaths(): readonly FortiTableSpec[] {
    const out: FortiTableSpec[] = [];
    for (const spec of [...this.specs.values()].sort((a, b) => a.renderOrder - b.renderOrder)) {
      if (spec.kind === 'table') {
        const table = this.tables.get(pathKey(spec.path));
        if (table && table.size() > 0) out.push(spec);
        continue;
      }
      const single = this.singletons.get(pathKey(spec.path));
      if (single && single.explicitNames().length > 0) out.push(spec);
    }
    return out;
  }
}
