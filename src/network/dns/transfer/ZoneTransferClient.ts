import type { IPAddress } from '@/network/core/types';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import type { Zone } from '@/network/dns/zone/Zone';
import { serialGreaterThan } from '@/network/dns/zone/SerialNumber';
import { isTransferQuery, zoneFromTransferAnswers } from '@/network/dns/transfer/AxfrSession';
import { isDeltaTransfer, applyIxfrDeltas } from '@/network/dns/transfer/IxfrSession';
import { askOverUdp, DNS_PORT, type DnsUdpClient } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp, type DnsTcpClient } from '@/network/dns/transport/DnsTcpTransport';

export interface ZoneTransferTransport {
  askOverUdp(server: IPAddress, query: DnsMessage, timeoutMs: number): Promise<DnsMessage | null>;
  askOverTcp(server: IPAddress, query: DnsMessage, timeoutMs: number): Promise<DnsMessage | null>;
}

export function transferTransportOf(
  udp: DnsUdpClient, tcp: DnsTcpClient, port: number = DNS_PORT,
): ZoneTransferTransport {
  return {
    askOverUdp: (server, query, timeoutMs) =>
      askOverUdp(udp, server, query, port, timeoutMs),
    askOverTcp: (server, query, timeoutMs) =>
      queryDnsOverTcp(tcp, server, query, port, timeoutMs),
  };
}

export interface ZoneTransferClientOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const ID_SPACE = 0x10000;

export class ZoneTransferClient {
  private readonly timeoutMs: number;
  private zone: Zone | null = null;
  private refreshing = false;
  private nextId = 1;

  constructor(
    private readonly origin: string,
    private readonly primaries: readonly IPAddress[],
    private readonly transport: ZoneTransferTransport,
    options: ZoneTransferClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  currentZone(): Zone | null { return this.zone; }

  currentSerial(): number | null { return this.zone?.soa.data.serial ?? null; }

  adopt(zone: Zone | null): void { this.zone = zone; }

  async refresh(force = false): Promise<boolean> {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      for (const primary of this.primaries) {
        if (await this.refreshFrom(primary, force)) return true;
      }
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshFrom(primary: IPAddress, force: boolean): Promise<boolean> {
    const primarySerial = await this.fetchPrimarySerial(primary);
    if (primarySerial === null) return false;

    if (!force && this.zone
      && !serialGreaterThan(primarySerial, this.zone.soa.data.serial)) {
      return true;
    }

    const reply = await this.transport.askOverTcp(
      primary, this.buildTransferQuery(force), this.timeoutMs);
    if (!reply || reply.answers.length === 0) return false;
    if (reply.answers.length === 1) return true;

    if (!force && this.zone && isDeltaTransfer(reply.answers)) {
      try {
        applyIxfrDeltas(this.zone, reply.answers);
        return true;
      } catch {
        return this.refreshFrom(primary, true);
      }
    }

    try {
      this.zone = zoneFromTransferAnswers(this.origin, reply.answers);
    } catch {
      return false;
    }
    return true;
  }

  private async fetchPrimarySerial(primary: IPAddress): Promise<number | null> {
    const reply = await this.transport.askOverUdp(
      primary, this.buildQuery(RRType.SOA), this.timeoutMs);
    const soa = reply?.answers.find((rr) => rr.data.type === RRType.SOA);
    return soa ? (soa.data as SoaRecordData).serial : null;
  }

  private buildTransferQuery(force: boolean): DnsMessage {
    if (force || !this.zone) return this.buildQuery(RRType.AXFR);
    return {
      ...this.buildQuery(RRType.IXFR),
      authorities: [this.zone.soa as ResourceRecord<SoaRecordData>],
    };
  }

  private buildQuery(qtype: number): DnsMessage {
    const id = this.nextId;
    this.nextId = (this.nextId + 1) % ID_SPACE;
    return {
      id,
      flags: {
        qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: [{ qname: this.origin, qtype, qclass: DnsClass.IN }],
      answers: [],
      authorities: [],
      additionals: [],
    };
  }
}

export { isTransferQuery };
