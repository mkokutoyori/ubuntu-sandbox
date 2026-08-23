import { hmac } from '@/crypto/mac/hmac';
import { MD5, SHA1, SHA256 } from '@/crypto/hash';
import type { HashAlgorithm } from '@/crypto/hash';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import {
  encodeCanonicalName, writeUint48, decodeDnsMessageDetailed, encodeDnsMessage,
} from '@/network/dns/wire/DnsMessageCodec';
import { makeTsigRecord, type TsigRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export const TsigAlgorithm = {
  HMAC_MD5: 'hmac-md5.sig-alg.reg.int.',
  HMAC_SHA1: 'hmac-sha1.',
  HMAC_SHA256: 'hmac-sha256.',
} as const;

export const TsigErrorCode = {
  NOERROR: 0,
  BADSIG: 16,
  BADKEY: 17,
  BADTIME: 18,
} as const;

export const TSIG_DEFAULT_FUDGE = 300;

export interface TsigKey {
  readonly name: string;
  readonly algorithm: string;
  readonly secret: string;
}

export type TsigKeyLookup = (name: string) => TsigKey | undefined;

export function canonicalKeyName(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

export class TsigKeyring {
  private readonly keys = new Map<string, TsigKey>();

  add(key: TsigKey): void { this.keys.set(canonicalKeyName(key.name), key); }
  remove(name: string): boolean { return this.keys.delete(canonicalKeyName(name)); }
  get(name: string): TsigKey | undefined { return this.keys.get(canonicalKeyName(name)); }
  size(): number { return this.keys.size; }
  list(): TsigKey[] { return [...this.keys.values()]; }
  readonly lookup: TsigKeyLookup = (name) => this.get(name);
}

function hashFor(algorithm: string): HashAlgorithm | null {
  switch (`${canonicalKeyName(algorithm)}.`) {
    case TsigAlgorithm.HMAC_MD5: return MD5;
    case TsigAlgorithm.HMAC_SHA1: return SHA1;
    case TsigAlgorithm.HMAC_SHA256: return SHA256;
    default: return null;
  }
}

function secretBytes(secret: string): Uint8Array {
  const bytes = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) bytes[i] = secret.charCodeAt(i) & 0xff;
  return bytes;
}

function tsigVariables(keyName: string, data: Omit<TsigRecordData, 'type' | 'mac' | 'originalId'>): number[] {
  const out: number[] = [];
  for (const b of encodeCanonicalName(keyName)) out.push(b);
  out.push((DnsClass.ANY >> 8) & 0xff, DnsClass.ANY & 0xff);
  out.push(0, 0, 0, 0);
  for (const b of encodeCanonicalName(data.algorithm)) out.push(b);
  writeUint48(out, data.timeSigned);
  out.push((data.fudge >> 8) & 0xff, data.fudge & 0xff);
  out.push((data.error >> 8) & 0xff, data.error & 0xff);
  out.push((data.otherData.length >> 8) & 0xff, data.otherData.length & 0xff);
  for (const b of data.otherData) out.push(b);
  return out;
}

function macInput(
  strippedMessage: Uint8Array, keyName: string,
  data: Omit<TsigRecordData, 'type' | 'mac' | 'originalId'>,
  requestMac: Uint8Array | null,
): Uint8Array {
  const parts: number[] = [];
  if (requestMac) {
    parts.push((requestMac.length >> 8) & 0xff, requestMac.length & 0xff);
    for (const b of requestMac) parts.push(b);
  }
  for (const b of strippedMessage) parts.push(b);
  for (const b of tsigVariables(keyName, data)) parts.push(b);
  return Uint8Array.from(parts);
}

function withArcount(bytes: Uint8Array, count: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[10] = (count >> 8) & 0xff;
  copy[11] = count & 0xff;
  return copy;
}

function withId(bytes: Uint8Array, id: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[0] = (id >> 8) & 0xff;
  copy[1] = id & 0xff;
  return copy;
}

export interface TsigSignOptions {
  readonly key: TsigKey;
  readonly timeSigned: number;
  readonly fudge?: number;
  readonly error?: number;
  readonly otherData?: Uint8Array;
  readonly requestMac?: Uint8Array | null;
}

export class TsigAlgorithmError extends Error {}

export function tsigRecordFor(message: DnsMessage, options: TsigSignOptions) {
  const hash = hashFor(options.key.algorithm);
  if (!hash) throw new TsigAlgorithmError(`unsupported TSIG algorithm ${options.key.algorithm}`);

  const bare = encodeDnsMessage(message);
  const variables = {
    algorithm: options.key.algorithm,
    timeSigned: options.timeSigned,
    fudge: options.fudge ?? TSIG_DEFAULT_FUDGE,
    error: options.error ?? 0,
    otherData: options.otherData ?? new Uint8Array(0),
  };
  const mac = hmac(hash, secretBytes(options.key.secret),
    macInput(bare, options.key.name, variables, options.requestMac ?? null));

  return makeTsigRecord(options.key.name, { ...variables, mac, originalId: message.id });
}

export function signedDnsMessage(message: DnsMessage, options: TsigSignOptions): DnsMessage {
  return {
    ...message,
    additionals: [...message.additionals, tsigRecordFor(message, options)],
  };
}

export function signDnsMessage(message: DnsMessage, options: TsigSignOptions): Uint8Array {
  return encodeDnsMessage(signedDnsMessage(message, options));
}

export type TsigVerdict =
  | { readonly status: 'absent' }
  | { readonly status: 'malformed' }
  | { readonly status: 'ok'; readonly key: TsigKey; readonly mac: Uint8Array; readonly tsig: TsigRecordData }
  | { readonly status: 'badkey' | 'badsig' | 'badtime'; readonly keyName: string; readonly tsig: TsigRecordData };

export interface TsigVerifyOptions {
  readonly lookup: TsigKeyLookup;
  readonly now: number;
  readonly requestMac?: Uint8Array | null;
}

export function verifyDnsMessage(bytes: Uint8Array, options: TsigVerifyOptions): TsigVerdict {
  let decoded;
  try {
    decoded = decodeDnsMessageDetailed(bytes);
  } catch {
    return { status: 'malformed' };
  }
  const last = decoded.message.additionals[decoded.message.additionals.length - 1];
  if (!last || last.data.type !== RRType.TSIG || decoded.lastAdditionalOffset === null) {
    return { status: 'absent' };
  }
  const tsig = last.data as TsigRecordData;

  const key = options.lookup(canonicalKeyName(last.name));
  const hash = key ? hashFor(key.algorithm) : null;
  if (!key || !hash || canonicalKeyName(key.algorithm) !== canonicalKeyName(tsig.algorithm)) {
    return { status: 'badkey', keyName: last.name, tsig };
  }

  const stripped = withId(
    withArcount(bytes.slice(0, decoded.lastAdditionalOffset),
      decoded.message.additionals.length - 1),
    tsig.originalId);

  const expected = hmac(hash, secretBytes(key.secret), macInput(stripped, last.name, {
    algorithm: tsig.algorithm, timeSigned: tsig.timeSigned,
    fudge: tsig.fudge, error: tsig.error, otherData: tsig.otherData,
  }, options.requestMac ?? null));

  if (expected.length !== tsig.mac.length) return { status: 'badsig', keyName: last.name, tsig };
  let equal = 0;
  for (let i = 0; i < expected.length; i++) equal |= expected[i] ^ tsig.mac[i];
  if (equal !== 0) return { status: 'badsig', keyName: last.name, tsig };

  if (Math.abs(options.now - tsig.timeSigned) > tsig.fudge) {
    return { status: 'badtime', keyName: last.name, tsig };
  }
  return { status: 'ok', key, mac: tsig.mac, tsig };
}

export function tsigErrorCodeFor(status: TsigVerdict['status']): number {
  switch (status) {
    case 'badkey': return TsigErrorCode.BADKEY;
    case 'badsig': return TsigErrorCode.BADSIG;
    case 'badtime': return TsigErrorCode.BADTIME;
    case 'malformed': return TsigErrorCode.BADSIG;
    default: return TsigErrorCode.NOERROR;
  }
}
