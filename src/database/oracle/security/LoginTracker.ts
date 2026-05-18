/**
 * LoginTracker — Track failed login attempts and enforce account lockout.
 *
 * Enforces FAILED_LOGIN_ATTEMPTS and PASSWORD_LOCK_TIME profile limits.
 * When failed attempts exceed the profile threshold:
 *   - Account status changes to LOCKED (recorded in catalog)
 *   - Auto-unlock after PASSWORD_LOCK_TIME days (if not UNLIMITED)
 */

import type { LoginAttemptRecord } from './types';

export type LockStatus = 'OPEN' | 'LOCKED_BY_FAILED_LOGINS' | 'LOCKED_BY_DBA';

export class LoginTracker {
  private attempts = new Map<string, LoginAttemptRecord>();

  // ── Recording ─────────────────────────────────────────────────────

  recordFailure(username: string): void {
    const key = username.toUpperCase();
    const rec = this.attempts.get(key) ?? { failedCount: 0, lastFailedAt: null, lockedAt: null };
    rec.failedCount++;
    rec.lastFailedAt = new Date();
    this.attempts.set(key, rec);
  }

  recordSuccess(username: string): void {
    const key = username.toUpperCase();
    const rec = this.attempts.get(key);
    if (rec) {
      rec.failedCount = 0;
      rec.lastFailedAt = null;
      rec.lockedAt = null;
    }
  }

  // ── Lock management ───────────────────────────────────────────────

  lockAccount(username: string): void {
    const key = username.toUpperCase();
    const rec = this.attempts.get(key) ?? { failedCount: 0, lastFailedAt: null, lockedAt: null };
    rec.lockedAt = new Date();
    this.attempts.set(key, rec);
  }

  unlockAccount(username: string): void {
    const key = username.toUpperCase();
    const rec = this.attempts.get(key);
    if (rec) {
      rec.failedCount = 0;
      rec.lockedAt = null;
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

  isLockedByFailedLogins(username: string): boolean {
    return this.attempts.get(username.toUpperCase())?.lockedAt !== null
      && this.attempts.get(username.toUpperCase())?.lockedAt !== undefined;
  }

  /**
   * Check if an auto-locked account should be auto-unlocked.
   * Returns true if lockTimeDays have elapsed since lockAt.
   */
  shouldAutoUnlock(username: string, lockTimeDays: number): boolean {
    if (lockTimeDays === Infinity) return false;
    const rec = this.attempts.get(username.toUpperCase());
    if (!rec?.lockedAt) return false;
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
