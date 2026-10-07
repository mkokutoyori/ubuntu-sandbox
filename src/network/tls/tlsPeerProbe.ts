import type { TlsProtocolVersion } from './legacy/legacyCipherSuites';
import { TlsClientSession } from './TlsClientSession';
import { CertificateVerifier } from '../pki/CertificateVerifier';
import type { TcpStack } from '../tcp/TcpStack';
import type { X509Certificate } from '../pki/X509Certificate';
import type { OcspResponseMessage } from '../pki/OcspWire';
import { encryptApplicationData, decryptApplicationData } from '../http/https/ApplicationDataCipher';
import { runTlsHandshakeOverSocket, bytesToBinaryString, binaryStringToBytes, encodeRecords, decodeRecords } from '../http/https/TlsRecordWire';

export interface TlsHandshakeDetails {
  readonly peerSignature: { readonly digest: string; readonly type: string } | null;
  readonly serverTempKey: string | null;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly alpn: string | null;
  readonly verificationReason: string | null;
}

export interface TlsProbeOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly certificate: X509Certificate | null;
  readonly cipherSuite: string | null;
  readonly protocolVersion?: string | null;
  readonly alert?: string | null;
  readonly verified: boolean;
  readonly staple?: OcspResponseMessage | null;
  readonly received?: Uint8Array;
  readonly chain?: readonly X509Certificate[];
  readonly details?: TlsHandshakeDetails;
}

export interface TlsProbeOptions {
  readonly servername?: string;
  readonly trustAnchors?: readonly X509Certificate[];
  readonly now?: number;
  readonly versions?: readonly TlsProtocolVersion[];
  readonly cipherList?: string;
  readonly requestStatus?: boolean;
  readonly send?: Uint8Array;
  readonly alpn?: readonly string[];
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
    ...(options.send !== undefined ? { allowUntrustedPeer: true } : {}),
    ...(options.alpn && options.alpn.length > 0 ? { alpn: options.alpn } : {}),
    ...(options.versions ? { versions: options.versions } : {}),
    ...(options.cipherList ? { cipherList: options.cipherList } : {}),
    ...(options.requestStatus ? { collectOcspStaple: true } : {}),
  });

  let bytesRead = 0;
  let bytesWritten = 0;
  const counted = {
    write: (data: string): unknown => { bytesWritten += data.length; return socket.write(data); },
    onData: (callback: Parameters<typeof socket.onData>[0]) => socket.onData((data) => { bytesRead += String(data).length; callback(data); }),
    setNoDelay: (value: boolean) => socket.setNoDelay?.(value),
  };
  try {
    runTlsHandshakeOverSocket(counted as unknown as Parameters<typeof runTlsHandshakeOverSocket>[0], session);
  } catch (error) {
    socket.close();
    return {
      ok: false, reason: error instanceof Error ? error.message : 'handshake error',
      certificate: null, cipherSuite: null, verified: false,
    };
  }

  const certificate = session.peerCertificate;
  const cipherSuite = session.negotiatedCipherSuite ?? null;
  const succeeded = session.result === 'success' && (options.send === undefined || session.peerVerified);
  const completed = session.result === 'success';
  const protocolVersion = session.negotiatedVersion;
  const alert = session.lastAlert?.description ?? null;
  let received: Uint8Array | undefined;
  if (completed && options.send !== undefined) received = exchangeApplicationData(socket, session, options.send);
  socket.close();

  if (certificate === null) {
    return {
      ok: false,
      reason: session.lastAlert?.description ?? 'no certificate presented',
      certificate: null, cipherSuite, protocolVersion, alert, verified: false,
    };
  }
  return { ok: true, certificate, cipherSuite, protocolVersion, alert, verified: succeeded, staple: session.receivedStaple, ...(received ? { received } : {}), chain: session.peerCertificateChain,
    details: {
      peerSignature: session.peerSignature, serverTempKey: session.serverTempKey, bytesRead, bytesWritten,
      alpn: session.negotiatedAlpnProtocol, verificationReason: session.peerVerificationReason,
    } };
}

function exchangeApplicationData(socket: NonNullable<ReturnType<TcpStack['connect']>>, session: TlsClientSession, payload: Uint8Array): Uint8Array {
  let reply = new Uint8Array(0);
  let serverSequence = 0;
  const unsubscribe = socket.onData((data) => {
    try {
      const opened = decryptApplicationData(session.serverTraffic(), serverSequence, decodeRecords(binaryStringToBytes(String(data))));
      serverSequence = opened.nextSeq;
      const joined = new Uint8Array(reply.length + opened.plaintext.length);
      joined.set(reply); joined.set(opened.plaintext, reply.length);
      reply = joined;
    } catch {
      return;
    }
  });
  socket.write(bytesToBinaryString(encodeRecords(encryptApplicationData(session.clientTraffic(), 0, payload).records)));
  unsubscribe();
  return reply;
}
