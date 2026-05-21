/**
 * HostLifecycle — the power & boot state machine of a host.
 *
 * A real machine is never simply "on" or "off": it moves through a defined
 * set of power states — `off → booting → running`, `running → halting → off`,
 * `running ↔ suspended`, `running → rebooting → running`. This class is the
 * faithful State-pattern model of that lifecycle, and the single source of
 * truth for the host's boot time and therefore its uptime.
 *
 * Transitions are guarded (an invalid request is a no-op) and every accepted
 * transition is published on the event bus as `host.lifecycle.transitioned`,
 * so consumers — telemetry, a power panel, the boot-banner logic — observe
 * the same stream.
 *
 * Simulated hosts come into existence already `running`; the intermediate
 * `booting` / `halting` / `rebooting` states are still traversed (and
 * emitted) so the event trace mirrors real equipment.
 */

import type { IEventBus } from '@/events/EventBus';
import type { HostPowerState } from '../events';

export type { HostPowerState };

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

export class HostLifecycle {
  private state: HostPowerState = 'running';
  /** Wall-clock of the current boot, or null while powered off. */
  private bootedAtMs: number | null;
  private lastTransitionMs: number;
  private bootCount: number;

  /** Reactive sink — null until the owning device attaches its bus. */
  private bus: IEventBus | null = null;
  private deviceId = '';
  private hostname: string | undefined;

  constructor(now: number = Date.now()) {
    // A simulated host is instantiated already powered on and running.
    this.bootedAtMs = now;
    this.lastTransitionMs = now;
    this.bootCount = 1;
  }

  /** Attach the owning device's event bus so transitions become observable. */
  attachBus(bus: IEventBus, deviceId: string, hostname?: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
    this.hostname = hostname;
  }

  // ─── State queries ─────────────────────────────────────────────────────

  getState(): HostPowerState {
    return this.state;
  }

  /** True for any state other than `off`. */
  isPoweredOn(): boolean {
    return this.state !== 'off';
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  isSuspended(): boolean {
    return this.state === 'suspended';
  }

  /** True while passing through a transient state (`booting`/`halting`/`rebooting`). */
  isTransitioning(): boolean {
    return this.state === 'booting' || this.state === 'halting' || this.state === 'rebooting';
  }

  /** Number of completed boots over this host's life. */
  get bootCountValue(): number {
    return this.bootCount;
  }

  /** Wall-clock of the last boot, or null while powered off. */
  bootedAt(): Date | null {
    return this.bootedAtMs === null ? null : new Date(this.bootedAtMs);
  }

  /** Uptime in whole seconds — zero while powered off. */
  uptimeSeconds(now: number = Date.now()): number {
    if (this.bootedAtMs === null || this.state === 'off') return 0;
    return Math.max(0, Math.floor((now - this.bootedAtMs) / MS_PER_SECOND));
  }

  /** Uptime in whole minutes. */
  uptimeMinutes(now: number = Date.now()): number {
    return Math.floor(this.uptimeSeconds(now) / SECONDS_PER_MINUTE);
  }

  // ─── Transitions ───────────────────────────────────────────────────────

  /** Power the host on: `off → booting → running`. No-op when already on. */
  powerOn(now: number = Date.now()): void {
    if (this.state !== 'off') return;
    this.transition('booting', now);
    this.bootedAtMs = now;
    this.bootCount += 1;
    this.transition('running', now);
  }

  /** Hard power-off: any state → `off`. No-op when already off. */
  powerOff(now: number = Date.now()): void {
    if (this.state === 'off') return;
    this.transition('off', now);
    this.bootedAtMs = null;
  }

  /** Graceful shutdown: `running → halting → off`. No-op when already off. */
  shutdown(now: number = Date.now()): void {
    if (this.state === 'off') return;
    this.transition('halting', now);
    this.transition('off', now);
    this.bootedAtMs = null;
  }

  /** Reboot: `→ rebooting → running`, resetting the boot clock. */
  reboot(now: number = Date.now()): void {
    if (this.state === 'off') {
      this.powerOn(now);
      return;
    }
    this.transition('rebooting', now);
    this.bootedAtMs = now;
    this.bootCount += 1;
    this.transition('running', now);
  }

  /** Suspend to RAM: `running → suspended`. */
  suspend(now: number = Date.now()): void {
    if (this.state !== 'running') return;
    this.transition('suspended', now);
  }

  /** Resume from suspend: `suspended → running`. */
  resume(now: number = Date.now()): void {
    if (this.state !== 'suspended') return;
    this.transition('running', now);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private transition(to: HostPowerState, now: number): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.lastTransitionMs = now;
    this.bus?.publish({
      topic: 'host.lifecycle.transitioned',
      payload: {
        deviceId: this.deviceId,
        hostname: this.hostname,
        from,
        to,
        bootCount: this.bootCount,
        uptimeSeconds: this.uptimeSeconds(now),
      },
    });
  }
}
