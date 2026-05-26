/**
 * SecurityAuditActor — central reactive consumer for security topics.
 *
 * Subscribes to the live `oracle.*` event stream and:
 *   1. Builds the AuditJournal (connection traces, DDL/DML history,
 *      sensitive access, privilege usage).
 *   2. Re-emits derived security events (`oracle.security.*`) so
 *      downstream subscribers (FilesystemSync, dashboards, the
 *      detector itself) can react.
 *   3. Runs the in-flight anomaly detector and SoD evaluator.
 *
 * The actor is the single subscriber to the bus — every entry point
 * (Executor, SQLPlusSession, OracleDatabase) just publishes; nobody
 * else touches the journal directly.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type {
  OracleConnectionTracedPayload,
  OracleSensitiveAccessPayload,
  OraclePrivilegeExercisedPayload,
  OracleSodViolationPayload,
  OracleSecurityAnomalyPayload,
  OracleDormantDetectedPayload,
  OracleDdlHistoryRecordedPayload,
  OracleDmlHistoryRecordedPayload,
  SecurityAnomalyKind,
} from '../../events';
import { AuditJournal } from './AuditJournal';
import { ConnectionTrace } from './ConnectionTrace';
import { DdlHistoryRecord } from './DdlHistoryRecord';
import { DmlHistoryRecord } from './DmlHistoryRecord';
import { SensitiveAccessRecord } from './SensitiveAccessRecord';
import { SodViolation } from './SodPolicy';
import { SecurityAnomalyRecord } from './SecurityAnomalyRecord';
import { DEFAULT_SECURITY_POLICY, isOffHours, type SecurityPolicyConfig } from './SecurityPolicyConfig';
import type { Severity } from './interfaces';

interface FailedLoginEntry {
  username: string;
  timestamps: number[]; // sliding window of failure ts
}

export class SecurityAuditActor {
  private subs: Unsubscribe[] = [];
  private readonly failedLogins = new Map<string, FailedLoginEntry>();
  /** Per-session tally of sensitive accesses (for mass-select detection). */
  private readonly sessionSensitiveAccessCount = new Map<number, number>();
  /** Per-session set of seen DDL kinds (privilege-escalation evidence). */
  private readonly sessionDdlActions = new Map<number, Set<string>>();

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly journal: AuditJournal,
    private readonly policy: SecurityPolicyConfig = DEFAULT_SECURITY_POLICY,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;

    const scoped = <P extends { deviceId: string }>(handler: (p: P) => void) =>
      (e: { payload: unknown }) => {
        const p = e.payload as P;
        if (p.deviceId !== this.deviceId) return;
        handler(p);
      };

    this.subs.push(
      // 1. Rich connection traces are the source of truth for DBA_CONNECTION_TRACES.
      this.bus.subscribe('oracle.security.connection-traced', scoped<OracleConnectionTracedPayload>((p) => {
        const trace = new ConnectionTrace({
          traceId: this.journal.allocateConnectionTraceId(),
          username: p.username, sessionId: p.sessionId, serial: p.serial,
          osUser: p.osUser, userhost: p.userhost, terminal: p.terminal, program: p.program,
          ipAddress: p.ipAddress, networkProtocol: p.networkProtocol,
          authenticationMethod: p.authenticationMethod,
          authenticationType: p.authenticationType,
          role: p.role, outcome: p.outcome, returncode: p.returncode,
          offHours: p.offHours, timestamp: p.timestamp,
        });
        this.journal.recordConnection(trace);
        // Every successful logon also "uses" the CREATE SESSION priv —
        // this is what DBA_USED_SYSPRIVS surfaces in production.
        if (trace.outcome === 'SUCCESS') {
          this.journal.recordPrivilegeUsage({
            username: trace.username, privilege: 'CREATE SESSION',
            action: 'LOGON', objectSchema: null, objectName: null,
          });
        }
        this.evaluateConnection(trace);
      })),

      // 2. DDL/DML executed → history + sensitive-access derivation.
      this.bus.subscribe('oracle.ddl.executed', scoped<{
        deviceId: string; sid: string; sessionId: string; schema: string; kind: string; name: string;
      }>((p) => {
        const scn = this.journal.nextScn();
        const sessionId = parseInt(p.sessionId, 10) || 0;
        const rec = new DdlHistoryRecord({
          scn, sessionId, username: p.schema, schema: p.schema,
          kind: p.kind, objectName: p.name,
        });
        this.journal.recordDdl(rec);
        this.bus.publish({
          topic: 'oracle.ddl.history-recorded',
          payload: {
            deviceId: this.deviceId, sid: p.sid, sessionId, username: p.schema,
            schema: p.schema, kind: p.kind, objectType: null, objectName: p.name,
            sqlText: null, scn, timestamp: rec.timestamp,
          } as OracleDdlHistoryRecordedPayload,
        });

        // Track per-session DDL surface for privilege escalation patterns.
        const set = this.sessionDdlActions.get(sessionId) ?? new Set<string>();
        set.add(p.kind.toUpperCase());
        this.sessionDdlActions.set(sessionId, set);

        // DDL on SYS-owned objects is always an anomaly.
        if (p.schema.toUpperCase() === 'SYS') {
          this.emitAnomaly({
            kind: 'DDL_ON_SYS_OBJECT', severity: 'HIGH',
            username: p.schema, sessionId,
            description: `DDL (${p.kind}) targeted SYS-owned object ${p.name}`,
            evidence: { kind: p.kind, object: p.name },
          });
        }

        // Privilege escalation: GRANT performed within a session that
        // also created users / roles is suspicious.
        if (p.kind === 'GRANT' && (set.has('CREATE USER') || set.has('CREATE ROLE'))) {
          this.emitAnomaly({
            kind: 'PRIVILEGE_ESCALATION', severity: 'CRITICAL',
            username: p.schema, sessionId,
            description: 'GRANT issued in same session as CREATE USER/ROLE',
            evidence: { ddlSeen: [...set].join(',') },
          });
        }
      })),

      this.bus.subscribe('oracle.dml.executed', scoped<{
        deviceId: string; sid: string; sessionId: string; schema: string; table: string; rowsAffected: number;
      }>((p) => {
        const scn = this.journal.nextScn();
        const sessionId = parseInt(p.sessionId, 10) || 0;
        // The bus event carries only "DML" not the verb. Use the cached
        // action set from prior audit.recorded; fallback to UPDATE.
        const action = this.lastDmlAction.get(sessionId) ?? 'UPDATE';
        const rec = new DmlHistoryRecord({
          scn, sessionId, username: p.schema, schema: p.schema, table: p.table,
          action, rowsAffected: p.rowsAffected,
        });
        this.journal.recordDml(rec);
        this.bus.publish({
          topic: 'oracle.dml.history-recorded',
          payload: {
            deviceId: this.deviceId, sid: p.sid, sessionId, username: p.schema,
            schema: p.schema, table: p.table, action, rowsAffected: p.rowsAffected,
            sqlText: null, scn, txId: null, timestamp: rec.timestamp,
          } as OracleDmlHistoryRecordedPayload,
        });

        // Mass-action anomaly.
        if (p.rowsAffected >= this.policy.massActionRowThreshold) {
          const kind: SecurityAnomalyKind =
            action === 'DELETE' ? 'MASS_DELETE'
            : action === 'SELECT' ? 'MASS_SELECT'
            : 'MASS_SELECT';
          this.emitAnomaly({
            kind, severity: 'HIGH', username: p.schema, sessionId,
            description: `${action} on ${p.schema}.${p.table} affected ${p.rowsAffected} rows (threshold ${this.policy.massActionRowThreshold})`,
            evidence: { rows: p.rowsAffected, table: `${p.schema}.${p.table}` },
          });
        }

        // Off-hours DML anomaly.
        if (action !== 'SELECT' && isOffHours(new Date(), this.policy.businessHours)) {
          this.emitAnomaly({
            kind: 'OFF_HOURS_DML', severity: 'MEDIUM',
            username: p.schema, sessionId,
            description: `${action} executed outside business hours`,
            evidence: { table: `${p.schema}.${p.table}`, rows: p.rowsAffected },
          });
        }

        // Sensitive object touched?
        const sens = this.journal.getSensitiveObjectRegistry().lookup(p.schema, p.table);
        if (sens) {
          const accessId = this.journal.allocateSensitiveAccessId();
          const offHours = isOffHours(new Date(), this.policy.businessHours);
          this.journal.recordSensitiveAccess(new SensitiveAccessRecord({
            accessId, sessionId, username: p.schema, action,
            objectSchema: sens.schema, objectName: sens.object,
            classification: sens.classification, rowsAffected: p.rowsAffected,
            sqlText: null, offHours, sensitiveColumns: sens.sensitiveColumns,
          }));
          this.bus.publish({
            topic: 'oracle.security.sensitive-access',
            payload: {
              deviceId: this.deviceId, sid: p.sid, sessionId,
              username: p.schema, action,
              objectSchema: sens.schema, objectName: sens.object,
              classification: sens.classification, rowsAffected: p.rowsAffected,
              sqlText: null, timestamp: new Date(), offHours,
            } as OracleSensitiveAccessPayload,
          });
          // Increment session counter for "mass select" pattern.
          const n = (this.sessionSensitiveAccessCount.get(sessionId) ?? 0) + 1;
          this.sessionSensitiveAccessCount.set(sessionId, n);
          if (n >= 10) {
            this.emitAnomaly({
              kind: 'SENSITIVE_OBJECT_EXPORT', severity: 'HIGH',
              username: p.schema, sessionId,
              description: `Session touched ${n} sensitive objects — possible exfiltration`,
              evidence: { count: n },
            });
          }
        }
      })),

      // 3. Audit-trail entries feed the DML action cache (so the DML event
      //    above can resolve INSERT/UPDATE/DELETE) and the privilege-use
      //    register (Catalog audits "SELECT", "INSERT", etc. by action).
      this.bus.subscribe('oracle.audit.recorded', scoped<{
        deviceId: string; sid: string; sessionId: number; username: string;
        actionName: string; objOwner: string | null; objName: string | null;
        returncode: number; timestamp: Date;
      }>((p) => {
        const verb = p.actionName.toUpperCase();
        if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'SELECT'].includes(verb)) {
          this.lastDmlAction.set(p.sessionId, verb as 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT');
        }
        // Privilege usage tracking — every audited action implies a privilege.
        this.journal.recordPrivilegeUsage({
          username: p.username, privilege: this.privilegeForAction(verb),
          action: verb, objectSchema: p.objOwner, objectName: p.objName,
        });
        this.bus.publish({
          topic: 'oracle.privilege.exercised',
          payload: {
            deviceId: this.deviceId, sid: p.sid, sessionId: p.sessionId,
            username: p.username, privilege: this.privilegeForAction(verb),
            action: verb, objectSchema: p.objOwner, objectName: p.objName,
            timestamp: p.timestamp,
          } as OraclePrivilegeExercisedPayload,
        });
      })),

      // 4. Errors feed the brute-force window.
      this.bus.subscribe('oracle.error.raised', scoped<{
        deviceId: string; sid: string; sessionId: string; code: number; message: string;
      }>((p) => {
        if (p.code === 1017 || p.code === 28000) {
          // No username in the payload — best effort: bucket by sessionId.
          this.recordFailedLogin(`session:${p.sessionId}`);
        }
      })),

      // 5. Instance shutdown drains everything.
      this.bus.subscribe('oracle.instance.state-changed', scoped<{
        deviceId: string; sid: string; newState: string;
      }>((p) => {
        if (p.newState === 'SHUTDOWN') {
          this.journal.reset();
          this.failedLogins.clear();
          this.sessionSensitiveAccessCount.clear();
          this.sessionDdlActions.clear();
          this.lastDmlAction.clear();
        }
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Map an audited verb to the privilege it exercises. */
  private privilegeForAction(action: string): string {
    const map: Record<string, string> = {
      SELECT: 'SELECT', INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE',
      'CREATE TABLE': 'CREATE TABLE', 'DROP TABLE': 'DROP TABLE',
      'ALTER TABLE': 'ALTER TABLE', 'CREATE USER': 'CREATE USER',
      'DROP USER': 'DROP USER', 'ALTER USER': 'ALTER USER',
      GRANT: 'GRANT ANY PRIVILEGE', REVOKE: 'GRANT ANY PRIVILEGE',
      LOGON: 'CREATE SESSION', LOGOFF: 'CREATE SESSION',
    };
    return map[action] ?? action;
  }

  /** Resolve the verb of the last DML executed on a session — fed by audit. */
  private readonly lastDmlAction = new Map<number, 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'SELECT'>();

  /** Slide failed-logon window for a username. */
  private recordFailedLogin(username: string): void {
    const u = username.toUpperCase();
    const now = Date.now();
    const cutoff = now - this.policy.bruteForceWindowMs;
    const rec = this.failedLogins.get(u) ?? { username: u, timestamps: [] };
    rec.timestamps = rec.timestamps.filter(t => t >= cutoff);
    rec.timestamps.push(now);
    this.failedLogins.set(u, rec);
    if (rec.timestamps.length >= this.policy.bruteForceThreshold) {
      this.emitAnomaly({
        kind: 'BRUTE_FORCE_ATTEMPT', severity: 'HIGH',
        username: u, sessionId: 0,
        description: `${rec.timestamps.length} failed logon attempts within ${Math.round(this.policy.bruteForceWindowMs / 1000)}s`,
        evidence: { failures: rec.timestamps.length },
      });
      rec.timestamps.length = 0;
    }
  }

  /** Run per-connection anomaly heuristics. */
  private evaluateConnection(trace: ConnectionTrace): void {
    if (trace.outcome === 'FAILURE') {
      this.recordFailedLogin(trace.username);
      return;
    }
    if (trace.outcome !== 'SUCCESS') return;

    if (trace.offHours) {
      this.emitAnomaly({
        kind: 'UNUSUAL_LOGIN_SOURCE', severity: 'LOW',
        username: trace.username, sessionId: trace.sessionId,
        description: `Successful logon outside business hours`,
        evidence: { osUser: trace.osUser, host: trace.userhost, terminal: trace.terminal },
      });
    }
    // Dormant account reactivation — fire if we previously detected this user as dormant.
    const dormantSet = this.journal.getDormantAccounts().find(d => d.username === trace.username);
    if (dormantSet) {
      this.emitAnomaly({
        kind: 'DORMANT_ACCOUNT_ACTIVATED', severity: 'HIGH',
        username: trace.username, sessionId: trace.sessionId,
        description: `Dormant account ${trace.username} (last login ${dormantSet.lastLoginAt?.toISOString() ?? 'never'}) just connected`,
        evidence: { daysSinceLastLogin: dormantSet.daysSinceLastLogin },
      });
      this.journal.clearDormant(trace.username);
    }
  }

  emitAnomaly(rec: {
    kind: SecurityAnomalyKind; severity: Severity; username: string;
    sessionId: number; description: string;
    evidence?: Record<string, string | number | boolean>;
  }): void {
    const anomaly = new SecurityAnomalyRecord({
      anomalyId: this.journal.allocateAnomalyId(),
      kind: rec.kind, severity: rec.severity,
      username: rec.username, sessionId: rec.sessionId,
      description: rec.description, evidence: rec.evidence ?? {},
    });
    this.journal.recordAnomaly(anomaly);
    this.bus.publish({
      topic: 'oracle.security.anomaly-detected',
      payload: {
        deviceId: this.deviceId, sid: '', sessionId: anomaly.sessionId,
        username: anomaly.username, kind: anomaly.kind, severity: anomaly.severity,
        description: anomaly.description, evidence: anomaly.evidence,
        timestamp: anomaly.timestamp,
      } as OracleSecurityAnomalyPayload,
    });
  }

  /** Public helper used by external SoD evaluator to publish + journal. */
  emitSodViolation(v: {
    policyName: string; username: string; sessionId: number;
    conflictingPrivileges: string[]; severity: Severity; description: string;
  }): void {
    const violation = new SodViolation({
      violationId: this.journal.allocateSodViolationId(),
      policyName: v.policyName, username: v.username, sessionId: v.sessionId,
      conflictingPrivileges: v.conflictingPrivileges, severity: v.severity,
      description: v.description,
    });
    this.journal.recordSodViolation(violation);
    this.bus.publish({
      topic: 'oracle.security.sod-violation',
      payload: {
        deviceId: this.deviceId, sid: '', sessionId: v.sessionId,
        username: v.username, policyName: v.policyName,
        conflictingPrivileges: v.conflictingPrivileges, severity: v.severity,
        description: v.description, timestamp: violation.timestamp,
      } as OracleSodViolationPayload,
    });
    this.emitAnomaly({
      kind: 'SOD_BREACH', severity: v.severity, username: v.username,
      sessionId: v.sessionId, description: `SoD policy ${v.policyName} breached`,
      evidence: { policy: v.policyName, privs: v.conflictingPrivileges.join(',') },
    });
  }

  emitDormant(rec: { username: string; lastLoginAt: Date | null;
    daysSinceLastLogin: number; thresholdDays: number; accountStatus: string;
  }): void {
    this.bus.publish({
      topic: 'oracle.security.dormant-detected',
      payload: {
        deviceId: this.deviceId, sid: '', username: rec.username,
        lastLoginAt: rec.lastLoginAt, daysSinceLastLogin: rec.daysSinceLastLogin,
        thresholdDays: rec.thresholdDays, accountStatus: rec.accountStatus,
        timestamp: new Date(),
      } as OracleDormantDetectedPayload,
    });
  }
}
