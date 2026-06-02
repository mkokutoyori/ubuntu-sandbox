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
      bus.subscribe('tcp.listener.changed', (e) => this.onTcpListenerChanged(e.payload)),
      bus.subscribe('tcp.connection.opened', (e) => this.onTcpConnectionOpened(e.payload)),
      bus.subscribe('tcp.connection.closed', (e) => this.onTcpConnectionClosed(e.payload)),
    );
  }

  private onTcpListenerChanged(p: {
    deviceId: string; localIp: string; localPort: number; added: boolean;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    const tag = this.tagForPort(p.localPort);
    this.logManager.logDaemon(
      tag,
      p.added
        ? `Server listening on ${p.localIp} port ${p.localPort}.`
        : `Closed TCP listening socket ${p.localIp}:${p.localPort}`,
    );
  }

  private onTcpConnectionOpened(p: {
    deviceId: string; remoteIp: string; remotePort: number;
    localIp: string; localPort: number; passive: boolean;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (!p.passive) return;
    const tag = this.tagForPort(p.localPort);
    this.logManager.logDaemon(
      tag,
      `Accepted connection from ${p.remoteIp}:${p.remotePort} on ${p.localIp}:${p.localPort}`,
    );
  }

  private onTcpConnectionClosed(p: {
    deviceId: string; remoteIp: string; remotePort: number;
    localIp: string; localPort: number; reason: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    const tag = this.tagForPort(p.localPort);
    this.logManager.logDaemon(
      tag,
      `Connection from ${p.remoteIp}:${p.remotePort} closed (${p.reason})`,
    );
  }

  private tagForPort(port: number): string {
    if (port === 22) return 'sshd';
    if (port === 80 || port === 443) return 'httpd';
    if (port === 25) return 'smtp';
    if (port === 21) return 'ftpd';
    return `tcp-${port}`;
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
