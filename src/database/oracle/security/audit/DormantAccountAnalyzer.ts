/**
 * DormantAccountAnalyzer — sweeps the catalog and flags accounts that
 * haven't logged on for at least `policy.dormantThresholdDays`.
 *
 * Source of "last login" data:
 *   1. Live runtime sessions (sessions currently open => active).
 *   2. The audit trail's most recent successful LOGON for the user.
 *   3. Otherwise the account is considered to have never logged on,
 *      using `created` as the reference point.
 */

import type { OracleCatalog } from '../../OracleCatalog';
import type { SecurityEngine } from '../SecurityEngine';
import type { AuditJournal } from './AuditJournal';
import type { SecurityAuditActor } from './SecurityAuditActor';
import { DormantAccountRecord } from './DormantAccountRecord';
import { DEFAULT_SECURITY_POLICY, type SecurityPolicyConfig } from './SecurityPolicyConfig';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class DormantAccountAnalyzer {
  constructor(
    private readonly catalog: OracleCatalog,
    private readonly journal: AuditJournal,
    private readonly actor: SecurityAuditActor,
    private readonly engine: SecurityEngine | null = null,
    private readonly policy: SecurityPolicyConfig = DEFAULT_SECURITY_POLICY,
  ) {}

  /** Run a full sweep, returning the number of dormant accounts found. */
  sweep(now: Date = new Date()): number {
    let found = 0;
    for (const user of this.catalog.getAllUsers()) {
      const upper = user.username.toUpperCase();
      if (this.policy.dormantExempt.has(upper)) continue;
      const lastLoginAt = this.findLastLogin(upper);
      const ref = lastLoginAt ?? user.created;
      const days = Math.floor((now.getTime() - ref.getTime()) / MS_PER_DAY);
      if (days < this.policy.dormantThresholdDays) continue;

      const rec = new DormantAccountRecord({
        username: upper, accountStatus: user.accountStatus,
        lastLoginAt, daysSinceLastLogin: days,
        thresholdDays: this.policy.dormantThresholdDays,
        profile: user.profile, createdAt: user.created,
      });
      this.journal.recordDormantAccount(rec);
      this.actor.emitDormant({
        username: upper, lastLoginAt, daysSinceLastLogin: days,
        thresholdDays: this.policy.dormantThresholdDays,
        accountStatus: user.accountStatus,
      });

      // INACTIVE_ACCOUNT_TIME (12c+) — when the user's profile defines a
      // hard inactivity ceiling, lock the account exactly the way the
      // real DB would (status → EXPIRED & LOCKED).
      if (this.engine) {
        const inactiveLimit = this.engine.profiles.resolveInactiveAccountTimeDays(user.profile);
        if (days >= inactiveLimit && user.accountStatus !== 'LOCKED'
            && user.accountStatus !== 'EXPIRED & LOCKED') {
          this.catalog.lockUser(upper);
          this.engine.loginTracker.lockAccount(upper, 'INACTIVITY');
        }
      }
      found++;
    }
    return found;
  }

  /** Most recent successful LOGON timestamp from the AUD$ history. */
  private findLastLogin(username: string): Date | null {
    const trail = this.catalog.getAuditTrail();
    for (let i = trail.length - 1; i >= 0; i--) {
      const e = trail[i];
      if (e.actionName === 'LOGON' && e.returncode === 0 && e.username === username) {
        return e.timestamp;
      }
    }
    return null;
  }
}
