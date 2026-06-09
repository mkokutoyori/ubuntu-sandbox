/**
 * DnsServerEndpoint — binds a DNS zone database to UDP port 53.
 *
 * Turns a passive record store (e.g. the dnsmasq-style `DnsService` on a
 * Linux host) into a real network service: queries arrive as UDP datagrams
 * through the simulated network and answers are sent back the same way.
 * When the endpoint is stopped, port 53 is closed and clients get ICMP
 * Port Unreachable from the host instead of an answer — exactly like
 * stopping dnsmasq on a real box.
 */

import type { UdpStack, ReceivedUdpDatagram } from '../udp/UdpStack';
import {
  DNS_PORT,
  isDnsQueryMessage,
  type DnsRecord,
  type DnsRcode,
  type DnsResponseMessage,
} from './types';

/** What the endpoint needs from a zone database (implemented by DnsService). */
export interface DnsZoneProvider {
  query(name: string, type: string): DnsRecord[];
  reverseQuery(ip: string): DnsRecord[];
  hasDomain(name: string): boolean;
}

export class DnsServerEndpoint {
  private unbind: (() => void) | null = null;

  constructor(
    private readonly udp: UdpStack,
    private readonly zone: DnsZoneProvider,
  ) {}

  /** Open UDP/53. Idempotent. Throws EADDRINUSE if another service owns it. */
  start(): void {
    if (this.unbind) return;
    this.unbind = this.udp.listen(DNS_PORT, (datagram) => this.handleQuery(datagram));
  }

  /** Close UDP/53. Idempotent. */
  stop(): void {
    this.unbind?.();
    this.unbind = null;
  }

  isRunning(): boolean {
    return this.unbind !== null;
  }

  private handleQuery(datagram: ReceivedUdpDatagram): void {
    const query = datagram.payload;
    if (!isDnsQueryMessage(query)) return; // not DNS — drop silently

    let answers: DnsRecord[];
    let rcode: DnsRcode = 'NOERROR';
    if (query.reverse) {
      answers = this.zone.reverseQuery(query.name);
      if (answers.length === 0) rcode = 'NXDOMAIN';
    } else {
      answers = this.zone.query(query.name, query.qtype);
      // RFC 2308: empty answer for an existing name is NOERROR/NODATA;
      // a name with no records at all is NXDOMAIN.
      if (answers.length === 0 && !this.zone.hasDomain(query.name)) {
        rcode = 'NXDOMAIN';
      }
    }

    const response: DnsResponseMessage = {
      kind: 'dns-response',
      id: query.id,
      rcode,
      answers,
    };
    void datagram.reply(response);
  }
}
