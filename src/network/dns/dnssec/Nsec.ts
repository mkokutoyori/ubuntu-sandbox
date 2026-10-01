import { RRType } from '@/network/dns/wire/RRType';
import { normalizeDnsName as normalize } from '@/network/dns/wire/DnsName';
import { makeNsecRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData, NsecRecordData } from '@/network/dns/wire/ResourceRecord';
import type { Zone } from '@/network/dns/zone/Zone';

export function canonicalNameCompare(a: string, b: string): number {
  const labelsA = normalize(a).split('.').reverse();
  const labelsB = normalize(b).split('.').reverse();
  const shared = Math.min(labelsA.length, labelsB.length);
  for (let i = 0; i < shared; i++) {
    if (labelsA[i] !== labelsB[i]) {
      return labelsA[i] < labelsB[i] ? -1 : 1;
    }
  }
  return labelsA.length - labelsB.length;
}

export function delegationCuts(zone: Zone): Set<string> {
  const cuts = new Set<string>();
  for (const rr of zone.allRecords()) {
    const owner = normalize(rr.name);
    if (rr.data.type === RRType.NS && owner !== zone.origin) cuts.add(owner);
  }
  return cuts;
}

export function isOccluded(name: string, cuts: ReadonlySet<string>): boolean {
  const owner = normalize(name);
  for (const cut of cuts) {
    if (owner !== cut && owner.endsWith(`.${cut}`)) return true;
  }
  return false;
}

export function isSignedRRset(
  name: string, type: number, zoneOrigin: string, cuts: ReadonlySet<string>,
): boolean {
  const owner = normalize(name);
  if (isOccluded(owner, cuts)) return false;
  return !(type === RRType.NS && owner !== zoneOrigin && cuts.has(owner));
}

export function buildNsecChain(zone: Zone): ResourceRecord<NsecRecordData>[] {
  const typesByOwner = new Map<string, Set<number>>();
  const cuts = delegationCuts(zone);
  for (const rr of zone.allRecords()) {
    const owner = normalize(rr.name);
    if (isOccluded(owner, cuts)) continue;
    const types = typesByOwner.get(owner) ?? new Set<number>();
    types.add(rr.data.type);
    typesByOwner.set(owner, types);
  }

  const owners = [...typesByOwner.keys()].sort(canonicalNameCompare);
  const ttl = zone.soa.data.minimum;

  return owners.map((owner, index) => {
    const next = owners[(index + 1) % owners.length];
    const types = [...typesByOwner.get(owner)!, RRType.NSEC, RRType.RRSIG];
    return makeNsecRecord(owner, ttl, next, types);
  });
}

export function nsecCovers(qname: string, nsec: ResourceRecord<NsecRecordData>): boolean {
  const name = normalize(qname);
  const owner = normalize(nsec.name);
  const next = normalize(nsec.data.nextDomainName);

  if (canonicalNameCompare(owner, next) < 0) {
    return canonicalNameCompare(owner, name) < 0 && canonicalNameCompare(name, next) < 0;
  }
  return canonicalNameCompare(owner, name) < 0 || canonicalNameCompare(name, next) < 0;
}

export function findCoveringNsec(zone: Zone, qname: string): ResourceRecord<NsecRecordData> | null {
  const nsecs = zone.allRecords().filter(
    (rr): rr is ResourceRecord<NsecRecordData> => rr.data.type === RRType.NSEC,
  );
  return nsecs.find((nsec) => nsecCovers(qname, nsec)) ?? null;
}

export function nsecProvesNxdomain(
  qname: string, records: readonly ResourceRecord<ResourceRecordData>[],
): boolean {
  return records.some(
    (rr) => rr.data.type === RRType.NSEC && nsecCovers(qname, rr as ResourceRecord<NsecRecordData>),
  );
}
