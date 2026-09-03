/**
 * DomainJoinClient — real `Add-Computer -DomainName`/`netdom join` network
 * dialogue (PRD-Windows-Server.md §5 P6): dials the DC's real TCP/389
 * LDAP listener via `LdapClient` (not a topology-wide lookup or a direct
 * method call into the DC's `DirectoryStore`), authenticates with the
 * supplied admin credential, and creates the computer's account object
 * over the wire with an `AddRequest` — exactly what a real domain join
 * does.
 *
 * Authentication is real Kerberos (PRD-Windows-Server-Advanced.md §5 P24):
 * an AS exchange, then a TGS exchange for the DC's own computer account
 * (discovered via `discoverDcHostname`, §5 P24's own doc), then an AP-REQ
 * presented as a GSSAPI SASL bind — not the plaintext simple bind this
 * used before. Every failure point still surfaces the exact same observable
 * message a plaintext bind failure produced, so existing consumers see no
 * behavioural change.
 *
 * DC location: no DNS SRV `_ldap._tcp.dc._msdcs.<domain>` lookup yet
 * (depends on the DNS Server role, P7) — callers must resolve the DC's
 * address themselves (explicit `-Server`, or the domain name itself if it
 * happens to already resolve) and pass it in as `dcAddress`.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { rootDnOf } from './DcHostnameDiscovery';
import { bindLdapWithKerberos } from './KerberosLdapBind';
import type { DomainMembership } from './DomainTypes';

export interface DomainJoinResult { ok: boolean; message: string; membership?: DomainMembership }

function randomMachineSecret(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function joinDomain(opts: {
  tcpStack: TcpStack;
  computerName: string;
  domainName: string;
  dcAddress: string;
  credentialUser: string;
  credentialPassword: string;
  ouPath?: string;
}): DomainJoinResult {
  const networkPathNotFound: DomainJoinResult = {
    ok: false,
    message: `Computer '${opts.computerName}' failed to join domain '${opts.domainName}' from its current workgroup with following error message: `
      + `The network path was not found.`,
  };
  const badCredential: DomainJoinResult = {
    ok: false,
    message: `Computer '${opts.computerName}' failed to join domain '${opts.domainName}' from its current workgroup with following error message: `
      + `Logon failure: unknown user name or bad password.`,
  };

  const session = bindLdapWithKerberos({
    tcpStack: opts.tcpStack, dcAddress: opts.dcAddress, domainName: opts.domainName,
    user: opts.credentialUser, password: opts.credentialPassword,
  });
  if (session.failure === 'no-network-path') return networkPathNotFound;
  if (session.failure !== undefined || !session.client) return badCredential;
  const ldap = session.client;

  // `-OUPath` names a real, possibly-nested container DN (e.g.
  // `OU=Postes,OU=Ordinateurs,OU=Mandeng,DC=...`) — used verbatim as the
  // parent, exactly like a real `Add-Computer -OUPath`/`dsadd computer`
  // over LDAP. The DC's own `Add` handling (`DirectoryTree.addEntry`)
  // is what actually validates the parent exists.
  const computerDn = opts.ouPath
    ? `CN=${opts.computerName},${opts.ouPath}`
    : `CN=${opts.computerName},CN=Computers,${rootDnOf(opts.domainName)}`;
  const machineSecret = randomMachineSecret();
  const add = ldap.add(computerDn, [
    { type: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user', 'computer'] },
    { type: 'cn', values: [opts.computerName] },
    { type: 'sAMAccountName', values: [`${opts.computerName}$`] },
    { type: 'userAccountControl', values: ['4096'] },
    { type: 'userPassword', values: [machineSecret] },
    { type: 'servicePrincipalName', values: [`HOST/${opts.computerName}`, `HOST/${opts.computerName}.${opts.domainName}`] },
  ]);
  ldap.unbind();

  if (!add.ok) {
    const reason = add.result.diagnosticMessage || 'unknown error';
    return {
      ok: false,
      message: `Computer '${opts.computerName}' failed to join domain '${opts.domainName}' from its current workgroup with following error message: ${reason}`,
    };
  }

  const netbiosName = opts.domainName.split('.')[0].toUpperCase();
  return {
    ok: true,
    message: '',
    membership: { dnsName: opts.domainName, netbiosName, dcAddress: opts.dcAddress, machineSecret },
  };
}
