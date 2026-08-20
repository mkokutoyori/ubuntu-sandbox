import { makeDnskeyRecord, makeDsRecord, rdataKey } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, DnskeyRecordData, DsRecordData } from '@/network/dns/wire/ResourceRecord';
import { simulatedDigest, simulatedKeyTag } from '@/network/dns/dnssec/Digest';

export const DnssecAlgorithm = {
  RSASHA256: 8,
  ECDSAP256SHA256: 13,
} as const;

export const DnssecDigestType = {
  SHA256: 2,
} as const;

export const DNSKEY_FLAG_ZSK = 256;
export const DNSKEY_FLAG_KSK = 257;

export type ZoneKeyRole = 'zsk' | 'ksk';

export function generateZoneKey(
  origin: string,
  role: ZoneKeyRole,
  ttl: number,
  algorithm: number = DnssecAlgorithm.ECDSAP256SHA256,
  seed: string = '',
): ResourceRecord<DnskeyRecordData> {
  const flags = role === 'ksk' ? DNSKEY_FLAG_KSK : DNSKEY_FLAG_ZSK;
  const publicKey = `sim-${algorithm}-${simulatedDigest(`${origin}|${role}|${algorithm}|${seed}`)}`;
  return makeDnskeyRecord(origin, ttl, { flags, algorithm, publicKey });
}

export function keyTagOf(key: DnskeyRecordData): number {
  return simulatedKeyTag(rdataKey(key));
}

export function isKsk(key: DnskeyRecordData): boolean {
  return key.flags === DNSKEY_FLAG_KSK;
}

export function dsDigestOf(owner: string, key: DnskeyRecordData): string {
  return simulatedDigest(`${owner.toLowerCase()}|${rdataKey(key)}`);
}

export function makeDsForKey(
  owner: string, ttl: number, key: ResourceRecord<DnskeyRecordData>,
): ResourceRecord<DsRecordData> {
  return makeDsRecord(owner, ttl, {
    keyTag: keyTagOf(key.data),
    algorithm: key.data.algorithm,
    digestType: DnssecDigestType.SHA256,
    digest: dsDigestOf(owner, key.data),
  });
}

export function dsMatchesKey(owner: string, ds: DsRecordData, key: DnskeyRecordData): boolean {
  return ds.keyTag === keyTagOf(key) &&
    ds.algorithm === key.algorithm &&
    ds.digest === dsDigestOf(owner, key);
}
