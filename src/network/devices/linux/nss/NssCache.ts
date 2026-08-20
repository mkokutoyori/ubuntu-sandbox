/**
 * NssCache — the consumer the invalidation signal never had.
 *
 * `NameServiceSwitch` has always published a cache-invalidation signal
 * (12 wired bus topics) and its own class comment anticipated "a future
 * LRU layer". This is that layer.
 *
 * Correctness before speed: an entry's key embeds the mtime of every
 * file that could have produced it, so editing `/etc/passwd`,
 * `/etc/hosts` or `/etc/nsswitch.conf` changes the key and the stale
 * entry can never be read back. The bus signal on top of that drops
 * whole databases eagerly rather than waiting for the next lookup.
 *
 * Only file-backed lookups are cached — a `dns` or `systemd` answer has
 * no stat-able backing store to stamp a key with, so it is never stored.
 */

export interface NssCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  size: number;
}

interface CacheEntry {
  database: string;
  value: unknown;
}

const DEFAULT_MAX_ENTRIES = 128;

export class NssCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /**
   * Look a key up. A hit is moved to the end of the insertion order so
   * the least recently used entry is the first one evicted.
   */
  get<T>(key: string): { value: T } | null {
    const hit = this.entries.get(key);
    if (!hit) { this.misses++; return null; }
    this.entries.delete(key);
    this.entries.set(key, hit);
    this.hits++;
    return { value: hit.value as T };
  }

  set(database: string, key: string, value: unknown): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { database, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop every entry produced for one database. */
  invalidate(database: string): void {
    let dropped = 0;
    for (const [k, e] of this.entries) {
      if (e.database === database) { this.entries.delete(k); dropped++; }
    }
    if (dropped > 0) this.invalidations++;
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): NssCacheStats {
    return {
      hits: this.hits, misses: this.misses,
      invalidations: this.invalidations, size: this.entries.size,
    };
  }
}
