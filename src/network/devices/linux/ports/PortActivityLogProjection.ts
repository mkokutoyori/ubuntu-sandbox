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
      bus.subscribe('host.arp.ip-conflict', (e) => this.onArpIpConflict(e.payload)),
      bus.subscribe('linux.service.failed', (e) => this.onServiceFailed(e.payload)),
      bus.subscribe('linux.service.enabled', (e) => this.onServiceEnabled(e.payload)),
      bus.subscribe('linux.service.disabled', (e) => this.onServiceDisabled(e.payload)),
      bus.subscribe('port.config.ip-changed', (e) => this.onIpChanged(e.payload)),
      bus.subscribe('port.config.mtu-changed', (e) => this.onMtuChanged(e.payload)),
      bus.subscribe('ntp.synced', (e) => this.onNtpSynced(e.payload)),
      bus.subscribe('ntp.unsynced', (e) => this.onNtpUnsynced(e.payload)),
      bus.subscribe('ipsec.ike.sa-installed', (e) => this.onIpsecIkeUp(e.payload)),
      bus.subscribe('ipsec.ike.sa-deleted', (e) => this.onIpsecIkeDown(e.payload)),
      bus.subscribe('ipsec.dpd.peer-down', (e) => this.onIpsecDpdDown(e.payload)),
      bus.subscribe('dhcp.pool.lease-allocated', (e) => this.onDhcpdAllocated(e.payload)),
      bus.subscribe('dhcp.pool.lease-released', (e) => this.onDhcpdReleased(e.payload)),
      bus.subscribe('dhcp.address-conflict', (e) => this.onDhcpConflict(e.payload)),
      bus.subscribe('dhcp.nak.received', (e) => this.onDhcpNak(e.payload)),
      bus.subscribe('port.config.ipv6-added', (e) => this.onIpv6Added(e.payload)),
      bus.subscribe('port.config.ipv6-removed', (e) => this.onIpv6Removed(e.payload)),
      bus.subscribe('cable.disconnected', (e) => this.onCableDisconnected(e.payload)),
      bus.subscribe('cable.connected', (e) => this.onCableConnected(e.payload)),
      bus.subscribe('dhcp.client.state-changed', (e) => this.onDhcpClientState(e.payload)),
      bus.subscribe('host.icmp.echo-failed', (e) => this.onIcmpEchoFailed(e.payload)),
      bus.subscribe('host.lifecycle.transitioned', (e) => this.onLifecycleChanged(e.payload)),
      bus.subscribe('host.identity.changed', (e) => this.onHostnameChanged(e.payload)),
      bus.subscribe('linux.service.masked', (e) => this.onServiceMasked(e.payload)),
      bus.subscribe('linux.service.unmasked', (e) => this.onServiceUnmasked(e.payload)),
      bus.subscribe('linux.process.signalled', (e) => this.onProcessSignalled(e.payload)),
      bus.subscribe('linux.process.reaped', (e) => this.onProcessReaped(e.payload)),
    );
  }

  private onServiceMasked(p: { deviceId: string; name: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemctl',
      `Created symlink /etc/systemd/system/${p.name}.service → /dev/null.`);
  }

  private onServiceUnmasked(p: { deviceId: string; name: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemctl',
      `Removed /etc/systemd/system/${p.name}.service.`);
  }

  private onProcessSignalled(p: {
    deviceId: string; pid: number; comm: string; signal: string; sender?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `${p.comm}[${p.pid}] received signal ${p.signal} from ${p.sender ?? 'unknown'}`);
  }

  private onProcessReaped(p: {
    deviceId: string; pid: number; comm: string; exitCode: number;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (p.exitCode === 0) return;
    this.logManager.logDaemon('systemd',
      `${p.comm}[${p.pid}] exited with code ${p.exitCode}`);
  }

  private onIcmpEchoFailed(p: { deviceId: string; target?: string; reason?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `ICMP echo to ${p.target ?? '?'} failed (${p.reason ?? 'no response'})`);
  }

  private onLifecycleChanged(p: {
    deviceId: string; oldState?: string; newState?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logSystemd('systemd',
      `Reached lifecycle state ${p.newState ?? '?'} (was ${p.oldState ?? '?'}).`);
  }

  private onHostnameChanged(p: {
    deviceId: string; oldHostname?: string; newHostname?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemd-hostnamed',
      `Hostname set to <${p.newHostname ?? '?'}> (was <${p.oldHostname ?? '?'}>)`);
  }

  private onIpv6Added(p: { deviceId: string; portName: string; ipv6?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `${p.portName}: IPv6 address ${p.ipv6 ?? '?'} assigned`);
  }

  private onIpv6Removed(p: { deviceId: string; portName: string; ipv6?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `${p.portName}: IPv6 address ${p.ipv6 ?? '?'} removed`);
  }

  private onCableConnected(p: {
    portA?: { deviceId?: string; portName?: string };
    portB?: { deviceId?: string; portName?: string };
  }): void {
    const ours = p.portA?.deviceId === this.deviceId ? p.portA?.portName
               : p.portB?.deviceId === this.deviceId ? p.portB?.portName
               : null;
    if (!ours) return;
    this.logManager.logKernel('kernel', `${ours}: cable connected`);
  }

  private onCableDisconnected(p: {
    portA?: { deviceId?: string; portName?: string };
    portB?: { deviceId?: string; portName?: string };
  }): void {
    const ours = p.portA?.deviceId === this.deviceId ? p.portA?.portName
               : p.portB?.deviceId === this.deviceId ? p.portB?.portName
               : null;
    if (!ours) return;
    this.logManager.logKernel('kernel', `${ours}: cable disconnected`);
  }

  private onDhcpClientState(p: {
    deviceId: string; iface?: string; oldState?: string; newState?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhclient',
      `${p.iface ?? '?'}: state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`);
  }

  private onDhcpdAllocated(p: {
    deviceId: string; ip?: string; mac?: string; pool?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhcpd',
      `DHCPACK on ${p.ip ?? '?'} to ${p.mac ?? '?'} via pool ${p.pool ?? '?'}`);
  }

  private onDhcpdReleased(p: {
    deviceId: string; ip?: string; mac?: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhcpd',
      `DHCPRELEASE of ${p.ip ?? '?'} from ${p.mac ?? '?'}`);
  }

  private onDhcpConflict(p: { deviceId: string; ip?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhclient',
      `Address ${p.ip ?? '?'} already in use — declining lease`);
  }

  private onDhcpNak(p: { deviceId: string; serverIp?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('dhclient',
      `DHCPNAK from ${p.serverIp ?? '?'} — restarting discovery`);
  }

  private onNtpSynced(p: { deviceId: string; server?: string; stratum?: number; offsetMs?: number }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemd-timesyncd',
      `Synchronized to time server ${p.server ?? '?'} (stratum ${p.stratum ?? '?'}, offset ${p.offsetMs ?? 0}ms).`);
  }

  private onNtpUnsynced(p: { deviceId: string; reason?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('systemd-timesyncd',
      `Lost time synchronization (${p.reason ?? 'no reachable server'}).`);
  }

  private onIpsecIkeUp(p: { deviceId: string; peerIp?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('charon',
      `IKE_SA established with ${p.peerIp ?? '?'}`);
  }

  private onIpsecIkeDown(p: { deviceId: string; peerIp?: string; reason?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('charon',
      `IKE_SA with ${p.peerIp ?? '?'} deleted (${p.reason ?? 'remote close'})`);
  }

  private onIpsecDpdDown(p: { deviceId: string; peerIp?: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logDaemon('charon',
      `DPD: peer ${p.peerIp ?? '?'} not responding, deleting SA`);
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
    if (p.comm === '-bash' || p.comm === 'bash') return;
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

  private onArpIpConflict(p: {
    deviceId: string; iface: string; ip: string; foreignMac: string; localMac: string;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.logManager.logKernel('kernel',
      `IPv4: ${p.ip} duplicate arp reply received from ${p.foreignMac} on ${p.iface} (local ${p.localMac})`);
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
