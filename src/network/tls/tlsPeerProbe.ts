import { TlsClientSession } from './TlsClientSession';
import { CertificateVerifier } from '../pki/CertificateVerifier';
import { runTlsHandshakeOverSocket } from '../http/https/TlsRecordWire';
import type { TcpStack } from '../tcp/TcpStack';
import type { X509Certificate } from '../pki/X509Certificate';

export interface TlsProbeOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly certificate: X509Certificate | null;
  readonly cipherSuite: string | null;
  readonly verified: boolean;
}

export interface TlsProbeOptions {
  readonly servername?: string;
  readonly trustAnchors?: readonly X509Certificate[];
  readonly now?: number;
}

export function probeTlsPeer(
  tcp: TcpStack, ip: string, port: number, options: TlsProbeOptions = {},
): TlsProbeOutcome {
  const socket = tcp.connect(ip, port);
  if (!socket || socket.state !== 'established') {
    return { ok: false, reason: 'connection refused', certificate: null, cipherSuite: null, verified: false };
  }

  const anchors = options.trustAnchors ?? [];
  const session = new TlsClientSession({
    verifier: new CertificateVerifier({ trustAnchors: anchors }),
    serverName: options.servername,
    alpn: ['http/1.1'],
  });

  try {
    runTlsHandshakeOverSocket(socket, session);
  } catch (error) {
    socket.close();
    return {
      ok: false, reason: error instanceof Error ? error.message : 'handshake error',
      certificate: null, cipherSuite: null, verified: false,
    };
  }

  const certificate = session.peerCertificate;
  const cipherSuite = session.negotiatedCipherSuite ?? null;
  const succeeded = session.result === 'success';
  socket.close();

  if (certificate === null) {
    return {
      ok: false,
      reason: session.lastAlert?.description ?? 'no certificate presented',
      certificate: null, cipherSuite, verified: false,
    };
  }
  return { ok: true, certificate, cipherSuite, verified: succeeded };
}
