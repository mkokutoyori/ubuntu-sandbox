import { RRType } from '@/network/dns/wire/RRType';
import type {
  ResourceRecord, ResourceRecordData, SoaRecordData, NsRecordData, CnameRecordData,
} from '@/network/dns/wire/ResourceRecord';

export class ZoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneError';
  }
}

const MAX_CNAME_CHAIN_DEPTH = 16;

export type ZoneLookupResult =
  | { readonly kind: 'answer'; readonly records: readonly ResourceRecord<ResourceRecordData>[] }
  | {
      readonly kind: 'cname';
      readonly chain: readonly ResourceRecord<CnameRecordData>[];
      readonly finalRecords: readonly ResourceRecord<ResourceRecordData>[] | null;
    }
  | { readonly kind: 'delegation'; readonly nsRecords: readonly ResourceRecord<NsRecordData>[] }
  | { readonly kind: 'nodata' }
  | { readonly kind: 'nxdomain' };

function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function isWithinOrigin(name: string, origin: string): boolean {
  return origin === '' || name === origin || name.endsWith(`.${origin}`);
}

function parentOf(name: string): string | null {
  const dot = name.indexOf('.');
  return dot === -1 ? null : name.slice(dot + 1);
}

export class Zone {
  readonly origin: string;
  private readonly soaRecord: ResourceRecord<SoaRecordData>;
  private readonly rrsets = new Map<string, Map<number, ResourceRecord<ResourceRecordData>[]>>();

  constructor(origin: string, soa: ResourceRecord<SoaRecordData>) {
    this.origin = normalize(origin);
    this.soaRecord = soa;
    this.addRecord(soa as unknown as ResourceRecord<ResourceRecordData>);
  }

  get soa(): ResourceRecord<SoaRecordData> {
    return this.soaRecord;
  }

  addRecord(rr: ResourceRecord<ResourceRecordData>): void {
    const name = normalize(rr.name);
    if (!isWithinOrigin(name, this.origin)) {
      throw new ZoneError(
        `record owner "${rr.name}" is outside zone "${this.origin}"`);
    }
    if (rr.data.type === RRType.SOA && name !== this.origin) {
      throw new ZoneError(
        `SOA records may only appear at the zone apex "${this.origin}", not "${rr.name}"`);
    }

    let byType = this.rrsets.get(name);
    if (!byType) {
      byType = new Map();
      this.rrsets.set(name, byType);
    }
    const existing = byType.get(rr.data.type);
    if (existing) {
      existing.push(rr);
    } else {
      byType.set(rr.data.type, [rr]);
    }
  }

  getRRSet(name: string, type: number): readonly ResourceRecord<ResourceRecordData>[] | undefined {
    return this.rrsets.get(normalize(name))?.get(type);
  }

  private hasAnyRecord(name: string): boolean {
    return this.rrsets.has(normalize(name));
  }

  private findEnclosingDelegation(name: string): readonly ResourceRecord<NsRecordData>[] | null {
    let ancestor = parentOf(name);
    while (ancestor !== null && isWithinOrigin(ancestor, this.origin) && ancestor !== this.origin) {
      const ns = this.rrsets.get(ancestor)?.get(RRType.NS);
      if (ns) return ns as ResourceRecord<NsRecordData>[];
      ancestor = parentOf(ancestor);
    }
    return null;
  }

  lookup(qname: string, qtype: number, depth = 0): ZoneLookupResult {
    const name = normalize(qname);

    const enclosingDelegation = this.findEnclosingDelegation(name);
    if (enclosingDelegation) {
      return { kind: 'delegation', nsRecords: enclosingDelegation };
    }

    const ownRrsets = this.rrsets.get(name);
    const ownNs = ownRrsets?.get(RRType.NS);
    if (ownNs && name !== this.origin && qtype !== RRType.NS) {
      return { kind: 'delegation', nsRecords: ownNs as ResourceRecord<NsRecordData>[] };
    }

    const exact = ownRrsets?.get(qtype);
    if (exact) {
      return { kind: 'answer', records: exact };
    }

    const cname = ownRrsets?.get(RRType.CNAME);
    if (cname && qtype !== RRType.CNAME) {
      const chainHead = cname[0] as ResourceRecord<CnameRecordData>;
      if (depth >= MAX_CNAME_CHAIN_DEPTH) {
        throw new ZoneError(`CNAME chain from "${qname}" exceeds ${MAX_CNAME_CHAIN_DEPTH} hops (possible loop)`);
      }
      const target = normalize(chainHead.data.cname);
      if (!isWithinOrigin(target, this.origin)) {
        return { kind: 'cname', chain: [chainHead], finalRecords: null };
      }
      const targetResult = this.lookup(target, qtype, depth + 1);
      if (targetResult.kind === 'answer') {
        return { kind: 'cname', chain: [chainHead], finalRecords: targetResult.records };
      }
      if (targetResult.kind === 'cname') {
        return {
          kind: 'cname',
          chain: [chainHead, ...targetResult.chain],
          finalRecords: targetResult.finalRecords,
        };
      }
      return { kind: 'cname', chain: [chainHead], finalRecords: null };
    }

    if (ownRrsets && this.hasAnyRecord(name)) {
      return { kind: 'nodata' };
    }

    return { kind: 'nxdomain' };
  }
}
