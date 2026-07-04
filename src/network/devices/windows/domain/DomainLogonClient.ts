/**
 * DomainLogonClient — real domain logon dialogue (PRD-Windows-Server.md §5
 * P6): dials the DC's LDAP listener, binds as the supplied domain
 * account (the same real wire path a domain controller uses to validate
 * any credential — Add-Computer, `net user /domain`, SMB/WinRM domain
 * auth all end up here), then reads back the account's group
 * memberships with a real SearchRequest. No topology-wide shortcut.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';
import type { DomainMembership, DomainSession } from './DomainTypes';

export interface DomainLogonResult { ok: boolean; message: string; session?: DomainSession }

function rootDnOf(dnsName: string): string {
  return dnsName.split('.').map(p => `DC=${p}`).join(',');
}

/** The leaf CN of a formatted DN string, e.g. `CN=Domain Admins,CN=Users,DC=lab,DC=local` → `Domain Admins`. */
function leafCn(dn: string): string | null {
  const m = /^CN=([^,]+)/i.exec(dn);
  return m ? m[1] : null;
}

export function logonDomainUser(tcpStack: TcpStack, membership: DomainMembership, sam: string, password: string): DomainLogonResult {
  const conn = dialLdap(tcpStack, membership.dcAddress);
  if (!conn.ok || !conn.client) {
    return { ok: false, message: 'The trust relationship between this workstation and the primary domain failed.' };
  }
  const ldap = conn.client;

  const bind = ldap.bind(sam, password);
  if (!bind.ok) {
    ldap.unbind();
    return { ok: false, message: 'The user name or password is incorrect.' };
  }

  const search = ldap.search(rootDnOf(membership.dnsName), 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam }, ['memberOf']);
  ldap.unbind();

  const memberOfDns = search.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'memberof')?.values ?? [];
  const groups = memberOfDns.map(leafCn).filter((s): s is string => s !== null);
  return { ok: true, message: '', session: { netbiosName: membership.netbiosName, sam, groups } };
}
