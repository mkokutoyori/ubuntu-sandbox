import { TlsClientChannel } from './TlsClientChannel';
import type { TlsProtocolVersion } from './legacy/legacyCipherSuites';
import { TlsClientSession } from './TlsClientSession';
import { CertificateVerifier } from '../pki/CertificateVerifier';
import type { TcpStack } from '../tcp/TcpStack';
import type { SessionTicket } from './sessionTickets';
import type { ResumableLegacySession } from './legacy/legacySessions';
import type { PkiPrivateKey } from '../pki/PkiKeyPair';
import type { X509Certificate } from '../pki/X509Certificate';
import type { OcspResponseMessage } from '../pki/OcspWire';
import { runTlsHandshakeOverSocket } from '../http/https/TlsRecordWire';

export interface TlsHandshakeDetails {
  readonly peerSignature: { readonly digest: string; readonly type: string } | null;
  readonly serverTempKey: string | null;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly alpn: string | null;
  readonly verificationReason: string | null;
  readonly legacySession: ResumableLegacySession | null;
  readonly ticket: SessionTicket | null;
  readonly resumed: boolean;
  readonly earlyData: 'accepted' | 'rejected' | 'not-sent';
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
  readonly channel?: TlsClientChannel;
}

export interface TlsProbeOptions {
  readonly servername?: string;
  readonly trustAnchors?: readonly X509Certificate[];
  readonly now?: number;
  readonly versions?: readonly TlsProtocolVersion[];
  readonly cipherList?: string;
  readonly requestStatus?: boolean;
  readonly send?: Uint8Array;
  readonly keepOpen?: boolean;
  readonly resumptionTicket?: SessionTicket;
  readonly legacySession?: ResumableLegacySession;
  readonly earlyData?: Uint8Array;
  readonly alpn?: readonly string[];
  readonly clientCredential?: { readonly chain: readonly X509Certificate[]; readonly privateKey: PkiPrivateKey };
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
    ...(options.send !== undefined || options.keepOpen === true ? { allowUntrustedPeer: true } : {}),
    ...(options.clientCredential ? { clientCert: options.clientCredential.chain[0], clientChain: options.clientCredential.chain.slice(1), clientPrivateKey: options.clientCredential.privateKey } : {}),
    ...(options.alpn && options.alpn.length > 0 ? { alpn: options.alpn } : {}),
    ...(options.versions ? { versions: options.versions } : {}),
    ...(options.cipherList ? { cipherList: options.cipherList } : {}),
    ...(options.requestStatus ? { collectOcspStaple: true } : {}),
    ...(options.resumptionTicket ? { resumptionTicket: options.resumptionTicket } : {}),
    ...(options.legacySession ? { legacySession: options.legacySession } : {}),
    ...(options.resumptionTicket && options.earlyData ? { earlyData: options.earlyData } : {}),
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
  const succeeded = session.result === 'success' && ((options.send === undefined && options.keepOpen !== true) || session.peerVerified);
  const completed = session.result === 'success';
  const protocolVersion = session.negotiatedVersion;
  const alert = session.lastAlert?.description ?? null;
  const channel = new TlsClientChannel(socket, session);
  let received: Uint8Array | undefined;
  if (completed && options.send !== undefined) received = channel.exchange(options.send);
  const keepOpen = completed && options.keepOpen === true;
  if (!keepOpen) socket.close();

  if (certificate === null) {
    return {
      ok: false,
      reason: session.lastAlert?.description ?? 'no certificate presented',
      certificate: null, cipherSuite, protocolVersion, alert, verified: false,
    };
  }
  return { ok: true, certificate, cipherSuite, protocolVersion, alert, verified: succeeded, staple: session.receivedStaple, ...(received ? { received } : {}), chain: session.peerCertificateChain,
    ...(keepOpen ? { channel } : {}),
    details: {
      peerSignature: session.peerSignature, serverTempKey: session.serverTempKey, bytesRead, bytesWritten,
      alpn: session.negotiatedAlpnProtocol, verificationReason: session.peerVerificationReason,
      legacySession: session.exportLegacySession(),
      ticket: session.receivedTicket,
      resumed: session.pskResumed || session.legacyResumed,
      earlyData: session.earlyDataAccepted === true && session.pskResumed ? 'accepted' : session.rejectedEarlyData !== null ? 'rejected' : 'not-sent',
    } };
}

