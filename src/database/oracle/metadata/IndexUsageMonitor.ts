/**
 * IndexUsageMonitor — implements the `ALTER INDEX … MONITORING USAGE`
 * machinery used by Oracle since 9i. Feeds the native
 * `V$OBJECT_USAGE` (and its 12c rename `DBA_OBJECT_USAGE`) views.
 *
 * Real Oracle observes each query's execution plan: any plan that
 * uses the index updates the "USED" flag to YES and re-stamps
 * END_MONITORING. The simulator does not yet build full plans, so
 * the monitor takes the next-best signal: every `oracle.dml.executed`
 * event targeting the index's owning table flips USED on for every
 * actively-monitored index of that table.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { OracleStorage } from '../OracleStorage';

export interface IndexUsageRecord {
  owner: string;
  indexName: string;
  tableName: string;
  monitoring: boolean;
  used: boolean;
  startMonitoring: Date | null;
  endMonitoring: Date | null;
}

export class IndexUsageMonitor {
  /** Key `"owner.index"` → record. */
  private records = new Map<string, IndexUsageRecord>();
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly storage: OracleStorage,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.subs.push(this.bus.subscribe('oracle.dml.executed', (e) => {
      if (e.payload.deviceId !== this.deviceId) return;
      this.onDml(e.payload.schema, e.payload.table);
    }));
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  /** ALTER INDEX … MONITORING USAGE. */
  beginMonitoring(owner: string, indexName: string): void {
    const o = owner.toUpperCase(), i = indexName.toUpperCase();
    const indexes = this.storage.getIndexes(o);
    const idx = indexes.find(x => x.name.toUpperCase() === i);
    if (!idx) return;
    this.records.set(`${o}.${i}`, {
      owner: o, indexName: i, tableName: idx.tableName.toUpperCase(),
      monitoring: true, used: false,
      startMonitoring: new Date(), endMonitoring: null,
    });
  }

  /** ALTER INDEX … NOMONITORING USAGE. */
  endMonitoringFor(owner: string, indexName: string): void {
    const o = owner.toUpperCase(), i = indexName.toUpperCase();
    const rec = this.records.get(`${o}.${i}`);
    if (!rec) return;
    rec.monitoring = false;
    rec.endMonitoring = new Date();
  }

  private onDml(schema: string, table: string): void {
    const t = table.toUpperCase();
    const s = schema.toUpperCase();
    for (const r of this.records.values()) {
      if (r.monitoring && r.owner === s && r.tableName === t) r.used = true;
    }
  }

  /**
   * Scan an ExecutionPlan and flip USED on for every monitored index
   * whose name appears as an INDEX-prefixed operation's object. This
   * mirrors real Oracle's behavior: an index is only marked USED when
   * a query plan actually accesses it (not on every DML).
   */
  notePlanUsage(nodes: ReadonlyArray<{ operation: string; objectName: string | null }>): void {
    if (this.records.size === 0) return;
    for (const node of nodes) {
      if (!node.operation.startsWith('INDEX')) continue;
      if (!node.objectName) continue;
      const target = node.objectName.toUpperCase();
      for (const r of this.records.values()) {
        if (r.monitoring && r.indexName === target) r.used = true;
      }
    }
  }

  /** Snapshot for view rendering. */
  getRecords(): IndexUsageRecord[] { return [...this.records.values()]; }
}
