import { Zone } from '@/network/dns/zone/Zone';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { findCoveringNsec } from '@/network/dns/dnssec/Nsec';
import type { DnsQuestion } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData, RrsigRecordData } from '@/network/dns/wire/ResourceRecord';

export class ZoneStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneStoreError';
  }
}

export interface ZoneStoreAnswer {
  readonly aa: boolean;
  readonly rcode: number;
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly authority: readonly ResourceRecord<ResourceRecordData>[];
  readonly additional: readonly ResourceRecord<ResourceRecordData>[];
}

export interface ZoneStoreAnswerOptions {
  readonly dnssec?: boolean;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function parentOf(name: string): string | null {
  const dot = name.indexOf('.');
  return dot === -1 ? null : name.slice(dot + 1);
}

export class ZoneStore {
  private readonly zonesByOrigin = new Map<string, Zone>();

  addZone(zone: Zone): void {
    if (this.zonesByOrigin.has(zone.origin)) {
      throw new ZoneStoreError(`a zone for origin "${zone.origin}" is already loaded`);
    }
    this.zonesByOrigin.set(zone.origin, zone);
  }

  removeZone(origin: string): boolean {
    return this.zonesByOrigin.delete(normalize(origin));
  }

  findZone(qname: string): Zone | null {
    let candidate: string | null = normalize(qname);
    while (candidate !== null) {
      const zone = this.zonesByOrigin.get(candidate);
      if (zone) return zone;
      candidate = parentOf(candidate);
    }
    return this.zonesByOrigin.get('') ?? null;
  }

  answer(question: DnsQuestion, options: ZoneStoreAnswerOptions = {}): ZoneStoreAnswer {
    const zone = this.findZone(question.qname);
    if (!zone) {
      return { aa: false, rcode: DnsRcode.REFUSED, answers: [], authority: [], additional: [] };
    }

    const dnssec = options.dnssec === true;
    const sign = (records: readonly ResourceRecord<ResourceRecordData>[]) =>
      dnssec ? this.withSignatures(zone, records) : [...records];

    const result = zone.lookup(question.qname, question.qtype);
    switch (result.kind) {
      case 'answer':
        return {
          aa: true, rcode: DnsRcode.NOERROR,
          answers: sign(result.records), authority: [],
          additional: this.collectGlue(zone, result.records),
        };
      case 'cname':
        return {
          aa: true, rcode: DnsRcode.NOERROR,
          answers: sign(result.finalRecords ? [...result.chain, ...result.finalRecords] : [...result.chain]),
          authority: [], additional: [],
        };
      case 'nodata':
        return {
          aa: true, rcode: DnsRcode.NOERROR, answers: [],
          authority: sign(this.negativeAuthority(zone, question.qname, dnssec, 'nodata')),
          additional: [],
        };
      case 'nxdomain':
        return {
          aa: true, rcode: DnsRcode.NXDOMAIN, answers: [],
          authority: sign(this.negativeAuthority(zone, question.qname, dnssec, 'nxdomain')),
          additional: [],
        };
      case 'delegation':
        return {
          aa: false, rcode: DnsRcode.NOERROR,
          answers: [], authority: [...result.nsRecords],
          additional: this.collectGlue(zone, result.nsRecords),
        };
    }
  }

  private negativeAuthority(
    zone: Zone, qname: string, dnssec: boolean, kind: 'nodata' | 'nxdomain',
  ): ResourceRecord<ResourceRecordData>[] {
    const authority: ResourceRecord<ResourceRecordData>[] = [zone.soa as ResourceRecord<ResourceRecordData>];
    if (!dnssec) return authority;

    const proof = kind === 'nodata'
      ? zone.getRRSet(qname, RRType.NSEC)?.[0] ?? null
      : findCoveringNsec(zone, qname);
    if (proof) authority.push(proof as ResourceRecord<ResourceRecordData>);
    return authority;
  }

  private withSignatures(
    zone: Zone, records: readonly ResourceRecord<ResourceRecordData>[],
  ): ResourceRecord<ResourceRecordData>[] {
    const out = [...records];
    const seen = new Set<string>();
    for (const rr of records) {
      if (rr.data.type === RRType.RRSIG) continue;
      const key = `${normalize(rr.name)}|${rr.data.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sigs = zone.getRRSet(rr.name, RRType.RRSIG) ?? [];
      out.push(...sigs.filter(
        (sig) => (sig.data as RrsigRecordData).typeCovered === rr.data.type,
      ));
    }
    return out;
  }

  private collectGlue(
    zone: Zone, records: readonly ResourceRecord<ResourceRecordData>[],
  ): ResourceRecord<ResourceRecordData>[] {
    const glue: ResourceRecord<ResourceRecordData>[] = [];
    const seen = new Set<string>();

    for (const rr of records) {
      const targetName =
        rr.data.type === RRType.NS ? rr.data.nsdname :
        rr.data.type === RRType.MX ? rr.data.exchange :
        null;
      if (!targetName) continue;

      const key = normalize(targetName);
      if (seen.has(key)) continue;
      seen.add(key);

      const a = zone.getRRSet(targetName, RRType.A);
      if (a) glue.push(...a);
      const aaaa = zone.getRRSet(targetName, RRType.AAAA);
      if (aaaa) glue.push(...aaaa);
    }
    return glue;
  }
}
