const INITIAL_SIZE = 16;
const PERTURB_SHIFT = 5n;
const WORD = (1n << 64n) - 1n;
const UNSIGNED = (1n << 32n) - 1n;

interface Slot {
  readonly key: string;
  readonly hash: bigint;
}

function hashOf(key: string): bigint {
  const bytes = new TextEncoder().encode(key);
  if (bytes.length === 0) return 0n;
  let hash = BigInt(bytes[0]);
  for (let at = 1; at < bytes.length; at++) hash = (hash * 101n + BigInt(bytes[at])) & WORD;
  return hash;
}

function freeSlot(array: readonly (Slot | null)[], hash: bigint): number {
  const mask = BigInt(array.length - 1);
  let index = Number(hash & mask);
  if (array[index] === null) return index;
  for (let perturb = hash; ; perturb >>= PERTURB_SHIFT) {
    index = Number(((BigInt(index) << 2n) + BigInt(index) + perturb + 1n) & UNSIGNED);
    const slot = index & Number(mask);
    if (array[slot] === null) return slot;
  }
}

export function vimDictionaryOrder(keys: readonly string[]): string[] {
  let array: (Slot | null)[] = new Array<Slot | null>(INITIAL_SIZE).fill(null);
  let used = 0;
  for (const key of keys) {
    const hash = hashOf(key);
    array[freeSlot(array, hash)] = { key, hash };
    used += 1;
    if (used < INITIAL_SIZE - 1 && array.length === INITIAL_SIZE) continue;
    const size = array.length;
    if (used * 3 < size * 2 && used > Math.floor(size / 5)) continue;
    const minimum = used > 1000 ? used * 2 : used * 4;
    let grown = INITIAL_SIZE;
    while (grown < minimum) grown *= 2;
    if (grown === size && used * 3 < size * 2) continue;
    const moved: (Slot | null)[] = new Array<Slot | null>(grown).fill(null);
    for (const slot of array) if (slot !== null) moved[freeSlot(moved, slot.hash)] = slot;
    array = moved;
  }
  return array.filter((slot): slot is Slot => slot !== null).map((slot) => slot.key);
}

export function inVimOrder<V>(entries: ReadonlyMap<string, V>): [string, V][] {
  return vimDictionaryOrder([...entries.keys()]).map((key) => [key, entries.get(key)!]);
}
