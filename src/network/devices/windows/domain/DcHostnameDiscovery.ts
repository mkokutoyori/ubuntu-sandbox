/**
 * DcHostnameDiscovery — resolves the computer-account name (SPN target) of
 * the DC a client has already been given an address for
 * (PRD-Windows-Server-Advanced.md §5 P24). Kerberos's TGS exchange needs
 * the DC's own `sAMAccountName` (minus its trailing `$`) as `serviceName`
 * — ticket verification happens against that exact computer account's
 * secret (`KdcSession.ts`) — but callers here are only ever given
 * `dcAddress`, never a hostname.
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

export interface DiscoveredDc {
  hostname: string;
  site: string | null;
}

/** Returns the discovered DC computer-account name (no trailing `$`) and the site that account records, or `null` if the DC couldn't be reached or has no discoverable computer account. */
export function discoverDc(tcpStack: TcpStack, dcAddress: string, dnsName: string): DiscoveredDc | null {
  const conn = dialLdap(tcpStack, dcAddress);
  if (!conn.ok || !conn.client) return null;
  const ldap = conn.client;

  const bind = ldap.bind('', '');
  if (!bind.ok) { ldap.unbind(); return null; }

  const rootDse = ldap.search('', 'base',
    { kind: 'present', attr: 'objectClass' }, ['dnsHostName', 'serverName']);
  const published = identityFromRootDse(rootDse.entries[0], dnsName);
  if (published) { ldap.unbind(); return published; }

  const search = ldap.search(
    `OU=Domain Controllers,${rootDnOf(dnsName)}`, 'sub',
    { kind: 'equalityMatch', attr: 'objectClass', value: 'computer' }, ['sAMAccountName', 'site'],
  );
  ldap.unbind();

  const attributeOf = (name: string): string | undefined =>
    search.entries[0]?.attributes.find(a => a.type.toLowerCase() === name)?.values[0];
  const sam = attributeOf('samaccountname');
  if (!sam) return null;
  return {
    hostname: sam.endsWith('$') ? sam.slice(0, -1) : sam,
    site: attributeOf('site') ?? null,
  };
}

function identityFromRootDse(
  entry: { attributes: ReadonlyArray<{ type: string; values: string[] }> } | undefined,
  dnsName: string,
): DiscoveredDc | null {
  const valueOf = (name: string): string | undefined =>
    entry?.attributes.find(a => a.type.toLowerCase() === name)?.values[0];
  const dnsHostName = valueOf('dnshostname');
  if (!dnsHostName) return null;
  const suffix = `.${dnsName.toLowerCase()}`;
  const hostname = dnsHostName.toLowerCase().endsWith(suffix)
    ? dnsHostName.slice(0, -suffix.length)
    : dnsHostName;
  const serverName = valueOf('servername');
  const site = serverName ? /CN=Servers,CN=([^,]+),CN=Sites,/i.exec(serverName)?.[1] ?? null : null;
  return { hostname, site };
}
