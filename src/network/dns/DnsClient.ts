/**
 * DnsClient — stub resolver sending real queries over UDP/53.
 *
 * Replaces the legacy god-mode resolution (direct in-process lookup on the
 * server's DnsService object) with the actual protocol exchange: a query
 * datagram leaves through the host routing table + ARP, crosses the
 * simulated network, and the answer (or an ICMP error / a timeout) comes
 * back the same way. Unplugged cable, stopped daemon, missing route and
 * firewall rules now affect name resolution exactly as they would on a
 * real machine.
 */

import type { IEventBus } from '@/events/EventBus';
import type { IScheduler, TimerHandle } from '@/events/Scheduler';
import type { UdpStack } from '../udp/UdpStack';
import {
  DNS_PORT, DNS_QUERY_TIMEOUT_MS,
  isDnsResponseMessage,
  type DnsQueryMessage, type DnsRecord, type DnsRcode,
} from './types';

export type DnsQueryResult =
  /** The server answered (rcode may still be NXDOMAIN/REFUSED). */
  | { status: 'ok'; rcode: DnsRcode; answers: DnsRecord[] }
  /** No answer within the time budget. */
  | { status: 'timeout' }
  /** ICMP error from the server (port closed) or no way to reach it. */
  | { status: 'unreachable' };

export interface DnsQueryOptions {
  /** Query type, default 'A'. */
  qtype?: string;
  /** Reverse (PTR) lookup — `name` is a dotted-quad IP. */
  reverse?: boolean;
  timeoutMs?: number;
}

/** Narrow signature handed to command layers (dig/nslookup/host). */
export type DnsLookup = (
  serverIp: string,
  name: string,
  options?: DnsQueryOptions,
) => Promise<DnsQueryResult>;

export interface DnsClientHost {
  /** Device id — used to recognise our own ICMP-error bus events. */
  readonly deviceId: string;
  getUdpStack(): UdpStack;
  getScheduler(): IScheduler;
  getBus(): IEventBus;
}

export class DnsClient {
  private transactionCounter = 0;

  constructor(private readonly host: DnsClientHost) {}

  /** Send one query to one server and await its answer. */
  async query(serverIp: string, name: string, options: DnsQueryOptions = {}): Promise<DnsQueryResult> {
    const id = this.nextTransactionId();
    const timeoutMs = options.timeoutMs ?? DNS_QUERY_TIMEOUT_MS;
    const queryMessage: DnsQueryMessage = {
      kind: 'dns-query',
      id,
      name,
      qtype: (options.qtype ?? 'A').toUpperCase(),
      reverse: options.reverse,
    };

    let settle!: (result: DnsQueryResult) => void;
    const resultPromise = new Promise<DnsQueryResult>((resolve) => { settle = resolve; });

    let disposeListener: (() => void) | null = null;
    let unsubscribeIcmp: (() => void) | null = null;
    let timer: TimerHandle | null = null;
    let settled = false;
    const finish = (result: DnsQueryResult): void => {
      if (settled) return;
      settled = true;
      disposeListener?.();
      unsubscribeIcmp?.();
      if (timer !== null) this.host.getScheduler().clear(timer);
      settle(result);
    };

    // Bind the answer listener and the ICMP-error watch BEFORE sending:
    // cable delivery is synchronous, so the reply (or the Port Unreachable)
    // can arrive while `send()` is still awaited.
    const ephemeral = this.host.getUdpStack().listenEphemeral((datagram) => {
      const response = datagram.payload;
      if (!isDnsResponseMessage(response)) return;
      if (response.id !== id || datagram.sourceIp !== serverIp) return;
      finish({ status: 'ok', rcode: response.rcode, answers: response.answers });
    });
    disposeListener = ephemeral.dispose;

    unsubscribeIcmp = this.host.getBus().subscribe('host.icmp.echo-failed', (event) => {
      if (event.payload.deviceId !== this.host.deviceId) return;
      if (event.payload.fromIp !== serverIp) return;
      finish({ status: 'unreachable' });
    });

    timer = this.host.getScheduler().setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

    const sent = await this.host.getUdpStack().send({
      destinationIp: serverIp,
      destinationPort: DNS_PORT,
      sourcePort: ephemeral.port,
      payload: queryMessage,
    });
    if (!sent) finish({ status: 'unreachable' });

    return resultPromise;
  }

  /**
   * Resolve a name to its first A record, trying servers in order —
   * the contract of `gethostbyname` over resolv.conf nameservers.
   */
  async resolveFirstA(serverIps: readonly string[], name: string, options: DnsQueryOptions = {}): Promise<string | null> {
    for (const serverIp of serverIps) {
      const result = await this.query(serverIp, name, { ...options, qtype: 'A' });
      if (result.status === 'ok' && result.answers.length > 0) {
        return result.answers[0].value;
      }
      // NXDOMAIN from a responding server is authoritative — stop here.
      if (result.status === 'ok' && result.rcode === 'NXDOMAIN') return null;
      // timeout / unreachable → try the next configured server
    }
    return null;
  }

  private nextTransactionId(): number {
    this.transactionCounter = (this.transactionCounter + 1) & 0xffff;
    return this.transactionCounter;
  }
}
