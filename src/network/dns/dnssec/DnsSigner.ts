import { RRType } from '@/network/dns/wire/RRType';
import { makeRrsigRecord, rdataKey } from '@/network/dns/wire/ResourceRecord';
import type {
  ResourceRecord, ResourceRecordData, DnskeyRecordData, RrsigRecordData,
} from '@/network/dns/wire/ResourceRecord';
import type { Zone } from '@/network/dns/zone/Zone';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { keyTagOf, isKsk } from '@/network/dns/dnssec/DnsKey';
import { buildNsecChain } from '@/network/dns/dnssec/Nsec';

export interface SignatureWindow {
  readonly inception: number;
  readonly expiration: number;
}

const DEFAULT_VALIDITY_SECONDS = 30 * 86400;

export function defaultSignatureWindow(nowSeconds: number = Math.floor(Date.now() / 1000)): SignatureWindow {
  return { inception: nowSeconds - 3600, expiration: nowSeconds + DEFAULT_VALIDITY_SECONDS };
}

function labelCount(name: string): number {
  const trimmed = name.toLowerCase().replace(/\.$/, '');
  return trimmed === '' ? 0 : trimmed.split('.').length;
}

export function canonicalRRSetForm(records: readonly ResourceRecord<ResourceRecordData>[]): string {
  const first = records[0];
  const rdata = records.map((rr) => rdataKey(rr.data)).sort().join('#');
  return `${first.name.toLowerCase().replace(/\.$/, '')}|${first.data.type}|${first.ttl}|${rdata}`;
}

export function computeSignature(
  key: DnskeyRecordData,
  canonicalForm: string,
  window: SignatureWindow,
): string {
  return simulatedDigest(`${rdataKey(key)}|${window.inception}|${window.expiration}|${canonicalForm}`);
}

export function signRRSet(
  records: readonly ResourceRecord<ResourceRecordData>[],
  signerName: string,
  key: ResourceRecord<DnskeyRecordData>,
  window: SignatureWindow,
): ResourceRecord<RrsigRecordData> {
  const first = records[0];
  const canonicalForm = canonicalRRSetForm(records);
  return makeRrsigRecord(first.name, first.ttl, {
    typeCovered: first.data.type,
    algorithm: key.data.algorithm,
    labels: labelCount(first.name),
    originalTtl: first.ttl,
    expiration: window.expiration,
    inception: window.inception,
    keyTag: keyTagOf(key.data),
    signerName,
    signature: computeSignature(key.data, canonicalForm, window),
  });
}

export interface ZoneSigningKeys {
  readonly zsk: ResourceRecord<DnskeyRecordData>;
  readonly ksk: ResourceRecord<DnskeyRecordData>;
}

export function signZone(zone: Zone, keys: ZoneSigningKeys, window?: SignatureWindow): void {
  const signatureWindow = window ?? defaultSignatureWindow();
  zone.addRecord(keys.zsk as ResourceRecord<ResourceRecordData>);
  zone.addRecord(keys.ksk as ResourceRecord<ResourceRecordData>);

  for (const nsec of buildNsecChain(zone)) {
    zone.addRecord(nsec as ResourceRecord<ResourceRecordData>);
  }

  const rrsetsByOwnerAndType = new Map<string, ResourceRecord<ResourceRecordData>[]>();
  for (const rr of zone.allRecords()) {
    if (rr.data.type === RRType.RRSIG) continue;
    const key = `${rr.name.toLowerCase()}|${rr.data.type}`;
    const set = rrsetsByOwnerAndType.get(key);
    if (set) set.push(rr);
    else rrsetsByOwnerAndType.set(key, [rr]);
  }

  for (const records of rrsetsByOwnerAndType.values()) {
    const signingKey = records[0].data.type === RRType.DNSKEY ? keys.ksk : keys.zsk;
    zone.addRecord(signRRSet(records, zone.origin, signingKey, signatureWindow) as ResourceRecord<ResourceRecordData>);
  }
}

export function verifySignature(
  records: readonly ResourceRecord<ResourceRecordData>[],
  rrsig: RrsigRecordData,
  key: DnskeyRecordData,
  nowSeconds: number,
): boolean {
  if (nowSeconds < rrsig.inception || nowSeconds > rrsig.expiration) return false;
  if (rrsig.keyTag !== keyTagOf(key)) return false;
  if (rrsig.algorithm !== key.algorithm) return false;
  const expected = computeSignature(key, canonicalRRSetForm(records), {
    inception: rrsig.inception, expiration: rrsig.expiration,
  });
  return expected === rrsig.signature;
}

export function selectKskFrom(keys: readonly DnskeyRecordData[]): DnskeyRecordData | null {
  return keys.find(isKsk) ?? keys[0] ?? null;
}
