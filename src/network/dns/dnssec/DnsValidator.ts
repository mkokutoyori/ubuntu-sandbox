import { simulationNowMs } from '@/network/core/SystemClock';

import { RRType } from '@/network/dns/wire/RRType';
import { normalizeDnsName as normalize } from '@/network/dns/wire/DnsName';
import type {
  ResourceRecord, ResourceRecordData, DnskeyRecordData, RrsigRecordData, DsRecordData, NsecRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { verifySignature } from '@/network/dns/dnssec/DnsSigner';
import { isSupportedAlgorithm } from '@/network/dns/dnssec/DnssecAlgorithms';
import { isWithinDomain, parentName } from '@/network/dns/wire/DnsName';
import { labelCountOf } from '@/network/dns/dnssec/DnssecWire';
import { dsMatchesKey } from '@/network/dns/dnssec/DnsKey';
import { nsecCovers } from '@/network/dns/dnssec/Nsec';

export type DnssecStatus = 'secure' | 'insecure' | 'bogus';

export interface ChainLookupResult {
  readonly status: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  readonly records: readonly ResourceRecord<ResourceRecordData>[];
  readonly authorities?: readonly ResourceRecord<ResourceRecordData>[];
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

function commonAncestor(a: string, b: string): string {
  const left = normalize(a).split('.').filter((l) => l !== '').reverse();
  const right = normalize(b).split('.').filter((l) => l !== '').reverse();
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i++) shared.push(left[i]);
  return shared.reverse().join('.');
}

function closestEncloserFrom(qname: string, nsec: ResourceRecord<NsecRecordData>): string {
  const fromOwner = commonAncestor(qname, nsec.name);
  const fromNext = commonAncestor(qname, nsec.data.nextDomainName);
  return fromOwner.length >= fromNext.length ? fromOwner : fromNext;
}

export function capTtlsToSignatures(
  records: readonly ResourceRecord<ResourceRecordData>[], nowSeconds: number,
): ResourceRecord<ResourceRecordData>[] {
  const sigs = rrsigsOf(records);
  return records.map((rr) => {
    const covering = rr.data.type === RRType.RRSIG
      ? [rr as ResourceRecord<RrsigRecordData>]
      : sigs.filter((sig) => normalize(sig.name) === normalize(rr.name) && sig.data.typeCovered === rr.data.type);
    if (covering.length === 0) return rr;
    const ceiling = Math.min(...covering.map((sig) =>
      Math.min(sig.data.originalTtl, Math.max(0, sig.data.expiration - nowSeconds))));
    return rr.ttl <= ceiling ? rr : { ...rr, ttl: ceiling };
  });
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
    this.now = options.now ?? (() => Math.floor(simulationNowMs() / 1000));
    this.maxChainDepth = options.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
  }

  private anchorZoneFor(name: string): string | null {
    let best: string | null = null;
    for (const anchor of this.anchors) {
      const zone = normalize(anchor.name);
      if (isWithinDomain(normalize(name), zone) && (best === null || zone.length > best.length)) best = zone;
    }
    return best;
  }

  private async pathStatus(owner: string, includeOwner: boolean): Promise<DnssecStatus> {
    const target = normalize(owner);
    const anchorZone = this.anchorZoneFor(target);
    if (anchorZone === null) return 'insecure';

    const below: string[] = [];
    let cursor: string | null = includeOwner ? target : parentName(target);
    while (cursor !== null && cursor !== anchorZone && isWithinDomain(cursor, anchorZone)) {
      below.unshift(cursor);
      cursor = parentName(cursor);
    }
    for (const candidate of below) {
      const reply = await this.lookup(candidate, RRType.DS);
      if (reply.status === 'SERVFAIL') return 'bogus';
      const hasDs = reply.records.some((rr) => rr.data.type === RRType.DS && normalize(rr.name) === candidate);
      if (hasDs) continue;
      const verdict = await this.noDelegationProof(candidate, reply.authorities ?? []);
      if (verdict === 'bogus') return 'bogus';
      if (verdict === 'insecure') return 'insecure';
    }
    return 'secure';
  }

  private async noDelegationProof(
    candidate: string, authorities: readonly ResourceRecord<ResourceRecordData>[],
  ): Promise<'insecure' | 'notacut' | 'bogus'> {
    const nsecs = authorities.filter(
      (rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC);
    const exact = nsecs.find((nsec) => normalize(nsec.name) === candidate);
    const proof = exact ?? nsecs.find((nsec) => nsecCovers(candidate, nsec));
    if (!proof) return 'bogus';
    const sig = rrsigsOf(authorities).find(
      (candidateSig) => normalize(candidateSig.name) === normalize(proof.name)
        && candidateSig.data.typeCovered === RRType.NSEC);
    if (!sig) return 'bogus';
    const verdict = await this.verifyWithZoneKeys([proof], sig.data, 0);
    if (verdict === 'bogus') return 'bogus';
    if (verdict === 'insecure') return 'insecure';
    if (exact) {
      if (exact.data.types.includes(RRType.DS)) return 'bogus';
      return exact.data.types.includes(RRType.NS) && !exact.data.types.includes(RRType.SOA)
        ? 'insecure' : 'notacut';
    }
    return 'notacut';
  }

  async validateAnswer(
    records: readonly ResourceRecord<ResourceRecordData>[],
    authorities: readonly ResourceRecord<ResourceRecordData>[] = [],
  ): Promise<DnssecStatus> {
    const data = records.filter((rr) => rr.data.type !== RRType.RRSIG && rr.data.type !== RRType.OPT);
    if (data.length === 0) return 'insecure';
    const rrsigs = rrsigsOf(records);

    for (const rr of data) {
      const path = await this.pathStatus(rr.name, rr.data.type !== RRType.DS);
      if (path !== 'secure') return path;
    }

    const rrsets = new Map<string, ResourceRecord<ResourceRecordData>[]>();
    for (const rr of data) {
      const key = `${normalize(rr.name)}|${rr.data.type}`;
      const set = rrsets.get(key);
      if (set) set.push(rr);
      else rrsets.set(key, [rr]);
    }

    for (const set of rrsets.values()) {
      const first = set[0];
      const candidates = rrsigs.filter((sig) =>
        normalize(sig.name) === normalize(first.name) && sig.data.typeCovered === first.data.type
        && isWithinDomain(normalize(first.name), normalize(sig.data.signerName)));
      if (candidates.length === 0) return 'bogus';
      const usable = candidates.filter((sig) => isSupportedAlgorithm(sig.data.algorithm));
      if (usable.length === 0) return 'insecure';

      let verdict: DnssecStatus = 'bogus';
      for (const sig of usable) {
        const outcome = await this.verifyWithZoneKeys(set, sig.data, 0);
        if (outcome === 'secure') { verdict = 'secure'; break; }
        if (outcome === 'insecure') verdict = 'insecure';
      }
      if (verdict !== 'secure') return verdict;

      const expanded = candidates.some((sig) => sig.data.labels < labelCountOf(first.name));
      if (expanded) {
        const nsecs = authorities.filter(
          (rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC);
        if (!nsecs.some((nsec) => nsecCovers(first.name, nsec))) return 'bogus';
        const coverage = await this.validateNegative(first.name, authorities, true);
        if (coverage !== 'secure') return 'bogus';
      }
    }
    return 'secure';
  }

  async validateNegative(
    qname: string,
    authorities: readonly ResourceRecord<ResourceRecordData>[],
    nameError = false,
  ): Promise<DnssecStatus> {
    const path = await this.pathStatus(qname, true);
    if (path !== 'secure') return path;

    const nsecs = authorities.filter(
      (rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC,
    );
    if (nsecs.length === 0) return 'bogus';

    const proof = nsecs.find(
      (nsec) => nsecCovers(qname, nsec) || normalize(nsec.name) === normalize(qname),
    );
    if (!proof) return 'bogus';
    const used = [proof];

    if (nameError) {
      const encloser = closestEncloserFrom(qname, proof);
      const wildcard = encloser === '' ? '*' : `*.${encloser}`;
      const wildcardProof = nsecs.find((nsec) => nsecCovers(wildcard, nsec));
      if (!wildcardProof) return 'bogus';
      if (!used.includes(wildcardProof)) used.push(wildcardProof);
    }

    for (const nsec of used) {
      const rrsig = rrsigsOf(authorities).find(
        (sig) => normalize(sig.name) === normalize(nsec.name) && sig.data.typeCovered === RRType.NSEC,
      );
      if (!rrsig) return 'bogus';
      const verdict = await this.verifyWithZoneKeys([nsec], rrsig.data, 0);
      if (verdict !== 'secure') return verdict;
    }
    return 'secure';
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

    const trust = await this.trustedDigests(zoneName, depth);
    if (trust.status !== 'secure') return { status: trust.status, keys: trust.status === 'insecure' ? keys : [] };

    const entryKeys = keys.filter((key) => trust.digests.some((ds) => dsMatchesKey(zoneName, ds, key)));
    const selfSigs = rrsigsOf(reply.records).filter((sig) => sig.data.typeCovered === RRType.DNSKEY);
    const authenticated = selfSigs.some((sig) =>
      entryKeys.some((key) => verifySignature(keyRecords, sig.data, key, this.now())));
    return authenticated ? { status: 'secure', keys } : { status: 'bogus', keys: [] };
  }

  private async trustedDigests(
    zoneName: string, depth: number,
  ): Promise<{ status: DnssecStatus; digests: readonly DsRecordData[] }> {
    const anchored = this.anchors.filter((anchor) => normalize(anchor.name) === zoneName);
    if (anchored.length > 0) return { status: 'secure', digests: anchored.map((anchor) => anchor.data) };
    if (zoneName === '') return { status: 'insecure', digests: [] };

    const dsReply = await this.lookup(zoneName, RRType.DS);
    if (dsReply.status === 'SERVFAIL') return { status: 'bogus', digests: [] };

    const dsRecords = dsReply.records.filter(
      (rr): rr is ResourceRecord<DsRecordData> =>
        rr.data.type === RRType.DS && normalize(rr.name) === zoneName,
    );
    if (dsRecords.length === 0) {
      const proof = await this.noDelegationProof(zoneName, dsReply.authorities ?? []);
      return { status: proof === 'insecure' ? 'insecure' : 'bogus', digests: [] };
    }

    const candidates = rrsigsOf(dsReply.records).filter((sig) => sig.data.typeCovered === RRType.DS);
    for (const sig of candidates) {
      const parent = await this.verifyWithZoneKeys(dsRecords, sig.data, depth + 1);
      if (parent === 'secure') return { status: 'secure', digests: dsRecords.map((rr) => rr.data) };
      if (parent === 'insecure') return { status: 'insecure', digests: [] };
    }
    return { status: 'bogus', digests: [] };
  }
}
