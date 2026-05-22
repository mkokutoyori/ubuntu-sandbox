/**
 * PortProxySocketProjection — reactive socket-table coherence for
 * `netsh interface portproxy` rules.
 *
 * A real Windows port proxy holds an open listening socket for every
 * rule — `netstat -ano` shows it owned by the `iphlpsvc`-hosted
 * `svchost.exe`. This projection subscribes to the port-proxy event
 * stream and binds / releases the matching {@link SocketTable} entry, so
 * adding a rule makes its listen port appear in `netstat` and removing
 * it makes the port vanish.
 *
 * Windows analogue of the Linux SSH {@link SshForwardingTable}'s
 * socket-table coupling.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SocketTable } from '../../core/SocketTable';
import type { WindowsPortProxyEventPayload } from './events';

/** PID attributed to the `iphlpsvc`-hosted svchost that owns the proxy. */
const IPHLPSVC_PID = 1100;

export class PortProxySocketProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly deviceId: string,
    private readonly socketTable: SocketTable,
  ) {
    this.subscriptions.push(
      bus.subscribe('windows.portproxy.added', (e) => this.onAdded(e.payload)),
      bus.subscribe('windows.portproxy.removed', (e) => this.onRemoved(e.payload)),
    );
  }

  /** Detach every subscription — call before discarding the projection. */
  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onAdded(p: WindowsPortProxyEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    if (this.socketTable.isPortBound(p.listenPort, 'tcp')) return;
    try {
      this.socketTable.bind('tcp', p.listenAddress, p.listenPort, IPHLPSVC_PID, 'svchost.exe');
    } catch { /* already bound — keep the existing entry */ }
  }

  private onRemoved(p: WindowsPortProxyEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.socketTable.unbind('tcp', p.listenAddress, p.listenPort);
  }
}
