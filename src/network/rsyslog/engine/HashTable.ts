const PRIMES = [
  53, 97, 193, 389, 769, 1543, 3079, 6151, 12289, 24593, 49157, 98317, 196613, 393241, 786433, 1572869, 3145739, 6291469,
  12582917, 25165843, 50331653, 100663319, 201326611, 402653189, 805306457, 1610612741,
];
const MAX_LOAD_FACTOR = 65;
const MAX_MIN_SIZE = 1 << 30;
const ENCODER = new TextEncoder();

interface Entry<V> {
  readonly key: string;
  value: V;
  readonly hash: number;
  next: Entry<V> | null;
}

export function hashFromString(key: string): number {
  const terminator = key.indexOf('\0');
  const bytes = ENCODER.encode(terminator < 0 ? key : key.slice(0, terminator));
  let hashval = 1;
  for (const byte of bytes) hashval = (Math.imul(hashval, 33) + (byte > 127 ? byte - 256 : byte)) >>> 0;
  return hashval;
}

export function mixedHash(key: string): number {
  let value = hashFromString(key);
  value = (value + (~(value << 9) >>> 0)) >>> 0;
  value = (value ^ ((value >>> 14) | (value << 18))) >>> 0;
  value = (value + ((value << 4) >>> 0)) >>> 0;
  value = (value ^ ((value >>> 10) | (value << 22))) >>> 0;
  return value;
}

function loadLimit(size: number): number {
  return Math.floor((size * MAX_LOAD_FACTOR) / 100);
}

export class RsyslogHashTable<V> {
  private table: Array<Entry<V> | null>;
  private primeIndex: number;
  private entryCount = 0;
  private limit: number;

  constructor(minSize: number) {
    if (minSize > MAX_MIN_SIZE) throw new RangeError('hashtable too large');
    let index = PRIMES.findIndex((prime) => prime > minSize);
    if (index < 0) index = PRIMES.length;
    this.primeIndex = index;
    const size = index < PRIMES.length ? PRIMES[index] : PRIMES[0];
    this.table = new Array<Entry<V> | null>(size).fill(null);
    this.limit = loadLimit(size);
  }

  get count(): number {
    return this.entryCount;
  }

  hash(key: string): number {
    return mixedHash(key);
  }

  private expand(): void {
    if (this.primeIndex === PRIMES.length - 1) return;
    const size = PRIMES[++this.primeIndex];
    const grown = new Array<Entry<V> | null>(size).fill(null);
    for (let i = 0; i < this.table.length; i++) {
      let entry = this.table[i];
      while (entry !== null) {
        this.table[i] = entry.next;
        const index = entry.hash % size;
        entry.next = grown[index];
        grown[index] = entry;
        entry = this.table[i];
      }
    }
    this.table = grown;
    this.limit = loadLimit(size);
  }

  insertPrehashed(hash: number, key: string, value: V): void {
    if (++this.entryCount > this.limit) this.expand();
    const index = hash % this.table.length;
    this.table[index] = { key, value, hash, next: this.table[index] };
  }

  insert(key: string, value: V): void {
    this.insertPrehashed(this.hash(key), key, value);
  }

  searchPrehashed(hash: number, key: string): V | undefined {
    for (let entry = this.table[hash % this.table.length]; entry !== null; entry = entry.next) {
      if (entry.hash === hash && entry.key === key) return entry.value;
    }
    return undefined;
  }

  search(key: string): V | undefined {
    return this.searchPrehashed(this.hash(key), key);
  }

  removePrehashed(hash: number, key: string): V | undefined {
    const index = hash % this.table.length;
    let previous: Entry<V> | null = null;
    for (let entry = this.table[index]; entry !== null; previous = entry, entry = entry.next) {
      if (entry.hash !== hash || entry.key !== key) continue;
      if (previous === null) this.table[index] = entry.next;
      else previous.next = entry.next;
      this.entryCount--;
      return entry.value;
    }
    return undefined;
  }

  remove(key: string): V | undefined {
    return this.removePrehashed(this.hash(key), key);
  }

  entries(): Array<readonly [string, V]> {
    const entries: Array<readonly [string, V]> = [];
    for (const head of this.table) {
      for (let entry = head; entry !== null; entry = entry.next) entries.push([entry.key, entry.value]);
    }
    return entries;
  }

  values(): V[] {
    return this.entries().map(([, value]) => value);
  }

  removeIf(predicate: (key: string, value: V) => boolean): void {
    for (let i = 0; i < this.table.length; i++) {
      let previous: Entry<V> | null = null;
      for (let entry = this.table[i]; entry !== null; entry = entry.next) {
        if (predicate(entry.key, entry.value)) {
          if (previous === null) this.table[i] = entry.next;
          else previous.next = entry.next;
          this.entryCount--;
        } else previous = entry;
      }
    }
  }
}
