import { RRType } from '@/network/dns/wire/RRType';
import { normalizeDnsName as normalize } from '@/network/dns/wire/DnsName';
import type {
  ResourceRecord, ResourceRecordData, DnskeyRecordData, RrsigRecordData, DsRecordData, NsecRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { verifySignature } from '@/network/dns/dnssec/DnsSigner';
import { dsMatchesKey } from '@/network/dns/dnssec/DnsKey';
import { nsecCovers } from '@/network/dns/dnssec/Nsec';

export type DnssecStatus = 'secure' | 'insecure' | 'bogus';

export interface ChainLookupResult {
  readonly status: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
}

export type ChainLookup = (qname: string, qtype: number) => Promise<ChainLookupResult>;

export interface DnsValidatorOptions {
  readonly now?: () => number;
  readonly maxChainDepth?: number;
}

interface ZoneKeysVerdict {
  readonly status: DnssecStatus;
  readonly keys: readonly DnskeyRecordData[];
}

const DEFAULT_MAX_CHAIN_DEPTH = 8;

function rrsigsOf(records: readonly ResourceRecord<ResourceRecordData>[]): ResourceRecord<RrsigRecordData>[] {
  return records.filter(
    (rr): rr is ResourceRecord<RrsigRecordData> => rr.data.type === RRType.RRSIG,
  );
}

export class DnsValidator {
  private readonly now: () => number;
  private readonly maxChainDepth: number;
  private readonly zoneKeysCache = new Map<string, ZoneKeysVerdict>();

  constructor(
    private readonly lookup: ChainLookup,
    private readonly anchors: readonly ResourceRecord<DsRecordData>[],
    options: DnsValidatorOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.maxChainDepth = options.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  }

  async validateAnswer(records: readonly ResourceRecord<ResourceRecordData>[]): Promise<DnssecStatus> {
    const rrsigs = rrsigsOf(records);
    if (rrsigs.length === 0) return 'insecure';

    const rrsets = new Map<string, ResourceRecord<ResourceRecordData>[]>();
    for (const rr of records) {
      if (rr.data.type === RRType.RRSIG || rr.data.type === RRType.OPT) continue;
      const key = `${normalize(rr.name)}|${rr.data.type}`;
      const set = rrsets.get(key);
      if (set) set.push(rr);
      else rrsets.set(key, [rr]);
    }

    for (const set of rrsets.values()) {
      const first = set[0];
      const rrsig = rrsigs.find(
        (sig) => normalize(sig.name) === normalize(first.name) && sig.data.typeCovered === first.data.type,
      );
      if (!rrsig) return 'bogus';

      const verdict = await this.verifyWithZoneKeys(set, rrsig.data, 0);
      if (verdict !== 'secure') return verdict;
    }
    return 'secure';
  }

  async validateNegative(
    qname: string, authorities: readonly ResourceRecord<ResourceRecordData>[],
  ): Promise<DnssecStatus> {
    const nsecs = authorities.filter(
      (rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC,
    );
    if (nsecs.length === 0) return 'insecure';

    const proof = nsecs.find(
      (nsec) => nsecCovers(qname, nsec) || normalize(nsec.name) === normalize(qname),
    );
    if (!proof) return 'bogus';

    const rrsig = rrsigsOf(authorities).find(
      (sig) => normalize(sig.name) === normalize(proof.name) && sig.data.typeCovered === RRType.NSEC,
    );
    if (!rrsig) return 'bogus';

    return this.verifyWithZoneKeys([proof], rrsig.data, 0);
  }

  private async verifyWithZoneKeys(
    rrset: readonly ResourceRecord<ResourceRecordData>[],
    rrsig: RrsigRecordData,
    depth: number,
  ): Promise<DnssecStatus> {
    const zone = await this.zoneKeys(normalize(rrsig.signerName), depth);
    if (zone.status !== 'secure') return zone.status;

    const key = zone.keys.find((candidate) => verifySignature(rrset, rrsig, candidate, this.now()));
    return key ? 'secure' : 'bogus';
  }

  private async zoneKeys(zoneName: string, depth: number): Promise<ZoneKeysVerdict> {
    const cached = this.zoneKeysCache.get(zoneName);
    if (cached) return cached;
    if (depth > this.maxChainDepth) return { status: 'bogus', keys: [] };

    const verdict = await this.resolveZoneKeys(zoneName, depth);
    this.zoneKeysCache.set(zoneName, verdict);
    return verdict;
  }

  private async resolveZoneKeys(zoneName: string, depth: number): Promise<ZoneKeysVerdict> {
    const reply = await this.lookup(zoneName, RRType.DNSKEY);
    if (reply.status !== 'NOERROR') return { status: 'bogus', keys: [] };

    const keyRecords = reply.records.filter(
      (rr): rr is ResourceRecord<DnskeyRecordData> =>
        rr.data.type === RRType.DNSKEY && normalize(rr.name) === zoneName,
    );
    if (keyRecords.length === 0) return { status: 'bogus', keys: [] };

    const keys = keyRecords.map((rr) => rr.data);
    const selfSig = rrsigsOf(reply.records).find((sig) => sig.data.typeCovered === RRType.DNSKEY);
    if (!selfSig) return { status: 'bogus', keys: [] };

    const signingKey = keys.find((key) =>
      verifySignature(keyRecords, selfSig.data, key, this.now()));
    if (!signingKey) return { status: 'bogus', keys: [] };

    const anchored = this.anchors.filter((anchor) => normalize(anchor.name) === zoneName);
    if (anchored.length > 0) {
      const matches = anchored.some((anchor) =>
        keys.some((key) => dsMatchesKey(zoneName, anchor.data, key)));
      return { status: matches ? 'secure' : 'bogus', keys };
    }

    if (zoneName === '') return { status: 'insecure', keys };

    return this.verifyDelegation(zoneName, keys, depth);
  }

  private async verifyDelegation(
    zoneName: string, keys: readonly DnskeyRecordData[], depth: number,
  ): Promise<ZoneKeysVerdict> {
    const dsReply = await this.lookup(zoneName, RRType.DS);
    if (dsReply.status === 'SERVFAIL') return { status: 'bogus', keys: [] };

    const dsRecords = dsReply.records.filter(
      (rr): rr is ResourceRecord<DsRecordData> =>
        rr.data.type === RRType.DS && normalize(rr.name) === zoneName,
    );
    if (dsRecords.length === 0) return { status: 'insecure', keys };

    const dsSig = rrsigsOf(dsReply.records).find((sig) => sig.data.typeCovered === RRType.DS);
    if (!dsSig) return { status: 'bogus', keys: [] };

    const parentVerdict = await this.verifyWithZoneKeys(dsRecords, dsSig.data, depth + 1);
    if (parentVerdict !== 'secure') return { status: parentVerdict, keys: [] };

    const matched = dsRecords.some((ds) =>
      keys.some((key) => dsMatchesKey(zoneName, ds.data, key)));
    return { status: matched ? 'secure' : 'bogus', keys };
  }
}
