/**
 * TLS 1.3 (RFC 8446 §4) client-side handshake — nominal 1-RTT path (see
 * `TlsServerSession.ts` for the server side and the overall design note).
 * Verifies the server's certificate chain via the real (project-standard)
 * `CertificateVerifier`, the `CertificateVerify` signature via
 * `PkiKeyPair.verify`, and the server's `Finished` before ever trusting the
 * connection — failure at any of these three checks happens before any
 * `application_data` is exchanged.
 */
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { PkiKeyPair } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { CipherSuite } from './types';
import {
  type ClientHello, type ServerHello, type EncryptedExtensionsMessage,
  type CertificateMessage, type CertificateVerify, type Finished,
  encodeHandshakeMessage, decodeHandshakeMessage, decodeMessages, randomNonce,
} from './messages';
import { fragmentAsRecords, reassembleRecords, splitLeadingContentType, type TlsRecord } from './recordLayer';
import { deriveKeySchedule, computeFinished, transcriptHash, ZERO_IKM } from './keySchedule';

export interface TlsClientConfig {
  readonly verifier: CertificateVerifier;
  readonly cipherSuites?: readonly CipherSuite[];
}

type ClientState = 'idle' | 'awaiting-server-flight' | 'done';

export class TlsClientSession {
  result: 'success' | 'failure' | null = null;

  private state: ClientState = 'idle';
  private clientHelloBytes: Uint8Array | null = null;
  private clientRandom = '';
  private clientKeyShare = '';

  constructor(private readonly config: TlsClientConfig) {}

  /** Produces the initial `ClientHello` flight. */
  start(): readonly TlsRecord[] {
    this.clientRandom = randomNonce('cli');
    this.clientKeyShare = randomNonce('ks-cli');
    const clientHello: ClientHello = {
      kind: 'client_hello', legacyVersion: '1.2', random: this.clientRandom,
      cipherSuites: this.config.cipherSuites ?? ['TLS_AES_128_GCM_SHA256'],
      extensions: {
        supportedVersions: ['1.3'], keyShare: this.clientKeyShare,
        supportedGroups: ['x25519'], signatureAlgorithms: ['ecdsa_secp256r1_sha256'],
      },
    };
    this.clientHelloBytes = encodeHandshakeMessage(clientHello);
    this.state = 'awaiting-server-flight';
    return fragmentAsRecords('handshake', this.clientHelloBytes, false);
  }

  /** Feeds the server's flight in; returns the client's `Finished` flight on success, or null. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    if (this.state !== 'awaiting-server-flight') return null;
    try {
      return this.handleServerFlight(incoming);
    } catch {
      this.state = 'done';
      this.result = 'failure';
      return null;
    }
  }

  private handleServerFlight(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    const { contentType: shType, plaintext: serverHelloBytes } = reassembleRecords(leading, false);
    if (shType !== 'handshake') return this.fail();
    const serverHello = decodeHandshakeMessage(serverHelloBytes) as ServerHello;

    const { contentType: bundleType, plaintext: bundleBytes } = reassembleRecords(rest, true);
    if (bundleType !== 'handshake') return this.fail();
    const [encryptedExtensions, certificate, certificateVerify, serverFinished] = decodeMessages(bundleBytes) as [
      EncryptedExtensionsMessage, CertificateMessage, CertificateVerify, Finished,
    ];

    const dheSharedSecret = simulatedDigest(
      [this.clientRandom, serverHello.random, this.clientKeyShare, serverHello.extensions.keyShare ?? ''].join('|'),
    );
    const chTranscript = transcriptHash([this.clientHelloBytes!]);
    const shTranscript = transcriptHash([this.clientHelloBytes!, serverHelloBytes]);
    const handshakePhase = deriveKeySchedule(
      { clientHello: chTranscript, serverHello: shTranscript, serverFinished: '', clientFinished: '' },
      ZERO_IKM, dheSharedSecret,
    );

    const leafCert = certificate.certificateList[0];
    if (!leafCert || !this.config.verifier.verify(leafCert).ok) return this.fail();

    const encryptedExtensionsBytes = encodeHandshakeMessage(encryptedExtensions);
    const certificateBytes = encodeHandshakeMessage(certificate);
    const preVerifyTranscript = transcriptHash([this.clientHelloBytes!, serverHelloBytes, encryptedExtensionsBytes, certificateBytes]);
    if (!PkiKeyPair.verify(leafCert.publicKey, preVerifyTranscript, certificateVerify.signature)) return this.fail();

    const certificateVerifyBytes = encodeHandshakeMessage(certificateVerify);
    const preFinishedTranscript = transcriptHash([
      this.clientHelloBytes!, serverHelloBytes, encryptedExtensionsBytes, certificateBytes, certificateVerifyBytes,
    ]);
    const expectedServerFinished = computeFinished(handshakePhase.serverHandshakeTrafficSecret, preFinishedTranscript);
    if (serverFinished.verifyData !== expectedServerFinished) return this.fail();

    const serverFinishedBytes = encodeHandshakeMessage(serverFinished);
    const transcriptThroughServerFinished = transcriptHash([
      this.clientHelloBytes!, serverHelloBytes, encryptedExtensionsBytes, certificateBytes, certificateVerifyBytes, serverFinishedBytes,
    ]);
    const clientFinished: Finished = {
      kind: 'finished',
      verifyData: computeFinished(handshakePhase.clientHandshakeTrafficSecret, transcriptThroughServerFinished),
    };

    this.state = 'done';
    this.result = 'success';
    return fragmentAsRecords('handshake', encodeHandshakeMessage(clientFinished), true);
  }

  private fail(): null {
    this.state = 'done';
    this.result = 'failure';
    return null;
  }
}
