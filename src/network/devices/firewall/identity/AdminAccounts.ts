import type { TcpStack } from '../../../tcp/TcpStack';
import { parseAuthorizedKeysLine } from '../../../protocols/ssh/SshPureUtils';
import { dialLdap } from '../../windows/server/ad/ldap/LdapClient';
import { trustHostAllows, type AccessMatrix } from '../authz/AccessMatrix';
import type { IdentitySource } from './IdentityTable';
import type { PasswordHistory } from './PasswordHistory';

export interface AdminAccountDraft {
  readonly name: string;
  readonly password?: string;
  readonly profile: string;
  readonly vdoms: readonly string[];
  readonly trustHosts: readonly { index: number; address: string; mask: string }[];
  readonly sshPublicKeys?: readonly string[];
  readonly comments?: string;
}

export interface ApiUserDraft {
  readonly name: string;
  readonly apiKey?: string;
  readonly profile: string;
  readonly trustHosts: readonly { index: number; address: string; mask: string }[];
}

export interface ApiPrincipal {
  readonly name: string;
  readonly profile: string;
}

const API_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const API_KEY_LENGTH = 30;

export function generateApiKey(random: (count: number) => Uint8Array = randomBytes): string {
  let key = '';
  for (const byte of random(API_KEY_LENGTH)) key += API_KEY_ALPHABET[byte % API_KEY_ALPHABET.length];
  return key;
}

function randomBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  if (typeof globalThis.crypto?.getRandomValues === 'function') return globalThis.crypto.getRandomValues(out);
  for (let at = 0; at < count; at += 1) out[at] = Math.floor(Math.random() * 256);
  return out;
}

export function authenticateApiKey(
  users: ReadonlyMap<string, ApiUserDraft>, key: string, source: string,
): ApiPrincipal | null {
  if (key === '') return null;
  for (const user of users.values()) {
    if (user.apiKey !== key) continue;
    if (!trustHostAllows(user.trustHosts, source)) return null;
    return { name: user.name, profile: user.profile };
  }
  return null;
}

export interface LdapBindTarget {
  readonly address: string;
  readonly baseDn?: string;
  readonly cnid?: string;
}

export function applyAdminAccount(
  access: AccessMatrix, secrets: Map<string, string>, admin: AdminAccountDraft,
  history?: PasswordHistory, at?: number,
): void {
  access.setAdmin({
    name: admin.name,
    profile: admin.profile,
    vdoms: [...admin.vdoms],
    trustHosts: admin.trustHosts.map(host => ({ ...host })),
    sshPublicKeys: [...(admin.sshPublicKeys ?? [])],
    remoteAuth: false,
    comments: admin.comments,
  });

  if (admin.password === undefined) return;
  secrets.set(admin.name, admin.password);
  history?.remember(admin.name, admin.password, at);
}

export function authenticateAdmin(
  access: AccessMatrix, secrets: Map<string, string>,
  name: string, password: string, source?: string,
): boolean {
  const admin = access.getAdmin(name);
  if (!admin) return false;
  if (source !== undefined && !trustHostAllows(admin.trustHosts, source)) return false;
  return (secrets.get(name) ?? '') === password;
}

export function adminAcceptsPublicKey(
  access: AccessMatrix, name: string, material: string, source: string,
): boolean {
  const admin = access.getAdmin(name);
  if (!admin) return false;
  if (!trustHostAllows(admin.trustHosts, source)) return false;
  return admin.sshPublicKeys.some(line => parseAuthorizedKeysLine(line)?.material === material);
}

export function adminHasNoPassword(
  access: AccessMatrix, secrets: Map<string, string>, name: string,
): boolean {
  if (!access.getAdmin(name)) return false;
  return (secrets.get(name) ?? '') === '';
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

export interface RemoteAuthDeps {
  readonly tcp: TcpStack;
  readonly server: (name: string) => DeclaredAuthServer | undefined;
  readonly radius: AuthenticatingAgent;
  readonly tacacs: AuthenticatingAgent;
}

export interface DeclaredAuthServer extends LdapBindTarget {
  readonly kind: IdentitySource;
  readonly address: string;
}

export interface AuthenticatingAgent {
  authenticate(
    user: string, password: string, address: string,
  ): Promise<boolean | { status: string }> | boolean | { status: string };
}

export interface RemoteAuthResult {
  readonly accepted: boolean;
  readonly server?: string;
  readonly source?: IdentitySource;
}

export async function remoteAuthenticate(
  deps: RemoteAuthDeps, server: string, user: string, password: string,
): Promise<RemoteAuthResult> {
  const declared = deps.server(server);
  if (!declared) return { accepted: false };

  if (declared.kind === 'ldap') {
    return { accepted: ldapBind(deps.tcp, declared, user, password), server, source: 'ldap' };
  }

  const agent = declared.kind === 'radius' ? deps.radius : deps.tacacs;
  const outcome = await agent.authenticate(user, password, declared.address);
  const accepted = typeof outcome === 'boolean' ? outcome : outcome.status === 'pass';
  return { accepted, server, source: declared.kind };
}
