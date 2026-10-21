import { IPAddress, IPv6Address } from '@/network/core/types';
import { ipv6MatchesPrefix } from '@/network/core/RoutingTable';
import { RRType } from '@/network/dns/wire/RRType';
import { ipv6FromPtrName } from '@/network/dns/compat/DnsWireCompat';
import {
  makeAaaaRecord,
  type ResourceRecord,
  type ResourceRecordData,
} from '@/network/dns/wire/ResourceRecord';
import type { ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';
import { isGlobalIpv4, type Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';

export const DNS64_TTL_WITHOUT_SOA_SECONDS = 600;

export interface Ipv6Range {
  readonly network: IPv6Address;
  readonly length: number;
}

export const DEFAULT_DNS64_EXCLUDE: readonly Ipv6Range[] = [
  { network: new IPv6Address('::ffff:0:0'), length: 96 },
];

export interface Dns64Rule {
  readonly prefix: Nat64Prefix;
  readonly clients: (client: string) => boolean;
  readonly mapped: (address: IPAddress) => boolean;
  readonly exclude: readonly Ipv6Range[];
  readonly recursiveOnly: boolean;
  readonly breakDnssec: boolean;
}

export interface Dns64Query {
  readonly client: string;
  readonly checkingDisabled: boolean;
  readonly dnssecOk: boolean;
  readonly recursionDesired: boolean;
}

export type Dns64Lookup = (qname: string, qtype: number) => Promise<ResolutionResult>;

function isExcluded(address: IPv6Address, exclude: readonly Ipv6Range[]): boolean {
  return exclude.some((range) => ipv6MatchesPrefix(address, range.network, range.length));
}

function aaaaAddress(rr: ResourceRecord<ResourceRecordData>): IPv6Address | null {
  return rr.data.type === RRType.AAAA ? rr.data.address : null;
}

function soaTtl(authorities: readonly ResourceRecord<ResourceRecordData>[] | undefined): number | null {
  const soa = authorities?.find((rr) => rr.data.type === RRType.SOA);
  return soa === undefined ? null : soa.ttl;
}

export function selectDns64Rule(rules: readonly Dns64Rule[], client: string): Dns64Rule | null {
  return rules.find((rule) => rule.clients(client)) ?? null;
}

export async function applyDns64(
  rules: readonly Dns64Rule[],
  query: Dns64Query,
  qname: string,
  aaaaResult: ResolutionResult,
  lookup: Dns64Lookup,
): Promise<ResolutionResult> {
  const rule = selectDns64Rule(rules, query.client);
  if (rule === null) return aaaaResult;
  if (query.checkingDisabled && query.dnssecOk) return aaaaResult;
  if (rule.recursiveOnly && !query.recursionDesired) return aaaaResult;
  if (aaaaResult.status === 'NXDOMAIN') return aaaaResult;

  const real = aaaaResult.status === 'NOERROR'
    ? aaaaResult.answers.filter((rr) => {
      const address = aaaaAddress(rr);
      return address === null || !isExcluded(address, rule.exclude);
    })
    : [];
  if (query.dnssecOk && !query.checkingDisabled && !rule.breakDnssec && aaaaResult.security === 'secure') {
    return aaaaResult;
  }
  if (real.some((rr) => rr.data.type === RRType.AAAA)) {
    return { ...aaaaResult, answers: real };
  }

  const aResult = await lookup(qname, RRType.A);
  if (aResult.status !== 'NOERROR') return aResult;
  const addresses = aResult.answers.filter((rr) => rr.data.type === RRType.A);
  const synthesizable = addresses.filter((rr) => rr.data.type === RRType.A && rule.mapped(rr.data.address)
    && (!rule.prefix.wellKnown || isGlobalIpv4(rr.data.address)));
  if (synthesizable.length === 0) {
    return aaaaResult.status === 'NOERROR'
      ? aaaaResult
      : { status: 'NOERROR', answers: [], authorities: aResult.authorities, fromCache: aResult.fromCache };
  }

  const negativeTtl = soaTtl(aaaaResult.authorities);
  const chain = aResult.answers.filter((rr) => rr.data.type === RRType.CNAME);
  const synthetic = synthesizable.map((rr) => {
    if (rr.data.type !== RRType.A) throw new Error('unreachable');
    const ttl = Math.min(rr.ttl, negativeTtl ?? DNS64_TTL_WITHOUT_SOA_SECONDS);
    return makeAaaaRecord(rr.name, ttl, rule.prefix.synthesize(rr.data.address).toString());
  });
  return {
    status: 'NOERROR',
    answers: [...chain, ...synthetic],
    authorities: aResult.authorities,
    fromCache: aResult.fromCache,
    security: undefined,
  };
}

export function dns64ReverseTarget(rules: readonly Dns64Rule[], client: string, qname: string): string | null {
  const address = ipv6FromPtrName(qname);
  if (address === null) return null;
  for (const rule of rules) {
    if (!rule.clients(client)) continue;
    const embedded = rule.prefix.extract(address);
    if (embedded !== null) return `${embedded.getOctets().reverse().join('.')}.in-addr.arpa`;
  }
  return null;
}
