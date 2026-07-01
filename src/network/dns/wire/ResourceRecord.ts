import { IPAddress, IPv6Address } from '@/network/core/types';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';

/** RFC 1035 §3.1: a domain name is malformed (label/name length, empty label). */
export class DnsNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsNameError';
  }
}

/** A resource record's TTL or RDATA violates its RFC-mandated constraints. */
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

/**
 * Validate a domain name against RFC 1035 §3.1 (label/name length limits)
 * and §2.3.4 (no empty labels except the root).
 */
export function validateDnsName(name: string): void {
  if (name === '' || name === '.') return;

  const labels = name.split('.');
  // A trailing dot (fully-qualified name) yields one trailing empty label,
  // which is legal — only genuinely empty labels elsewhere are rejected.
  const effectiveLabels = labels[labels.length - 1] === '' ? labels.slice(0, -1) : labels;

  if (effectiveLabels.length === 0) return;

  let wireLength = 1; // root zero-length octet terminator
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

export type ResourceRecordData =
  | ARecordData
  | AaaaRecordData
  | NsRecordData
  | CnameRecordData
  | PtrRecordData
  | SoaRecordData
  | MxRecordData
  | TxtRecordData
  | SrvRecordData;

export interface ResourceRecord<TData extends ResourceRecordData = ResourceRecordData> {
  readonly name: string;
  readonly ttl: number;
  readonly rrClass: DnsClass;
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
