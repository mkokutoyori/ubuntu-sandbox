const INITIAL_SIZE = 16;
const PERTURB_SHIFT = 5n;
const WORD = (1n << 64n) - 1n;
const UNSIGNED = (1n << 32n) - 1n;
const REMOVED = Symbol('removed');

interface Slot {
  readonly key: string;
  readonly hash: bigint;
}

type Cell = Slot | null | typeof REMOVED;

function hashOf(key: string): bigint {
  const bytes = new TextEncoder().encode(key);
  if (bytes.length === 0) return 0n;
  let hash = BigInt(bytes[0]);
  for (let at = 1; at < bytes.length; at++) hash = (hash * 101n + BigInt(bytes[at])) & WORD;
  return hash;
}

function matches(cell: Cell, hash: bigint, key: string): boolean {
  return cell !== null && cell !== REMOVED && cell.hash === hash && cell.key === key;
}

function lookup(array: readonly Cell[], hash: bigint, key: string): number {
  const mask = BigInt(array.length - 1);
  let index = Number(hash & mask);
  const first = array[index];
  if (first === null) return index;
  let freeItem = first === REMOVED ? index : -1;
  if (matches(first, hash, key)) return index;
  let running = index;
  for (let perturb = hash; ; perturb >>= PERTURB_SHIFT) {
    running = Number(((BigInt(running) << 2n) + BigInt(running) + perturb + 1n) & UNSIGNED);
    index = running & Number(mask);
    const cell = array[index];
    if (cell === null) return freeItem < 0 ? index : freeItem;
    if (matches(cell, hash, key)) return index;
    if (cell === REMOVED && freeItem < 0) freeItem = index;
  }
}

function freeSlot(array: readonly Cell[], hash: bigint): number {
  const mask = BigInt(array.length - 1);
  let index = Number(hash & mask);
  if (array[index] === null) return index;
  for (let perturb = hash; ; perturb >>= PERTURB_SHIFT) {
    index = Number(((BigInt(index) << 2n) + BigInt(index) + perturb + 1n) & UNSIGNED);
    const slot = index & Number(mask);
    if (array[slot] === null) return slot;
  }
}

class HashTable {
  private array: Cell[] = new Array<Cell>(INITIAL_SIZE).fill(null);
  private used = 0;
  private filled = 0;

  add(key: string): void {
    const hash = hashOf(key);
    const at = lookup(this.array, hash, key);
    if (matches(this.array[at], hash, key)) return;
    if (this.array[at] === null) this.filled += 1;
    this.array[at] = { key, hash };
    this.used += 1;
    this.mayResize();
  }

  remove(key: string): void {
    const hash = hashOf(key);
    const at = lookup(this.array, hash, key);
    if (!matches(this.array[at], hash, key)) return;
    this.array[at] = REMOVED;
    this.used -= 1;
    this.mayResize();
  }

  keys(): string[] {
    return this.array.filter((cell): cell is Slot => cell !== null && cell !== REMOVED).map((cell) => cell.key);
  }

  private mayResize(): void {
    const size = this.array.length;
    if (this.filled < INITIAL_SIZE - 1 && size === INITIAL_SIZE) return;
    if (this.filled * 3 < size * 2 && this.used > Math.floor(size / 5)) return;
    const minimum = this.used > 1000 ? this.used * 2 : this.used * 4;
    let grown = INITIAL_SIZE;
    while (grown < minimum) grown *= 2;
    const moved: Cell[] = new Array<Cell>(grown).fill(null);
    for (const cell of this.array) {
      if (cell === null || cell === REMOVED) continue;
      moved[freeSlot(moved, cell.hash)] = cell;
    }
    this.array = moved;
    this.filled = this.used;
  }
}

export class TrackedEntries<V> extends Map<string, V> {
  readonly trace: string[] = [];

  override set(key: string, value: V): this {
    if (!this.has(key)) this.trace.push(`+${key}`);
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.trace.push(`-${key}`);
    return had;
  }

  override clear(): void {
    for (const key of [...this.keys()]) this.delete(key);
  }
}

export function vimOrderOfTrace(trace: readonly string[]): string[] {
  const table = new HashTable();
  for (const step of trace) {
    if (step[0] === '+') table.add(step.slice(1));
    else table.remove(step.slice(1));
  }
  return table.keys();
}

export function vimDictionaryOrder(keys: readonly string[]): string[] {
  return vimOrderOfTrace(keys.map((key) => `+${key}`));
}

export function inVimOrder<V>(entries: ReadonlyMap<string, V>): [string, V][] {
  const order = entries instanceof TrackedEntries ? vimOrderOfTrace(entries.trace) : vimDictionaryOrder([...entries.keys()]);
  return order.map((key) => [key, entries.get(key)!]);
}
