/**
 * TLS 1.3 (RFC 8446 §4) server-side handshake — nominal 1-RTT path only
 * (no `HelloRetryRequest`, no client certificate request): `ClientHello`
 * -> `ServerHello` (unprotected) + `EncryptedExtensions`/`Certificate`/
 * `CertificateVerify`/`Finished` (protected, one flight) -> client
 * `Finished` -> established. `CertificateVerify`'s signature is a real
 * (simulated) `PkiKeyPair.sign` over the transcript, and `Finished` is
 * bound to the correct handshake traffic secret — a step up in fidelity
 * from `EapTlsHandshake.ts`'s 2-RTT model, which this module does not
 * reuse (see `PRD-TLS.md` §2.1.1).
 */
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CipherSuite } from './types';
import {
  type ClientHello, type ServerHello, type EncryptedExtensionsMessage,
  type CertificateMessage, type CertificateVerify, type Finished,
  encodeHandshakeMessage, decodeHandshakeMessage, encodeMessages, randomNonce,
} from './messages';
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from './recordLayer';
import { deriveKeySchedule, computeFinished, transcriptHash, ZERO_IKM } from './keySchedule';

export interface TlsServerConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
  readonly cipherSuite?: CipherSuite;
}

type ServerState = 'idle' | 'awaiting-client-finished' | 'done';

export class TlsServerSession {
  result: 'accept' | 'reject' | null = null;

  private state: ServerState = 'idle';
  private readonly cipherSuite: CipherSuite;
  private clientHandshakeTrafficSecret: string | null = null;
  private transcriptThroughServerFinished: string | null = null;

  constructor(private readonly config: TlsServerConfig) {
    this.cipherSuite = config.cipherSuite ?? 'TLS_AES_128_GCM_SHA256';
  }

  /** Feeds the peer's flight in; returns this side's next flight, or null once nothing more is to be sent. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    try {
      if (this.state === 'idle') return this.handleClientHello(incoming);
      if (this.state === 'awaiting-client-finished') return this.handleClientFinished(incoming);
      return null;
    } catch {
      this.state = 'done';
      this.result = 'reject';
      return null;
    }
  }

  private handleClientHello(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext: clientHelloBytes } = reassembleRecords(incoming, false);
    if (contentType !== 'handshake') { this.state = 'done'; this.result = 'reject'; return null; }
    const clientHello = decodeHandshakeMessage(clientHelloBytes) as ClientHello;

    const serverRandom = randomNonce('srv');
    const serverKeyShare = randomNonce('ks-srv');
    const serverHello: ServerHello = {
      kind: 'server_hello', random: serverRandom, cipherSuite: this.cipherSuite,
      extensions: { supportedVersions: '1.3', keyShare: serverKeyShare },
    };
    const serverHelloBytes = encodeHandshakeMessage(serverHello);

    const dheSharedSecret = simulatedDigest(
      [clientHello.random, serverRandom, clientHello.extensions.keyShare, serverKeyShare].join('|'),
    );
    const chTranscript = transcriptHash([clientHelloBytes]);
    const shTranscript = transcriptHash([clientHelloBytes, serverHelloBytes]);
    const handshakePhase = deriveKeySchedule(
      { clientHello: chTranscript, serverHello: shTranscript, serverFinished: '', clientFinished: '' },
      ZERO_IKM, dheSharedSecret,
    );
    this.clientHandshakeTrafficSecret = handshakePhase.clientHandshakeTrafficSecret;

    const encryptedExtensions: EncryptedExtensionsMessage = {
      kind: 'encrypted_extensions', extensions: { alpn: clientHello.extensions.alpn?.[0] },
    };
    const certificate: CertificateMessage = { kind: 'certificate', certificateList: [this.config.serverCert] };
    const encryptedExtensionsBytes = encodeHandshakeMessage(encryptedExtensions);
    const certificateBytes = encodeHandshakeMessage(certificate);
    const preVerifyTranscript = transcriptHash([clientHelloBytes, serverHelloBytes, encryptedExtensionsBytes, certificateBytes]);
    const certificateVerify: CertificateVerify = {
      kind: 'certificate_verify',
      signature: PkiKeyPair.sign(this.config.serverPrivateKey, preVerifyTranscript),
    };
    const certificateVerifyBytes = encodeHandshakeMessage(certificateVerify);
    const preFinishedTranscript = transcriptHash([
      clientHelloBytes, serverHelloBytes, encryptedExtensionsBytes, certificateBytes, certificateVerifyBytes,
    ]);
    const finished: Finished = {
      kind: 'finished',
      verifyData: computeFinished(handshakePhase.serverHandshakeTrafficSecret, preFinishedTranscript),
    };
    const finishedBytes = encodeHandshakeMessage(finished);

    this.transcriptThroughServerFinished = transcriptHash([
      clientHelloBytes, serverHelloBytes, encryptedExtensionsBytes, certificateBytes, certificateVerifyBytes, finishedBytes,
    ]);

    const serverBundleBytes = encodeMessages([encryptedExtensions, certificate, certificateVerify, finished]);
    this.state = 'awaiting-client-finished';
    return [
      ...fragmentAsRecords('handshake', serverHelloBytes, false),
      ...fragmentAsRecords('handshake', serverBundleBytes, true),
    ];
  }

  private handleClientFinished(incoming: readonly TlsRecord[]): null {
    const { contentType, plaintext } = reassembleRecords(incoming, true);
    if (contentType !== 'handshake') { this.state = 'done'; this.result = 'reject'; return null; }
    const clientFinished = decodeHandshakeMessage(plaintext) as Finished;
    const expected = computeFinished(this.clientHandshakeTrafficSecret!, this.transcriptThroughServerFinished!);
    this.state = 'done';
    this.result = clientFinished.verifyData === expected ? 'accept' : 'reject';
    return null;
  }
}
