/**
 * PortActivityLogProjection — reactive consumer of the port-lifecycle event
 * stream.
 *
 * {@link ServicePortProjection} publishes `linux.port.bound` /
 * `linux.port.released` whenever a service opens or closes a listening
 * socket. This projection subscribes to that stream and records a
 * daemon-facility line in the system log — the way systemd-journald notes a
 * daemon starting to listen on, or relinquishing, a port.
 *
 * It keeps the producer (the socket-table coherence layer) decoupled from
 * the log: the port projection announces, this projection reacts.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { LinuxLogManager } from '../LinuxLogManager';
import type { PortBoundPayload, PortReleasedPayload } from '../events';

export class PortActivityLogProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly logManager: LinuxLogManager,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('linux.port.bound', (e) => this.onBound(e.payload)),
      bus.subscribe('linux.port.released', (e) => this.onReleased(e.payload)),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onBound(p: PortBoundPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon(
      p.serviceName ?? p.processName,
      `Listening on ${p.protocol.toUpperCase()} ${p.address}:${p.port}`,
    );
  }

  private onReleased(p: PortReleasedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon(
      p.serviceName ?? p.processName,
      `Closed ${p.protocol.toUpperCase()} listening socket ${p.address}:${p.port}`,
    );
  }
}
