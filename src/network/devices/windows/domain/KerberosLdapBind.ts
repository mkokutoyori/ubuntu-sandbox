import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';
import { GssInitiator } from '@/network/kerberos/gssapi/GssInitiator';
import { GSS_C_INTEG_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_SEQUENCE_FLAG } from '@/network/kerberos/gssapi/GssToken';
import { MAX_BUFFER_FIELD } from '@/network/ldap/gssapi/Rfc4752';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import type { LdapClient } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { discoverDc } from './DcHostnameDiscovery';
import { parseDomainQualifiedUser } from './DomainTypes';

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
  const dcHostname = discoverDc(opts.tcpStack, opts.dcAddress, opts.domainName)?.hostname ?? null;
  if (!dcHostname) return { failure: 'no-network-path' };

  const realm = opts.domainName.toUpperCase();
  const kdcConn = dialKdc(opts.tcpStack, opts.dcAddress);
  if (!kdcConn.ok || !kdcConn.client) return { failure: 'no-network-path' };
  const account = parseDomainQualifiedUser(opts.user, { dnsName: opts.domainName, netbiosName: opts.domainName.split('.')[0] })?.sam ?? opts.user;
  const cname = principalName(PrincipalNameType.NT_PRINCIPAL, account);

  const asResult = kdcConn.client.asExchange(account, opts.password, realm);
  if (!asResult.ok) return { failure: 'bad-credential' };
  const tgsResult = kdcConn.client.tgsExchange(asResult.ticket!, asResult.sessionKey!, cname, realm, dcHostname);
  if (!tgsResult.ok) return { failure: 'bad-credential' };
  const initiator = new GssInitiator({
    credential: { ticket: tgsResult.ticket!, sessionKey: tgsResult.sessionKey!, clientName: cname, clientRealm: realm },
    requestedFlags: GSS_C_MUTUAL_FLAG | GSS_C_SEQUENCE_FLAG | GSS_C_INTEG_FLAG,
    layerFlagsOnlyWhenRequested: true,
    clock: { nowMicroseconds: () => Math.floor(opts.tcpStack.nowMs() * 1000) },
  });

  const conn = dialLdap(opts.tcpStack, opts.dcAddress);
  if (!conn.ok || !conn.client) return { failure: 'no-network-path' };
  const ldap = conn.client;

  const bind = ldap.bindGssapi(initiator, { minSsf: 0, maxSsf: 0, externalSsf: 0, maxBufferSize: MAX_BUFFER_FIELD });
  if (!bind.ok) {
    ldap.unbind();
    return { failure: 'bad-credential' };
  }
  return { client: ldap, dcHostname };
}
