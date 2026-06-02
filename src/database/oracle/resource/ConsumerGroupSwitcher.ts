/**
 * ConsumerGroupSwitcher — applies ResourceManager mappings + switch
 * rules to live sessions in response to bus traffic.
 *
 * Behaviours:
 *   • On `oracle.security.connection-traced` outcome=SUCCESS, look
 *     up the consumer group for the new session via the active plan
 *     and stamp it on the SessionLimitTracker row.
 *   • On `oracle.sql.executed`, if the cumulative execution time of
 *     the session's current group exceeds the directive's
 *     `switch_time`, move the session to `switch_group` (mirrors
 *     real Oracle's CPU-quantum switching).
 *   • Publishes `oracle.resource.consumer-group-switched` so audit
 *     trails and views can react.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SecurityEngine } from '../security/SecurityEngine';
import type { ResourceManager } from './ResourceManager';

export class ConsumerGroupSwitcher {
  private subs: Unsubscribe[] = [];
  /** Cumulative execution time per session id, in seconds. */
  private execSeconds = new Map<number, number>();

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly engine: SecurityEngine,
    private readonly rm: ResourceManager,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;

    this.subs.push(
      this.bus.subscribe('oracle.security.connection-traced', (e) => {
        if (e.payload.deviceId !== this.deviceId) return;
        if (e.payload.outcome !== 'SUCCESS') return;
        this.assignInitialGroup(e.payload.sessionId);
      }),

      this.bus.subscribe('oracle.sql.executed', (e) => {
        if (e.payload.deviceId !== this.deviceId) return;
        const sid = parseInt(e.payload.sessionId, 10) || 0;
        const elapsed = e.payload.elapsedMicros / 1_000_000;
        const total = (this.execSeconds.get(sid) ?? 0) + elapsed;
        this.execSeconds.set(sid, total);
        this.evaluateSwitch(sid, total);
      }),

      // Reset on shutdown.
      this.bus.subscribe('oracle.instance.state-changed', (e) => {
        if (e.payload.deviceId !== this.deviceId) return;
        if (e.payload.newState === 'SHUTDOWN') this.execSeconds.clear();
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private assignInitialGroup(sid: number): void {
    const s = this.engine.sessions.getSessionBySid(sid);
    if (!s) return;
    const group = this.rm.resolveConsumerGroup({
      username: s.username, service: s.service, osUser: s.osUser,
      program: s.program, machine: s.machine,
      module: s.module, action: s.action, clientIdentifier: null,
    });
    if (group !== s.resourceConsumerGroup) this.applySwitch(sid, group, 'INITIAL');
  }

  private evaluateSwitch(sid: number, totalSeconds: number): void {
    const s = this.engine.sessions.getSessionBySid(sid);
    if (!s) return;
    const target = this.rm.resolveSwitchTarget(s.resourceConsumerGroup, totalSeconds);
    if (target && target !== s.resourceConsumerGroup) {
      this.applySwitch(sid, target, 'TIME_QUANTUM');
    }
  }

  private applySwitch(sid: number, newGroup: string, reason: 'INITIAL' | 'TIME_QUANTUM'): void {
    const s = this.engine.sessions.getSessionBySid(sid);
    if (!s) return;
    const oldGroup = s.resourceConsumerGroup;
    (s as { resourceConsumerGroup: string }).resourceConsumerGroup = newGroup;
    this.bus.publish({
      topic: 'oracle.resource.consumer-group-switched',
      payload: {
        deviceId: this.deviceId, sid: '', sessionId: sid,
        username: s.username, oldGroup, newGroup, reason,
        timestamp: new Date(),
      },
    });
  }
}
