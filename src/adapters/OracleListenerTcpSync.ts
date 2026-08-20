import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleListenerNetworkBinding } from '@/database/oracle/listener/OracleListenerNetworkBinding';

export interface OracleListenerTcpSyncCtx {
  resolveDevice(deviceId: string): Equipment | null;
  resolveDatabase(deviceId: string): OracleDatabase | null;
}

interface TcpCapableEquipment {
  getTcpStack?: () => unknown;
}

type BindingHost = ConstructorParameters<typeof OracleListenerNetworkBinding>[0]['host'];

export class OracleListenerTcpSync {
  private subs: Unsubscribe[] = [];
  private bindings: Map<string, OracleListenerNetworkBinding> = new Map();

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleListenerTcpSyncCtx,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.subs.push(
      this.bus.subscribe('oracle.listener.event', (e) => {
        const { deviceId, state } = e.payload;
        if (state === 'running') this.attach(deviceId);
        else this.detach(deviceId);
      }),
    );
  }

  stop(): void {
    for (const unsub of this.subs) unsub();
    this.subs = [];
    for (const binding of this.bindings.values()) {
      try { binding.detach(); } catch { /* already detached */ }
    }
    this.bindings.clear();
  }

  /** Bind the listener that just booted before `resolveDatabase` was wired up. */
  primeListener(deviceId: string): void {
    this.attach(deviceId);
  }

  private attach(deviceId: string): void {
    this.detach(deviceId);
    const dev = this.ctx.resolveDevice(deviceId) as unknown as TcpCapableEquipment | null;
    const db = this.ctx.resolveDatabase(deviceId);
    if (!dev || typeof dev.getTcpStack !== 'function' || !db) return;
    const host: BindingHost = { getTcpStack: () => dev.getTcpStack!() } as BindingHost;
    const binding = new OracleListenerNetworkBinding({ host, listener: db.instance.listener });
    try {
      binding.attach();
      this.bindings.set(deviceId, binding);
    } catch { /* the listener flipped state again before we attached */ }
  }

  private detach(deviceId: string): void {
    const binding = this.bindings.get(deviceId);
    if (!binding) return;
    try { binding.detach(); } catch { /* idempotent */ }
    this.bindings.delete(deviceId);
  }
}
