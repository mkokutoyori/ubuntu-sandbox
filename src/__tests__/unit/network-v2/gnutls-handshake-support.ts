import { defaultLdapOptions } from '@/network/ldap/openldap/ldapOptions';
import { connectTls, type TlsConnectHost } from '@/network/ldap/openldap/tls/tlsConnect';
import type { TlsClientConfig } from '@/network/tls/TlsClientSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import { TlsServerSession, type TlsServerConfig } from '@/network/tls/TlsServerSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

export function play(client: TlsClientSession, server: TlsServerSession): void {
  let flight: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 10 && server.result === null && flight !== null && flight.length > 0; i++) {
    const reply = server.handle(flight);
    if (reply === null) break;
    flight = client.handle(reply);
  }
}

export async function connectWithPriority(
  priority: string, server: () => TlsServerConfig,
): Promise<{ lines: string[]; suite: string | null }> {
  const lines: string[] = [];
  let suite: string | null = null;
  const options = defaultLdapOptions();
  options.tls.requireCert = 0;
  options.tls.cipherSuite = priority;
  const host: TlsConnectHost = {
    files: { read: () => ({ error: 'No such file or directory' }), regularFiles: () => null },
    localFqdn: async () => 'vm',
    handshake(config: TlsClientConfig) {
      const peer = new TlsServerSession(server());
      const session = new TlsClientSession(config);
      play(session, peer);
      suite = session.result === 'success' ? session.negotiatedCipherSuite : null;
      return {
        established: session.result === 'success', alert: session.lastAlert !== null,
        localAlert: session.peerAlert === null ? session.lastAlert?.description ?? null : null,
        certificate: session.peerCertificate, chain: session.peerCertificateChain, verification: { ok: true as const },
      };
    },
    detach: () => undefined,
  };
  await connectTls({ serverName: '10.0.0.10', tls: options.tls, implicit: true, debug: (_level: number, text: string) => { lines.push(text.trimEnd()); } }, host);
  return { lines, suite };
}
