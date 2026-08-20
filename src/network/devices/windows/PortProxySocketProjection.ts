/**
 * PortProxySocketProjection — reactive socket-table coherence AND a real
 * data relay for `netsh interface portproxy` rules.
 *
 * A real Windows port proxy holds an open listening socket for every
 * rule — `netstat -ano` shows it owned by the `iphlpsvc`-hosted
 * `svchost.exe` — and is an application-level bridge (like `socat`): it
 * accepts a connection at `listenaddress:listenport`, opens a second, real
 * connection to `connectaddress:connectport`, and relays bytes both ways.
 * Before Phase 7 (`docs/PRD-Port-Forwarding.md`) this projection only did
 * the `SocketTable` bookkeeping — configuring a rule made the port visible
 * in `netstat` but never moved a single byte. `connectAddress`/`connectPort`
 * are now actually dialed via `TcpStack`, reusing the same real
 * listen/connect/send/close primitives every other TCP service in this
 * simulator uses — no IP-level forwarding is involved, matching real
 * `iphlpsvc`, which needs none either.
 *
 * Windows analogue of the Linux SSH {@link SshForwardingTable}'s
 * socket-table coupling.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { SocketTable } from '../../core/SocketTable';
import type { TcpStack, TcpSocket } from '../../tcp/TcpStack';
import type { WindowsPortProxyEventPayload } from './events';

/** PID attributed to the `iphlpsvc`-hosted svchost that owns the proxy. */
const IPHLPSVC_PID = 1100;

export class PortProxySocketProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly deviceId: string,
    private readonly socketTable: SocketTable,
    private readonly tcpStack: TcpStack,
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
    if (!this.socketTable.isPortBound(p.listenPort, 'tcp')) {
      try {
        this.socketTable.bind('tcp', p.listenAddress, p.listenPort, IPHLPSVC_PID, 'svchost.exe');
      } catch { /* already bound — keep the existing entry */ }
    }
    try {
      this.tcpStack.listen(
        p.listenPort,
        { onAccept: (accepted) => this.relay(p, accepted) },
        p.listenAddress,
      );
    } catch { /* a real listener already occupies this exact address:port */ }
  }

  private onRemoved(p: WindowsPortProxyEventPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.socketTable.unbind('tcp', p.listenAddress, p.listenPort);
    this.tcpStack.closeListener(p.listenPort, p.listenAddress);
  }

  /**
   * Bridge one accepted connection to a fresh connection dialed at the
   * rule's connect endpoint, piping bytes both ways — exactly what real
   * `iphlpsvc` does. A failed/refused connect side closes the accepted
   * side immediately (there is nothing to relay to); either side closing
   * later closes the other.
   */
  private relay(p: WindowsPortProxyEventPayload, accepted: TcpSocket): void {
    const upstream = this.tcpStack.connect(p.connectAddress, p.connectPort, {
      onData: (data) => accepted.send(data),
      onClose: () => accepted.close(),
    });
    if (!upstream) {
      accepted.close();
      return;
    }
    accepted.onData((data) => upstream.send(data));
    accepted.onClose(() => upstream.close());
  }
}
