import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialKdc, buildApReq } from '@/network/kerberos/KerberosClient';
import { KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import type { LdapClient } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { discoverDcHostname } from './DcHostnameDiscovery';

export type KerberosLdapFailure = 'no-network-path' | 'bad-credential';

export interface KerberosLdapBindResult {
  client?: LdapClient;
  dcHostname?: string;
  failure?: KerberosLdapFailure;
}

export function bindLdapWithKerberos(opts: {
  tcpStack: TcpStack;
  dcAddress: string;
  domainName: string;
  user: string;
  password: string;
}): KerberosLdapBindResult {
  const dcHostname = discoverDcHostname(opts.tcpStack, opts.dcAddress, opts.domainName);
  if (!dcHostname) return { failure: 'no-network-path' };

  const realm = opts.domainName.toUpperCase();
  const kdcConn = dialKdc(opts.tcpStack, opts.dcAddress);
  if (!kdcConn.ok || !kdcConn.client) return { failure: 'no-network-path' };
  const cname = principalName(PrincipalNameType.NT_PRINCIPAL, opts.user);

  const asResult = kdcConn.client.asExchange(opts.user, opts.password, realm);
  if (!asResult.ok) return { failure: 'bad-credential' };
  const tgsResult = kdcConn.client.tgsExchange(asResult.ticket!, asResult.sessionKey!, cname, realm, dcHostname);
  if (!tgsResult.ok) return { failure: 'bad-credential' };
  const apReqBytes = buildApReq(tgsResult.ticket!, tgsResult.sessionKey!, cname, realm, KU_AP_REQ_AUTHENTICATOR);

  const conn = dialLdap(opts.tcpStack, opts.dcAddress);
  if (!conn.ok || !conn.client) return { failure: 'no-network-path' };
  const ldap = conn.client;

  const bind = ldap.bindSasl('GSSAPI', apReqBytes);
  if (!bind.ok) {
    ldap.unbind();
    return { failure: 'bad-credential' };
  }
  return { client: ldap, dcHostname };
}
