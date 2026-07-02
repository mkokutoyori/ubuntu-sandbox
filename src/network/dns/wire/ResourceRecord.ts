import { IPAddress, IPv6Address } from '@/network/core/types';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';

export class DnsNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsNameError';
  }
}

export class DnsRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsRecordError';
  }
}

const MAX_LABEL_OCTETS = 63;
const MAX_NAME_OCTETS = 255;
const MAX_TTL = 0x7fffffff;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const MAX_CHARACTER_STRING_OCTETS = 255;

export function validateDnsName(name: string): void {
  if (name === '' || name === '.') return;

  const labels = name.split('.');
  const effectiveLabels = labels[labels.length - 1] === '' ? labels.slice(0, -1) : labels;

  if (effectiveLabels.length === 0) return;

  let wireLength = 1;
  for (const label of effectiveLabels) {
    if (label.length === 0) {
      throw new DnsNameError(`domain name "${name}" contains an empty label`);
    }
    if (label.length > MAX_LABEL_OCTETS) {
      throw new DnsNameError(
        `label "${label}" exceeds the maximum of ${MAX_LABEL_OCTETS} octets (RFC 1035 §3.1)`);
    }
    wireLength += label.length + 1;
  }

  if (wireLength > MAX_NAME_OCTETS) {
    throw new DnsNameError(
      `domain name "${name}" exceeds the maximum wire length of ${MAX_NAME_OCTETS} octets (RFC 1035 §3.1)`);
  }
}

function validateTtl(ttl: number): void {
  if (ttl < 0) {
    throw new DnsRecordError(`TTL must not be negative, got ${ttl}`);
  }
  if (ttl > MAX_TTL) {
    throw new DnsRecordError(
      `TTL must fit in a signed 32-bit integer (RFC 1035 §3.2.1), got ${ttl}`);
  }
}

function validateUint16(value: number, fieldName: string): void {
  if (value < 0 || value > MAX_UINT16) {
    throw new DnsRecordError(
      `${fieldName} must fit in an unsigned 16-bit integer (0-${MAX_UINT16}), got ${value}`);
  }
}

function validateUint32(value: number, fieldName: string): void {
  if (value < 0 || value > MAX_UINT32) {
    throw new DnsRecordError(
      `${fieldName} must fit in an unsigned 32-bit integer (0-${MAX_UINT32}), got ${value}`);
  }
}

function validateCharacterString(text: string): void {
  if (text.length > MAX_CHARACTER_STRING_OCTETS) {
    throw new DnsRecordError(
      `character-string exceeds the maximum of ${MAX_CHARACTER_STRING_OCTETS} octets (RFC 1035 §3.3), got ${text.length}`);
  }
}

export interface ARecordData {
  readonly type: typeof RRType.A;
  readonly address: IPAddress;
}

export interface AaaaRecordData {
  readonly type: typeof RRType.AAAA;
  readonly address: IPv6Address;
}

export interface NsRecordData {
  readonly type: typeof RRType.NS;
  readonly nsdname: string;
}

export interface CnameRecordData {
  readonly type: typeof RRType.CNAME;
  readonly cname: string;
}

export interface PtrRecordData {
  readonly type: typeof RRType.PTR;
  readonly ptrdname: string;
}

export interface SoaRecordData {
  readonly type: typeof RRType.SOA;
  readonly mname: string;
  readonly rname: string;
  readonly serial: number;
  readonly refresh: number;
  readonly retry: number;
  readonly expire: number;
  readonly minimum: number;
}

export interface MxRecordData {
  readonly type: typeof RRType.MX;
  readonly preference: number;
  readonly exchange: string;
}

export interface TxtRecordData {
  readonly type: typeof RRType.TXT;
  readonly text: readonly string[];
}

export interface SrvRecordData {
  readonly type: typeof RRType.SRV;
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly target: string;
}

export interface OptRecordData {
  readonly type: typeof RRType.OPT;
  readonly udpPayloadSize: number;
  readonly version: number;
  readonly dnssecOk: boolean;
  readonly extendedRcodeHigh: number;
}

export interface DnskeyRecordData {
  readonly type: typeof RRType.DNSKEY;
  readonly flags: number;
  readonly protocol: number;
  readonly algorithm: number;
  readonly publicKey: string;
}

export interface RrsigRecordData {
  readonly type: typeof RRType.RRSIG;
  readonly typeCovered: number;
  readonly algorithm: number;
  readonly labels: number;
  readonly originalTtl: number;
  readonly expiration: number;
  readonly inception: number;
  readonly keyTag: number;
  readonly signerName: string;
  readonly signature: string;
}

export interface DsRecordData {
  readonly type: typeof RRType.DS;
  readonly keyTag: number;
  readonly algorithm: number;
  readonly digestType: number;
  readonly digest: string;
}

export interface NsecRecordData {
  readonly type: typeof RRType.NSEC;
  readonly nextDomainName: string;
  readonly types: readonly number[];
}

export type ResourceRecordData =
  | ARecordData
  | AaaaRecordData
  | NsRecordData
  | CnameRecordData
  | PtrRecordData
  | SoaRecordData
  | MxRecordData
  | TxtRecordData
  | SrvRecordData
  | OptRecordData
  | DnskeyRecordData
  | RrsigRecordData
  | DsRecordData
  | NsecRecordData;

export interface ResourceRecord<TData extends ResourceRecordData = ResourceRecordData> {
  readonly name: string;
  readonly ttl: number;
  readonly rrClass: DnsClass | number;
  readonly data: TData;
}

function buildRecordBase(name: string, ttl: number): { name: string; ttl: number; rrClass: DnsClass } {
  validateDnsName(name);
  validateTtl(ttl);
  return { name, ttl, rrClass: DnsClass.IN };
}

export function makeARecord(name: string, ttl: number, address: string): ResourceRecord<ARecordData> {
  const base = buildRecordBase(name, ttl);
  return { ...base, data: { type: RRType.A, address: new IPAddress(address) } };
}

export function makeAaaaRecord(name: string, ttl: number, address: string): ResourceRecord<AaaaRecordData> {
  const base = buildRecordBase(name, ttl);
  return { ...base, data: { type: RRType.AAAA, address: new IPv6Address(address) } };
}

export function makeNsRecord(name: string, ttl: number, nsdname: string): ResourceRecord<NsRecordData> {
  const base = buildRecordBase(name, ttl);
  validateDnsName(nsdname);
  return { ...base, data: { type: RRType.NS, nsdname } };
}

export function makeCnameRecord(name: string, ttl: number, cname: string): ResourceRecord<CnameRecordData> {
  const base = buildRecordBase(name, ttl);
  validateDnsName(cname);
  return { ...base, data: { type: RRType.CNAME, cname } };
}

export function makePtrRecord(name: string, ttl: number, ptrdname: string): ResourceRecord<PtrRecordData> {
  const base = buildRecordBase(name, ttl);
  validateDnsName(ptrdname);
  return { ...base, data: { type: RRType.PTR, ptrdname } };
}

export interface SoaTimers {
  readonly mname: string;
  readonly rname: string;
  readonly serial: number;
  readonly refresh: number;
  readonly retry: number;
  readonly expire: number;
  readonly minimum: number;
}

export function makeSoaRecord(name: string, ttl: number, timers: SoaTimers): ResourceRecord<SoaRecordData> {
  const base = buildRecordBase(name, ttl);
  validateDnsName(timers.mname);
  validateDnsName(timers.rname);
  validateUint32(timers.serial, 'serial');
  validateUint32(timers.refresh, 'refresh');
  validateUint32(timers.retry, 'retry');
  validateUint32(timers.expire, 'expire');
  validateUint32(timers.minimum, 'minimum');
  return {
    ...base,
    data: {
      type: RRType.SOA,
      mname: timers.mname,
      rname: timers.rname,
      serial: timers.serial,
      refresh: timers.refresh,
      retry: timers.retry,
      expire: timers.expire,
      minimum: timers.minimum,
    },
  };
}

export function makeMxRecord(
  name: string, ttl: number, preference: number, exchange: string,
): ResourceRecord<MxRecordData> {
  const base = buildRecordBase(name, ttl);
  validateUint16(preference, 'preference');
  validateDnsName(exchange);
  return { ...base, data: { type: RRType.MX, preference, exchange } };
}

export function makeTxtRecord(
  name: string, ttl: number, textOrSegments: string | readonly string[],
): ResourceRecord<TxtRecordData> {
  const base = buildRecordBase(name, ttl);
  const segments = typeof textOrSegments === 'string' ? [textOrSegments] : textOrSegments;
  segments.forEach(validateCharacterString);
  return { ...base, data: { type: RRType.TXT, text: [...segments] } };
}

export interface SrvTarget {
  readonly priority: number;
  readonly weight: number;
  readonly port: number;
  readonly target: string;
}

export function makeSrvRecord(name: string, ttl: number, target: SrvTarget): ResourceRecord<SrvRecordData> {
  const base = buildRecordBase(name, ttl);
  validateUint16(target.priority, 'priority');
  validateUint16(target.weight, 'weight');
  validateUint16(target.port, 'port');
  validateDnsName(target.target);
  return {
    ...base,
    data: {
      type: RRType.SRV,
      priority: target.priority,
      weight: target.weight,
      port: target.port,
      target: target.target,
    },
  };
}

export function makeDnskeyRecord(
  name: string, ttl: number,
  key: { flags: number; algorithm: number; publicKey: string; protocol?: number },
): ResourceRecord<DnskeyRecordData> {
  const base = buildRecordBase(name, ttl);
  validateUint16(key.flags, 'flags');
  return {
    ...base,
    data: {
      type: RRType.DNSKEY,
      flags: key.flags,
      protocol: key.protocol ?? 3,
      algorithm: key.algorithm,
      publicKey: key.publicKey,
    },
  };
}

export interface RrsigFields {
  readonly typeCovered: number;
  readonly algorithm: number;
  readonly labels: number;
  readonly originalTtl: number;
  readonly expiration: number;
  readonly inception: number;
  readonly keyTag: number;
  readonly signerName: string;
  readonly signature: string;
}

export function makeRrsigRecord(name: string, ttl: number, fields: RrsigFields): ResourceRecord<RrsigRecordData> {
  const base = buildRecordBase(name, ttl);
  validateUint16(fields.typeCovered, 'typeCovered');
  validateUint16(fields.keyTag, 'keyTag');
  validateUint32(fields.expiration, 'expiration');
  validateUint32(fields.inception, 'inception');
  validateDnsName(fields.signerName);
  return { ...base, data: { type: RRType.RRSIG, ...fields } };
}

export function makeDsRecord(
  name: string, ttl: number,
  fields: { keyTag: number; algorithm: number; digestType: number; digest: string },
): ResourceRecord<DsRecordData> {
  const base = buildRecordBase(name, ttl);
  validateUint16(fields.keyTag, 'keyTag');
  return { ...base, data: { type: RRType.DS, ...fields } };
}

export function makeNsecRecord(
  name: string, ttl: number, nextDomainName: string, types: readonly number[],
): ResourceRecord<NsecRecordData> {
  const base = buildRecordBase(name, ttl);
  validateDnsName(nextDomainName);
  return { ...base, data: { type: RRType.NSEC, nextDomainName, types: [...types].sort((a, b) => a - b) } };
}

export function rdataKey(data: ResourceRecordData): string {
  switch (data.type) {
    case RRType.A:
    case RRType.AAAA:
      return `a|${data.address.toString()}`;
    case RRType.NS:
      return `ns|${data.nsdname.toLowerCase()}`;
    case RRType.CNAME:
      return `cname|${data.cname.toLowerCase()}`;
    case RRType.PTR:
      return `ptr|${data.ptrdname.toLowerCase()}`;
    case RRType.SOA:
      return `soa|${data.mname}|${data.rname}|${data.serial}`;
    case RRType.MX:
      return `mx|${data.preference}|${data.exchange.toLowerCase()}`;
    case RRType.TXT:
      return `txt|${data.text.join(' ')}`;
    case RRType.SRV:
      return `srv|${data.priority}|${data.weight}|${data.port}|${data.target.toLowerCase()}`;
    case RRType.DNSKEY:
      return `dnskey|${data.flags}|${data.algorithm}|${data.publicKey}`;
    case RRType.RRSIG:
      return `rrsig|${data.typeCovered}|${data.keyTag}|${data.signerName.toLowerCase()}|${data.signature}`;
    case RRType.DS:
      return `ds|${data.keyTag}|${data.algorithm}|${data.digestType}|${data.digest}`;
    case RRType.NSEC:
      return `nsec|${data.nextDomainName.toLowerCase()}|${data.types.join(',')}`;
    default:
      return JSON.stringify(data);
  }
}
