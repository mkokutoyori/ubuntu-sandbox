/**
 * FsmoTransferClient — `Move-ADDirectoryServerOperationMasterRole`'s
 * real network dialogue for the three domain-wide FSMO roles (RID
 * Master/PDC Emulator/Infrastructure Master): dials the current
 * holder's real TCP/389 LDAP listener and issues a genuine
 * `ModifyRequest` recording the new owner on its own domain root entry
 * — not a topology-wide shortcut. Schema Master/Domain Naming Master
 * are forest-wide and shared by reference (`forest/Forest.ts`), so
 * there is no remote object to write to for those; use a local seize
 * instead.
 */
import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '../server/ad/ldap/LdapClient';
import { DOMAIN_FSMO_ROLE_ATTR, type DomainFsmoRole } from '../server/ad/fsmo/FsmoRoles';

export interface FsmoTransferResult { ok: boolean; message: string }

export function transferDomainFsmoRole(opts: {
  tcpStack: TcpStack;
  role: DomainFsmoRole;
  currentHolderDcAddress: string;
  domainRootDn: string;
  credentialUser: string;
  credentialPassword: string;
  newOwnerHostname: string;
}): FsmoTransferResult {
  const conn = dialLdap(opts.tcpStack, opts.currentHolderDcAddress);
  if (!conn.ok || !conn.client) return { ok: false, message: 'The specified domain either does not exist or could not be contacted.' };
  const ldap = conn.client;

  const bind = ldap.bind(opts.credentialUser, opts.credentialPassword);
  if (!bind.ok) {
    ldap.unbind();
    return { ok: false, message: 'Logon failure: unknown user name or bad password.' };
  }

  const modify = ldap.modify(opts.domainRootDn, [
    { operation: 'replace', modification: { type: DOMAIN_FSMO_ROLE_ATTR[opts.role], values: [opts.newOwnerHostname] } },
  ]);
  ldap.unbind();
  if (!modify.ok) return { ok: false, message: modify.result.diagnosticMessage || 'unable to transfer role' };
  return { ok: true, message: '' };
}
