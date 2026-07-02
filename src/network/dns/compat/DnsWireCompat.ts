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

export interface DnsRecord {
  name: string;
  type: 'A' | 'AAAA' | 'PTR' | 'MX' | 'TXT' | 'CNAME' | 'NS' | 'SOA';
  value: string;
  ttl: number;
  priority?: number;
}

export type DnsRcodeName = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED';

export type DnsQueryFn = (
  serverIP: string,
  name: string,
  qtype: string,
  timeoutMs?: number,
) => Promise<DnsMessage | null>;

const RR_TYPE_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(RRType).map(([name, value]) => [value, name]),
);

export function rrTypeFromName(name: string): number | null {
  const type = (RRType as Record<string, number>)[name.toUpperCase()];
  return typeof type === 'number' ? type : null;
}

export function rrTypeName(type: number): string {
  return RR_TYPE_NAMES.get(type) ?? `TYPE${type}`;
}

let transactionCounter = 0;

export function nextDnsTransactionId(): number {
  transactionCounter = (transactionCounter + 1) & 0xffff;
  return transactionCounter;
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function ptrQName(target: string): string {
  if (!IPV4_LITERAL.test(target)) return target;
  return target.split('.').reverse().join('.') + '.in-addr.arpa';
}

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
  const segments: string[] = [];
  for (let i = 0; i < record.value.length; i += TXT_CHARACTER_STRING_MAX) {
    segments.push(record.value.slice(i, i + TXT_CHARACTER_STRING_MAX));
  }
  return makeTxtRecord(record.name, record.ttl, segments.length > 0 ? segments : ['']);
}

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

const LEGACY_RCODE_TO_WIRE: Record<DnsRcodeName, number> = {
  NOERROR: WireRcode.NOERROR,
  NXDOMAIN: WireRcode.NXDOMAIN,
  SERVFAIL: WireRcode.SERVFAIL,
  REFUSED: WireRcode.REFUSED,
};

export function rcodeToWire(rcode: DnsRcodeName | number): number {
  return typeof rcode === 'number' ? rcode : LEGACY_RCODE_TO_WIRE[rcode];
}

export function rcodeFromWire(rcode: number): DnsRcodeName {
  switch (rcode) {
    case WireRcode.NOERROR: return 'NOERROR';
    case WireRcode.NXDOMAIN: return 'NXDOMAIN';
    case WireRcode.REFUSED: return 'REFUSED';
    default: return 'SERVFAIL';
  }
}

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

export function buildLegacyResponseMessage(
  query: DnsMessage,
  rcode: DnsRcodeName | number,
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
