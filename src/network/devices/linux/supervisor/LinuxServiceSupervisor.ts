/**
 * LinuxServiceSupervisor — reactive consumer of process events.
 *
 * systemd does not poll; it *reacts* to its children dying. This
 * supervisor subscribes to `linux.process.exited` and, when the dead
 * process was the main pid of a still-active unit, applies the unit's
 * Restart= policy:
 *
 *   always | on-failure | on-abnormal  → restart the unit
 *   no | on-success                    → mark the unit failed
 *
 * Intentional `systemctl stop` / `restart` move the unit out of the
 * `active` state *before* the kill, so the supervisor ignores those
 * exits and never fights the operator (no restart loop).
 *
 * It is a pure consumer: it never touches the process table directly,
 * only the service API, and it is fully decoupled from whoever emits
 * the events (Dependency Inversion + Observer).
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxServiceManager, RestartPolicy } from '../LinuxServiceManager';

const RESTART_POLICIES: ReadonlySet<RestartPolicy> = new Set<RestartPolicy>([
  'always', 'on-failure', 'on-abnormal',
]);

export class LinuxServiceSupervisor {
  private readonly off: Unsubscribe;

  constructor(
    bus: IEventBus,
    private readonly services: LinuxServiceManager,
    private readonly deviceId: string,
  ) {
    this.off = bus.subscribe('linux.process.exited', (event) => {
      const { deviceId, pid, signal } = event.payload;
      if (deviceId !== this.deviceId) return;
      this.onMainProcessExit(pid, signal);
    });
  }

  /** Detach from the bus (called on device reset / teardown). */
  dispose(): void {
    this.off();
  }

  private onMainProcessExit(pid: number, signal?: string): void {
    const unit = this.services.findByMainPid(pid);
    // Not a daemon's main pid, or the operator already moved the unit
    // out of `active` (stop/restart in flight) → nothing to supervise.
    if (!unit || unit.state !== 'active') return;

    if (RESTART_POLICIES.has(unit.restart)) {
      this.services.restart(unit.name);
    } else {
      this.services.markFailed(
        unit.name,
        `main process exited${signal ? `, killed by ${signal}` : ''}`,
      );
    }
  }
}
