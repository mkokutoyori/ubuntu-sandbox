/**
 * DomainLogonClient — real domain logon dialogue (PRD-Windows-Server.md §5
 * P6): dials the DC's LDAP listener, authenticates as the supplied domain
 * account (the same real wire path a domain controller uses to validate
 * any credential — Add-Computer, `net user /domain`, SMB/WinRM domain
 * auth all end up here), then reads back the account's group
 * memberships with a real SearchRequest. No topology-wide shortcut.
 *
 * Authentication is real Kerberos (PRD-Windows-Server-Advanced.md §5 P24):
 * an AS exchange, then a TGS exchange for the DC's own computer account
 * (discovered via `discoverDcHostname`), then an AP-REQ presented as a
 * GSSAPI SASL bind — not the plaintext simple bind this used before. Every
 * failure point still surfaces the exact same observable message a
 * plaintext bind failure produced.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { discoverDcHostname, rootDnOf } from './DcHostnameDiscovery';
import type { DomainMembership, DomainSession } from './DomainTypes';
import { bindLdapWithKerberos } from './KerberosLdapBind';

export interface DomainLogonResult { ok: boolean; message: string; session?: DomainSession }

/** The leaf CN of a formatted DN string, e.g. `CN=Domain Admins,CN=Users,DC=lab,DC=local` → `Domain Admins`. */
function leafCn(dn: string): string | null {
  const m = /^CN=([^,]+)/i.exec(dn);
  return m ? m[1] : null;
}

export function logonDomainUser(tcpStack: TcpStack, membership: DomainMembership, sam: string, password: string): DomainLogonResult {
  const trustFailed: DomainLogonResult = { ok: false, message: 'The trust relationship between this workstation and the primary domain failed.' };
  const badCredential: DomainLogonResult = { ok: false, message: 'The user name or password is incorrect.' };

  const dcHostname = discoverDcHostname(tcpStack, membership.dcAddress, membership.dnsName);
  if (!dcHostname) return trustFailed;

  const session = bindLdapWithKerberos({
    tcpStack, dcAddress: membership.dcAddress, domainName: membership.dnsName,
    user: sam, password,
  });
  if (session.failure === 'no-network-path') return trustFailed;
  if (session.failure !== undefined || !session.client) return badCredential;
  const ldap = session.client;

  const search = ldap.search(rootDnOf(membership.dnsName), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam }, ['memberOf']);
  ldap.unbind();

  const memberOfDns = search.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'memberof')?.values ?? [];
  const groups = memberOfDns.map(leafCn).filter((s): s is string => s !== null);
  return { ok: true, message: '', session: { netbiosName: membership.netbiosName, sam, groups } };
}
