import { simulationNowMs } from '@/network/core/SystemClock';

import type { IPAddress } from '@/network/core/types';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData, SoaRecordData, TsigRecordData } from '@/network/dns/wire/ResourceRecord';
import { TsigKeyring, signedDnsMessage, verifyMessageStream, type TsigKey } from '@/network/dns/tsig/Tsig';
import type { Zone } from '@/network/dns/zone/Zone';
import { serialGreaterThan } from '@/network/dns/zone/SerialNumber';
import { isTransferQuery, zoneFromTransferAnswers, transferComplete } from '@/network/dns/transfer/AxfrSession';
import { isDeltaTransfer, applyIxfrDeltas } from '@/network/dns/transfer/IxfrSession';
import { askOverUdp, DNS_PORT, type DnsUdpClient } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcpStream, type DnsTcpClient } from '@/network/dns/transport/DnsTcpTransport';

export interface ZoneTransferTransport {
  askOverUdp(server: IPAddress, query: DnsMessage, timeoutMs: number): Promise<DnsMessage | null>;
  askTransfer(
    server: IPAddress, query: DnsMessage, timeoutMs: number,
  ): Promise<{ messages: DnsMessage[]; frames: Uint8Array[] } | null>;
}

export function transferTransportOf(
  udp: DnsUdpClient, tcp: DnsTcpClient, port: number = DNS_PORT,
): ZoneTransferTransport {
  return {
    askOverUdp: (server, query, timeoutMs) =>
      askOverUdp(udp, server, query, port, timeoutMs),
    askTransfer: (server, query, timeoutMs) =>
      queryDnsOverTcpStream(tcp, server, query, transferComplete, port, timeoutMs),
  };
}

export interface ZoneTransferClientOptions {
  readonly timeoutMs?: number;
  readonly key?: TsigKey;
  readonly keys?: ReadonlyMap<string, TsigKey>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const ID_SPACE = 0x10000;

export class ZoneTransferClient {
  private readonly timeoutMs: number;
  private readonly key: TsigKey | null;
  private readonly keys: ReadonlyMap<string, TsigKey>;
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
    this.key = options.key ?? null;
    this.keys = options.keys ?? new Map();
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

    const answers = await this.fetchTransfer(primary, this.buildTransferQuery(force));
    if (!answers || answers.length === 0) return false;
    if (answers.length === 1) return true;

    if (!force && this.zone && isDeltaTransfer(answers)) {
      try {
        applyIxfrDeltas(this.zone, answers);
        return true;
      } catch {
        return this.refreshFrom(primary, true);
      }
    }

    try {
      this.zone = zoneFromTransferAnswers(this.origin, answers);
    } catch {
      return false;
    }
    return true;
  }

  private async fetchTransfer(
    primary: IPAddress, query: DnsMessage,
  ): Promise<ResourceRecord<ResourceRecordData>[] | null> {
    const now = Math.floor(simulationNowMs() / 1000);
    const key = this.keys.get(primary.toString()) ?? this.key;
    const sent = key ? signedDnsMessage(query, { key, timeSigned: now }) : query;
    const requestMac = key
      ? (sent.additionals[sent.additionals.length - 1].data as TsigRecordData).mac : null;
    const result = await this.transport.askTransfer(primary, sent, this.timeoutMs);
    if (!result) return null;
    if (result.messages[0].flags.rcode !== DnsRcode.NOERROR) return null;
    if (key) {
      const ring = new TsigKeyring();
      ring.add(key);
      const verdict = verifyMessageStream(result.frames, { lookup: ring.lookup, now, requestMac });
      if (!verdict.ok) return null;
    }
    return result.messages.flatMap((message) => message.answers);
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
