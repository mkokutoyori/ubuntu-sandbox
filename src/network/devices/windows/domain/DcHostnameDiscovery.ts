/**
 * DcHostnameDiscovery — resolves the computer-account name (SPN target) of
 * the DC a client has already been given an address for
 * (PRD-Windows-Server-Advanced.md §5 P24). Kerberos's TGS exchange needs
 * the DC's own `sAMAccountName` (minus its trailing `$`) as `serviceName`
 * — ticket verification happens against that exact computer account's
 * secret (`KdcSession.ts`) — but callers here are only ever given
 * `dcAddress`, never a hostname (no DNS SRV `_ldap._tcp.dc._msdcs.<domain>`
 * discovery yet, same accepted limitation as domain join/logon's own
 * docblocks already state).
 *
 * Resolved via a genuine LDAP round trip — an anonymous simple bind (RFC
 * 4511 §5.1.2's `name=''`/`password=''` case, already served with zero new
 * server-side code by `LdapServer.ts`), then a real SearchRequest under
 * `OU=Domain Controllers,<rootDn>` — not a topology-wide shortcut into the
 * DC's own `DirectoryStore`. Only a single-DC domain is disambiguated
 * (`entries[0]`); true multi-DC DC-locator behaviour remains out of scope.
 */
import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';

export function rootDnOf(dnsName: string): string {
  return dnsName.split('.').map(p => `DC=${p}`).join(',');
}

/** Returns the discovered DC computer-account name (no trailing `$`), or `null` if the DC couldn't be reached or has no discoverable computer account. */
export function discoverDcHostname(tcpStack: TcpStack, dcAddress: string, dnsName: string): string | null {
  const conn = dialLdap(tcpStack, dcAddress);
  if (!conn.ok || !conn.client) return null;
  const ldap = conn.client;

  const bind = ldap.bind('', '');
  if (!bind.ok) { ldap.unbind(); return null; }

  const search = ldap.search(
    `OU=Domain Controllers,${rootDnOf(dnsName)}`, 'sub',
    { kind: 'equalityMatch', attr: 'objectClass', value: 'computer' }, ['sAMAccountName'],
  );
  ldap.unbind();

  const sam = search.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'samaccountname')?.values[0];
  if (!sam) return null;
  return sam.endsWith('$') ? sam.slice(0, -1) : sam;
}
