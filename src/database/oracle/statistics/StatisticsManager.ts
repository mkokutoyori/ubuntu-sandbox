/**
 * StatisticsManager — Oracle table/column/index statistics.
 *
 * Backed by concrete classes for each kind. Populated by
 * `DBMS_STATS` package routines (GATHER_TABLE_STATS / GATHER_SCHEMA_STATS).
 *
 * The classes hold every column DBA_TAB_STATISTICS / DBA_COL_STATISTICS /
 * DBA_TAB_HISTOGRAMS surface, even when the simulator does not compute
 * them yet (e.g. CLUSTER_FACTOR, BLEVEL) — defaults match Oracle's
 * "freshly gathered" appearance.
 */

import type { OracleStorage } from '../OracleStorage';

export type HistogramKind = 'NONE' | 'FREQUENCY' | 'HEIGHT BALANCED' | 'HYBRID' | 'TOP-FREQUENCY';

export class TableStatistics {
  constructor(
    readonly owner: string,
    readonly tableName: string,
    readonly numRows: number,
    readonly blocks: number,
    readonly emptyBlocks: number,
    readonly avgSpace: number,
    readonly chainCount: number,
    readonly avgRowLen: number,
    readonly sampleSize: number,
    readonly lastAnalyzed: Date,
    /** Stale flag, mutated by GATHER_STATS / SET_TABLE_STATS. */
    readonly stale: boolean = false,
    /** Global vs partition-level — we only model GLOBAL stats. */
    readonly statType: 'GLOBAL' | 'PARTITION' | 'SUBPARTITION' = 'GLOBAL',
  ) {}
}

export class ColumnStatistics {
  constructor(
    readonly owner: string,
    readonly tableName: string,
    readonly columnName: string,
    readonly numDistinct: number,
    readonly numNulls: number,
    readonly numBuckets: number,
    readonly density: number,
    readonly avgColLen: number,
    readonly lowValue: string,
    readonly highValue: string,
    readonly histogram: HistogramKind,
    readonly lastAnalyzed: Date,
    readonly sampleSize: number,
  ) {}
}

export class HistogramBucket {
  constructor(
    readonly owner: string,
    readonly tableName: string,
    readonly columnName: string,
    readonly endpointNumber: number,
    readonly endpointValue: string,
    readonly endpointActualValue: string,
  ) {}
}

export class IndexStatistics {
  constructor(
    readonly owner: string,
    readonly indexName: string,
    readonly tableName: string,
    readonly bLevel: number,
    readonly leafBlocks: number,
    readonly distinctKeys: number,
    readonly avgLeafBlocksPerKey: number,
    readonly avgDataBlocksPerKey: number,
    readonly clusterFactor: number,
    readonly numRows: number,
    readonly sampleSize: number,
    readonly lastAnalyzed: Date,
  ) {}
}

export class StatisticsManager {
  private tableStats = new Map<string, TableStatistics>();
  private columnStats = new Map<string, ColumnStatistics>();
  private histogramBuckets: HistogramBucket[] = [];
  private indexStats = new Map<string, IndexStatistics>();

  constructor(private readonly storage: OracleStorage) {}

  // ── DBMS_STATS surface ─────────────────────────────────────────

  /** Gather stats for one table. Walks the row set + columns to
   *  compute NUM_ROWS / NUM_DISTINCT / NUM_NULLS / AVG_COL_LEN. */
  gatherTableStats(ownerIn: string, tableIn: string, sampleRatio: number = 1.0): boolean {
    const owner = ownerIn.toUpperCase();
    const tableName = tableIn.toUpperCase();
    const meta = this.storage.getTableMeta(owner, tableName);
    if (!meta) return false;
    const rows = this.storage.getRows(owner, tableName);
    const now = new Date();
    const blocks = Math.max(1, Math.ceil(rows.length / 8));
    const avgRowLen = meta.columns.reduce((s, c) => s + (c.dataType.precision ?? 4), 0);
    this.tableStats.set(`${owner}.${tableName}`, new TableStatistics(
      owner, tableName, rows.length, blocks, Math.floor(blocks * 0.1), 0, 0,
      avgRowLen, Math.max(1, Math.floor(rows.length * sampleRatio)), now, false,
    ));

    // Per-column stats.
    for (let ci = 0; ci < meta.columns.length; ci++) {
      const c = meta.columns[ci];
      const values = rows.map(r => r[ci]);
      const non = values.filter(v => v !== null && v !== undefined);
      const distinct = new Set(non.map(v => String(v))).size;
      const numNulls = values.length - non.length;
      const sorted = [...non].map(v => String(v ?? '')).sort();
      const low = sorted[0] ?? '';
      const high = sorted[sorted.length - 1] ?? '';
      const avgColLen = non.length === 0 ? (c.dataType.precision ?? 4)
        : Math.max(1, Math.round(non.reduce((s, v) => s + String(v).length, 0) / non.length));
      this.columnStats.set(
        `${owner}.${tableName}.${c.name}`,
        new ColumnStatistics(
          owner, tableName, c.name.toUpperCase(),
          distinct, numNulls, distinct <= 254 ? distinct : 254,
          distinct === 0 ? 0 : 1 / distinct, avgColLen,
          low, high, distinct <= 254 ? 'FREQUENCY' : 'HEIGHT BALANCED',
          now, Math.max(1, Math.floor(values.length * sampleRatio)),
        ),
      );
      // Drop stale histogram buckets for this column, then re-fill.
      this.histogramBuckets = this.histogramBuckets.filter(b =>
        !(b.owner === owner && b.tableName === tableName && b.columnName === c.name.toUpperCase()));
      const sortedNum = sorted.slice(0, 254);
      sortedNum.forEach((v, i) => {
        this.histogramBuckets.push(new HistogramBucket(
          owner, tableName, c.name.toUpperCase(), i + 1, v, v,
        ));
      });
    }

    // Per-index stats.
    for (const idx of this.storage.getIndexes(owner)) {
      if (idx.tableName.toUpperCase() !== tableName) continue;
      const distinctKeys = Math.max(1, Math.ceil(rows.length / 2));
      const leafBlocks = Math.max(1, Math.ceil(rows.length / 100));
      this.indexStats.set(`${owner}.${idx.name}`, new IndexStatistics(
        owner, idx.name, tableName, 1, leafBlocks, distinctKeys, 1, 1,
        Math.max(1, Math.floor(rows.length * 0.8)), rows.length,
        Math.max(1, Math.floor(rows.length * sampleRatio)), now,
      ));
    }
    return true;
  }

  /** Gather stats for every table in a schema. */
  gatherSchemaStats(schema: string): number {
    const upper = schema.toUpperCase();
    let n = 0;
    for (const t of this.storage.getAllTables()) {
      if (t.schema.toUpperCase() !== upper) continue;
      if (this.gatherTableStats(t.schema, t.name)) n++;
    }
    return n;
  }

  /** DBMS_STATS.DELETE_TABLE_STATS — wipe stats for a table. */
  deleteTableStats(owner: string, tableName: string): void {
    const o = owner.toUpperCase(), t = tableName.toUpperCase();
    this.tableStats.delete(`${o}.${t}`);
    for (const k of [...this.columnStats.keys()]) {
      if (k.startsWith(`${o}.${t}.`)) this.columnStats.delete(k);
    }
    this.histogramBuckets = this.histogramBuckets.filter(b =>
      !(b.owner === o && b.tableName === t));
    for (const k of [...this.indexStats.keys()]) {
      const s = this.indexStats.get(k);
      if (s && s.owner === o && s.tableName === t) this.indexStats.delete(k);
    }
  }

  // ── Read APIs (consumed by views) ────────────────────────────────

  getTableStats(owner: string, table: string): TableStatistics | undefined {
    return this.tableStats.get(`${owner.toUpperCase()}.${table.toUpperCase()}`);
  }
  getAllTableStats(): TableStatistics[] { return [...this.tableStats.values()]; }
  getAllColumnStats(): ColumnStatistics[] { return [...this.columnStats.values()]; }
  getAllHistogramBuckets(): HistogramBucket[] { return this.histogramBuckets; }
  getAllIndexStats(): IndexStatistics[] { return [...this.indexStats.values()]; }
}
