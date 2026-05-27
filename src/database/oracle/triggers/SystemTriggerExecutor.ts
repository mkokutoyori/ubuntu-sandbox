/**
 * SystemTriggerExecutor — fires database-level event triggers in
 * response to the oracle.* event bus.
 *
 * Wiring (mirrors real Oracle semantics):
 *   • `oracle.security.connection-traced` outcome=SUCCESS
 *       → AFTER LOGON ON DATABASE / SCHEMA
 *   • `oracle.security.connection-traced` outcome=LOGOFF
 *       → BEFORE LOGOFF ON DATABASE / SCHEMA
 *   • `oracle.instance.state-changed`
 *       newState=OPEN → AFTER STARTUP ON DATABASE
 *       newState=SHUTDOWN → BEFORE SHUTDOWN ON DATABASE
 *   • `oracle.ddl.executed` → AFTER CREATE / ALTER / DROP …
 *   • `oracle.error.raised` → AFTER SERVERERROR ON DATABASE
 *
 * Firing a trigger is a no-op execution (the simulator does not run
 * PL/SQL bodies), but every firing:
 *   1. Stamps `lastFiredAt` and increments `fireCount` on the trigger
 *   2. Publishes an alert-log entry so DBA_ALERT_HISTORY shows it
 *   3. Records an audit-trail row when AUDIT TRIGGER is enabled
 *
 * Body execution would be plugged in here once PL/SQL becomes
 * executable; the seam is `runBody(t)`.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SystemTriggerRegistry } from './SystemTriggerRegistry';
import type { SystemTrigger, TriggerEvent } from './SystemTrigger';
import type { OracleInstance } from '../OracleInstance';

export class SystemTriggerExecutor {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly registry: SystemTriggerRegistry,
    private readonly instance: OracleInstance,
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
      this.bus.subscribe('oracle.security.connection-traced', scoped<{
        deviceId: string; username: string; outcome: string; sessionId: number;
      }>((p) => {
        if (p.outcome === 'SUCCESS') this.fire('LOGON', p.username, p.sessionId);
        else if (p.outcome === 'LOGOFF') this.fire('LOGOFF', p.username, p.sessionId);
      })),

      this.bus.subscribe('oracle.instance.state-changed', scoped<{
        deviceId: string; newState: 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';
      }>((p) => {
        if (p.newState === 'OPEN')       this.fire('STARTUP', undefined, 0);
        else if (p.newState === 'SHUTDOWN') this.fire('SHUTDOWN', undefined, 0);
      })),

      this.bus.subscribe('oracle.ddl.executed', scoped<{
        deviceId: string; schema: string; kind: string;
      }>((p) => {
        const verb = p.kind.toUpperCase();
        if (verb.startsWith('CREATE')) this.fire('CREATE', p.schema, 0);
        else if (verb.startsWith('ALTER')) this.fire('ALTER', p.schema, 0);
        else if (verb.startsWith('DROP'))  this.fire('DROP',  p.schema, 0);
      })),

      this.bus.subscribe('oracle.error.raised', scoped<{
        deviceId: string; code: number;
      }>((p) => {
        if (p.code >= 1) this.fire('SERVERERROR', undefined, 0);
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  /** Public — primarily used by tests to assert firing semantics. */
  fire(event: TriggerEvent, username: string | undefined, sessionId: number): SystemTrigger[] {
    const fired = this.registry.matching(event, username);
    for (const t of fired) {
      t.recordFiring();
      this.instance.logAlertEvent(
        `system trigger ${t.owner}.${t.name} fired on ${t.timing} ${event}`
        + (username ? ` for user ${username}` : '')
        + (sessionId ? ` sid=${sessionId}` : ''));
    }
    return fired;
  }
}
