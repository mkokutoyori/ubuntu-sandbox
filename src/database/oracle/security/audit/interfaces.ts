/**
 * Security-audit domain — interfaces.
 *
 * Each notion (connection trace, DDL/DML history, sensitive access,
 * SoD violation, dormant account, anomaly, privilege usage) is defined
 * as an interface here and *fully* implemented by a concrete class in
 * the sibling files. The classes hold every attribute a real Oracle
 * server would expose — even ones the simulator does not animate yet —
 * so monitoring scripts written against the real product keep working
 * when run here.
 */

import type { SecurityAnomalyKind } from '../../events';

// ── Common ─────────────────────────────────────────────────────────────

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ConnectionOutcome = 'SUCCESS' | 'FAILURE' | 'LOGOFF';
export type AccessAction = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'EXPORT';
export type SensitivityClass = 'PII' | 'PCI' | 'PHI' | 'FINANCIAL' | 'CREDENTIALS' | 'CUSTOM';

// ── Connection trace ────────────────────────────────────────────────

export interface IConnectionTrace {
  readonly traceId: number;
  readonly timestamp: Date;
  readonly username: string;
  readonly sessionId: number;
  readonly serial: number;
  readonly osUser: string;
  readonly userhost: string;
  readonly terminal: string;
  readonly program: string;
  readonly ipAddress: string;
  readonly networkProtocol: string;
  readonly authenticationMethod: string;
  readonly authenticationType: string;
  readonly role: 'NORMAL' | 'SYSDBA' | 'SYSOPER';
  readonly outcome: ConnectionOutcome;
  readonly returncode: number;
  readonly offHours: boolean;
}

// ── DDL / DML history ───────────────────────────────────────────────

export interface IDdlHistoryRecord {
  readonly scn: number;
  readonly timestamp: Date;
  readonly sessionId: number;
  readonly username: string;
  readonly schema: string;
  readonly kind: string;
  readonly objectType: string | null;
  readonly objectName: string;
  readonly sqlText: string | null;
  readonly success: boolean;
  readonly returncode: number;
}

export interface IDmlHistoryRecord {
  readonly scn: number;
  readonly timestamp: Date;
  readonly sessionId: number;
  readonly username: string;
  readonly schema: string;
  readonly table: string;
  readonly action: 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT';
  readonly rowsAffected: number;
  readonly sqlText: string | null;
  readonly txId: number | null;
}

// ── Sensitive access ────────────────────────────────────────────────

export interface ISensitiveObject {
  readonly schema: string;
  readonly object: string;
  readonly classification: SensitivityClass;
  /**
   * Columns considered sensitive on this object. Empty list means the
   * whole object is sensitive. Even if unused at access-time today, we
   * keep it because real Oracle Data Redaction policies need it.
   */
  readonly sensitiveColumns: string[];
  readonly description: string;
}

export interface ISensitiveAccessRecord {
  readonly accessId: number;
  readonly timestamp: Date;
  readonly sessionId: number;
  readonly username: string;
  readonly action: AccessAction;
  readonly objectSchema: string;
  readonly objectName: string;
  readonly classification: SensitivityClass;
  readonly rowsAffected: number;
  readonly sqlText: string | null;
  readonly offHours: boolean;
}

// ── Segregation of duties (SoD) ─────────────────────────────────────

export interface ISodPolicy {
  readonly name: string;
  readonly description: string;
  readonly severity: Severity;
  /** Privilege / role tokens that, when held together, breach the policy. */
  readonly conflictingPrivileges: string[];
  /** Optional callout enabled toggle. */
  readonly enabled: boolean;
}

export interface ISodViolation {
  readonly violationId: number;
  readonly timestamp: Date;
  readonly policyName: string;
  readonly username: string;
  readonly sessionId: number;
  readonly conflictingPrivileges: string[];
  readonly severity: Severity;
  readonly description: string;
}

// ── Dormant accounts ────────────────────────────────────────────────

export interface IDormantAccountRecord {
  readonly username: string;
  readonly accountStatus: string;
  readonly lastLoginAt: Date | null;
  readonly daysSinceLastLogin: number;
  readonly thresholdDays: number;
  readonly profile: string;
  readonly createdAt: Date;
  readonly detectedAt: Date;
}

// ── Security anomaly ────────────────────────────────────────────────

export interface ISecurityAnomalyRecord {
  readonly anomalyId: number;
  readonly timestamp: Date;
  readonly kind: SecurityAnomalyKind;
  readonly severity: Severity;
  readonly username: string;
  readonly sessionId: number;
  readonly description: string;
  readonly evidence: Record<string, string | number | boolean>;
}

// ── Privilege usage ─────────────────────────────────────────────────

export interface IPrivilegeUsageRecord {
  readonly username: string;
  readonly privilege: string;
  readonly action: string;
  readonly objectSchema: string | null;
  readonly objectName: string | null;
  readonly lastUsedAt: Date;
  readonly useCount: number;
}

// ── Audit-journal facade ────────────────────────────────────────────

export interface IAuditJournal {
  /** Allocate the next SCN (monotonic, journal-local). */
  nextScn(): number;

  // Producers
  recordConnection(trace: IConnectionTrace): void;
  recordDdl(rec: IDdlHistoryRecord): void;
  recordDml(rec: IDmlHistoryRecord): void;
  recordSensitiveAccess(rec: ISensitiveAccessRecord): void;
  recordSodViolation(v: ISodViolation): void;
  recordDormantAccount(rec: IDormantAccountRecord): void;
  recordAnomaly(rec: ISecurityAnomalyRecord): void;
  recordPrivilegeUsage(rec: Omit<IPrivilegeUsageRecord, 'useCount' | 'lastUsedAt'>): void;

  // Read-only snapshots (consumed by the DBA_* views)
  getConnectionTraces(): readonly IConnectionTrace[];
  getDdlHistory(): readonly IDdlHistoryRecord[];
  getDmlHistory(): readonly IDmlHistoryRecord[];
  getSensitiveAccessRecords(): readonly ISensitiveAccessRecord[];
  getSodViolations(): readonly ISodViolation[];
  getDormantAccounts(): readonly IDormantAccountRecord[];
  getAnomalies(): readonly ISecurityAnomalyRecord[];
  getPrivilegeUsage(): readonly IPrivilegeUsageRecord[];

  // Registries
  getSensitiveObjectRegistry(): SensitiveObjectRegistryView;
  getSodPolicies(): readonly ISodPolicy[];
}

/** Read-only projection of the sensitive-object registry. */
export interface SensitiveObjectRegistryView {
  list(): readonly ISensitiveObject[];
  lookup(schema: string, object: string): ISensitiveObject | undefined;
}
