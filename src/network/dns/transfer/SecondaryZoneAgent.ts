import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import type { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { serialGreaterThan } from '@/network/dns/zone/SerialNumber';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer, unbindDnsUdpServer, queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { bindDnsTcpServer, unbindDnsTcpServer, queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import { isTransferQuery, refuseTransfer, zoneFromTransferAnswers } from '@/network/dns/transfer/AxfrSession';
import { isDeltaTransfer, applyIxfrDeltas } from '@/network/dns/transfer/IxfrSession';
import { isNotify, makeNotifyAck } from '@/network/dns/transfer/NotifyProtocol';

export interface SecondaryZoneAgentOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const ID_SPACE = 0x10000;

export class SecondaryZoneAgent {
  private readonly store = new ZoneStore();
  private readonly authServer = new AuthoritativeServer(this.store);
  private readonly timeoutMs: number;
  private zone: Zone | null = null;
  private refreshing = false;
  private nextId = 1;

  constructor(
    private readonly host: EndHost,
    private readonly origin: string,
    private readonly primaryIP: IPAddress,
    options: SecondaryZoneAgentOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  start(): void {
    bindDnsUdpServer(this.host, (query) => this.routeUdp(query));
    bindDnsTcpServer(this.host, (query) =>
      isTransferQuery(query) ? refuseTransfer(query) : this.authServer.answer(query));
  }

  stop(): void {
    unbindDnsUdpServer(this.host);
    unbindDnsTcpServer(this.host);
  }

  async refresh(): Promise<boolean> {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      const primarySerial = await this.fetchPrimarySerial();
      if (primarySerial === null) return false;

      if (this.zone && !serialGreaterThan(primarySerial, this.zone.soa.data.serial)) {
        return true;
      }

      const reply = await queryDnsOverTcp(
        this.host, this.primaryIP, this.buildTransferQuery(), undefined, this.timeoutMs,
      );
      if (!reply || reply.answers.length === 0) return false;
      if (reply.answers.length === 1) return true;

      if (this.zone && isDeltaTransfer(reply.answers)) {
        applyIxfrDeltas(this.zone, reply.answers);
      } else {
        this.installZone(zoneFromTransferAnswers(this.origin, reply.answers));
      }
      return true;
    } finally {
      this.refreshing = false;
    }
  }

  private routeUdp(query: DnsMessage): DnsMessage {
    if (isNotify(query)) {
      void this.refresh();
      return makeNotifyAck(query);
    }
    if (isTransferQuery(query)) {
      return refuseTransfer(query);
    }
    return this.authServer.answer(query);
  }

  private async fetchPrimarySerial(): Promise<number | null> {
    const reply = await queryDnsOverUdp(
      this.host, this.primaryIP, this.buildQuery(RRType.SOA), undefined, this.timeoutMs,
    );
    const soa = reply?.answers.find((rr) => rr.data.type === RRType.SOA);
    return soa ? (soa.data as SoaRecordData).serial : null;
  }

  private buildTransferQuery(): DnsMessage {
    if (!this.zone) return this.buildQuery(RRType.AXFR);
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

  private installZone(zone: Zone): void {
    this.store.removeZone(this.origin);
    this.store.addZone(zone);
    this.zone = zone;
  }
}
