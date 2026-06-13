/**
 * RowIndexCache — hash-index runtime over in-memory table rows.
 *
 * Until now indexes only existed as catalog metadata (IndexMeta): every
 * lookup — UNIQUE/PK constraint checks, FK parent checks, WHERE col = :x —
 * was a full linear scan. This module gives the storage layer a real,
 * lazily-built equality index so execution finally matches what the plan
 * generator advertises (INDEX UNIQUE SCAN) and bulk DML stops being O(n²).
 *
 * Design constraints that shaped this implementation:
 *
 * - **Never a false negative.** Callers may treat a probe result as the
 *   complete candidate set, so a row that `compareValues` considers equal
 *   to the probe key MUST be in the returned bucket. Where hashing cannot
 *   guarantee that (mixed-type columns, cross-type probes that the engine
 *   would implicitly convert), the probe answers `null` and the caller
 *   falls back to a full scan. False positives are fine — callers verify
 *   candidates with the real comparator (or re-run the full WHERE filter).
 *
 * - **Cheap appends.** INSERT is the hot path (bulk loads validate a
 *   UNIQUE key per row); appends therefore do not invalidate the index —
 *   the probe indexes the new tail incrementally. Any other mutation
 *   (UPDATE/DELETE/TRUNCATE/column drops) bumps the owning table's epoch,
 *   which throws the cached structure away wholesale.
 *
 * - **Engine stays vendor-agnostic.** Implicit string→DATE coercion is
 *   Oracle (NLS) behaviour, so it is injected via `IndexValueSemantics`
 *   rather than imported from the oracle/ layer.
 */

import type { CellValue, StorageRow } from './BaseStorage';

/** Dialect-specific implicit conversions the index needs for probing. */
export interface IndexValueSemantics {
  /** String→Date coercion used when probing a DATE-kind column with a string. */
  toDate?(value: CellValue): Date | null;
}

/** Counters exposed for tests and (eventually) V$-style statistics. */
export interface IndexRuntimeStats {
  /** Full index (re)builds — high churn here means epoch thrash. */
  builds: number;
  /** Probes answered from a hash bucket (incl. provable no-match). */
  probes: number;
  /** Probes that had to decline (mixed kinds, unsupported value shape). */
  fallbacks: number;
}

/**
 * The runtime type of every non-NULL value seen in an indexed column.
 * A column whose values mix kinds cannot be hashed safely (the engine's
 * comparator applies implicit conversions between kinds) — such an index
 * is marked unusable and probes fall back to scanning.
 */
type ColumnKind = 'empty' | 'number' | 'string' | 'date' | 'boolean' | 'mixed';

const NULL_PART = '\u0000';
const PART_SEPARATOR = '\u0001';
/** Lookup-encoding verdict: no bucket can match → provably empty result. */
const NO_MATCH = Symbol('no-match');
/** Lookup-encoding verdict: hashing unsafe for this value/kind pair. */
const UNSAFE = Symbol('unsafe');

const MAX_CACHED_INDEXES = 256;

interface CachedIndex {
  epoch: number;
  /** Rows [0, indexedLength) are reflected in the buckets. */
  indexedLength: number;
  kinds: ColumnKind[];
  /** Encoded key → indices into the rows array, in table order. */
  buckets: Map<string, number[]>;
}

function kindOfValue(v: CellValue): ColumnKind | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  if (v instanceof Date) return 'date';
  return 'mixed'; // unknown runtime shape — refuse to hash
}

/** Encode a stored cell into its bucket key part (kind is tracked separately). */
function encodeStored(v: CellValue): string {
  if (v === null || v === undefined) return NULL_PART;
  if (typeof v === 'number') return `n${v}`;
  if (typeof v === 'boolean') return `b${v}`;
  if (v instanceof Date) return `d${v.getTime()}`;
  // NFC-normalise so composed/decomposed Unicode land in one bucket,
  // mirroring localeCompare's normalisation-insensitive equality.
  return `s${String(v).normalize('NFC')}`;
}

/**
 * Encode a probe value against a column of the given kind. Returns the
 * bucket key part, NO_MATCH when the comparator provably cannot equate
 * the value with any stored one, or UNSAFE when hashing can't preserve
 * the comparator's implicit-conversion semantics.
 */
function encodeLookup(
  v: CellValue,
  kind: ColumnKind,
  semantics: IndexValueSemantics,
): string | typeof NO_MATCH | typeof UNSAFE {
  if (v === undefined) return UNSAFE;
  if (v === null) return NULL_PART;
  switch (kind) {
    case 'empty':
      // Only NULLs are stored; a non-NULL probe can never match.
      return NO_MATCH;
    case 'number': {
      if (typeof v === 'number') return `n${v}`;
      if (typeof v === 'string') {
        // The comparator equates a number with a string only when the
        // string is numeric ('5.0' = 5) — non-numeric strings can only
        // match via String(number) === s, which is itself numeric.
        const n = Number(v);
        return Number.isNaN(n) ? NO_MATCH : `n${n}`;
      }
      return UNSAFE;
    }
    case 'string':
      if (typeof v === 'string') return `s${v.normalize('NFC')}`;
      // number/Date probes against string storage rely on per-value
      // implicit conversion ('5.0' = 5) that buckets can't reproduce.
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

export class RowIndexCache {
  private readonly entries = new Map<string, CachedIndex>();
  private readonly stats: IndexRuntimeStats = { builds: 0, probes: 0, fallbacks: 0 };

  constructor(private readonly semantics: IndexValueSemantics = {}) {}

  getStats(): Readonly<IndexRuntimeStats> {
    return this.stats;
  }

  /** Drop every cached structure for a table (DROP TABLE housekeeping). */
  forgetTable(tableKey: string): void {
    const prefix = `${tableKey}#`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /**
   * Probe `rows` for entries whose `columnOrdinals` cells equal `values`.
   *
   * @param tableKey unique per-table cache key (schema.table)
   * @param epoch    the table's mutation epoch — a mismatch discards the cache
   * @returns candidate rows in table order (caller must verify with the real
   *          comparator), `[]` when provably nothing matches, or `null` when
   *          the caller must fall back to a full scan.
   */
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
      this.entries.delete(cacheKey); // refresh FIFO position
      this.entries.set(cacheKey, entry);
    }
    // Index the appended tail (appends never bump the epoch).
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
