import type { TcpStack } from '../../../tcp/TcpStack';
import { dialLdap } from '../../windows/server/ad/ldap/LdapClient';
import { trustHostAllows, type AccessMatrix } from '../authz/AccessMatrix';

export interface AdminAccountDraft {
  readonly name: string;
  readonly password?: string;
  readonly profile: string;
  readonly vdoms: readonly string[];
  readonly trustHosts: readonly { index: number; address: string; mask: string }[];
  readonly comments?: string;
}

export interface LdapBindTarget {
  readonly address: string;
  readonly baseDn?: string;
  readonly cnid?: string;
}

export function applyAdminAccount(
  access: AccessMatrix, secrets: Map<string, string>, admin: AdminAccountDraft,
): void {
  access.setAdmin({
    name: admin.name,
    profile: admin.profile,
    vdoms: [...admin.vdoms],
    trustHosts: admin.trustHosts.map(host => ({ ...host })),
    remoteAuth: false,
    comments: admin.comments,
  });

  if (admin.password === undefined) return;
  secrets.set(admin.name, admin.password);
}

export function authenticateAdmin(
  access: AccessMatrix, secrets: Map<string, string>,
  name: string, password: string, source?: string,
): boolean {
  const admin = access.getAdmin(name);
  if (!admin) return false;
  if (source !== undefined && !trustHostAllows(admin.trustHosts, source)) return false;
  return secrets.get(name) === password;
}

export function adminTrustsSource(
  access: AccessMatrix, name: string, source: string,
): boolean {
  const admin = access.getAdmin(name);
  if (!admin) return false;
  return trustHostAllows(admin.trustHosts, source);
}

export function ldapBind(
  tcp: TcpStack, server: LdapBindTarget, user: string, password: string,
): boolean {
  const dialed = dialLdap(tcp, server.address);
  if (!dialed.ok || !dialed.client) return false;

  const dn = `${server.cnid ?? 'cn'}=${user},${server.baseDn ?? ''}`;
  const bound = dialed.client.bind(dn, password);
  dialed.client.unbind();
  return bound.ok;
}
