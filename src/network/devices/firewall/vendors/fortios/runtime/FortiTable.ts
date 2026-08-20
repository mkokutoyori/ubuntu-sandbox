import {
  EMPTY_ENVIRONMENT, type FortiSchemaEnvironment, type FortiTableSpec,
} from '../schema/types';
import { FortiObject, type FortiObjectSnapshot } from './FortiObject';

export type MovePosition = 'before' | 'after';

export interface FortiTableSnapshot {
  readonly order: readonly string[];
  readonly objects: ReadonlyMap<string, FortiObjectSnapshot>;
}

export class FortiTable {
  private readonly objects = new Map<string, FortiObject>();
  private order: string[] = [];

  constructor(
    readonly spec: FortiTableSpec,
    private readonly env: FortiSchemaEnvironment = EMPTY_ENVIRONMENT,
  ) {}

  has(key: string): boolean {
    return this.objects.has(key);
  }

  get(key: string): FortiObject | undefined {
    return this.objects.get(key);
  }

  ensure(key: string): FortiObject {
    const existing = this.objects.get(key);
    if (existing) return existing;

    const created = new FortiObject(this.spec, key, this.env);
    this.objects.set(key, created);
    this.order.push(key);
    return created;
  }

  remove(key: string): boolean {
    if (!this.objects.delete(key)) return false;
    this.order = this.order.filter(k => k !== key);
    return true;
  }

  purge(): readonly string[] {
    const removed = [...this.order];
    this.objects.clear();
    this.order = [];
    return removed;
  }

  rename(from: string, to: string): boolean {
    const object = this.objects.get(from);
    if (!object || this.objects.has(to)) return false;

    object.key = to;
    this.objects.delete(from);
    this.objects.set(to, object);
    this.order = this.order.map(k => (k === from ? to : k));
    return true;
  }

  clone(from: string, to: string): FortiObject | null {
    const source = this.objects.get(from);
    if (!source || this.objects.has(to)) return null;

    const copy = this.ensure(to);
    copy.restore(source.snapshot());
    return copy;
  }

  move(key: string, position: MovePosition, target: string): boolean {
    const at = this.order.indexOf(key);
    const to = this.order.indexOf(target);
    if (at < 0 || to < 0 || key === target) return false;

    this.order.splice(at, 1);
    const anchor = this.order.indexOf(target);
    this.order.splice(position === 'before' ? anchor : anchor + 1, 0, key);
    return true;
  }

  keys(): readonly string[] {
    return [...this.order];
  }

  all(): readonly FortiObject[] {
    return this.order.map(k => this.objects.get(k)!).filter(Boolean);
  }

  size(): number {
    return this.objects.size;
  }

  nextFreeIntegerKey(): string {
    let candidate = 1;
    while (this.objects.has(String(candidate))) candidate++;
    return String(candidate);
  }

  snapshot(): FortiTableSnapshot {
    const objects = new Map<string, FortiObjectSnapshot>();
    for (const [key, object] of this.objects) objects.set(key, object.snapshot());
    return { order: [...this.order], objects };
  }

  restore(snapshot: FortiTableSnapshot): void {
    this.objects.clear();
    this.order = [...snapshot.order];
    for (const key of this.order) {
      const state = snapshot.objects.get(key);
      if (!state) continue;
      const object = new FortiObject(this.spec, key, this.env);
      object.restore(state);
      this.objects.set(key, object);
    }
  }
}
