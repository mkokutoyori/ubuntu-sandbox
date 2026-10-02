import type { TlsProtocolVersion } from './legacy/legacyCipherSuites';
import { TlsClientSession } from './TlsClientSession';
import { CertificateVerifier } from '../pki/CertificateVerifier';
import { runTlsHandshakeOverSocket } from '../http/https/TlsRecordWire';
import type { TcpStack } from '../tcp/TcpStack';
import type { X509Certificate } from '../pki/X509Certificate';
import type { SignedOcspResponse } from '../pki/OcspResponder';

export interface TlsProbeOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly certificate: X509Certificate | null;
  readonly cipherSuite: string | null;
  readonly protocolVersion?: string | null;
  readonly alert?: string | null;
  readonly verified: boolean;
  readonly staple?: SignedOcspResponse | null;
}

export interface TlsProbeOptions {
  readonly servername?: string;
  readonly trustAnchors?: readonly X509Certificate[];
  readonly now?: number;
  readonly versions?: readonly TlsProtocolVersion[];
  readonly cipherList?: string;
  readonly requestStatus?: boolean;
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
    ...(options.versions ? { versions: options.versions } : {}),
    ...(options.cipherList ? { cipherList: options.cipherList } : {}),
    ...(options.requestStatus ? { collectOcspStaple: true } : {}),
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
  const protocolVersion = session.negotiatedVersion;
  const alert = session.lastAlert?.description ?? null;
  socket.close();

  if (certificate === null) {
    return {
      ok: false,
      reason: session.lastAlert?.description ?? 'no certificate presented',
      certificate: null, cipherSuite, protocolVersion, alert, verified: false,
    };
  }
  return { ok: true, certificate, cipherSuite, protocolVersion, alert, verified: succeeded, staple: session.receivedStaple };
}
