/**
 * DomainJoinClient — real `Add-Computer -DomainName`/`netdom join` network
 * dialogue (PRD-Windows-Server.md §5 P6): dials the DC's real TCP/389
 * LDAP listener via `LdapClient` (not a topology-wide lookup or a direct
 * method call into the DC's `DirectoryStore`), binds with the supplied
 * admin credential, and creates the computer's account object over the
 * wire with an `AddRequest` — exactly what a real domain join does.
 *
 * DC location: no DNS SRV `_ldap._tcp.dc._msdcs.<domain>` lookup yet
 * (depends on the DNS Server role, P7) — callers must resolve the DC's
 * address themselves (explicit `-Server`, or the domain name itself if it
 * happens to already resolve) and pass it in as `dcAddress`.
 */

import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';
import type { DomainMembership } from './DomainTypes';

export interface DomainJoinResult { ok: boolean; message: string; membership?: DomainMembership }

function randomMachineSecret(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function rootDnOf(dnsName: string): string {
  return dnsName.split('.').map(p => `DC=${p}`).join(',');
}

export function joinDomain(opts: {
  tcpStack: TcpStack;
  computerName: string;
  domainName: string;
  dcAddress: string;
  credentialUser: string;
  credentialPassword: string;
}): DomainJoinResult {
  const conn = dialLdap(opts.tcpStack, opts.dcAddress);
  if (!conn.ok || !conn.client) {
    return {
      ok: false,
      message: `Computer '${opts.computerName}' failed to join domain '${opts.domainName}' from its current workgroup with following error message: `
        + `The network path was not found.`,
    };
  }
  const ldap = conn.client;

  const bind = ldap.bind(opts.credentialUser, opts.credentialPassword);
  if (!bind.ok) {
    ldap.unbind();
    return {
      ok: false,
      message: `Computer '${opts.computerName}' failed to join domain '${opts.domainName}' from its current workgroup with following error message: `
        + `Logon failure: unknown user name or bad password.`,
    };
  }

  const computerDn = `CN=${opts.computerName},CN=Computers,${rootDnOf(opts.domainName)}`;
  const machineSecret = randomMachineSecret();
  const add = ldap.add(computerDn, [
    { type: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user', 'computer'] },
    { type: 'cn', values: [opts.computerName] },
    { type: 'sAMAccountName', values: [`${opts.computerName}$`] },
    { type: 'userAccountControl', values: ['4096'] },
    { type: 'userPassword', values: [machineSecret] },
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
