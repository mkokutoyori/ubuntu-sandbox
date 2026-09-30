import { encodeCanonicalName, encodeCanonicalRData } from '@/network/dns/wire/DnsMessageCodec';
import { base64ToBytes } from '@/crypto/encoding';
import type {
  ResourceRecord, ResourceRecordData, DnskeyRecordData, RrsigRecordData,
} from '@/network/dns/wire/ResourceRecord';

const ALGORITHM_RSAMD5 = 1;

function uint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function uint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function labelCountOf(name: string): number {
  const trimmed = name.toLowerCase().replace(/\.$/, '');
  if (trimmed === '') return 0;
  const labels = trimmed.split('.');
  return labels[0] === '*' ? labels.length - 1 : labels.length;
}

export function dnskeyRdata(key: DnskeyRecordData): Uint8Array {
  const material = base64ToBytes(key.publicKey);
  const out = new Uint8Array(4 + material.length);
  out[0] = (key.flags >>> 8) & 0xff;
  out[1] = key.flags & 0xff;
  out[2] = key.protocol & 0xff;
  out[3] = key.algorithm & 0xff;
  out.set(material, 4);
  return out;
}

export function keyTagOfRdata(rdata: Uint8Array, algorithm: number): number {
  if (algorithm === ALGORITHM_RSAMD5) {
    return (rdata[rdata.length - 3] << 8) | rdata[rdata.length - 2];
  }
  let accumulator = 0;
  for (let i = 0; i < rdata.length; i++) {
    accumulator += (i & 1) === 1 ? rdata[i] : rdata[i] << 8;
  }
  accumulator += (accumulator >>> 16) & 0xffff;
  return accumulator & 0xffff;
}

export function canonicalOwnerName(name: string): Uint8Array {
  return Uint8Array.from(encodeCanonicalName(name));
}

function compareOctets(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function rrsigRdataWithoutSignature(rrsig: RrsigRecordData): Uint8Array {
  return Uint8Array.from([
    ...uint16(rrsig.typeCovered),
    rrsig.algorithm & 0xff,
    rrsig.labels & 0xff,
    ...uint32(rrsig.originalTtl),
    ...uint32(rrsig.expiration),
    ...uint32(rrsig.inception),
    ...uint16(rrsig.keyTag),
    ...encodeCanonicalName(rrsig.signerName),
  ]);
}

function signedOwner(name: string, labels: number): string {
  const trimmed = name.toLowerCase().replace(/\.$/, '');
  const parts = trimmed === '' ? [] : trimmed.split('.');
  if (labels >= parts.length) return trimmed;
  return ['*', ...parts.slice(parts.length - labels)].join('.');
}

export function signedData(
  rrsig: RrsigRecordData, records: readonly ResourceRecord<ResourceRecordData>[],
): Uint8Array {
  const owner = canonicalOwnerName(signedOwner(records[0].name, rrsig.labels));
  const type = uint16(records[0].data.type);
  const rrClass = uint16(records[0].rrClass);
  const ttl = uint32(rrsig.originalTtl);

  const rdatas = records.map((rr) => encodeCanonicalRData(rr.data)).sort(compareOctets);
  const unique = rdatas.filter((rdata, index) => index === 0 || compareOctets(rdatas[index - 1], rdata) !== 0);

  const out: number[] = [...rrsigRdataWithoutSignature(rrsig)];
  for (const rdata of unique) {
    out.push(...owner, ...type, ...rrClass, ...ttl, ...uint16(rdata.length), ...rdata);
  }
  return Uint8Array.from(out);
}
