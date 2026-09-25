import type { IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import type { IPAddress } from '../core/types';
import type { PortNumber } from '../core/ports/PortNumber';
import { v, vb, type SnmpPacket, type SnmpVersion } from './types';

export type SnmpQueryPdu = 'get-request' | 'get-next-request';

export interface SnmpQuery {
  readonly server: IPAddress;
  readonly port: PortNumber;
  readonly community: string;
  readonly version: SnmpVersion;
  readonly pduType: SnmpQueryPdu;
  readonly oids: readonly string[];
}

export type SnmpResponseMatching = 'request-id' | 'request-id-and-peer';

export interface SnmpRetransmission {
  readonly timeoutMs: number;
  readonly retries: number;
}

export type SnmpExchange =
  | { readonly kind: 'response'; readonly packet: SnmpPacket }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unsent' }
  | { readonly kind: 'abandoned' };

interface PendingQuery {
  readonly serverIp: string;
  readonly serverPort: number;
  readonly settle: (exchange: SnmpExchange) => void;
  timer: symbol | null;
}

export class SnmpManager {
  private readonly pending = new Map<number, PendingQuery>();
  private readonly timers: TimerSet;
  private nextRequestId = 1;

  constructor(
    private readonly transmit: (query: SnmpQuery, packet: SnmpPacket) => boolean,
    scheduler: () => IScheduler,
    private readonly matching: SnmpResponseMatching,
  ) {
    this.timers = new TimerSet(scheduler);
  }

  exchange(query: SnmpQuery, retransmission: SnmpRetransmission): Promise<SnmpExchange> {
    const requestId = this.nextRequestId++ & 0x7fffffff;
    const packet: SnmpPacket = {
      type: 'snmp', version: query.version, community: query.community,
      pduType: query.pduType, requestId,
      errorStatus: 'no-error', errorIndex: 0,
      varBindings: query.oids.map((oid) => vb(oid, v('null', null))),
    };
    return new Promise<SnmpExchange>((resolve) => {
      const entry: PendingQuery = {
        serverIp: query.server.toString(), serverPort: query.port.value, settle: resolve, timer: null,
      };
      this.pending.set(requestId, entry);
      const attempt = (retriesLeft: number): void => {
        if (!this.transmit(query, packet)) {
          this.settle(requestId, { kind: 'unsent' });
          return;
        }
        if (!this.pending.has(requestId)) return;
        entry.timer = this.timers.setTimeout(() => {
          entry.timer = null;
          if (retriesLeft > 0) attempt(retriesLeft - 1);
          else this.settle(requestId, { kind: 'timeout' });
        }, retransmission.timeoutMs);
      };
      attempt(retransmission.retries);
    });
  }

  accept(sender: IPAddress, senderPort: PortNumber, packet: SnmpPacket): boolean {
    if (packet.pduType !== 'get-response') return false;
    const entry = this.pending.get(packet.requestId);
    if (!entry) return false;
    if (this.matching === 'request-id-and-peer'
      && (entry.serverIp !== sender.toString() || entry.serverPort !== senderPort.value)) return false;
    this.settle(packet.requestId, { kind: 'response', packet });
    return true;
  }

  abandonAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, { kind: 'abandoned' });
  }

  private settle(requestId: number, exchange: SnmpExchange): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    this.timers.clear(entry.timer);
    entry.settle(exchange);
  }
}
