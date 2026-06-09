/**
 * DNS wire types (RFC 1035, simulated).
 *
 * The simulator does not serialize DNS messages to binary; queries and
 * responses are structured payloads carried inside real UDP datagrams
 * (port 53) that traverse the simulated network — routing, ARP, firewalls
 * and cable cuts all apply.
 */

export const DNS_PORT = 53;

/** Default client-side query budget before reporting a timeout. */
export const DNS_QUERY_TIMEOUT_MS = 2_000;

export type DnsRecordType = 'A' | 'AAAA' | 'PTR' | 'MX' | 'TXT' | 'CNAME' | 'NS' | 'SOA';

export interface DnsRecord {
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
  /** For MX records. */
  priority?: number;
}

/** Response codes (RFC 1035 §4.1.1 RCODE, symbolic). */
export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED';

export interface DnsQueryMessage {
  kind: 'dns-query';
  /** Transaction ID matching responses to queries (RFC 1035 §4.1.1). */
  id: number;
  name: string;
  /** Query type ('A', 'MX', 'ANY', …). Ignored for reverse lookups. */
  qtype: string;
  /** Reverse (PTR) lookup — `name` is then a dotted-quad IP. */
  reverse?: boolean;
}

export interface DnsResponseMessage {
  kind: 'dns-response';
  /** Echoes the query's transaction ID. */
  id: number;
  rcode: DnsRcode;
  answers: DnsRecord[];
}

export function isDnsQueryMessage(payload: unknown): payload is DnsQueryMessage {
  return !!payload && typeof payload === 'object'
    && (payload as DnsQueryMessage).kind === 'dns-query';
}

export function isDnsResponseMessage(payload: unknown): payload is DnsResponseMessage {
  return !!payload && typeof payload === 'object'
    && (payload as DnsResponseMessage).kind === 'dns-response';
}
