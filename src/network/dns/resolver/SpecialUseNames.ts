import { IPV4_SPECIAL_PURPOSE_ENTRIES } from '@/network/core/SpecialPurposeRegistry';
import { isWithinDomain, normalizeDnsName } from '@/network/dns/wire/DnsName';
import { RRType } from '@/network/dns/wire/RRType';
import { makeARecord, makeAaaaRecord } from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

export type SpecialUseKind = 'private-reverse' | 'test' | 'localhost' | 'invalid';

export interface SpecialUseAnswer {
  readonly status: 'NOERROR' | 'NXDOMAIN';
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
}

const LOCALHOST_TTL = 0;

function privateReverseDomains(): readonly string[] {
  const domains: string[] = [];
  for (const entry of IPV4_SPECIAL_PURPOSE_ENTRIES) {
    if (entry.rfc !== 'RFC1918') continue;
    const [address, length] = entry.block.split('/');
    const octets = address.split('.').map(Number);
    const prefix = Number(length);
    const fixed = Math.ceil(prefix / 8);
    const free = fixed * 8 - prefix;
    const last = octets[fixed - 1];
    for (let value = last; value < last + (1 << free); value++) {
      domains.push([...octets.slice(0, fixed - 1), value].reverse().join('.') + '.in-addr.arpa');
    }
  }
  return domains;
}

const PRIVATE_REVERSE_DOMAINS = privateReverseDomains();

export function classifySpecialUseName(qname: string): SpecialUseKind | null {
  const name = normalizeDnsName(qname);
  if (PRIVATE_REVERSE_DOMAINS.some(domain => isWithinDomain(name, domain))) return 'private-reverse';
  if (isWithinDomain(name, 'test')) return 'test';
  if (isWithinDomain(name, 'localhost')) return 'localhost';
  if (isWithinDomain(name, 'invalid')) return 'invalid';
  return null;
}

export function answerSpecialUseName(kind: SpecialUseKind, qname: string, qtype: number): SpecialUseAnswer {
  if (kind === 'localhost') {
    if (qtype === RRType.A) return { status: 'NOERROR', answers: [makeARecord(qname, LOCALHOST_TTL, '127.0.0.1')] };
    if (qtype === RRType.AAAA) return { status: 'NOERROR', answers: [makeAaaaRecord(qname, LOCALHOST_TTL, '::1')] };
    return { status: 'NOERROR', answers: [] };
  }
  return { status: 'NXDOMAIN', answers: [] };
}
