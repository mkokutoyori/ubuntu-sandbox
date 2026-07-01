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
  IXFR: 251,
  AXFR: 252,
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
