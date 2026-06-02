/**
 * UserActivityTracker — per-user activity ledger reactively built from
 * the bus.
 *
 * Aggregates everything DBAs and auditors ask for when they query an
 * account: how many times has the user logged in, when did they last
 * connect/disconnect, how often have they changed their password,
 * have they ever been locked out, what's their total session time…
 *
 * Subscribes to:
 *   - `oracle.security.connection-traced` — every SUCCESS/FAILURE/LOGOFF
 *   - `oracle.user.activity` — CREATE/DROP/LOCK/UNLOCK/PASSWORD_*
 *
 * Also reconciles `ConnectionTrace.closeAt` on the matching SUCCESS
 * row when its LOGOFF event lands so the trace carries the full
 * `durationSeconds` in DBA_AUDIT_SESSION / UNIFIED_AUDIT_TRAIL.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { OracleConnectionTracedPayload, OracleUserActivityPayload, UserActivityKind } from '../../events';
import type { ConnectionTrace } from './ConnectionTrace';
import type { AuditJournal } from './AuditJournal';

export interface UserActivityStats {
  username: string;
  logonCount: number;
  failedLogonCount: number;
  passwordChangeCount: number;
  lockEvents: number;
  unlockEvents: number;
  firstLogonAt: Date | null;
  lastLogonAt: Date | null;
  lastLogoffAt: Date | null;
  totalSessionSeconds: number;
  /** Number of times the account has been dropped (could be > 0 after
   *  CREATE → DROP → CREATE cycles in the same instance). */
  dropEvents: number;
  /** Last password change instant. */
  lastPasswordChangeAt: Date | null;
}

export class UserActivityTracker {
  private readonly stats = new Map<string, UserActivityStats>();
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly journal: AuditJournal,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.subs.push(
      this.bus.subscribe('oracle.security.connection-traced', (e) => {
        if (e.payload.deviceId !== this.deviceId) return;
        this.onConnection(e.payload);
      }),
      this.bus.subscribe('oracle.user.activity', (e) => {
        if (e.payload.deviceId !== this.deviceId) return;
        this.onUserActivity(e.payload);
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  // ── Read API ───────────────────────────────────────────────────────

  getStats(username: string): UserActivityStats | undefined {
    return this.stats.get(username.toUpperCase());
  }

  getAllStats(): UserActivityStats[] { return [...this.stats.values()]; }

  // ── Reactive handlers ──────────────────────────────────────────────

  private onConnection(p: OracleConnectionTracedPayload): void {
    const u = p.username.toUpperCase();
    const stats = this.ensure(u);
    if (p.outcome === 'SUCCESS') {
      stats.logonCount++;
      if (!stats.firstLogonAt) stats.firstLogonAt = p.timestamp;
      stats.lastLogonAt = p.timestamp;
    } else if (p.outcome === 'FAILURE') {
      stats.failedLogonCount++;
    } else if (p.outcome === 'LOGOFF') {
      stats.lastLogoffAt = p.timestamp;
      // Find the open SUCCESS trace with the same sessionId and close it.
      const traces = this.journal.getConnectionTraces();
      for (let i = traces.length - 1; i >= 0; i--) {
        const t = traces[i] as ConnectionTrace;
        if (t.username === u && t.sessionId === p.sessionId
            && t.outcome === 'SUCCESS' && t.logoffAt === null) {
          t.closeAt(p.timestamp);
          stats.totalSessionSeconds += t.durationSeconds;
          break;
        }
      }
    }
  }

  private onUserActivity(p: OracleUserActivityPayload): void {
    const stats = this.ensure(p.username);
    switch (p.kind as UserActivityKind) {
      case 'CREATED':        break; // ensure() already created the row
      case 'DROPPED':        stats.dropEvents++; break;
      case 'LOCKED':         stats.lockEvents++; break;
      case 'UNLOCKED':       stats.unlockEvents++; break;
      case 'PASSWORD_CHANGED':
        stats.passwordChangeCount++;
        stats.lastPasswordChangeAt = p.timestamp;
        break;
    }
  }

  private ensure(username: string): UserActivityStats {
    const u = username.toUpperCase();
    let s = this.stats.get(u);
    if (!s) {
      s = {
        username: u, logonCount: 0, failedLogonCount: 0,
        passwordChangeCount: 0, lockEvents: 0, unlockEvents: 0,
        firstLogonAt: null, lastLogonAt: null, lastLogoffAt: null,
        totalSessionSeconds: 0, dropEvents: 0, lastPasswordChangeAt: null,
      };
      this.stats.set(u, s);
    }
    return s;
  }

  /** Reset (instance SHUTDOWN). */
  reset(): void { this.stats.clear(); }
}
