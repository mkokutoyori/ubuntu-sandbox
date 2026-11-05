import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { DnsStreamFailure } from '@/network/dns/transport/DnsTcpTransport';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { RR_TYPE_NAMES as REGISTERED_RR_TYPE_NAMES, rrTypeNumber } from '@/network/dns/wire/RRTypeNames';
import { DnsRcode as WireRcode, DnsOpcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { IPv6Address } from '@/network/core/types';
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
import { makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
export interface DnsRecord {
  name: string;
  type: 'A' | 'AAAA' | 'PTR' | 'MX' | 'TXT' | 'CNAME' | 'NS' | 'SOA';
  value: string;
  ttl: number;
  priority?: number;
}

export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED';

export type DnsRcodeName = DnsRcode;

export interface DnsWireResponse {
  kind: 'dns-response';
  id: number;
  rcode: DnsRcode;
  name: string;
  qtype: string;
  answers: DnsRecord[];
}

export interface DnsQueryOptions {
  readonly recursionDesired?: boolean;
  readonly tcp?: boolean;
  /** DNS-over-TLS (RFC 7858) : TCP/853 sous une vraie session TLS 1.3. */
  readonly tls?: boolean;
  readonly dnssecOk?: boolean;
  readonly udpPayloadSize?: number;
  /** Destination port override (`dig -p <port>`). Defaults to 53. */
  readonly port?: number;
  /** Name the server certificate must carry (DNS-over-TLS, `systemd-resolved` `ADDRESS#NAME`). */
  readonly serverName?: string;
  /** DNS-over-HTTPS (RFC 8484) : le chemin du point d'accès et la méthode (`dig +https[=chemin]`, `+https-get`). */
  readonly https?: { readonly path: string; readonly method: 'GET' | 'POST'; readonly plain?: boolean };
  /** Ancres de confiance du client TLS ; absentes, le client n'approuve que la racine publique du simulateur. */
  readonly tlsAnchors?: readonly X509Certificate[];
  /** `false` : la chaîne et le nom du serveur ne sont pas vérifiés (`dig +tls` sans `+tls-ca` ni `+tls-hostname`). */
  readonly tlsVerify?: boolean;
  readonly tlsClientIdentity?: { readonly certificate: X509Certificate; readonly chain: readonly X509Certificate[]; readonly privateKey: PkiPrivateKey };
  readonly onTlsVerifyFailure?: (text: string) => void;
  readonly onHttpFailure?: (status: number) => void;
  readonly onStreamFailure?: (failure: DnsStreamFailure) => void;
  /** Query class override (`dig -c CH`/bare `chaos` keyword), e.g. `DnsClass.CH`. Defaults to IN. */
  readonly qclass?: number;
  readonly onTransportFailure?: (failure: 'refused') => void;
  readonly onUnreachable?: () => void;
}

export type DnsQueryFn = (
  serverIP: string,
  name: string,
  qtype: string,
  timeoutMs?: number,
  options?: DnsQueryOptions,
) => Promise<DnsMessage | null>;

const RR_TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  ...Object.entries(REGISTERED_RR_TYPE_NAMES).map(([value, name]): [number, string] => [Number(value), name]),
  ...Object.entries(RRType).map(([name, value]): [number, string] => [value, name]),
]);

const GENERIC_RR_TYPE = /^TYPE(\d{1,5})$/i;
const GENERIC_RR_CLASS = /^CLASS(\d{1,5})$/i;
const MAX_WIRE_VALUE = 65535;

export function rrTypeFromName(name: string): number | null {
  const upper = name.toUpperCase();
  const known = (RRType as Record<string, number>)[upper] ?? rrTypeNumber(upper);
  if (typeof known === 'number') return known;
  const generic = GENERIC_RR_TYPE.exec(name);
  if (generic === null) return null;
  const value = Number(generic[1]);
  return value <= MAX_WIRE_VALUE ? value : null;
}

export function rrTypeName(type: number): string {
  return RR_TYPE_NAMES.get(type) ?? `TYPE${type}`;
}

const RR_CLASS_NAMES: ReadonlyMap<number, string> = new Map([[1, 'IN'], [3, 'CH'], [4, 'HS'], [254, 'NONE'], [255, 'ANY']]);
const RR_CLASS_VALUES: Readonly<Record<string, number>> = { IN: 1, CH: 3, CHAOS: 3, HS: 4, HESIOD: 4, NONE: 254, ANY: 255 };

export function rrClassFromName(name: string): number | null {
  const known = RR_CLASS_VALUES[name.toUpperCase()];
  if (known !== undefined) return known;
  const generic = GENERIC_RR_CLASS.exec(name);
  if (generic === null) return null;
  const value = Number(generic[1]);
  return value <= MAX_WIRE_VALUE ? value : null;
}

export function rrClassText(rrClass: number): string {
  return RR_CLASS_NAMES.get(rrClass) ?? `CLASS${rrClass}`;
}

const RCODE_TEXTS = [
  'NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'YXDOMAIN', 'YXRRSET', 'NXRRSET', 'NOTAUTH', 'NOTZONE',
  'RESERVED11', 'RESERVED12', 'RESERVED13', 'RESERVED14', 'RESERVED15', 'BADVERS',
] as const;

export function rcodeText(rcode: number): string {
  return rcode < RCODE_TEXTS.length ? RCODE_TEXTS[rcode] : `?${rcode}`;
}

let transactionCounter = 0;

export function nextDnsTransactionId(): number {
  transactionCounter = (transactionCounter + 1) & 0xffff;
  return transactionCounter;
}

const IPV4_LITERAL = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/;

/** Cheap syntactic pre-check before attempting the (throwing) `IPv6Address` parse. */
const IPV6_CANDIDATE = /^[0-9a-fA-F:]*:[0-9a-fA-F:.]*(%[^%]+)?$/;

export function isIPv4Literal(target: string): boolean {
  return IPV4_LITERAL.test(target) && target.split('.').every((octet) => Number(octet) <= 255);
}

export function isIPv6Literal(target: string): boolean {
  if (!IPV6_CANDIDATE.test(target)) return false;
  try {
    new IPv6Address(target);
    return true;
  } catch {
    return false;
  }
}

/** True for any IPv4/IPv6 literal — i.e. an `nslookup`/`dig` argument that triggers a reverse (PTR) lookup. */
export function isIpLiteral(target: string): boolean {
  return isIPv4Literal(target) || isIPv6Literal(target);
}

/** Nibble-reverses a full 32-nibble IPv6 address into its `ip6.arpa` PTR query name (RFC 3596 §2.5). */
function ipv6PtrQName(target: string): string {
  const hextets = new IPv6Address(target).getHextets();
  const nibbles: string[] = [];
  for (const hextet of hextets) {
    const hex = hextet.toString(16).padStart(4, '0');
    for (const ch of hex) nibbles.push(ch);
  }
  return nibbles.reverse().join('.') + '.ip6.arpa';
}

export function ptrQName(target: string): string {
  if (isIPv4Literal(target)) return target.split('.').reverse().join('.') + '.in-addr.arpa';
  if (isIPv6Literal(target)) return ipv6PtrQName(target);
  return target;
}

export function ipv6FromPtrName(name: string): IPv6Address | null {
  const labels = name.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length !== 34 || labels[32] !== 'ip6' || labels[33] !== 'arpa') return null;
  const nibbles = labels.slice(0, 32).reverse();
  if (!nibbles.every((nibble) => /^[0-9a-f]$/.test(nibble))) return null;
  const hextets: number[] = [];
  for (let i = 0; i < 32; i += 4) hextets.push(parseInt(nibbles.slice(i, i + 4).join(''), 16));
  return new IPv6Address(hextets);
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

const LEGACY_RCODE_TO_WIRE: Record<DnsRcode, number> = {
  NOERROR: WireRcode.NOERROR,
  NXDOMAIN: WireRcode.NXDOMAIN,
  SERVFAIL: WireRcode.SERVFAIL,
  REFUSED: WireRcode.REFUSED,
};

export function rcodeToWire(rcode: DnsRcode | number): number {
  return typeof rcode === 'number' ? rcode : LEGACY_RCODE_TO_WIRE[rcode];
}

export function rcodeFromWire(rcode: number): DnsRcode {
  switch (rcode) {
    case WireRcode.NOERROR: return 'NOERROR';
    case WireRcode.NXDOMAIN: return 'NXDOMAIN';
    case WireRcode.REFUSED: return 'REFUSED';
    default: return 'SERVFAIL';
  }
}

export function buildLegacyQueryMessage(
  id: number,
  name: string,
  qtype: string,
  options: DnsQueryOptions = {},
): DnsMessage | null {
  const type = rrTypeFromName(qtype);
  if (type === null) return null;
  const qname = type === RRType.PTR ? ptrQName(name) : name;
  const additionals: ResourceRecord<ResourceRecordData>[] = [];
  if (options.dnssecOk || options.udpPayloadSize !== undefined) {
    additionals.push(makeOptRecord(
      options.udpPayloadSize ?? DEFAULT_EDNS_PAYLOAD_SIZE,
      { dnssecOk: options.dnssecOk === true },
    ));
  }
  return {
    id,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: options.recursionDesired ?? true, ra: false, ad: false, cd: false,
      rcode: WireRcode.NOERROR,
    },
    questions: [{ qname, qtype: type, qclass: options.qclass ?? DnsClass.IN }],
    answers: [],
    authorities: [],
    additionals,
  };
}

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
