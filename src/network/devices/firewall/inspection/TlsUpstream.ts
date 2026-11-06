import type { TcpStack, TcpSocket } from '../../../tcp/TcpStack';
import { TlsClientSession } from '../../../tls/TlsClientSession';
import { CertificateVerifier } from '../../../pki/CertificateVerifier';
import { runTlsHandshakeOverSocket } from '../../../http/https/TlsRecordWire';
import type { X509Certificate } from '../../../pki/X509Certificate';

export interface TlsUpstream {
  readonly socket: TcpSocket;
  readonly session: TlsClientSession;
  readonly certificate: X509Certificate;
  readonly verified: boolean;
}

export function openTlsUpstream(
  tcp: TcpStack, trustAnchors: readonly X509Certificate[], ip: string, port: number,
): TlsUpstream | null {
  const socket = tcp.connect(ip, port);
  if (!socket || socket.state !== 'established') return null;

  const session = new TlsClientSession({
    verifier: new CertificateVerifier({ trustAnchors, clock: () => tcp.nowMs() }),
    allowUntrustedPeer: true,
    alpn: ['http/1.1'],
  });
  runTlsHandshakeOverSocket(socket, session);

  const certificate = session.peerCertificate;
  if (!certificate) { socket.close(); return null; }
  if (session.result !== 'success') { socket.close(); return null; }
  return { socket, session, certificate, verified: session.peerVerified };
}
