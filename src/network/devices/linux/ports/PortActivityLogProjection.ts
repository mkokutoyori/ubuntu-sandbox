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
      bus.subscribe('tcp.segment.dropped', (e) => this.onTcpSegmentDropped(e.payload)),
      bus.subscribe('port.link.up', (e) => this.onLinkUp(e.payload)),
      bus.subscribe('port.link.down', (e) => this.onLinkDown(e.payload)),
      bus.subscribe('dhcp.lease.granted', (e) => this.onDhcpGranted(e.payload)),
      bus.subscribe('dhcp.lease.renewing', (e) => this.onDhcpRenewing(e.payload)),
      bus.subscribe('dhcp.lease.expired', (e) => this.onDhcpExpired(e.payload)),
      bus.subscribe('port.security.violation', (e) => this.onPortSecurityViolation(e.payload)),
      bus.subscribe('port.security.errdisable.set', (e) => this.onPortSecurityErrdisable(e.payload)),
      bus.subscribe('linux.process.spawned', (e) => this.onProcessSpawned(e.payload)),
      bus.subscribe('linux.process.exited', (e) => this.onProcessExited(e.payload)),
      bus.subscribe('arp.violation', (e) => this.onArpViolation(e.payload)),
      bus.subscribe('linux.service.failed', (e) => this.onServiceFailed(e.payload)),
      bus.subscribe('linux.service.enabled', (e) => this.onServiceEnabled(e.payload)),
      bus.subscribe('linux.service.disabled', (e) => this.onServiceDisabled(e.payload)),
      bus.subscribe('port.config.ip-changed', (e) => this.onIpChanged(e.payload)),
      bus.subscribe('port.config.mtu-changed', (e) => this.onMtuChanged(e.payload)),
    );
  }

  private onServiceFailed(p: { deviceId: string; name: string; reason?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logSystemd(p.name,
      `${p.name}.service: Failed with result '${p.reason ?? 'failure'}'.`);
  }

  private onServiceEnabled(p: { deviceId: string; name: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemctl',
      `Created symlink /etc/systemd/system/multi-user.target.wants/${p.name}.service.`);
  }

  private onServiceDisabled(p: { deviceId: string; name: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemctl',
      `Removed symlink /etc/systemd/system/multi-user.target.wants/${p.name}.service.`);
  }

  private onIpChanged(p: {
    deviceId: string; portName: string; ip?: string | null; mask?: string | null;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.ip) {
      this.logManager.logKernel('kernel',
        `${p.portName}: IPv4 address ${p.ip}/${p.mask ?? ''} assigned`);
    } else {
      this.logManager.logKernel('kernel',
        `${p.portName}: IPv4 address removed`);
    }
  }

  private onMtuChanged(p: { deviceId: string; portName: string; mtu?: number }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `${p.portName}: MTU changed to ${p.mtu ?? '?'}`);
  }

  private onPortSecurityViolation(p: {
    deviceId: string; portName: string; mac: string; mode: string; action: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `port-security: ${p.portName}: violation mac=${p.mac} mode=${p.mode} action=${p.action}`);
  }

  private onPortSecurityErrdisable(p: {
    deviceId: string; portName: string; mac: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `port-security: ${p.portName} placed in err-disabled state (offending mac ${p.mac})`);
  }

  private onProcessSpawned(p: {
    deviceId: string; pid: number; comm: string; ppid: number; user: string;
    command: string; serviceName?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.serviceName) return;
    if (p.user === 'root' && p.comm !== 'sudo') return;
    this.logManager.logDaemon(p.comm,
      `[${p.pid}] ${p.user}: ${p.command}`);
  }

  private onProcessExited(p: {
    deviceId: string; pid: number; comm: string; exitCode: number; signal?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.signal) {
      this.logManager.logDaemon('kernel',
        `${p.comm}[${p.pid}] terminated by signal ${p.signal}`);
    }
  }

  private onArpViolation(p: {
    deviceId: string; iface?: string; senderIp?: string; senderMac?: string;
    reason?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `arp-inspection: ${p.iface ?? '?'}: violation ${p.reason ?? 'invalid'} from ${p.senderMac ?? '?'}/${p.senderIp ?? '?'}`);
  }

  private onLinkUp(p: { deviceId: string; portName: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `${p.portName}: Link is Up - 1000 Mbps Full Duplex`);
  }

  private onLinkDown(p: { deviceId: string; portName: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `${p.portName}: Link is Down`);
  }

  private onDhcpGranted(p: {
    deviceId: string; iface?: string; ip?: string; leaseTimeSec?: number;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    const renewIn = p.leaseTimeSec ? Math.floor(p.leaseTimeSec / 2) : 0;
    this.logManager.logDaemon('dhclient',
      `bound to ${p.ip ?? '?'} -- renewal in ${renewIn} seconds.`);
  }

  private onDhcpRenewing(p: {
    deviceId: string; iface?: string; ip?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhclient',
      `DHCPREQUEST for ${p.ip ?? '?'} on ${p.iface ?? 'unknown'}`);
  }

  private onDhcpExpired(p: {
    deviceId: string; iface?: string; ip?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhclient',
      `lease ${p.ip ?? '?'} on ${p.iface ?? 'unknown'} expired`);
  }

  private onTcpSegmentDropped(p: {
    deviceId: string; sourceIp: string; destinationIp: string;
    sourcePort: number; destinationPort: number; reason: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel(
      'TCP',
      `${p.reason} SRC=${p.sourceIp} DST=${p.destinationIp} SPT=${p.sourcePort} DPT=${p.destinationPort}`,
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
