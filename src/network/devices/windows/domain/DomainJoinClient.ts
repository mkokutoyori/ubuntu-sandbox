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
import { dialLdap } from '../server/ad/ldap/LdapClient';
import { dialKdc, buildApReq } from '@/network/kerberos/KerberosClient';
import { KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';
import { discoverDcHostname, rootDnOf } from './DcHostnameDiscovery';
import { parseDN, leafValue } from '../server/ad/ldap/LdapDN';
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

  const dcHostname = discoverDcHostname(opts.tcpStack, opts.dcAddress, opts.domainName);
  if (!dcHostname) return networkPathNotFound;

  const realm = opts.domainName.toUpperCase();
  const kdcConn = dialKdc(opts.tcpStack, opts.dcAddress);
  if (!kdcConn.ok || !kdcConn.client) return networkPathNotFound;
  const cname = principalName(PrincipalNameType.NT_PRINCIPAL, opts.credentialUser);

  const asResult = kdcConn.client.asExchange(opts.credentialUser, opts.credentialPassword, realm);
  if (!asResult.ok) return badCredential;
  const tgsResult = kdcConn.client.tgsExchange(asResult.ticket!, asResult.sessionKey!, cname, realm, dcHostname);
  if (!tgsResult.ok) return badCredential;
  const apReqBytes = buildApReq(tgsResult.ticket!, tgsResult.sessionKey!, cname, realm, KU_AP_REQ_AUTHENTICATOR);

  const conn = dialLdap(opts.tcpStack, opts.dcAddress);
  if (!conn.ok || !conn.client) return networkPathNotFound;
  const ldap = conn.client;

  const bind = ldap.bindSasl('GSSAPI', apReqBytes);
  if (!bind.ok) {
    ldap.unbind();
    return badCredential;
  }

  const targetContainer = (() => {
    if (!opts.ouPath) return 'CN=Computers';
    try {
      const leaf = leafValue(parseDN(opts.ouPath));
      return leaf ? `OU=${leaf}` : 'CN=Computers';
    } catch { return 'CN=Computers'; }
  })();
  const computerDn = `CN=${opts.computerName},${targetContainer},${rootDnOf(opts.domainName)}`;
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
