/**
 * OracleSystemdSync — keeps `oracle-database-<SID>.service` and
 * `oracle-listener-<SID>.service` on the underlying Linux machine in
 * lockstep with the Oracle instance / listener state — in BOTH
 * directions, like a real host where dbstart/dbshut and the unit files
 * wrap the same engine:
 *
 *   Oracle → systemd (`oracle.instance.state-changed`,
 *   `oracle.listener.event`): STARTUP/SHUTDOWN and lsnrctl start/stop
 *   flip the corresponding unit active/inactive.
 *
 *   systemd → Oracle (`linux.service.started/stopped/restarted`):
 *   `systemctl start/stop oracle-…` actually drives the instance and
 *   listener state machines instead of only spawning a wrapper process.
 *
 * Convergence is guaranteed by idempotence on both sides: each handler
 * first checks the target state and no-ops when already there, and the
 * service manager emits no lifecycle event for no-op start/stop — so a
 * round trip always terminates after one cycle.
 *
 * Mirrors the design of `OracleFilesystemSync`. The adapter is
 * device-agnostic — it goes through a thin SystemdHost capability
 * interface, which the LinuxServer/LinuxMachine satisfies through a
 * new sync method (see LinuxMachine.installSystemdUnit).
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';

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
  /**
   * Listener identity: the sockets the unit opens while active and the
   * daemon process it leaves behind. The host's port projection uses it
   * to keep netstat/ss/ps coherent with the service state.
   */
  listener?: {
    processName: string;
    daemonCommand?: string;
    sockets: { port: number; protocol: 'tcp' | 'udp'; address?: string }[];
  };
}

export interface OracleSystemdSyncCtx {
  resolveDevice(deviceId: string): Equipment | null;
  /**
   * Resolve a deviceId to its OracleDatabase — required for the
   * systemd → Oracle direction. Optional so existing wirings that only
   * need the forward direction keep working unchanged.
   */
  resolveDatabase?(deviceId: string): OracleDatabase | null;
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
        // Only the terminal states drive the unit. NOMOUNT/MOUNT are
        // transient phases of one STARTUP/SHUTDOWN — flapping the unit
        // through inactive mid-startup would kill its own processes
        // (and, with the reverse direction below, shut the instance
        // back down).
        if (e.payload.newState === 'OPEN') {
          host.installSystemdUnit(databaseUnit(e.payload.sid), 'active');
        } else if (e.payload.newState === 'SHUTDOWN') {
          host.installSystemdUnit(databaseUnit(e.payload.sid), 'inactive');
        }
      }),

      this.bus.subscribe('oracle.listener.event', (e) => {
        const host = this.host(e.payload.deviceId);
        if (!host) return;
        const desired: 'active' | 'inactive' = e.payload.state === 'running' ? 'active' : 'inactive';
        host.installSystemdUnit(listenerUnit(e.payload.sid), desired);
      }),

      // systemd → Oracle: systemctl start/stop genuinely runs the engine.
      this.bus.subscribe('linux.service.started', (e) =>
        this.onServiceLifecycle(e.payload.deviceId, e.payload.name, 'started')),
      this.bus.subscribe('linux.service.restarted', (e) =>
        this.onServiceLifecycle(e.payload.deviceId, e.payload.name, 'started')),
      this.bus.subscribe('linux.service.stopped', (e) =>
        this.onServiceLifecycle(e.payload.deviceId, e.payload.name, 'stopped')),
    );
  }

  /**
   * Drive the Oracle engine from a service lifecycle transition. Every
   * branch is guarded by the engine's current state, so events that the
   * forward direction itself produced converge as no-ops.
   */
  private onServiceLifecycle(deviceId: string, unitName: string, kind: 'started' | 'stopped'): void {
    const db = this.ctx.resolveDatabase?.(deviceId);
    if (!db) return;
    const sid = db.instance.config.sid;

    if (unitName === `oracle-listener-${sid}`) {
      const listener = db.instance.listener;
      if (kind === 'started' && !listener.running) db.instance.startListener();
      else if (kind === 'stopped' && listener.running) db.instance.stopListener();
      return;
    }

    if (unitName === `oracle-database-${sid}`) {
      if (kind === 'started' && db.instance.state === 'SHUTDOWN') {
        db.instance.startup();
      } else if (kind === 'stopped' && db.instance.state !== 'SHUTDOWN') {
        // dbshut performs an immediate shutdown — same here.
        db.instance.shutdown('IMMEDIATE');
      }
    }
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
    // lsnrctl is only the launcher; the daemon that stays behind and
    // owns TCP 1521 is tnslsnr — that's what ps and netstat -p show.
    listener: {
      processName: 'tnslsnr',
      daemonCommand: '/u01/app/oracle/product/19c/dbhome_1/bin/tnslsnr LISTENER -inherit',
      sockets: [{ port: 1521, protocol: 'tcp' }],
    },
  };
}
