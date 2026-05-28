/**
 * IdleSessionMonitor — enforces `IDLE_TIME` from each user's profile.
 *
 * Real Oracle marks an idle session as SNIPED in V$SESSION once PMON's
 * sweep finds `last_call_et > IDLE_TIME * 60` seconds (IDLE_TIME is
 * specified in minutes). The simulator follows the same rule.
 *
 * The monitor is *driven*, not timer-based: a call to `sweep(now)`
 * scans the active session set and snipes whichever sessions have
 * been idle too long. Triggering the sweep is the caller's
 * responsibility — typically PMON's own pulse, the dormant analyzer,
 * or a SQL*Plus `SECDEMO` directive.
 *
 * Every snipe publishes `oracle.session.idle-sniped` so:
 *  • SecurityAuditActor records a security anomaly
 *  • UserActivityTracker accounts for the session close
 *  • DBA_OUTSTANDING_ALERTS / DBA_ALERT_HISTORY surface the event
 */

import type { IEventBus } from '@/events/EventBus';
import type { SecurityEngine } from '../SecurityEngine';
import type { OracleCatalog } from '../../OracleCatalog';

export class IdleSessionMonitor {
  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly sid: string,
    private readonly engine: SecurityEngine,
    private readonly catalog: OracleCatalog,
  ) {}

  /**
   * Walk every active session, comparing `lastCallEt` against the
   * IDLE_TIME profile limit, and snipe + close anyone over budget.
   * Returns the list of sniped session ids.
   */
  sweep(now: Date = new Date()): number[] {
    const sniped: number[] = [];
    for (const s of this.engine.sessions.getAllSessions()) {
      const user = this.catalog.getUser(s.username);
      if (!user) continue;
      const idleMin = this.engine.profiles.resolveIdleTimeMinutes(user.profile);
      if (!isFinite(idleMin)) continue;       // UNLIMITED — nothing to do
      const thresholdSec = idleMin * 60;
      if (s.lastCallEt < thresholdSec) continue;

      // Mark as SNIPED in the tracker so V$SESSION shows it.
      (s as unknown as { status: string }).status = 'SNIPED';
      this.engine.sessions.unregisterSession(s.sessionId);
      this.bus.publish({
        topic: 'oracle.session.idle-sniped',
        payload: {
          deviceId: this.deviceId, sid: this.sid,
          sessionId: s.sid, username: s.username,
          idleSeconds: s.lastCallEt, thresholdSeconds: thresholdSec,
          timestamp: now,
        },
      });
      sniped.push(s.sid);
    }
    return sniped;
  }

  /**
   * Hand-set the `lastCallEt` of one session — used by tests and by
   * fraud scenarios to fast-forward idleness without sleeping the
   * jest clock.
   */
  bumpIdle(sessionId: string, idleSeconds: number): void {
    const s = this.engine.sessions.getSession(sessionId);
    if (s) (s as unknown as { lastCallEt: number }).lastCallEt = idleSeconds;
  }
}
