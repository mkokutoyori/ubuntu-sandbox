import type { TcpStack } from '@/network/tcp/TcpStack';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import type { LdapClient } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { IPAddress } from '@/network/core/types';
import { bindLdapWithKerberos } from '@/network/devices/windows/domain/KerberosLdapBind';

export interface RemoteDirectoryTarget {
  server: string;
  bindUser: string;
  bindPassword: string;
  authType: string;
  domainName?: string;
}

export interface RemoteDirectoryResult { ok: boolean; message: string }

export type RemoteDirectoryWork<T> = (client: LdapClient) => T;

export interface RemoteDirectoryHost {
  tcpStack(): TcpStack;
  resolveAddress(name: string): IPAddress | null;
}

export interface RemoteDirectoryOutcome<T> {
  value?: T;
  failure?: string;
}

export function withRemoteDirectory<T>(
  host: RemoteDirectoryHost,
  target: RemoteDirectoryTarget,
  cmdletName: string,
  work: RemoteDirectoryWork<T>,
): RemoteDirectoryOutcome<T> {
  const address = host.resolveAddress(target.server);
  if (!address) {
    return { failure: `${cmdletName} : Unable to contact the server. This may be because this server does not exist, it is currently down, or it does not have the Active Directory Web Services running.` };
  }
  const conn = dialLdap(host.tcpStack(), address.toString());
  if (!conn.ok || !conn.client) {
    return { failure: `${cmdletName} : Unable to contact the server. ${conn.error ?? ''}`.trim() };
  }
  let client = conn.client;
  if (target.authType.toLowerCase() === 'negotiate' && target.domainName) {
    client.unbind();
    const session = bindLdapWithKerberos({
      tcpStack: host.tcpStack(), dcAddress: address.toString(),
      domainName: target.domainName, user: target.bindUser, password: target.bindPassword,
    });
    if (session.failure === 'no-network-path' || !session.client) {
      return { failure: `${cmdletName} : ${session.failure === 'bad-credential' ? 'The supplied credential is invalid.' : 'Unable to contact the server.'}` };
    }
    client = session.client;
  } else {
    const bind = client.bind(target.bindUser, target.bindPassword);
    if (!bind.ok) {
      client.unbind();
      return { failure: `${cmdletName} : The supplied credential is invalid.` };
    }
  }
  try {
    return { value: work(client) };
  } finally {
    client.unbind();
  }
}
