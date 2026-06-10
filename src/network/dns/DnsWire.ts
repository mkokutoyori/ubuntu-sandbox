/**
 * DNS wire messages (RFC 1035, simulator-level encoding).
 *
 * Carried as the payload of UDP datagrams on port 53 through the simulated
 * network — unlike the legacy path that looked DNS servers up in the
 * Equipment registry and called them directly, bypassing cables, routing
 * and firewalls entirely.
 *
 * The structures mirror the parts of a real DNS message that matter to the
 * simulation: transaction id, one question, answer records and an rcode.
 */

// ─── DNS records ─────────────────────────────────────────────────────

export interface DnsRecord {
  name: string;
  type: 'A' | 'AAAA' | 'PTR' | 'MX' | 'TXT' | 'CNAME' | 'NS' | 'SOA';
  value: string;
  ttl: number;
  priority?: number; // For MX records
}

export const UDP_PORT_DNS = 53;

/** Subset of RFC 1035 §4.1.1 response codes the simulator distinguishes. */
export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED';

export interface DnsWireQuery {
  kind: 'dns-query';
  /** Transaction id used to correlate the response (RFC 1035 §4.1.1). */
  id: number;
  name: string;
  qtype: string;
  recursionDesired: boolean;
}

export interface DnsWireResponse {
  kind: 'dns-response';
  id: number;
  rcode: DnsRcode;
  name: string;
  qtype: string;
  answers: DnsRecord[];
}

export function isDnsWireQuery(payload: unknown): payload is DnsWireQuery {
  return !!payload && (payload as DnsWireQuery).kind === 'dns-query';
}

export function isDnsWireResponse(payload: unknown): payload is DnsWireResponse {
  return !!payload && (payload as DnsWireResponse).kind === 'dns-response';
}

let dnsTransactionCounter = 0;

/** Allocate a 16-bit transaction id (wraps like a real resolver's counter). */
export function nextDnsTransactionId(): number {
  dnsTransactionCounter = (dnsTransactionCounter + 1) & 0xffff;
  return dnsTransactionCounter;
}

/**
 * Rough on-wire size estimate for a DNS message (header + question +
 * answers), used for the UDP length field of the simulated datagram.
 */
export function estimateDnsMessageSize(name: string, answers: DnsRecord[] = []): number {
  const HEADER = 12;
  const question = name.length + 2 + 4;
  const answerBytes = answers.reduce((sum, a) => sum + a.name.length + 2 + 10 + a.value.length, 0);
  return HEADER + question + answerBytes;
}

/**
 * Async query transport used by DNS client tools (dig, nslookup, host).
 * Implemented by hosts on top of their UDP socket layer; resolves to null
 * on timeout (server unreachable / not listening).
 */
export type DnsQueryFn = (
  serverIP: string,
  name: string,
  qtype: string,
  timeoutMs?: number,
) => Promise<DnsWireResponse | null>;
