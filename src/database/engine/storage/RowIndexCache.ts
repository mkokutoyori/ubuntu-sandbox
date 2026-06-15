import type { CellValue, StorageRow } from './BaseStorage';

export interface IndexValueSemantics {
  toDate?(value: CellValue): Date | null;
}

export interface IndexRuntimeStats {
  builds: number;
  probes: number;
  fallbacks: number;
}

type ColumnKind = 'empty' | 'number' | 'string' | 'date' | 'boolean' | 'mixed';

const NULL_PART = '\u0000';
const PART_SEPARATOR = '\u0001';
const NO_MATCH = Symbol('no-match');
const UNSAFE = Symbol('unsafe');

const MAX_CACHED_INDEXES = 256;

interface CachedIndex {
  epoch: number;
  indexedLength: number;
  kinds: ColumnKind[];
  buckets: Map<string, number[]>;
}

function kindOfValue(v: CellValue): ColumnKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Date) return 'date';
  return 'mixed';
}

function encodeStored(v: CellValue): string {
  if (v === null || v === undefined) return NULL_PART;
  if (typeof v === 'number') return `n${v}`;
  if (typeof v === 'boolean') return `b${v}`;
  if (v instanceof Date) return `d${v.getTime()}`;
  return `s${String(v).normalize('NFC')}`;
}

function encodeLookup(
  v: CellValue,
  kind: ColumnKind,
  semantics: IndexValueSemantics,
): string | typeof NO_MATCH | typeof UNSAFE {
  if (v === undefined) return UNSAFE;
  if (v === null) return NULL_PART;
  switch (kind) {
    case 'empty':
      return NO_MATCH;
    case 'number': {
      if (typeof v === 'number') return `n${v}`;
      if (typeof v === 'string') {
        const n = Number(v);
        return Number.isNaN(n) ? NO_MATCH : `n${n}`;
      }
      return UNSAFE;
    }
    case 'string':
      if (typeof v === 'string') return `s${v.normalize('NFC')}`;
      return UNSAFE;
    case 'date': {
      if (v instanceof Date) return `d${v.getTime()}`;
      if (typeof v === 'string' && semantics.toDate) {
        const d = semantics.toDate(v);
        if (d) return `d${d.getTime()}`;
      }
      return UNSAFE;
    }
    case 'boolean':
      return typeof v === 'boolean' ? `b${v}` : UNSAFE;
    default:
      return UNSAFE;
  }
}

/**
 * Lazily-built equality index over in-memory table rows. Never produces a
 * false negative: when hashing cannot preserve the comparator's implicit
 * conversions, probe() returns null and the caller falls back to a scan.
 * Appends extend the structure incrementally; any other mutation bumps the
 * table epoch and discards the cache.
 */
export class RowIndexCache {
  private readonly entries = new Map<string, CachedIndex>();
  private readonly stats: IndexRuntimeStats = { builds: 0, probes: 0, fallbacks: 0 };

  constructor(private readonly semantics: IndexValueSemantics = {}) {}

  getStats(): Readonly<IndexRuntimeStats> {
    return this.stats;
  }

  forgetTable(tableKey: string): void {
    const prefix = `${tableKey}#`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  probe(
    tableKey: string,
    epoch: number,
    rows: StorageRow[],
    columnOrdinals: number[],
    values: CellValue[],
  ): StorageRow[] | null {
    if (columnOrdinals.length === 0 || columnOrdinals.some(o => o < 0)) {
      this.stats.fallbacks++;
      return null;
    }
    const entry = this.entryFor(tableKey, epoch, rows, columnOrdinals);
    if (entry.kinds.includes('mixed')) {
      this.stats.fallbacks++;
      return null;
    }
    const parts: string[] = [];
    for (let i = 0; i < columnOrdinals.length; i++) {
      const part = encodeLookup(values[i], entry.kinds[i], this.semantics);
      if (part === UNSAFE) {
        this.stats.fallbacks++;
        return null;
      }
      if (part === NO_MATCH) {
        this.stats.probes++;
        return [];
      }
      parts.push(part);
    }
    this.stats.probes++;
    const bucket = entry.buckets.get(parts.join(PART_SEPARATOR));
    if (!bucket) return [];
    return bucket.map(i => rows[i]);
  }

  private entryFor(
    tableKey: string,
    epoch: number,
    rows: StorageRow[],
    columnOrdinals: number[],
  ): CachedIndex {
    const cacheKey = `${tableKey}#${columnOrdinals.join(',')}`;
    let entry = this.entries.get(cacheKey);
    if (!entry || entry.epoch !== epoch) {
      entry = {
        epoch,
        indexedLength: 0,
        kinds: columnOrdinals.map(() => 'empty' as ColumnKind),
        buckets: new Map(),
      };
      this.stats.builds++;
      if (this.entries.size >= MAX_CACHED_INDEXES) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, entry);
    }
    for (let r = entry.indexedLength; r < rows.length; r++) {
      const parts: string[] = [];
      for (let c = 0; c < columnOrdinals.length; c++) {
        const cell = rows[r][columnOrdinals[c]];
        const kind = kindOfValue(cell);
        if (kind !== null) {
          if (entry.kinds[c] === 'empty') entry.kinds[c] = kind;
          else if (entry.kinds[c] !== kind) entry.kinds[c] = 'mixed';
        }
        parts.push(encodeStored(cell));
      }
      const key = parts.join(PART_SEPARATOR);
      const bucket = entry.buckets.get(key);
      if (bucket) bucket.push(r);
      else entry.buckets.set(key, [r]);
    }
    entry.indexedLength = rows.length;
    return entry;
  }
}
