/**
 * IANA-registered DNS resource record types and classes (RFC 1035 §3.2.2,
 * §3.2.4; RFC 3596 for AAAA; RFC 2782 for SRV; RFC 6891 for OPT).
 *
 * Only the subset needed by this engine's supported record set is listed —
 * RFC 3597 generic-RR handling covers any type not enumerated here.
 */

export const RRType = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
  ANY: 255,
} as const;

export type RRType = (typeof RRType)[keyof typeof RRType];

export const DnsClass = {
  IN: 1,
  CH: 3,
  HS: 4,
  ANY: 255,
} as const;

export type DnsClass = (typeof DnsClass)[keyof typeof DnsClass];
