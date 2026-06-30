/**
 * TcpSocketStateProjection — reactive mirror of the TcpStack's per-connection
 * state into the kernel-visible {@link SocketTable}.
 *
 * The TCP machinery lives in `tcp/TcpStack.ts` and publishes
 * `tcp.state.changed` whenever a socket moves through the RFC 9293 state
 * machine (SYN-SENT → ESTABLISHED → FIN-WAIT-1 → FIN-WAIT-2 → TIME-WAIT →
 * CLOSED). Without a projection, `ss -tan` / `netstat -tan` only see the
 * pre-existing LISTEN sockets — they miss every transient state a real
 * connection goes through. This projection keeps the SocketTable in lock-
 * step with TcpStack, so the tooling reports the live picture.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type {
  TcpStateChangedPayload,
  TcpConnectionClosedPayload,
} from '@/network/tcp/events';
import type { TcpState } from '@/network/tcp/types';
import type { SocketState, SocketTable } from '@/network/core/SocketTable';

const STATE_MAP: Record<TcpState, SocketState | null> = {
  'closed':       null,
  'listen':       'LISTEN',
  'syn-sent':     'SYN_SENT',
  'syn-received': 'SYN_RECEIVED',
  'established':  'ESTABLISHED',
  'fin-wait-1':   'FIN_WAIT_1',
  'fin-wait-2':   'FIN_WAIT_2',
  'close-wait':   'CLOSE_WAIT',
  'closing':      'CLOSING',
  'last-ack':     'LAST_ACK',
  'time-wait':    'TIME_WAIT',
};

export class TcpSocketStateProjection {
  private readonly subscriptions: Unsubscribe[] = [];

  constructor(
    bus: IEventBus,
    private readonly socketTable: SocketTable,
    private readonly deviceId: string,
  ) {
    this.subscriptions.push(
      bus.subscribe('tcp.state.changed', (e) => this.onStateChanged(e.payload)),
      bus.subscribe('tcp.connection.closed', (e) => this.onClosed(e.payload)),
    );
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
  }

  private onStateChanged(p: TcpStateChangedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    const mapped = STATE_MAP[p.newState];
    if (mapped === null) {
      this.socketTable.removeConnection({
        protocol: 'tcp',
        localPort: p.localPort,
        remoteAddress: p.remoteIp,
        remotePort: p.remotePort,
      });
      return;
    }
    this.socketTable.upsertConnection({
      protocol: 'tcp',
      localAddress: p.localIp,
      localPort: p.localPort,
      remoteAddress: p.remoteIp,
      remotePort: p.remotePort,
      state: mapped,
    });
  }

  private onClosed(p: TcpConnectionClosedPayload): void {
    if (p.deviceId !== this.deviceId) return;
    this.socketTable.removeConnection({
      protocol: 'tcp',
      localPort: p.localPort,
      remoteAddress: p.remoteIp,
      remotePort: p.remotePort,
    });
  }
}
