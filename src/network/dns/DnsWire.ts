/**
 * Legacy simulator-level DNS shapes.
 *
 * Since the phase-9 migration of PRD-DNS, DNS messages travel through the
 * simulated network as RFC 1035 *binary* datagrams (encoded/decoded by
 * `wire/DnsMessageCodec`) — the JSON "dns-query"/"dns-response" payloads
 * are gone from the wire. What remains here are the record/response
 * shapes still used as the API of the client tools (dig, nslookup, host),
 * the NSS `dns` source and dnsmasq's record store, plus the conversion
 * bridge in `compat/DnsWireCompat.ts`. This module disappears once those
 * callers consume the engine's native model directly.
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

/** Subset of RFC 1035 §4.1.1 response codes the legacy shapes distinguish. */
export type DnsRcode = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED';

export interface DnsWireResponse {
  kind: 'dns-response';
  id: number;
  rcode: DnsRcode;
  name: string;
  qtype: string;
  answers: DnsRecord[];
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
