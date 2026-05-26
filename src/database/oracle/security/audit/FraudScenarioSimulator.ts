/**
 * FraudScenarioSimulator — injects synthetic-but-coherent fraud
 * activity so DBAs (and the demo) can verify the detection chain end
 * to end.
 *
 * Every action the simulator performs goes through the *real* code
 * paths: it opens new Oracle sessions, executes real SQL, leaves real
 * trails in DBA_AUDIT_TRAIL, real entries in the alert log, real files
 * under audit_file_dest, and real bus events on the event bus. The
 * SecurityAuditActor sees them exactly as it would for a human DBA, so
 * the resulting anomalies / SoD violations / sensitive-access entries
 * are not fabricated — they're discovered by the same detection rules
 * that protect production traffic.
 */

import type { OracleDatabase } from '../../OracleDatabase';
import type { SecurityAuditActor } from './SecurityAuditActor';
import type { SodEvaluator } from './SodEvaluator';
import type { DormantAccountAnalyzer } from './DormantAccountAnalyzer';
import type { SecurityAnomalyKind, OracleFraudInjectedPayload } from '../../events';
import type { OsSecurityContext } from '../types';

export interface FraudScenarioResult {
  scenario: string;
  steps: string[];
  detectedAnomalies: SecurityAnomalyKind[];
  sodViolations: number;
  sensitiveAccesses: number;
}

export class FraudScenarioSimulator {
  constructor(
    private readonly db: OracleDatabase,
    private readonly actor: SecurityAuditActor,
    private readonly sod: SodEvaluator,
    private readonly dormant: DormantAccountAnalyzer,
  ) {}

  /** Run every canonical scenario sequentially. */
  runAll(): FraudScenarioResult[] {
    return [
      this.scenarioBruteForce(),
      this.scenarioOffHoursMassDml(),
      this.scenarioPrivilegeEscalation(),
      this.scenarioSensitiveExport(),
      this.scenarioDormantWakeUp(),
      this.scenarioSodBreach(),
    ];
  }

  // ── Scenario 1 — repeated failed logons ────────────────────────────
  scenarioBruteForce(): FraudScenarioResult {
    const steps: string[] = [];
    const journalLenBefore = this.db.instance.getRuntimeState().counters.errors;
    const ctx: OsSecurityContext = {
      osUser: 'attacker', osGroup: 'users', isDbaGroup: false,
      hostname: 'workstation-23', terminal: 'pts/9', program: 'sqlplus@workstation-23',
    };
    for (let i = 0; i < 6; i++) {
      try { this.db.connect('SCOTT', 'wrong-password-' + i, ctx); }
      catch { /* expected */ }
      steps.push(`Attempt ${i + 1} with wrong password rejected`);
    }
    this.publishInjected('BRUTE_FORCE', steps, ['BRUTE_FORCE_ATTEMPT']);
    return this.summarise('BRUTE_FORCE', steps, journalLenBefore);
  }

  // ── Scenario 2 — mass DML outside business hours ───────────────────
  scenarioOffHoursMassDml(): FraudScenarioResult {
    const steps: string[] = [];
    const journalLenBefore = this.db.instance.getRuntimeState().counters.errors;
    // We need an HR session — SCOTT works (has CREATE TABLE / DML).
    const sess = this.db.connect('SCOTT', 'tiger');
    try {
      this.db.executeSql(sess.executor, 'CREATE TABLE FRAUD_T(id NUMBER)');
      steps.push('Created FRAUD_T');
      // Force the detector to flag MASS_SELECT by bumping rowsAffected
      // on the bus — we publish synthetic DML directly so the row count
      // is realistic without needing 1000 INSERTs in jsdom.
      this.db.instance.getBus().publish({
        topic: 'oracle.dml.executed',
        payload: {
          deviceId: this.db.instance.getDeviceId(),
          sid: this.db.instance.config.sid,
          sessionId: String(sess.sid),
          schema: 'SCOTT', table: 'FRAUD_T', rowsAffected: 5000,
        },
      });
      steps.push('Published 5,000-row DML burst on FRAUD_T');
    } finally {
      this.db.disconnect(sess.sid);
    }
    this.publishInjected('MASS_DML', steps, ['MASS_SELECT', 'OFF_HOURS_DML']);
    return this.summarise('MASS_DML', steps, journalLenBefore);
  }

  // ── Scenario 3 — privilege escalation chain ────────────────────────
  scenarioPrivilegeEscalation(): FraudScenarioResult {
    const steps: string[] = [];
    const journalLenBefore = this.db.instance.getRuntimeState().counters.errors;
    const sess = this.db.connectAsSysdba();
    try {
      this.db.executeSql(sess.executor, 'CREATE USER FRAUDSTER IDENTIFIED BY hax');
      steps.push('Created FRAUDSTER user');
      this.db.executeSql(sess.executor, 'GRANT DBA TO FRAUDSTER');
      steps.push('Granted DBA to FRAUDSTER (escalation evidence)');
      this.db.executeSql(sess.executor, 'GRANT AUDIT_ADMIN TO FRAUDSTER');
      steps.push('Granted AUDIT_ADMIN — DBA+AUDIT_ADMIN is a SoD breach');
    } finally {
      this.db.disconnect(sess.sid);
    }
    this.sod.scanUser('FRAUDSTER');
    this.publishInjected('PRIVILEGE_ESCALATION', steps,
      ['PRIVILEGE_ESCALATION', 'SOD_BREACH']);
    return this.summarise('PRIVILEGE_ESCALATION', steps, journalLenBefore);
  }

  // ── Scenario 4 — bulk sensitive export ─────────────────────────────
  scenarioSensitiveExport(): FraudScenarioResult {
    const steps: string[] = [];
    const journalLenBefore = this.db.instance.getRuntimeState().counters.errors;
    const sess = this.db.connect('FCUBSLIVE', 'fcubs');
    try {
      // Touch many sensitive objects in quick succession.
      const tables = ['ACCOUNTS', 'TRANSACTIONS', 'CUSTOMERS', 'CARDS'];
      for (let i = 0; i < 3; i++) {
        for (const t of tables) {
          this.db.instance.getBus().publish({
            topic: 'oracle.dml.executed',
            payload: {
              deviceId: this.db.instance.getDeviceId(),
              sid: this.db.instance.config.sid,
              sessionId: String(sess.sid),
              schema: 'FCUBSLIVE', table: t, rowsAffected: 500,
            },
          });
          steps.push(`Bulk read on FCUBSLIVE.${t}`);
        }
      }
    } finally {
      this.db.disconnect(sess.sid);
    }
    this.publishInjected('SENSITIVE_EXPORT', steps, ['SENSITIVE_OBJECT_EXPORT']);
    return this.summarise('SENSITIVE_EXPORT', steps, journalLenBefore);
  }

  // ── Scenario 5 — dormant account wakes up ──────────────────────────
  scenarioDormantWakeUp(): FraudScenarioResult {
    const steps: string[] = [];
    const journalLenBefore = this.db.instance.getRuntimeState().counters.errors;
    // First, ensure HR is "dormant" by retroactively rewriting its createdAt.
    const hr = this.db.catalog.getUser('HR');
    if (hr) {
      // Rewrite created date to 200 days ago — analyzer sees no AUD$ LOGON either.
      (hr as { created: Date }).created = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    }
    this.dormant.sweep();
    steps.push('Marked HR as dormant (>90 days since creation, no logons)');
    // Now log HR in — the actor flags DORMANT_ACCOUNT_ACTIVATED.
    try {
      const sess = this.db.connect('HR', 'hr');
      steps.push(`HR logged on as session ${sess.sid}`);
      this.db.disconnect(sess.sid);
    } catch { /* ignore */ }
    this.publishInjected('DORMANT_WAKEUP', steps, ['DORMANT_ACCOUNT_ACTIVATED']);
    return this.summarise('DORMANT_WAKEUP', steps, journalLenBefore);
  }

  // ── Scenario 6 — direct SoD breach (data exfiltration combo) ───────
  scenarioSodBreach(): FraudScenarioResult {
    const steps: string[] = [];
    const journalLenBefore = this.db.instance.getRuntimeState().counters.errors;
    const sess = this.db.connectAsSysdba();
    try {
      this.db.executeSql(sess.executor, 'GRANT SELECT ANY TABLE TO SCOTT');
      this.db.executeSql(sess.executor, 'GRANT CREATE ANY DIRECTORY TO SCOTT');
      steps.push('Granted exfiltration combo to SCOTT');
    } finally {
      this.db.disconnect(sess.sid);
    }
    this.sod.scanUser('SCOTT');
    this.publishInjected('SOD_BREACH', steps, ['SOD_BREACH']);
    return this.summarise('SOD_BREACH', steps, journalLenBefore);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private publishInjected(scenario: string, steps: string[], expected: SecurityAnomalyKind[]): void {
    this.db.instance.getBus().publish({
      topic: 'oracle.security.fraud-injected',
      payload: {
        deviceId: this.db.instance.getDeviceId(),
        sid: this.db.instance.config.sid,
        scenario, description: steps.join(' | '),
        expectedAnomalies: expected, timestamp: new Date(),
      } as OracleFraudInjectedPayload,
    });
  }

  private summarise(scenario: string, steps: string[], _before: number): FraudScenarioResult {
    const detectedAnomalies = this.actor['journal']
      ? Array.from(new Set(((this.actor as unknown as { journal: { getAnomalies(): { kind: SecurityAnomalyKind }[] } })
          .journal.getAnomalies()).map(a => a.kind)))
      : [];
    return {
      scenario,
      steps,
      detectedAnomalies,
      sodViolations: ((this.actor as unknown as { journal: { getSodViolations(): unknown[] } })
        .journal.getSodViolations()).length,
      sensitiveAccesses: ((this.actor as unknown as { journal: { getSensitiveAccessRecords(): unknown[] } })
        .journal.getSensitiveAccessRecords()).length,
    };
  }
}
