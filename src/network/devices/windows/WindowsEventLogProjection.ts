/**
 * WindowsEventLogProjection — reactive bridge from Windows service-lifecycle
 * events to the System event log.
 *
 * `WindowsServiceManager` announces every start/stop on the bus instead of
 * journaling them itself. This projection subscribes and writes the faithful
 * Service Control Manager event 7036 ("The X service entered the running /
 * stopped state.") into the System log — the audit trail `Get-EventLog
 * System` and `wevtutil` show.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { WindowsAuditPolicy } from './WindowsAuditPolicy';
import type {
  WindowsServiceEventPayload, WindowsServiceCrashedPayload, WindowsServiceRecoveryCriticalPayload,
  WindowsServiceCreatedPayload,
} from './events';

/** SCM event ID for a service state transition (System log). */
const SCM_STATE_CHANGE = 7036;
/** SCM event ID for an unexpected service termination (System log). */
const SCM_UNEXPECTED_TERMINATION = 7034;
/** SCM event ID announcing the corrective action about to be taken (System log). */
const SCM_RECOVERY_ACTION = 7031;
/** SCM event ID for a new service installed in the system (System log). */
const SCM_SERVICE_INSTALLED = 7045;
/** Windows Filtering Platform — packet blocked (Security log). */
const WFP_PACKET_BLOCKED = 5152;
/** TCP listener started (System log). */
const TCP_LISTENER_OPENED = 5158;
/** Inbound connection allowed (Security log). */
const WFP_CONNECTION_ALLOWED = 5156;

/** The slice of the event-log provider this projection writes through. */
export interface WindowsEventLogSink {
  writeEventLog(
    logName: string, source: string, eventId: number,
    entryType: 'Information' | 'Warning' | 'Error' | 'SuccessAudit' | 'FailureAudit',
    message: string,
    data?: Record<string, string>,
  ): string;
}

export class WindowsEventLogProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly sink: WindowsEventLogSink,
    private readonly deviceId: string,
    private readonly auditPolicy?: WindowsAuditPolicy,
  ) {
    this.subscriptions.push(
      bus.subscribe('windows.service.started', (e) => this.onService(e.payload)),
      bus.subscribe('windows.service.stopped', (e) => this.onService(e.payload)),
      bus.subscribe('windows.service.crashed', (e) => this.onServiceCrashed(e.payload)),
      bus.subscribe('windows.service.created', (e) => this.onServiceCreated(e.payload)),
      bus.subscribe('windows.service.recovery-critical', (e) => this.onRecoveryCritical(e.payload)),
      bus.subscribe('tcp.listener.changed', (e) => this.onTcpListener(e.payload)),
      bus.subscribe('tcp.connection.opened', (e) => this.onTcpAccepted(e.payload)),
      bus.subscribe('windows.firewall.drop', (e) => this.onFirewallDrop(e.payload)),
      bus.subscribe('windows.portproxy.added', (e) => this.onPortProxyAdded(e.payload)),
      bus.subscribe('windows.portproxy.removed', (e) => this.onPortProxyRemoved(e.payload)),
      bus.subscribe('dhcp.lease.granted', (e) => this.onDhcpGranted(e.payload)),
      bus.subscribe('port.link.up', (e) => this.onLinkUp(e.payload)),
      bus.subscribe('port.link.down', (e) => this.onLinkDown(e.payload)),
    );
  }

  private gated(subcategory: string, kind: 'success' | 'failure'): boolean {
    return this.auditPolicy ? this.auditPolicy.isEnabled(subcategory, kind) : true;
  }

  private onPortProxyAdded(p: {
    deviceId: string; listenAddress: string; listenPort: number;
    connectAddress: string; connectPort: number;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System', 'Tcpip', 5159, 'Information',
      `Port proxy added: ${p.listenAddress}:${p.listenPort} → ${p.connectAddress}:${p.connectPort}.`,
    );
  }

  private onPortProxyRemoved(p: {
    deviceId: string; listenAddress: string; listenPort: number;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System', 'Tcpip', 5160, 'Information',
      `Port proxy removed: ${p.listenAddress}:${p.listenPort}.`,
    );
  }

  private onDhcpGranted(p: {
    deviceId: string; iface?: string; ip?: string; leaseTimeSec?: number;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System', 'Dhcp-Client', 50036, 'Information',
      `Your computer was successfully assigned an address from the DHCP server, and the address is ${p.ip ?? '?'}. Lease time: ${p.leaseTimeSec ?? 0}s.`,
    );
  }

  private onLinkUp(p: { deviceId: string; portName: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System', 'NDIS', 4201, 'Information',
      `Network adapter ${p.portName} has been connected.`,
    );
  }

  private onLinkDown(p: { deviceId: string; portName: string }): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System', 'NDIS', 4202, 'Warning',
      `Network adapter ${p.portName} has been disconnected.`,
    );
  }

  private onTcpListener(p: {
    deviceId: string; localIp: string; localPort: number; added: boolean;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (!p.added) return;
    this.sink.writeEventLog(
      'System', 'Tcpip', TCP_LISTENER_OPENED, 'Information',
      `TCP listener opened on ${p.localIp}:${p.localPort}.`,
    );
  }

  private onTcpAccepted(p: {
    deviceId: string; remoteIp: string; remotePort: number;
    localIp: string; localPort: number; passive: boolean;
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (!p.passive) return;
    if (!this.gated('Filtering Platform Connection', 'success')) return;
    this.sink.writeEventLog(
      'Security', 'Microsoft-Windows-Security-Auditing',
      WFP_CONNECTION_ALLOWED, 'SuccessAudit',
      `The Windows Filtering Platform has permitted a connection. ` +
      `Source: ${p.remoteIp}:${p.remotePort}, Destination: ${p.localIp}:${p.localPort}.`,
    );
  }

  private onFirewallDrop(p: {
    deviceId: string; ruleName: string;
    sourceIp: string; sourcePort: number;
    destinationIp: string; destinationPort: number;
    protocol: string; direction: 'Inbound' | 'Outbound';
  }): void {
    if (p.deviceId !== this.deviceId) return;
    if (!this.gated('Filtering Platform Packet Drop', 'failure')) return;
    this.sink.writeEventLog(
      'Security', 'Microsoft-Windows-Security-Auditing',
      WFP_PACKET_BLOCKED, 'FailureAudit',
      `The Windows Filtering Platform has blocked a packet. ` +
      `Direction: ${p.direction}, Protocol: ${p.protocol}, ` +
      `Source: ${p.sourceIp}:${p.sourcePort}, Destination: ${p.destinationIp}:${p.destinationPort}, ` +
      `Filter: ${p.ruleName}.`,
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onService(p: WindowsServiceEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System',
      'Service Control Manager',
      SCM_STATE_CHANGE,
      'Information',
      `The ${p.displayName} service entered the ${p.running ? 'running' : 'stopped'} state.`,
    );
  }

  private onServiceCrashed(p: WindowsServiceCrashedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System',
      'Service Control Manager',
      SCM_UNEXPECTED_TERMINATION,
      'Error',
      `The ${p.displayName} service terminated unexpectedly. It has done this ${p.failureCount} time(s).`,
    );
  }

  private onServiceCreated(p: WindowsServiceCreatedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System',
      'Service Control Manager',
      SCM_SERVICE_INSTALLED,
      'Information',
      `A service was installed in the system.\n\n` +
      `Service Name:  ${p.serviceName}\n` +
      `Service File Name:  ${p.binaryPath}\n` +
      `Service Type:  user mode service\n` +
      `Service Start Type:  demand start\n` +
      `Service Account:  ${p.account}`,
      // L'ordre compte : un script lit `Data[0]` pour le nom du service,
      // `Data[1]` pour le binaire. 7045 est le premier événement qu'on
      // regarde quand un service inconnu apparaît, et un message en
      // texte libre ne se dépouille pas.
      {
        ServiceName: p.serviceName,
        ImagePath: p.binaryPath,
        ServiceType: 'user mode service',
        StartType: 'demand start',
        AccountName: p.account,
      },
    );
  }

  private onRecoveryCritical(p: WindowsServiceRecoveryCriticalPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.sink.writeEventLog(
      'System',
      'Service Control Manager',
      SCM_RECOVERY_ACTION,
      'Error',
      `The ${p.displayName} service terminated unexpectedly. It has done this ${p.rank} time(s). ` +
      `The configured corrective action is Reboot the Computer — suppressed by the simulator; the service remains stopped.`,
    );
  }
}
