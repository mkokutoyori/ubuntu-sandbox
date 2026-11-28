import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { HostCapableDevice } from '@/network';

export interface OracleBrokerDmonCtx {
  resolveDevice(deviceId: string): Equipment | null;
  resolveDatabase(deviceId: string): OracleDatabase | null;
}

export type BrokerCommandRunner = (device: HostCapableDevice, database: OracleDatabase, command: string) => string;

let runner: BrokerCommandRunner | null = null;

export function registerBrokerCommandRunner(next: BrokerCommandRunner): void {
  runner = next;
}

export class OracleBrokerDmon {
  private subs: Unsubscribe[] = [];

  constructor(private readonly bus: IEventBus, private readonly ctx: OracleBrokerDmonCtx) {}

  start(): void {
    this.subs.push(
      this.bus.subscribe('oracle.dataguard.broker-command-requested', (e) => {
        const device = this.ctx.resolveDevice(e.payload.deviceId);
        const database = this.ctx.resolveDatabase(e.payload.deviceId);
        if (device === null || database === null || runner === null) {
          e.payload.accept('Error: the broker is not running on this machine');
          return;
        }
        e.payload.accept(runner(device as unknown as HostCapableDevice, database, e.payload.command));
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.subs) unsubscribe();
    this.subs = [];
  }
}
