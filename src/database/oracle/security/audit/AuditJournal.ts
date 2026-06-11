/**
 * AuditJournal — central event-driven repository for the security
 * subsystem. Implements `IAuditJournal`.
 *
 * Architecture:
 *  - Pure data structure: no event-bus subscriptions live here. The
 *    `SecurityAuditActor` owns the subscriptions and feeds the journal
 *    through the `record*` API.
 *  - Bounded FIFO caps mirror the OracleRuntimeState budget contract
 *    so a long-lived simulator stays inside a few MB of memory.
 *
 * The journal also holds the SoD policy registry and the sensitive
 * object registry, because those are read by the same DBA_* views that
 * read the recorded entries — keeping them all on one aggregate makes
 * snapshot consistency obvious.
 */

import type {
  IAuditJournal,
  IConnectionTrace,
  IDdlHistoryRecord,
  IDmlHistoryRecord,
  ISensitiveAccessRecord,
  ISodPolicy,
  ISodViolation,
  IDormantAccountRecord,
  ISecurityAnomalyRecord,
  IPrivilegeUsageRecord,
  SensitiveObjectRegistryView,
} from './interfaces';
import { SensitiveObjectRegistry } from './SensitiveObjectRegistry';
import { DEFAULT_SOD_POLICIES, SodPolicy } from './SodPolicy';
import { PrivilegeUsageRecord } from './PrivilegeUsageRecord';

export interface AuditJournalBudget {
  readonly connectionTraces: number;
  readonly ddlHistory: number;
  readonly dmlHistory: number;
  readonly sensitiveAccess: number;
  readonly sodViolations: number;
  readonly dormantAccounts: number;
  readonly anomalies: number;
  readonly privilegeUsage: number;
}

export const DEFAULT_AUDIT_JOURNAL_BUDGET: AuditJournalBudget = Object.freeze({
  connectionTraces: 2000,
  ddlHistory: 2000,
  dmlHistory: 5000,
  sensitiveAccess: 2000,
  sodViolations: 500,
  dormantAccounts: 500,
  anomalies: 1000,
  privilegeUsage: 5000,
});

function capArray<T>(arr: T[], max: number): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

export class AuditJournal implements IAuditJournal {
  private readonly _connectionTraces: IConnectionTrace[] = [];
  private readonly _ddl: IDdlHistoryRecord[] = [];
  private readonly _dml: IDmlHistoryRecord[] = [];
  private readonly _sensitiveAccess: ISensitiveAccessRecord[] = [];
  private readonly _sodViolations: ISodViolation[] = [];
  private readonly _dormant = new Map<string, IDormantAccountRecord>();
  private readonly _anomalies: ISecurityAnomalyRecord[] = [];
  private readonly _privilegeUsage = new Map<string, PrivilegeUsageRecord>();

  private readonly sensitiveRegistry = new SensitiveObjectRegistry(true);
  private readonly sodPolicies = new Map<string, SodPolicy>();

  /** Counters used to allocate stable ids. */
  private nextSod = 1;
  private nextAnomaly = 1;
  private nextAccess = 1;
  private nextTrace = 1;
  private scnCounter = 1_000_000;

  constructor(
    private readonly budget: AuditJournalBudget = DEFAULT_AUDIT_JOURNAL_BUDGET,
    /** Shared SCN source (the owning instance). When provided, audit
     *  records carry SCNs from the same stream as V$DATABASE.CURRENT_SCN
     *  instead of a journal-private counter. */
    private readonly scnSource?: () => number,
  ) {
    for (const p of DEFAULT_SOD_POLICIES) this.sodPolicies.set(p.name, p);
  }

  nextScn(): number { return this.scnSource ? this.scnSource() : ++this.scnCounter; }

  // ── Producers ─────────────────────────────────────────────────────

  recordConnection(trace: IConnectionTrace): void {
    this._connectionTraces.push(trace);
    capArray(this._connectionTraces, this.budget.connectionTraces);
  }

  recordDdl(rec: IDdlHistoryRecord): void {
    this._ddl.push(rec);
    capArray(this._ddl, this.budget.ddlHistory);
  }

  recordDml(rec: IDmlHistoryRecord): void {
    this._dml.push(rec);
    capArray(this._dml, this.budget.dmlHistory);
  }

  recordSensitiveAccess(rec: ISensitiveAccessRecord): void {
    this._sensitiveAccess.push(rec);
    capArray(this._sensitiveAccess, this.budget.sensitiveAccess);
  }

  recordSodViolation(v: ISodViolation): void {
    this._sodViolations.push(v);
    capArray(this._sodViolations, this.budget.sodViolations);
  }

  recordDormantAccount(rec: IDormantAccountRecord): void {
    this._dormant.set(rec.username, rec);
    if (this._dormant.size > this.budget.dormantAccounts) {
      const oldest = [...this._dormant.entries()]
        .sort((a, b) => a[1].detectedAt.getTime() - b[1].detectedAt.getTime())[0][0];
      this._dormant.delete(oldest);
    }
  }

  /** Clear a username from the dormant set (e.g. after a successful logon). */
  clearDormant(username: string): void {
    this._dormant.delete(username.toUpperCase());
  }

  recordAnomaly(rec: ISecurityAnomalyRecord): void {
    this._anomalies.push(rec);
    capArray(this._anomalies, this.budget.anomalies);
  }

  recordPrivilegeUsage(rec: {
    username: string; privilege: string; action: string;
    objectSchema: string | null; objectName: string | null;
  }): void {
    const candidate = new PrivilegeUsageRecord(rec);
    const existing = this._privilegeUsage.get(candidate.key());
    if (existing) {
      existing.touch();
      return;
    }
    this._privilegeUsage.set(candidate.key(), candidate);
    if (this._privilegeUsage.size > this.budget.privilegeUsage) {
      // Evict the least-recently-used entry.
      let lruKey: string | null = null;
      let lruAt = Infinity;
      for (const [k, v] of this._privilegeUsage) {
        if (v.lastUsedAt.getTime() < lruAt) {
          lruAt = v.lastUsedAt.getTime();
          lruKey = k;
        }
      }
      if (lruKey) this._privilegeUsage.delete(lruKey);
    }
  }

  // ── Id allocators (used by the actor) ──────────────────────────────

  allocateConnectionTraceId(): number { return this.nextTrace++; }
  allocateSensitiveAccessId(): number { return this.nextAccess++; }
  allocateSodViolationId(): number { return this.nextSod++; }
  allocateAnomalyId(): number { return this.nextAnomaly++; }

  // ── Read-only snapshots ────────────────────────────────────────────

  getConnectionTraces(): readonly IConnectionTrace[] { return this._connectionTraces; }
  getDdlHistory(): readonly IDdlHistoryRecord[] { return this._ddl; }
  getDmlHistory(): readonly IDmlHistoryRecord[] { return this._dml; }
  getSensitiveAccessRecords(): readonly ISensitiveAccessRecord[] { return this._sensitiveAccess; }
  getSodViolations(): readonly ISodViolation[] { return this._sodViolations; }
  getDormantAccounts(): readonly IDormantAccountRecord[] { return [...this._dormant.values()]; }
  getAnomalies(): readonly ISecurityAnomalyRecord[] { return this._anomalies; }
  getPrivilegeUsage(): readonly IPrivilegeUsageRecord[] { return [...this._privilegeUsage.values()]; }

  // ── Registries ─────────────────────────────────────────────────────

  getSensitiveObjectRegistry(): SensitiveObjectRegistry { return this.sensitiveRegistry; }
  /** Public, write-capable accessor (DBAs register sensitive objects). */
  registerSensitiveObject = (o: ConstructorParameters<typeof SensitiveObjectRegistry>[0] extends boolean
    ? Parameters<SensitiveObjectRegistry['register']>[0]
    : never) => this.sensitiveRegistry.register(o);

  getSodPolicies(): readonly ISodPolicy[] { return [...this.sodPolicies.values()]; }
  registerSodPolicy(p: SodPolicy): void { this.sodPolicies.set(p.name, p); }
  removeSodPolicy(name: string): boolean { return this.sodPolicies.delete(name.toUpperCase()); }

  // ── Helpers used by views ──────────────────────────────────────────

  /** Hand views a stable read-only view of the sensitive registry. */
  getSensitiveRegistryView(): SensitiveObjectRegistryView { return this.sensitiveRegistry; }

  /** Reset everything — invoked when the instance returns to SHUTDOWN. */
  reset(): void {
    this._connectionTraces.length = 0;
    this._ddl.length = 0;
    this._dml.length = 0;
    this._sensitiveAccess.length = 0;
    this._sodViolations.length = 0;
    this._dormant.clear();
    this._anomalies.length = 0;
    this._privilegeUsage.clear();
    this.nextSod = this.nextAnomaly = this.nextAccess = this.nextTrace = 1;
    this.scnCounter = 1_000_000;
  }
}
