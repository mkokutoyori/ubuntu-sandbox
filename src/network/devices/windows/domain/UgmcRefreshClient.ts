/**
 * UgmcRefreshClient — a non-GC DC's real network refresh of its
 * Universal Group Membership Cache: dials a Global Catalog's real
 * TCP/389 LDAP listener, searches for every Universal-scope group
 * under the domain root, and inverts each group's `member` DNs into a
 * per-user membership map — not a topology-wide shortcut.
 */
import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';
import { leafValue, parseDN } from '../server/ad/ldap/LdapDN';

export interface UgmcRefreshResult { ok: boolean; message: string; membership?: Map<string, string[]> }

/** Real AD groupType bit for Universal scope (`GROUP_TYPE_UNIVERSAL_GROUP`, `0x00000008`, sign-extended to `-2147483640` — matches `DirectoryStore`'s own `GROUP_TYPE.Universal`). */
const UNIVERSAL_GROUP_TYPE = -2147483640;

export function refreshUgmcFromGc(
  tcpStack: TcpStack, gcAddress: string, domainRootDn: string, credentialUser: string, credentialPassword: string,
): UgmcRefreshResult {
  const conn = dialLdap(tcpStack, gcAddress);
  if (!conn.ok || !conn.client) return { ok: false, message: 'The specified Global Catalog either does not exist or could not be contacted.' };
  const ldap = conn.client;

  const bind = ldap.bind(credentialUser, credentialPassword);
  if (!bind.ok) {
    ldap.unbind();
    return { ok: false, message: 'Logon failure: unknown user name or bad password.' };
  }

  const result = ldap.search(domainRootDn, 'sub', { kind: 'equalityMatch', attr: 'objectClass', value: 'group' }, ['groupType', 'member']);
  ldap.unbind();
  if (!result.ok) return { ok: false, message: result.result.diagnosticMessage || 'unable to search the Global Catalog' };

  const membership = new Map<string, string[]>();
  for (const entry of result.entries) {
    const groupType = Number(entry.attributes.find(a => a.type.toLowerCase() === 'grouptype')?.values[0]);
    if (groupType !== UNIVERSAL_GROUP_TYPE) continue;
    const groupSam = entry.dn ? (leafValue(parseDN(entry.dn)) ?? '') : '';
    const memberDns = entry.attributes.find(a => a.type.toLowerCase() === 'member')?.values ?? [];
    for (const memberDnStr of memberDns) {
      let userSam: string | null;
      try { userSam = leafValue(parseDN(memberDnStr)); } catch { userSam = null; }
      if (!userSam) continue;
      const key = userSam.toLowerCase();
      const existing = membership.get(key) ?? [];
      existing.push(groupSam);
      membership.set(key, existing);
    }
  }
  return { ok: true, message: '', membership };
}
