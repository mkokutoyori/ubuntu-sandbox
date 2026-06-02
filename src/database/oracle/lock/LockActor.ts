import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LockManager } from './LockManager';

export class LockActor {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly lockManager: LockManager,
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
      this.bus.subscribe('oracle.dml.executed', scoped<{
        deviceId: string; sessionId: string; schema: string; table: string;
      }>((p) => {
        if (!p.table) return;
        const sid = parseInt(p.sessionId, 10) || 0;
        this.lockManager.acquireDmlLock({
          sessionId: p.sessionId, sid, schema: p.schema, table: p.table, txId: sid,
        });
      })),

      this.bus.subscribe('oracle.transaction.committed', scoped<{
        deviceId: string; sessionId: string; txId: number;
      }>((p) => {
        this.lockManager.releaseSession(p.sessionId);
      })),

      this.bus.subscribe('oracle.transaction.rolled-back', scoped<{
        deviceId: string; sessionId: string; txId: number;
      }>((p) => {
        this.lockManager.releaseSession(p.sessionId);
      })),

      this.bus.subscribe('oracle.session.disconnected', scoped<{
        deviceId: string; sessionId: string;
      }>((p) => {
        this.lockManager.releaseSession(p.sessionId);
      })),

      this.bus.subscribe('oracle.instance.state-changed', scoped<{
        deviceId: string; newState: string;
      }>((p) => {
        if (p.newState === 'SHUTDOWN') this.lockManager.reset();
      })),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }
}
