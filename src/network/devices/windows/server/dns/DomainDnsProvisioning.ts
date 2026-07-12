import type { IPAddress, SubnetMask } from '@/network/core/types';
import type { WindowsDnsServerRole } from './WindowsDnsServerRole';

function reverseZoneNameFor24(ip: IPAddress): string {
  const octets = ip.toString().split('.');
  return `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`;
}

function provisionReverseZone(dns: WindowsDnsServerRole, hostname: string, domainName: string, ownIp: IPAddress, ownMask: SubnetMask): void {
  if (ownMask.toCIDR() !== 24) return;
  const zoneName = reverseZoneNameFor24(ownIp);
  if (!dns.getZone(zoneName)) dns.addPrimaryZone(zoneName);
  const lastOctet = ownIp.toString().split('.')[3];
  dns.addPtrRecord(zoneName, lastOctet, `${hostname}.${domainName}`);
}

export function provisionDomainDnsZone(
  dns: WindowsDnsServerRole,
  domainName: string,
  hostname: string,
  ownIp: IPAddress | null,
  ownMask: SubnetMask | null,
  siteName: string,
  isGlobalCatalog: boolean,
): void {
  if (!dns.getZone(domainName)) {
    dns.addPrimaryZone(domainName);
    if (ownIp) dns.addARecord(domainName, hostname, ownIp.toString());
    const dcTarget = `${hostname}.${domainName}`;
    dns.addSrvRecord(domainName, '_ldap._tcp.dc._msdcs', { priority: 0, weight: 100, port: 389, target: dcTarget });
    dns.addSrvRecord(domainName, '_kerberos._tcp.dc._msdcs', { priority: 0, weight: 100, port: 88, target: dcTarget });
    dns.addSrvRecord(domainName, `_ldap._tcp.${siteName}._sites.dc._msdcs`, { priority: 0, weight: 100, port: 389, target: dcTarget });
    dns.addSrvRecord(domainName, `_kerberos._tcp.${siteName}._sites.dc._msdcs`, { priority: 0, weight: 100, port: 88, target: dcTarget });
    if (isGlobalCatalog) {
      dns.addSrvRecord(domainName, '_gc._tcp', { priority: 0, weight: 100, port: 3268, target: dcTarget });
      dns.addSrvRecord(domainName, `_gc._tcp.${siteName}._sites`, { priority: 0, weight: 100, port: 3268, target: dcTarget });
    }
  }
  if (ownIp && ownMask) provisionReverseZone(dns, hostname, domainName, ownIp, ownMask);
}
