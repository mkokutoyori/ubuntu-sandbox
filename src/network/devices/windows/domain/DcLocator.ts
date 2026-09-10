import type { ResourceRecord, SrvRecordData, ARecordData } from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';
import { IPAddress } from '@/network/core/types';

export const DC_LOCATOR_SRV_PREFIX = '_ldap._tcp.dc._msdcs';

export interface DnsRecordLookup {
  lookupDnsRecordsSync(name: string, qtype: string, server?: string): readonly ResourceRecord[] | null;
}

export interface LocatedDomainController {
  address: IPAddress;
  hostname: string;
}

export function dcLocatorRecordName(domain: string): string {
  return `${DC_LOCATOR_SRV_PREFIX}.${domain}`;
}

export function locateDomainController(dns: DnsRecordLookup, domain: string): LocatedDomainController | null {
  for (const candidate of orderedSrvTargets(dns, domain)) {
    const address = firstAddressOf(dns, candidate);
    if (address) return { address, hostname: candidate };
  }
  return null;
}

function orderedSrvTargets(dns: DnsRecordLookup, domain: string): string[] {
  const answers = dns.lookupDnsRecordsSync(dcLocatorRecordName(domain), 'SRV') ?? [];
  const targets = answers
    .filter((rr): rr is ResourceRecord<SrvRecordData> => rr.data.type === RRType.SRV)
    .map((rr) => rr.data);
  targets.sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.target.localeCompare(b.target));
  return targets.map((t) => t.target);
}

function firstAddressOf(dns: DnsRecordLookup, hostname: string): IPAddress | null {
  const answers = dns.lookupDnsRecordsSync(hostname, 'A') ?? [];
  for (const rr of answers) {
    if (rr.data.type === RRType.A) return (rr.data as ARecordData).address;
  }
  return null;
}
