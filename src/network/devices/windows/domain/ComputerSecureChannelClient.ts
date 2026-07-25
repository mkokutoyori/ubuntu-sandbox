/**
 * ComputerSecureChannelClient — `netdom reset`/`resetpwd`/`remove`/
 * `renamecomputer` (docs/PRD-Netdom.md §2.1 P2/P3/P4/P5): a real LDAP
 * dialogue (search to find the computer account's own DN, then
 * `ModifyRequest`/`DelRequest`/`ModifyDNRequest` on it) against a
 * domain's DC, over this machine's own `TcpStack` — no direct method
 * call into another device's `DirectoryStore`. Mirrors `GpoPullClient`'s
 * wire shape exactly (dial, bind, search, act, unbind).
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap, type LdapClient } from '../server/ad/ldap/LdapClient';
import { rootDnOf } from './DcHostnameDiscovery';

export interface ComputerOpResult { ok: boolean; message: string }

function findComputerDn(client: LdapClient, rootDn: string, sam: string): string | null {
  const result = client.search(rootDn, 'sub', { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam }, []);
  if (!result.ok || result.entries.length === 0) return null;
  return result.entries[0].dn;
}

/** Binds with `credentialUser`/`credentialPassword` (a domain admin, not the computer's own account — real `netdom reset`'s `/UserO`/`/PasswordO`), finds this computer's own account by sAMAccountName, and replaces its `userPassword`. */
export function resetComputerSecretOverWire(
  tcpStack: TcpStack, dcAddress: string, dnsName: string, computerName: string, newSecret: string,
  credentialUser: string, credentialPassword: string,
): ComputerOpResult {
  const conn = dialLdap(tcpStack, dcAddress);
  if (!conn.ok || !conn.client) return { ok: false, message: 'The specified domain either does not exist or could not be contacted.' };
  const bind = conn.client.bind(credentialUser, credentialPassword);
  if (!bind.ok) { conn.client.unbind(); return { ok: false, message: 'Logon failure: unknown user name or bad password.' }; }
  const dn = findComputerDn(conn.client, rootDnOf(dnsName), `${computerName}$`);
  if (!dn) { conn.client.unbind(); return { ok: false, message: `Cannot find an object with identity: '${computerName}'.` }; }
  const mod = conn.client.modify(dn, [{ operation: 'replace', modification: { type: 'userPassword', values: [newSecret] } }]);
  conn.client.unbind();
  if (!mod.ok) return { ok: false, message: mod.result.diagnosticMessage || 'The secure channel could not be reset.' };
  return { ok: true, message: '' };
}

/** Binds as a domain admin, finds the computer account, and deletes it — `netdom remove`'s DC-side effect (real AD deletes the object, it doesn't just disable it). */
export function removeComputerAccountOverWire(
  tcpStack: TcpStack, dcAddress: string, dnsName: string, computerName: string,
  credentialUser: string, credentialPassword: string,
): ComputerOpResult {
  const conn = dialLdap(tcpStack, dcAddress);
  if (!conn.ok || !conn.client) return { ok: false, message: 'The specified domain either does not exist or could not be contacted.' };
  const bind = conn.client.bind(credentialUser, credentialPassword);
  if (!bind.ok) { conn.client.unbind(); return { ok: false, message: 'Logon failure: unknown user name or bad password.' }; }
  const dn = findComputerDn(conn.client, rootDnOf(dnsName), `${computerName}$`);
  if (!dn) { conn.client.unbind(); return { ok: false, message: `Cannot find an object with identity: '${computerName}'.` }; }
  const del = conn.client.delete(dn);
  conn.client.unbind();
  if (!del.ok) return { ok: false, message: del.result.diagnosticMessage || 'The computer account could not be removed.' };
  return { ok: true, message: '' };
}

/**
 * Binds as a domain admin, finds the computer account by its OLD
 * sAMAccountName, then renames it for real: a `ModifyDNRequest` (RFC
 * 4511 §4.9) changes the RDN/DN itself, followed by a `ModifyRequest`
 * updating `sAMAccountName`/`servicePrincipalName`/`dNSHostName` to
 * match — `netdom renamecomputer`/`Rename-Computer`'s DC-side effect
 * (docs/PRD-Netdom.md §2.1 P5). **Known simplification**: this
 * simulator has no dynamic DNS update protocol (RFC 2136) anywhere —
 * the DNS A record isn't touched by this operation, only the directory
 * object itself; a real deployment's DNS zone would also need updating,
 * which stays a manual `Add-/Remove-DnsServerResourceRecordA` step here.
 */
export function renameComputerAccountOverWire(
  tcpStack: TcpStack, dcAddress: string, dnsName: string, oldComputerName: string, newComputerName: string,
  credentialUser: string, credentialPassword: string,
): ComputerOpResult {
  const conn = dialLdap(tcpStack, dcAddress);
  if (!conn.ok || !conn.client) return { ok: false, message: 'The specified domain either does not exist or could not be contacted.' };
  const bind = conn.client.bind(credentialUser, credentialPassword);
  if (!bind.ok) { conn.client.unbind(); return { ok: false, message: 'Logon failure: unknown user name or bad password.' }; }
  const dn = findComputerDn(conn.client, rootDnOf(dnsName), `${oldComputerName}$`);
  if (!dn) { conn.client.unbind(); return { ok: false, message: `Cannot find an object with identity: '${oldComputerName}'.` }; }
  const parentDn = dn.split(',').slice(1).join(',');
  const newRdn = `CN=${newComputerName}`;
  const rename = conn.client.modifyDN(dn, newRdn, true);
  if (!rename.ok) { conn.client.unbind(); return { ok: false, message: rename.result.diagnosticMessage || 'The computer could not be renamed.' }; }
  const newDn = `${newRdn},${parentDn}`;
  const mod = conn.client.modify(newDn, [
    { operation: 'replace', modification: { type: 'sAMAccountName', values: [`${newComputerName}$`] } },
    { operation: 'replace', modification: { type: 'servicePrincipalName', values: [`HOST/${newComputerName}`, `HOST/${newComputerName}.${dnsName}`] } },
    { operation: 'replace', modification: { type: 'dNSHostName', values: [`${newComputerName}.${dnsName}`] } },
  ]);
  conn.client.unbind();
  if (!mod.ok) return { ok: false, message: mod.result.diagnosticMessage || 'The computer could not be renamed.' };
  return { ok: true, message: '' };
}
