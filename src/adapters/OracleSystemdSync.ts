/**
 * OracleSystemdSync — keeps `oracle-database-<SID>.service` and
 * `oracle-listener-<SID>.service` on the underlying Linux machine in
 * lockstep with the Oracle instance / listener state.
 *
 * Acts as a pure bus subscriber:
 *   - `oracle.instance.state-changed` drives the database service
 *   - `oracle.listener.event`         drives the listener service
 *
 * Mirrors the design of `OracleFilesystemSync`. The adapter is
 * device-agnostic — it goes through a thin SystemdHost capability
 * interface, which the LinuxServer/LinuxMachine satisfies through a
 * new sync method (see LinuxMachine.installSystemdUnit).
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';

/** Minimal capability surface this adapter needs from the device. */
export interface SystemdHost {
  /**
   * Idempotently install the given systemd unit and mark its
   * post-boot state ('active' or 'inactive'). Implementations should
   * write a unit file to /etc/systemd/system, daemon-reload, and
   * start/stop the service.
   */
  installSystemdUnit(spec: SystemdUnitSpec, desired: 'active' | 'inactive'): void;
}

export interface SystemdUnitSpec {
  /** Unit name without the .service suffix. */
  name: string;
  description: string;
  /** Path-like exec command. */
  execStart: string;
  /** Optional exec for graceful stop. */
  execStop?: string;
  /** Run-as user. */
  user?: string;
  /** Ordering hint — comma-separated dependency unit names (no .service). */
  after?: string[];
}

export interface OracleSystemdSyncCtx {
  resolveDevice(deviceId: string): Equipment | null;
}

export class OracleSystemdSync {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleSystemdSyncCtx,
  ) {}

  start(): void {
    if (this.subs.length > 0) return;
    this.subs.push(
      this.bus.subscribe('oracle.instance.state-changed', (e) => {
        const host = this.host(e.payload.deviceId);
        if (!host) return;
        const desired: 'active' | 'inactive' = e.payload.newState === 'OPEN' ? 'active' : 'inactive';
        host.installSystemdUnit(databaseUnit(e.payload.sid), desired);
      }),

      this.bus.subscribe('oracle.listener.event', (e) => {
        const host = this.host(e.payload.deviceId);
        if (!host) return;
        const desired: 'active' | 'inactive' = e.payload.state === 'running' ? 'active' : 'inactive';
        host.installSystemdUnit(listenerUnit(e.payload.sid), desired);
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs.length = 0;
  }

  private host(deviceId: string): SystemdHost | null {
    const dev = this.ctx.resolveDevice(deviceId) as unknown as Partial<SystemdHost> | null;
    return dev && typeof dev.installSystemdUnit === 'function' ? (dev as SystemdHost) : null;
  }
}

function databaseUnit(sid: string): SystemdUnitSpec {
  return {
    name: `oracle-database-${sid}`,
    description: `Oracle Database (SID=${sid})`,
    execStart: '/u01/app/oracle/product/19c/dbhome_1/bin/dbstart',
    execStop:  '/u01/app/oracle/product/19c/dbhome_1/bin/dbshut',
    user: 'oracle',
    after: ['oracle-listener-' + sid, 'network-online.target'],
  };
}

function listenerUnit(sid: string): SystemdUnitSpec {
  return {
    name: `oracle-listener-${sid}`,
    description: `Oracle TNS Listener (SID=${sid})`,
    execStart: '/u01/app/oracle/product/19c/dbhome_1/bin/lsnrctl start',
    execStop:  '/u01/app/oracle/product/19c/dbhome_1/bin/lsnrctl stop',
    user: 'oracle',
  };
}
