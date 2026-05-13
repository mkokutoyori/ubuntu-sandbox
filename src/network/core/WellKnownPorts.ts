/**
 * WellKnownPorts — IANA port number registry
 *
 * Port ranges per RFC 6335 (IANA):
 *   0–1023    Well-known (system) ports  — require root/CAP_NET_BIND_SERVICE
 *   1024–49151  Registered ports         — assigned by IANA to specific services
 *   49152–65535 Dynamic / ephemeral      — used by OS for outgoing connections
 *
 * Service names follow the IANA Service Name and Transport Protocol Port Number Registry.
 * https://www.iana.org/assignments/service-names-port-numbers/
 */

export enum PortRange {
  WELL_KNOWN = 'well-known',
  REGISTERED = 'registered',
  EPHEMERAL  = 'ephemeral',
}

/** First ephemeral port per RFC 6335 */
export const EPHEMERAL_PORT_MIN = 49152;
/** Last ephemeral port per RFC 6335 */
export const EPHEMERAL_PORT_MAX = 65535;

// ─── IANA service name table ─────────────────────────────────────────
// Values: { tcp?: name, udp?: name }
// A missing key means that protocol is not assigned for that port.

const IANA: Map<number, { tcp?: string; udp?: string }> = new Map([
  [20,   { tcp: 'ftp-data' }],
  [21,   { tcp: 'ftp' }],
  [22,   { tcp: 'ssh' }],
  [23,   { tcp: 'telnet' }],
  [25,   { tcp: 'smtp' }],
  [37,   { tcp: 'time', udp: 'time' }],
  [43,   { tcp: 'whois' }],
  [53,   { tcp: 'domain', udp: 'domain' }],
  [67,   { udp: 'bootps' }],
  [68,   { udp: 'bootpc' }],
  [69,   { udp: 'tftp' }],
  [79,   { tcp: 'finger' }],
  [80,   { tcp: 'http' }],
  [88,   { tcp: 'kerberos', udp: 'kerberos' }],
  [110,  { tcp: 'pop3' }],
  [119,  { tcp: 'nntp' }],
  [123,  { udp: 'ntp' }],
  [143,  { tcp: 'imap' }],
  [161,  { udp: 'snmp' }],
  [162,  { udp: 'snmptrap' }],
  [179,  { tcp: 'bgp' }],
  [389,  { tcp: 'ldap', udp: 'ldap' }],
  [443,  { tcp: 'https' }],
  [445,  { tcp: 'microsoft-ds', udp: 'microsoft-ds' }],
  [500,  { udp: 'isakmp' }],
  [514,  { udp: 'syslog' }],
  [520,  { udp: 'route' }],
  [587,  { tcp: 'submission' }],
  [636,  { tcp: 'ldaps' }],
  [993,  { tcp: 'imaps' }],
  [995,  { tcp: 'pop3s' }],
  [1433, { tcp: 'ms-sql-s', udp: 'ms-sql-s' }],
  [1521, { tcp: 'oracle' }],
  [1723, { tcp: 'pptp' }],
  [3306, { tcp: 'mysql' }],
  [3389, { tcp: 'ms-wbt-server' }],
  [4500, { udp: 'ipsec-nat-t' }],
  [5432, { tcp: 'postgresql' }],
  [5900, { tcp: 'vnc' }],
  [6379, { tcp: 'redis' }],
  [8080, { tcp: 'http-alt' }],
  [8443, { tcp: 'https-alt' }],
]);

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Classify a port number into its RFC 6335 range.
 */
export function getPortRange(port: number): PortRange {
  if (port < 1024)  return PortRange.WELL_KNOWN;
  if (port < 49152) return PortRange.REGISTERED;
  return PortRange.EPHEMERAL;
}

/**
 * Look up the IANA service name for a port/protocol pair.
 * Returns the port number as a string when no assignment exists.
 */
export function getServiceName(port: number, protocol: 'tcp' | 'udp'): string {
  const entry = IANA.get(port);
  if (entry) {
    const name = entry[protocol];
    if (name) return name;
  }
  return String(port);
}

/**
 * True for ports in the well-known range (0–1023).
 * These require elevated privileges to bind on POSIX systems.
 */
export function isPrivileged(port: number): boolean {
  return port < 1024;
}

/**
 * True for ports in the RFC 6335 ephemeral range (49152–65535).
 */
export function isEphemeral(port: number): boolean {
  return port >= EPHEMERAL_PORT_MIN && port <= EPHEMERAL_PORT_MAX;
}
