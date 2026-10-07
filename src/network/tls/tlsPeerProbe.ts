import { bytesToFileText } from '@/crypto/encoding';
import type { TlsProtocolVersion } from './legacy/legacyCipherSuites';
import { TlsClientSession } from './TlsClientSession';
import { CertificateVerifier } from '../pki/CertificateVerifier';
import type { TcpStack } from '../tcp/TcpStack';
import type { ResumableLegacySession } from './legacy/legacySessions';
import type { PkiPrivateKey } from '../pki/PkiKeyPair';
import type { X509Certificate } from '../pki/X509Certificate';
import type { OcspResponseMessage } from '../pki/OcspWire';
import type { TlsRecord } from './recordLayer';
import { encryptApplicationData, decryptApplicationData } from '../http/https/ApplicationDataCipher';
import { runTlsHandshakeOverSocket, bytesToBinaryString, binaryStringToBytes, encodeRecords, decodeRecords } from '../http/https/TlsRecordWire';

export interface TlsHandshakeDetails {
  readonly peerSignature: { readonly digest: string; readonly type: string } | null;
  readonly serverTempKey: string | null;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  readonly alpn: string | null;
  readonly verificationReason: string | null;
  readonly legacySession: ResumableLegacySession | null;
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
  readonly channel?: TlsPeerChannel;
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
  const channel = new TlsPeerChannel(socket, session);
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
    } };
}

type ProbeSocket = NonNullable<ReturnType<TcpStack['connect']>>;

export class TlsPeerChannel {
  private clientSequence = 0;
  private serverSequence = 0;
  private inbox = new Uint8Array(0);
  private collecting = false;
  private pushHandler: ((text: string) => void) | null = null;

  constructor(private readonly socket: ProbeSocket, private readonly session: TlsClientSession) {
    socket.onData((data) => {
      try { this.receive(data); } catch { return; }
    });
  }

  onPush(handler: (text: string) => void): void {
    this.pushHandler = handler;
  }

  private write(records: readonly TlsRecord[]): void {
    this.socket.write(bytesToBinaryString(encodeRecords([...records])));
  }

  private receive(data: unknown): void {
    const records = decodeRecords(binaryStringToBytes(String(data)));
    if (this.session.renegotiating) {
      this.continueRenegotiation(records);
      return;
    }
    const opened = decryptApplicationData(this.session.serverTraffic(), this.serverSequence, records);
    this.serverSequence = opened.nextSeq;
    if (opened.renegotiation) this.continueRenegotiation(opened.renegotiation.records, opened.renegotiation.sequence);
    if (opened.peerKeyUpdates) {
      const answer = this.session.applyPeerKeyUpdates(opened.peerKeyUpdates, opened.peerRequestedKeyUpdate === true, this.clientSequence);
      if (answer.length > 0) { this.write(answer); this.clientSequence = 0; }
    }
    if (opened.plaintext.length === 0) return;
    if (this.collecting || this.pushHandler === null) {
      const joined = new Uint8Array(this.inbox.length + opened.plaintext.length);
      joined.set(this.inbox); joined.set(opened.plaintext, this.inbox.length);
      this.inbox = joined;
    } else {
      this.pushHandler(bytesToFileText(opened.plaintext));
    }
  }

  private continueRenegotiation(records: readonly TlsRecord[], receiveSequence = this.serverSequence): void {
    const answer = this.session.handleRenegotiation(records, receiveSequence, this.clientSequence);
    if (answer && answer.length > 0) this.write(answer);
    if (this.session.takeRenegotiationCompleted()) { this.clientSequence = 0; this.serverSequence = 0; }
  }

  private collect(act: () => void): Uint8Array {
    this.inbox = new Uint8Array(0);
    this.collecting = true;
    try { act(); } finally { this.collecting = false; }
    const reply = this.inbox;
    this.inbox = new Uint8Array(0);
    return reply;
  }

  exchange(payload: Uint8Array): Uint8Array {
    return this.collect(() => {
      const sealed = encryptApplicationData(this.session.clientTraffic(), this.clientSequence, payload);
      this.clientSequence = sealed.nextSeq;
      this.write(sealed.records);
    });
  }

  renegotiate(): boolean {
    const hello = this.session.startRenegotiation(this.serverSequence, this.clientSequence);
    if (hello === null) return false;
    this.clientSequence += hello.length;
    this.collect(() => this.write(hello));
    return !this.session.renegotiating && this.session.renegotiations > 0;
  }

  keyUpdate(requestUpdate: boolean): void {
    const records = this.session.sendKeyUpdate(requestUpdate, this.clientSequence);
    this.clientSequence = 0;
    this.collect(() => this.write(records));
  }

  close(): void {
    this.socket.close();
  }
}
