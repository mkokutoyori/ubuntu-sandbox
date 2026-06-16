/**
 * LoginTracker — Track login outcomes and enforce account lockout.
 *
 * Enforces FAILED_LOGIN_ATTEMPTS and PASSWORD_LOCK_TIME profile limits,
 * and records the last successful logon so INACTIVE_ACCOUNT_TIME (12c+)
 * can be enforced at connect time.
 *
 * Lock reasons are tracked explicitly because Oracle releases them
 * differently:
 *   - FAILED_LOGIN  → auto-unlocks after PASSWORD_LOCK_TIME days.
 *   - INACTIVITY    → stays locked until `ACCOUNT UNLOCK` (12c+).
 *   - DBA           → stays locked until `ACCOUNT UNLOCK`.
 */

import type { LoginAttemptRecord, AccountLockReason } from './types';

export type LockStatus = 'OPEN' | 'LOCKED_BY_FAILED_LOGINS' | 'LOCKED_BY_DBA';

export class LoginTracker {
  private attempts = new Map<string, LoginAttemptRecord>();

  private newRecord(): LoginAttemptRecord {
    return { failedCount: 0, lastFailedAt: null, lockedAt: null, lockReason: null, lastSuccessAt: null };
  }

  private record(key: string): LoginAttemptRecord {
    const existing = this.attempts.get(key);
    if (existing) return existing;
    const rec = this.newRecord();
    this.attempts.set(key, rec);
    return rec;
  }

  // ── Recording ─────────────────────────────────────────────────────

  recordFailure(username: string): void {
    const rec = this.record(username.toUpperCase());
    rec.failedCount++;
    rec.lastFailedAt = new Date();
  }

  recordSuccess(username: string): void {
    const rec = this.record(username.toUpperCase());
    rec.failedCount = 0;
    rec.lastFailedAt = null;
    rec.lockedAt = null;
    rec.lockReason = null;
    rec.lastSuccessAt = new Date();
  }

  // ── Lock management ───────────────────────────────────────────────

  /**
   * Lock the account. `reason` controls auto-unlock eligibility:
   * only FAILED_LOGIN locks are released by PASSWORD_LOCK_TIME.
   */
  lockAccount(username: string, reason: AccountLockReason = 'FAILED_LOGIN'): void {
    const rec = this.record(username.toUpperCase());
    rec.lockedAt = new Date();
    rec.lockReason = reason;
  }

  unlockAccount(username: string): void {
    const rec = this.attempts.get(username.toUpperCase());
    if (rec) {
      rec.failedCount = 0;
      rec.lockedAt = null;
      rec.lockReason = null;
      rec.lastFailedAt = null;
    }
  }

  // ── Queries ───────────────────────────────────────────────────────

  getRecord(username: string): LoginAttemptRecord | undefined {
    return this.attempts.get(username.toUpperCase());
  }

  getFailedCount(username: string): number {
    return this.attempts.get(username.toUpperCase())?.failedCount ?? 0;
  }

  /** Timestamp of the most recent successful logon, or null if never. */
  getLastSuccessfulLogin(username: string): Date | null {
    return this.attempts.get(username.toUpperCase())?.lastSuccessAt ?? null;
  }

  isLockedByFailedLogins(username: string): boolean {
    const rec = this.attempts.get(username.toUpperCase());
    return !!rec?.lockedAt && rec.lockReason === 'FAILED_LOGIN';
  }

  /**
   * Check if an auto-locked account should be auto-unlocked.
   * Only FAILED_LOGIN locks are eligible — DBA and INACTIVITY locks
   * require an explicit ACCOUNT UNLOCK, like the real database.
   * Returns true if lockTimeDays have elapsed since lockAt.
   */
  shouldAutoUnlock(username: string, lockTimeDays: number): boolean {
    if (lockTimeDays === Infinity) return false;
    const rec = this.attempts.get(username.toUpperCase());
    if (!rec?.lockedAt || rec.lockReason !== 'FAILED_LOGIN') return false;
    const lockMs = lockTimeDays * 24 * 60 * 60 * 1000;
    return Date.now() - rec.lockedAt.getTime() >= lockMs;
  }

  /**
   * Check if a new login attempt exceeds FAILED_LOGIN_ATTEMPTS.
   * Returns true when the account should be locked.
   */
  exceedsThreshold(username: string, maxAttempts: number): boolean {
    if (maxAttempts === Infinity) return false;
    return (this.attempts.get(username.toUpperCase())?.failedCount ?? 0) >= maxAttempts;
  }

  dropUser(username: string): void {
    this.attempts.delete(username.toUpperCase());
  }
}
