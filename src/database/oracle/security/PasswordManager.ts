/**
 * PasswordManager — Password lifecycle, history and expiry enforcement.
 *
 * Enforces:
 *   - PASSWORD_LIFE_TIME: expire after n days
 *   - PASSWORD_GRACE_TIME: warn after expiry, allow login during grace
 *   - PASSWORD_REUSE_TIME: cannot reuse a password within n days
 *   - PASSWORD_REUSE_MAX: cannot reuse until changed n times
 *   - PASSWORD EXPIRE: force change on next login
 */

import type { PasswordHistoryRecord } from './types';

export type PasswordStatus = 'OPEN' | 'EXPIRED' | 'EXPIRED(GRACE)';

export class PasswordManager {
  /** username (upper) → password history (newest first) */
  private history = new Map<string, PasswordHistoryRecord[]>();
  /** username (upper) → current change timestamp */
  private lastChanged = new Map<string, Date>();
  /** username (upper) → manually expired flag */
  private forceExpired = new Set<string>();

  // ── Setting passwords ─────────────────────────────────────────────

  setPassword(username: string, newPassword: string): void {
    const key = username.toUpperCase();
    const existing = this.history.get(key) ?? [];
    existing.unshift({ password: newPassword, changedAt: new Date() });
    this.history.set(key, existing);
    this.lastChanged.set(key, new Date());
    this.forceExpired.delete(key);
  }

  expirePassword(username: string): void {
    this.forceExpired.add(username.toUpperCase());
  }

  clearExpired(username: string): void {
    this.forceExpired.delete(username.toUpperCase());
  }

  // ── Status queries ────────────────────────────────────────────────

  isForceExpired(username: string): boolean {
    return this.forceExpired.has(username.toUpperCase());
  }

  /**
   * Compute password status based on lifetime and grace time.
   * Returns null if no password set yet.
   */
  getPasswordStatus(
    username: string,
    lifetimeDays: number,
    graceDays: number
  ): PasswordStatus {
    const key = username.toUpperCase();

    if (this.forceExpired.has(key)) return 'EXPIRED';

    const changed = this.lastChanged.get(key);
    if (!changed) return 'OPEN'; // no password → not expired

    if (lifetimeDays === Infinity) return 'OPEN';

    const ageMs = Date.now() - changed.getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);

    if (ageDays > lifetimeDays + graceDays) return 'EXPIRED';
    if (ageDays > lifetimeDays) return 'EXPIRED(GRACE)';
    return 'OPEN';
  }

  /** Compute the expiry date given lifetime. Returns null if UNLIMITED. */
  computeExpiryDate(username: string, lifetimeDays: number): Date | null {
    if (lifetimeDays === Infinity) return null;
    const changed = this.lastChanged.get(username.toUpperCase());
    if (!changed) return null;
    return new Date(changed.getTime() + lifetimeDays * 24 * 60 * 60 * 1000);
  }

  // ── Reuse checks ──────────────────────────────────────────────────

  /**
   * Check if the candidate password violates PASSWORD_REUSE_TIME.
   * Returns true when reuse is blocked.
   */
  violatesReuseTime(username: string, candidate: string, reuseTimeDays: number): boolean {
    if (reuseTimeDays === Infinity) return false;
    const key = username.toUpperCase();
    const records = this.history.get(key) ?? [];
    const cutoff = Date.now() - reuseTimeDays * 24 * 60 * 60 * 1000;
    return records.some(
      r => r.password === candidate && r.changedAt.getTime() > cutoff
    );
  }

  /**
   * Check if the candidate password violates PASSWORD_REUSE_MAX.
   * Returns true when reuse is blocked.
   */
  violatesReuseMax(username: string, candidate: string, reuseMax: number): boolean {
    if (reuseMax === Infinity) return false;
    const key = username.toUpperCase();
    const records = this.history.get(key) ?? [];
    // If there are fewer than reuseMax entries in history, always block reuse
    // of the current password (which is records[0] if any).
    if (records.length === 0) return false;
    const tail = records.slice(0, reuseMax);
    return tail.some(r => r.password === candidate);
  }

  getHistory(username: string): PasswordHistoryRecord[] {
    return this.history.get(username.toUpperCase()) ?? [];
  }

  dropUser(username: string): void {
    const key = username.toUpperCase();
    this.history.delete(key);
    this.lastChanged.delete(key);
    this.forceExpired.delete(key);
  }
}
