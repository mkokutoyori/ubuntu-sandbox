import { boundedInteger } from '@/cli/ArgumentTypes';

export const VLAN_MIN = 1;
export const VLAN_MAX = 4094;
const VLAN_RANGE_SIZE = VLAN_MAX - VLAN_MIN + 1;

function inRange(vlan: number): boolean {
  return Number.isInteger(vlan) && vlan >= VLAN_MIN && vlan <= VLAN_MAX;
}

export function parseVlanId(token: string | undefined): number | null {
  return boundedInteger(token, VLAN_MIN, VLAN_MAX);
}

export interface VlanListProblem {
  readonly at: number;
}

/**
 * `10 20 to 24 30` — la forme que VRP accepte partout ou il attend une
 * liste de VLAN. Rend le rang du jeton fautif plutot qu'un booleen,
 * pour que l'appelant place son caret.
 */
export function parseVlanList(
  args: readonly string[],
): { vlans: number[] } | VlanListProblem {
  if (args.length === 0) return { at: 0 };
  const vlans: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const debut = parseVlanId(args[i]);
    if (debut === null) return { at: i };
    if ((args[i + 1] ?? '').toLowerCase() === 'to') {
      const fin = parseVlanId(args[i + 2]);
      if (fin === null) return { at: i + 2 };
      if (fin < debut) return { at: i + 2 };
      for (let v = debut; v <= fin; v++) vlans.push(v);
      i += 2;
    } else {
      vlans.push(debut);
    }
  }
  return { vlans };
}

export class VlanSet {
  private complemented: boolean;
  private members: Set<number>;

  private constructor(complemented: boolean, members: Set<number>) {
    this.complemented = complemented;
    this.members = members;
  }

  static all(): VlanSet {
    return new VlanSet(true, new Set());
  }

  static none(): VlanSet {
    return new VlanSet(false, new Set());
  }

  static of(vlans: Iterable<number>): VlanSet {
    return new VlanSet(false, new Set(vlans));
  }

  static allExcept(vlans: Iterable<number>): VlanSet {
    const excluded = new Set<number>();
    for (const v of vlans) {
      if (inRange(v)) excluded.add(v);
    }
    return new VlanSet(true, excluded);
  }

  static from(source: VlanSet | Iterable<number>): VlanSet {
    return source instanceof VlanSet ? source.clone() : VlanSet.of(source);
  }

  clone(): VlanSet {
    return new VlanSet(this.complemented, new Set(this.members));
  }

  get size(): number {
    return this.complemented ? VLAN_RANGE_SIZE - this.members.size : this.members.size;
  }

  has(vlan: number): boolean {
    if (!this.complemented) return this.members.has(vlan);
    return inRange(vlan) && !this.members.has(vlan);
  }

  add(vlan: number): this {
    if (!this.complemented) {
      this.members.add(vlan);
      return this;
    }
    if (inRange(vlan)) {
      this.members.delete(vlan);
      return this;
    }
    this.expand();
    this.members.add(vlan);
    return this;
  }

  delete(vlan: number): boolean {
    if (!this.complemented) return this.members.delete(vlan);
    if (!inRange(vlan) || this.members.has(vlan)) return false;
    this.members.add(vlan);
    return true;
  }

  clear(): void {
    this.complemented = false;
    this.members = new Set();
  }

  isAll(): boolean {
    return this.complemented && this.members.size === 0;
  }

  *[Symbol.iterator](): IterableIterator<number> {
    if (!this.complemented) {
      yield* this.members;
      return;
    }
    for (let vlan = VLAN_MIN; vlan <= VLAN_MAX; vlan++) {
      if (!this.members.has(vlan)) yield vlan;
    }
  }

  values(): IterableIterator<number> {
    return this[Symbol.iterator]();
  }

  keys(): IterableIterator<number> {
    return this[Symbol.iterator]();
  }

  forEach(callback: (vlan: number, key: number, set: VlanSet) => void): void {
    for (const vlan of this) callback(vlan, vlan, this);
  }

  private expand(): void {
    const explicit = new Set<number>();
    for (let vlan = VLAN_MIN; vlan <= VLAN_MAX; vlan++) {
      if (!this.members.has(vlan)) explicit.add(vlan);
    }
    this.members = explicit;
    this.complemented = false;
  }
}
