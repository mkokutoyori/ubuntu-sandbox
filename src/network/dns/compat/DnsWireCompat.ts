/**
 * Bridge between the legacy simulator-level DNS shapes (`DnsRecord`,
 * `DnsWireResponse` — still the API of the client tools, the NSS `dns`
 * source and dnsmasq's record store) and the RFC 1035 binary message
 * model of the DNS engine (`src/network/dns/wire`).
 *
 * Transitional by design (PRD-DNS §5, phase 9): the wire format is now
 * always binary — only the *shapes at the API boundary* remain legacy.
 * This module shrinks as callers migrate to the engine's native model,
 * and disappears together with `DnsWire.ts`.
 */

import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode as WireRcode, DnsOpcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import {
  makeARecord,
  makeAaaaRecord,
  makeNsRecord,
  makeCnameRecord,
  makePtrRecord,
  makeMxRecord,
  makeTxtRecord,
  makeSoaRecord,
  type ResourceRecord,
  type ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';
import type { DnsRecord, DnsRcode, DnsWireResponse } from '@/network/dns/DnsWire';

// ─── RR type names ───────────────────────────────────────────────────

const RR_TYPE_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(RRType).map(([name, value]) => [value, name]),
);

/** Numeric RR type for a mnemonic ("A", "MX", …); null if unknown. */
export function rrTypeFromName(name: string): number | null {
  const type = (RRType as Record<string, number>)[name.toUpperCase()];
  return typeof type === 'number' ? type : null;
}

/** Mnemonic for a numeric RR type; RFC 3597 "TYPEnnn" form if unknown. */
export function rrTypeName(type: number): string {
  return RR_TYPE_NAMES.get(type) ?? `TYPE${type}`;
}

// ─── Transaction ids ─────────────────────────────────────────────────

let transactionCounter = 0;

/** Allocate a 16-bit transaction id (wraps like a real resolver's counter). */
export function nextDnsTransactionId(): number {
  transactionCounter = (transactionCounter + 1) & 0xffff;
  return transactionCounter;
}

// ─── Reverse-lookup names ────────────────────────────────────────────

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * QNAME actually sent for a PTR lookup: the legacy tools pass the raw
 * IPv4 address, but on the wire a real stub resolver queries the
 * in-addr.arpa name (RFC 1035 §3.5).
 */
export function ptrQName(target: string): string {
  if (!IPV4_LITERAL.test(target)) return target;
  return target.split('.').reverse().join('.') + '.in-addr.arpa';
}

// ─── Record conversion ───────────────────────────────────────────────

const TXT_CHARACTER_STRING_MAX = 255;

function legacySoaToResourceRecord(record: DnsRecord): ResourceRecord | null {
  const fields = record.value.trim().split(/\s+/);
  if (fields.length !== 7) return null;
  const [mname, rname, ...rest] = fields;
  const timers = rest.map(Number);
  if (timers.some(Number.isNaN)) return null;
  const [serial, refresh, retry, expire, minimum] = timers;
  return makeSoaRecord(record.name, record.ttl, {
    mname, rname, serial, refresh, retry, expire, minimum,
  });
}

function legacyTxtToResourceRecord(record: DnsRecord): ResourceRecord {
  // Long TXT data is carried as consecutive <character-string>s, each at
  // most 255 octets (RFC 1035 §3.3.14) — exactly what real servers do.
  const segments: string[] = [];
  for (let i = 0; i < record.value.length; i += TXT_CHARACTER_STRING_MAX) {
    segments.push(record.value.slice(i, i + TXT_CHARACTER_STRING_MAX));
  }
  return makeTxtRecord(record.name, record.ttl, segments.length > 0 ? segments : ['']);
}

/**
 * Legacy record → engine resource record. Returns null for a record that
 * cannot be represented on the wire (invalid name/address/fields): such a
 * record could never have left a real server either.
 */
export function legacyRecordToResourceRecord(record: DnsRecord): ResourceRecord | null {
  try {
    switch (record.type) {
      case 'A': return makeARecord(record.name, record.ttl, record.value);
      case 'AAAA': return makeAaaaRecord(record.name, record.ttl, record.value);
      case 'NS': return makeNsRecord(record.name, record.ttl, record.value);
      case 'CNAME': return makeCnameRecord(record.name, record.ttl, record.value);
      case 'PTR': return makePtrRecord(record.name, record.ttl, record.value);
      case 'MX': return makeMxRecord(record.name, record.ttl, record.priority ?? 0, record.value);
      case 'TXT': return legacyTxtToResourceRecord(record);
      case 'SOA': return legacySoaToResourceRecord(record);
      default: return null;
    }
  } catch {
    return null;
  }
}

/** Engine resource record → legacy record; null for engine-only types (OPT, …). */
export function resourceRecordToLegacyRecord(rr: ResourceRecord<ResourceRecordData>): DnsRecord | null {
  const base = { name: rr.name, ttl: rr.ttl };
  const data = rr.data;
  switch (data.type) {
    case RRType.A: return { ...base, type: 'A', value: data.address.toString() };
    case RRType.AAAA: return { ...base, type: 'AAAA', value: data.address.toString() };
    case RRType.NS: return { ...base, type: 'NS', value: data.nsdname };
    case RRType.CNAME: return { ...base, type: 'CNAME', value: data.cname };
    case RRType.PTR: return { ...base, type: 'PTR', value: data.ptrdname };
    case RRType.MX: return { ...base, type: 'MX', value: data.exchange, priority: data.preference };
    case RRType.TXT: return { ...base, type: 'TXT', value: data.text.join('') };
    case RRType.SOA:
      return {
        ...base,
        type: 'SOA',
        value: `${data.mname} ${data.rname} ${data.serial} ${data.refresh} ${data.retry} ${data.expire} ${data.minimum}`,
      };
    default: return null;
  }
}

// ─── Rcode conversion ────────────────────────────────────────────────

const LEGACY_RCODE_TO_WIRE: Record<DnsRcode, number> = {
  NOERROR: WireRcode.NOERROR,
  NXDOMAIN: WireRcode.NXDOMAIN,
  SERVFAIL: WireRcode.SERVFAIL,
  REFUSED: WireRcode.REFUSED,
};

export function rcodeToWire(rcode: DnsRcode | number): number {
  return typeof rcode === 'number' ? rcode : LEGACY_RCODE_TO_WIRE[rcode];
}

/** Wire rcode → the subset the legacy shapes distinguish (others → SERVFAIL). */
export function rcodeFromWire(rcode: number): DnsRcode {
  switch (rcode) {
    case WireRcode.NOERROR: return 'NOERROR';
    case WireRcode.NXDOMAIN: return 'NXDOMAIN';
    case WireRcode.REFUSED: return 'REFUSED';
    default: return 'SERVFAIL';
  }
}

// ─── Message builders ────────────────────────────────────────────────

/**
 * RFC 1035 query message for a legacy (name, qtype-mnemonic) lookup, with
 * RD set like a stub resolver. Null if the mnemonic is unknown.
 */
export function buildLegacyQueryMessage(id: number, name: string, qtype: string): DnsMessage | null {
  const type = rrTypeFromName(qtype);
  if (type === null) return null;
  const qname = type === RRType.PTR ? ptrQName(name) : name;
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: true, ra: false, ad: false, cd: false, rcode: WireRcode.NOERROR,
    },
    questions: [{ qname, qtype: type, qclass: DnsClass.IN }],
    answers: [],
    authorities: [],
    additionals: [],
  };
}

/**
 * Response message echoing the query's question section (RFC 1035 §4.1),
 * with RA set like a recursing forwarder (dnsmasq). Legacy answers that
 * cannot be represented on the wire are omitted.
 */
export function buildLegacyResponseMessage(
  query: DnsMessage,
  rcode: DnsRcode | number,
  answers: readonly DnsRecord[],
): DnsMessage {
  return {
    id: query.id,
    flags: {
      qr: true, opcode: query.flags.opcode, aa: false, tc: false,
      rd: query.flags.rd, ra: true, ad: false, cd: false, rcode: rcodeToWire(rcode),
    },
    questions: query.questions,
    answers: answers
      .map(legacyRecordToResourceRecord)
      .filter((rr): rr is ResourceRecord => rr !== null),
    authorities: [],
    additionals: [],
  };
}

/** Parsed response message → the legacy shape the client tools consume. */
export function messageToLegacyResponse(
  message: DnsMessage,
  fallbackName: string,
  fallbackQtype: string,
): DnsWireResponse {
  const question = message.questions[0];
  return {
    kind: 'dns-response',
    id: message.id,
    rcode: rcodeFromWire(message.flags.rcode),
    name: question?.qname ?? fallbackName,
    qtype: question ? rrTypeName(question.qtype as number) : fallbackQtype,
    answers: message.answers
      .map(resourceRecordToLegacyRecord)
      .filter((record): record is DnsRecord => record !== null),
  };
}
