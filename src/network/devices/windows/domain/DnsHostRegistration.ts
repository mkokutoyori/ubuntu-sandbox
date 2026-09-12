import type { IPAddress } from '@/network/core/types';
import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import type { DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';

export const HOST_RECORD_TTL = 1200;

/**
 * What a Windows machine sends after joining a domain, and again on
 * `ipconfig /registerdns`: an RFC 2136 update replacing its own A record
 * in the domain's zone. Replacing rather than adding is what the real
 * client does — a machine that changed address must not leave the old one
 * answering for its name.
 */
export function hostRegistrationRequest(
  zone: string, hostname: string, address: IPAddress,
): DnsUpdateRequest {
  const fqdn = `${hostname}.${zone}`;
  return {
    zone,
    zoneClass: DnsClass.IN,
    prerequisites: [],
    updates: [
      { kind: 'delete-rrset', name: fqdn, type: RRType.A },
      { kind: 'add', record: makeARecord(fqdn, HOST_RECORD_TTL, address.toString()) },
    ],
  };
}
