/**
 * QuotaManager — Tablespace quota tracking per user.
 *
 * Oracle tablespace quotas:
 *   - UNLIMITED ON tablespace: user may use any amount
 *   - n M/G/K ON tablespace: user is limited to n bytes
 *   - 0 (no quota): user cannot create segments in that tablespace
 *
 * DBA_TS_QUOTAS / USER_TS_QUOTAS views are backed by this manager.
 */

import type { QuotaRecord } from './types';

export class QuotaManager {
  /** key = `username:tablespace` (upper) */
  private quotas = new Map<string, QuotaRecord>();

  // ── Public API ───────────────────────────────────────────────────

  /** Grant quota on a tablespace. size = 'UNLIMITED' | '100M' | '2G' | '0'. */
  grantQuota(username: string, tablespace: string, size: string): void {
    const key = this.key(username, tablespace);
    const maxBytes = this.parseSize(size);
    const existing = this.quotas.get(key);
    this.quotas.set(key, {
      username: username.toUpperCase(),
      tablespace: tablespace.toUpperCase(),
      bytesUsed: existing?.bytesUsed ?? 0,
      maxBytes,
    });
  }

  /** Revoke quota on a tablespace (sets maxBytes to 0, keeps used). */
  revokeQuota(username: string, tablespace: string): void {
    const key = this.key(username, tablespace);
    const existing = this.quotas.get(key);
    if (existing) {
      existing.maxBytes = 0;
    } else {
      this.quotas.set(key, {
        username: username.toUpperCase(),
        tablespace: tablespace.toUpperCase(),
        bytesUsed: 0,
        maxBytes: 0,
      });
    }
  }

  /** Drop all quotas for a user (called when DROP USER). */
  dropUserQuotas(username: string): void {
    const upper = username.toUpperCase();
    for (const [k, v] of this.quotas) {
      if (v.username === upper) this.quotas.delete(k);
    }
  }

  /** Record bytes used when a segment is created. */
  addBytesUsed(username: string, tablespace: string, bytes: number): void {
    const key = this.key(username, tablespace);
    const rec = this.quotas.get(key);
    if (rec) rec.bytesUsed += bytes;
  }

  /**
   * Check if user has quota available on tablespace.
   * Admins with UNLIMITED TABLESPACE privilege bypass quota.
   */
  hasQuota(username: string, tablespace: string, hasUnlimitedPriv: boolean): boolean {
    if (hasUnlimitedPriv) return true;
    const key = this.key(username, tablespace);
    const rec = this.quotas.get(key);
    if (!rec) return false; // no quota granted
    if (rec.maxBytes === -1) return true; // UNLIMITED
    return rec.bytesUsed < rec.maxBytes;
  }

  getQuota(username: string, tablespace: string): QuotaRecord | undefined {
    return this.quotas.get(this.key(username, tablespace));
  }

  /** Return all quota rows for DBA_TS_QUOTAS. */
  getAllQuotas(): QuotaRecord[] {
    return Array.from(this.quotas.values());
  }

  /** Return quotas for a specific user (USER_TS_QUOTAS). */
  getUserQuotas(username: string): QuotaRecord[] {
    const upper = username.toUpperCase();
    return Array.from(this.quotas.values()).filter(q => q.username === upper);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private key(username: string, tablespace: string): string {
    return `${username.toUpperCase()}:${tablespace.toUpperCase()}`;
  }

  /** Convert size string to bytes. Returns -1 for UNLIMITED, 0 for '0'. */
  parseSize(size: string): number {
    const upper = size.toUpperCase().trim();
    if (upper === 'UNLIMITED') return -1;
    if (upper === '0' || upper === '') return 0;
    const match = upper.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)$/);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    switch (match[2]) {
      case 'K': return Math.round(num * 1024);
      case 'M': return Math.round(num * 1024 * 1024);
      case 'G': return Math.round(num * 1024 * 1024 * 1024);
      case 'T': return Math.round(num * 1024 * 1024 * 1024 * 1024);
      default: return Math.round(num);
    }
  }

  /** Format bytes for display in DBA_TS_QUOTAS.MAX_BYTES. */
  formatBytes(bytes: number): number {
    return bytes; // raw bytes in the view
  }
}
