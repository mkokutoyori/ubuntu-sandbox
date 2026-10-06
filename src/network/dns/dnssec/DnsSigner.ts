import { simulationNowMs } from '@/network/core/SystemClock';

import { RRType } from '@/network/dns/wire/RRType';
import { makeRrsigRecord } from '@/network/dns/wire/ResourceRecord';
import type {
  ResourceRecord, ResourceRecordData, DnskeyRecordData, RrsigRecordData,
} from '@/network/dns/wire/ResourceRecord';
import type { Zone } from '@/network/dns/zone/Zone';
import { bytesToBase64, base64ToBytes } from '@/crypto/encoding';
import { keyTagOf, isKsk, privateKeyOf } from '@/network/dns/dnssec/DnsKey';
import { signWithDnssecKey, verifyWithDnssecKey } from '@/network/dns/dnssec/DnssecAlgorithms';
import { labelCountOf, signedData } from '@/network/dns/dnssec/DnssecWire';
import { buildNsecChain, delegationCuts, isSignedRRset } from '@/network/dns/dnssec/Nsec';

export interface SignatureWindow {
  readonly inception: number;
  readonly expiration: number;
}

const DEFAULT_VALIDITY_SECONDS = 30 * 86400;

export function defaultSignatureWindow(nowSeconds: number = Math.floor(simulationNowMs() / 1000)): SignatureWindow {
  return { inception: nowSeconds - 3600, expiration: nowSeconds + DEFAULT_VALIDITY_SECONDS };
}

export function signRRSet(
  records: readonly ResourceRecord<ResourceRecordData>[],
  signerName: string,
  key: ResourceRecord<DnskeyRecordData>,
  window: SignatureWindow,
): ResourceRecord<RrsigRecordData> {
  const first = records[0];
  const privateKey = privateKeyOf(key);
  if (!privateKey) throw new Error(`no private key is held for DNSKEY ${key.name}`);
  const fields = {
    typeCovered: first.data.type as number,
    algorithm: key.data.algorithm,
    labels: labelCountOf(first.name),
    originalTtl: first.ttl,
    expiration: window.expiration,
    inception: window.inception,
    keyTag: keyTagOf(key.data),
    signerName,
  };
  const signature = signWithDnssecKey(
    privateKey, signedData({ type: RRType.RRSIG, ...fields, signature: '' }, records));
  return makeRrsigRecord(first.name, first.ttl, { ...fields, signature: bytesToBase64(signature) });
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

  const cuts = delegationCuts(zone);
  const rrsetsByOwnerAndType = new Map<string, ResourceRecord<ResourceRecordData>[]>();
  for (const rr of zone.allRecords()) {
    if (rr.data.type === RRType.RRSIG) continue;
    if (!isSignedRRset(rr.name, rr.data.type as number, zone.origin, cuts)) continue;
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
  if (records.length === 0) return false;
  if (nowSeconds < rrsig.inception || nowSeconds > rrsig.expiration) return false;
  if (rrsig.keyTag !== keyTagOf(key)) return false;
  if (rrsig.algorithm !== key.algorithm) return false;
  if (rrsig.typeCovered !== records[0].data.type) return false;
  if (rrsig.labels > labelCountOf(records[0].name)) return false;
  let signature: Uint8Array;
  let material: Uint8Array;
  try {
    signature = base64ToBytes(rrsig.signature);
    material = base64ToBytes(key.publicKey);
  } catch {
    return false;
  }
  return verifyWithDnssecKey(
    key.algorithm, material, signedData(rrsig, records), signature);
}

export function selectKskFrom(keys: readonly DnskeyRecordData[]): DnskeyRecordData | null {
  return keys.find(isKsk) ?? keys[0] ?? null;
}
