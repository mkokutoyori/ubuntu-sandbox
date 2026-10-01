import { makeDnskeyRecord, makeDsRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, DnskeyRecordData, DsRecordData } from '@/network/dns/wire/ResourceRecord';
import { sha1, sha256 } from '@/crypto/hash';
import { bytesToBase64, bytesToHex } from '@/crypto/encoding';
import {
  DnssecAlgorithmNumber, generateDnssecKey, type DnssecPrivateKey,
} from '@/network/dns/dnssec/DnssecAlgorithms';
import { canonicalOwnerName, dnskeyRdata, keyTagOfRdata } from '@/network/dns/dnssec/DnssecWire';

export const DnssecAlgorithm = DnssecAlgorithmNumber;

export const DnssecDigestType = {
  SHA1: 1,
  SHA256: 2,
} as const;

export const DNSKEY_FLAG_ZSK = 256;
export const DNSKEY_FLAG_KSK = 257;

export type ZoneKeyRole = 'zsk' | 'ksk';

const privateKeys = new WeakMap<object, DnssecPrivateKey>();

export function privateKeyOf(key: ResourceRecord<DnskeyRecordData>): DnssecPrivateKey | undefined {
  return privateKeys.get(key.data);
}

export function generateZoneKey(
  origin: string,
  role: ZoneKeyRole,
  ttl: number,
  algorithm: number = DnssecAlgorithm.ECDSAP256SHA256,
  seed: string = '',
): ResourceRecord<DnskeyRecordData> {
  const flags = role === 'ksk' ? DNSKEY_FLAG_KSK : DNSKEY_FLAG_ZSK;
  const generated = generateDnssecKey(algorithm, `${origin}|${role}|${algorithm}|${seed}`);
  const record = makeDnskeyRecord(origin, ttl, {
    flags, algorithm, publicKey: bytesToBase64(generated.publicKey),
  });
  privateKeys.set(record.data, generated.privateKey);
  return record;
}

export function keyTagOf(key: DnskeyRecordData): number {
  return keyTagOfRdata(dnskeyRdata(key), key.algorithm);
}

export function isKsk(key: DnskeyRecordData): boolean {
  return key.flags === DNSKEY_FLAG_KSK;
}

export function dsDigestOf(
  owner: string, key: DnskeyRecordData, digestType: number = DnssecDigestType.SHA256,
): string {
  const input = Uint8Array.from([...canonicalOwnerName(owner), ...dnskeyRdata(key)]);
  const digest = digestType === DnssecDigestType.SHA1 ? sha1(input) : sha256(input);
  return bytesToHex(digest).toUpperCase();
}

export function makeDsForKey(
  owner: string, ttl: number, key: ResourceRecord<DnskeyRecordData>,
  digestType: number = DnssecDigestType.SHA256,
): ResourceRecord<DsRecordData> {
  return makeDsRecord(owner, ttl, {
    keyTag: keyTagOf(key.data),
    algorithm: key.data.algorithm,
    digestType,
    digest: dsDigestOf(owner, key.data, digestType),
  });
}

export function dsMatchesKey(owner: string, ds: DsRecordData, key: DnskeyRecordData): boolean {
  if (ds.digestType !== DnssecDigestType.SHA1 && ds.digestType !== DnssecDigestType.SHA256) return false;
  return ds.keyTag === keyTagOf(key) &&
    ds.algorithm === key.algorithm &&
    ds.digest.toUpperCase() === dsDigestOf(owner, key, ds.digestType);
}
