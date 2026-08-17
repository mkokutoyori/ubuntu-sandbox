import {
  attributeMap, childMap, typeArity,
  type FortiAttributeSpec, type FortiObjectView, type FortiTableSpec,
} from '../schema/types';
import { FortiTable } from './FortiTable';

export interface FortiObjectSnapshot {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly children: ReadonlyMap<string, unknown>;
}

export class FortiObject implements FortiObjectView {
  private readonly values = new Map<string, string[]>();
  private readonly childTables = new Map<string, FortiTable>();
  private readonly attributes: ReadonlyMap<string, FortiAttributeSpec>;

  constructor(readonly spec: FortiTableSpec, public key: string) {
    this.attributes = attributeMap(spec);
    for (const [name, childSpec] of childMap(spec)) {
      this.childTables.set(name, new FortiTable(childSpec));
    }
  }

  attribute(name: string): FortiAttributeSpec | undefined {
    return this.attributes.get(name);
  }

  attributeNames(): readonly string[] {
    return this.spec.attributes.map(a => a.name);
  }

  availableAttributes(): readonly FortiAttributeSpec[] {
    return this.spec.attributes.filter(a => this.isAvailable(a));
  }

  isAvailable(attribute: FortiAttributeSpec): boolean {
    return attribute.availableWhen === undefined || attribute.availableWhen(this);
  }

  child(name: string): FortiTable | undefined {
    return this.childTables.get(name);
  }

  childNames(): readonly string[] {
    return [...this.childTables.keys()];
  }

  set(name: string, values: readonly string[]): void {
    this.values.set(name, [...values]);
  }

  unset(name: string): void {
    this.values.delete(name);
  }

  isExplicit(name: string): boolean {
    return this.values.has(name);
  }

  explicit(name: string): readonly string[] | undefined {
    return this.values.get(name);
  }

  explicitNames(): readonly string[] {
    return this.spec.attributes
      .filter(a => this.values.has(a.name))
      .map(a => a.name);
  }

  effective(name: string): readonly string[] {
    const posed = this.values.get(name);
    if (posed !== undefined) return posed;
    return this.attributes.get(name)?.defaultValue ?? [];
  }

  string(name: string): string {
    return this.effective(name)[0] ?? '';
  }

  integer(name: string): number {
    return Number.parseInt(this.effective(name)[0] ?? '', 10);
  }

  bool(name: string): boolean {
    return this.effective(name)[0] === 'enable';
  }

  list(name: string): readonly string[] {
    return this.effective(name);
  }

  appendTo(name: string, values: readonly string[]): void {
    const current = [...this.effective(name)];
    for (const value of values) if (!current.includes(value)) current.push(value);
    this.values.set(name, current);
  }

  keepOnly(name: string, values: readonly string[]): void {
    const current = this.effective(name);
    this.values.set(name, current.filter(v => values.includes(v)));
  }

  removeFrom(name: string, values: readonly string[]): void {
    const current = this.effective(name);
    this.values.set(name, current.filter(v => !values.includes(v)));
  }

  arityOf(name: string): number {
    const attribute = this.attributes.get(name);
    return attribute ? typeArity(attribute) : 1;
  }

  snapshot(): FortiObjectSnapshot {
    const values = new Map<string, readonly string[]>();
    for (const [name, list] of this.values) values.set(name, [...list]);
    const children = new Map<string, unknown>();
    for (const [name, table] of this.childTables) children.set(name, table.snapshot());
    return { values, children };
  }

  restore(snapshot: FortiObjectSnapshot): void {
    this.values.clear();
    for (const [name, list] of snapshot.values) this.values.set(name, [...list]);
    for (const [name, state] of snapshot.children) {
      this.childTables.get(name)?.restore(state as never);
    }
  }
}
