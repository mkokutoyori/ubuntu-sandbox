import type { IScheduler } from '@/events/Scheduler';
import type { UdpListener } from '../devices/EndHost';
import { PORT_ANY, PortNumber } from '../core/ports/PortNumber';
import { IPAddress } from '../core/types';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';
import { SnmpManager, type SnmpExchange, type SnmpQuery, type SnmpRetransmission } from './SnmpManager';
import type { SnmpPacket } from './types';

export interface SnmpClientHost {
  udpBind(port: number, listener: UdpListener, processName?: string): number | false;
  udpClose(port: number): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  getScheduler(): IScheduler;
}

export class SnmpClientSession {
  private readonly manager: SnmpManager;
  private closed = false;

  private constructor(private readonly host: SnmpClientHost, readonly localPort: number) {
    this.manager = new SnmpManager(
      (query, packet) => host.sendUdpDatagram({
        destination: query.server,
        destinationPort: query.port.value,
        sourcePort: localPort,
        payload: packet,
        payloadBytes: 48 + packet.varBindings.length * 16,
      }),
      () => host.getScheduler(),
    );
  }

  static open(host: SnmpClientHost, processName: string): SnmpClientSession | null {
    let session: SnmpClientSession | null = null;
    const bound = host.udpBind(PORT_ANY, ({ sourceIP, udp }) => {
      const packet = udp.payload as SnmpPacket | undefined;
      if (packet?.type !== 'snmp' || !(sourceIP instanceof IPAddress)) return;
      session?.manager.accept(sourceIP, PortNumber.of(udp.sourcePort), packet);
    }, processName);
    if (bound === false) return null;
    session = new SnmpClientSession(host, bound);
    return session;
  }

  exchange(query: SnmpQuery, retransmission: SnmpRetransmission): Promise<SnmpExchange> {
    return this.manager.exchange(query, retransmission);
  }

  now(): number {
    return this.host.getScheduler().now();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.manager.abandonAll();
    this.host.udpClose(this.localPort);
  }
}
