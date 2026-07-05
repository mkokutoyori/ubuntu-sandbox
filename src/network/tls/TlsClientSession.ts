/**
 * TLS 1.3 (RFC 8446 §4) client-side handshake — see `TlsServerSession.ts`
 * for the server side and the overall design note, including mTLS
 * (`CertificateRequest`/`Certificate`/`CertificateVerify` in the client ->
 * server direction, §4.3.2/§4.4.2). Verifies the server's certificate
 * chain via the real (project-standard) `CertificateVerifier`, the
 * `CertificateVerify` signature via `PkiKeyPair.verify`, and the server's
 * `Finished` before ever trusting the connection — failure at any of
 * these three checks happens before any `application_data` is exchanged.
 */
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CipherSuite } from './types';
import {
  type ClientHello, type ServerHello, type EncryptedExtensionsMessage,
  type CertificateRequest, type CertificateMessage, type CertificateVerify, type Finished,
  type TlsHandshakeMessage,
  encodeHandshakeMessage, decodeHandshakeMessage, encodeMessages, decodeMessages, randomNonce,
} from './messages';
import { fragmentAsRecords, reassembleRecords, splitLeadingContentType, type TlsRecord } from './recordLayer';
import { deriveKeySchedule, computeFinished, transcriptHash, ZERO_IKM } from './keySchedule';

export interface TlsClientConfig {
  readonly verifier: CertificateVerifier;
  readonly cipherSuites?: readonly CipherSuite[];
  /** Presented only if the server actually sends a CertificateRequest (mTLS). */
  readonly clientCert?: X509Certificate;
  readonly clientPrivateKey?: PkiPrivateKey;
}

type ClientState = 'idle' | 'awaiting-server-flight' | 'done';

export class TlsClientSession {
  result: 'success' | 'failure' | null = null;

  private state: ClientState = 'idle';
  private clientRandom = '';
  private clientKeyShare = '';
  private readonly transcript: Uint8Array[] = [];

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
    const clientHelloBytes = encodeHandshakeMessage(clientHello);
    this.transcript.push(clientHelloBytes);
    this.state = 'awaiting-server-flight';
    return fragmentAsRecords('handshake', clientHelloBytes, false);
  }

  /** Feeds the server's flight in; returns the client's final flight on success, or null. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    if (this.state !== 'awaiting-server-flight') return null;
    try {
      return this.handleServerFlight(incoming);
    } catch {
      return this.fail();
    }
  }

  private fail(): null {
    this.state = 'done';
    this.result = 'failure';
    return null;
  }

  private handleServerFlight(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    const { contentType: shType, plaintext: serverHelloBytes } = reassembleRecords(leading, false);
    if (shType !== 'handshake') return this.fail();
    const serverHello = decodeHandshakeMessage(serverHelloBytes) as ServerHello;
    this.transcript.push(serverHelloBytes);

    const { contentType: bundleType, plaintext: bundleBytes } = reassembleRecords(rest, true);
    if (bundleType !== 'handshake') return this.fail();
    const messages = decodeMessages(bundleBytes);

    const encryptedExtensions = messages.find((m): m is EncryptedExtensionsMessage => m.kind === 'encrypted_extensions');
    const certificateRequest = messages.find((m): m is CertificateRequest => m.kind === 'certificate_request');
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate');
    const certificateVerify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify');
    const serverFinished = messages.find((m): m is Finished => m.kind === 'finished');
    if (!encryptedExtensions || !certificate || !certificateVerify || !serverFinished) return this.fail();

    const dheSharedSecret = simulatedDigest(
      [this.clientRandom, serverHello.random, this.clientKeyShare, serverHello.extensions.keyShare ?? ''].join('|'),
    );
    const handshakePhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]]), serverHello: transcriptHash(this.transcript), serverFinished: '', clientFinished: '' },
      ZERO_IKM, dheSharedSecret,
    );

    const leafCert = certificate.certificateList[0];
    if (!leafCert || !this.config.verifier.verify(leafCert).ok) return this.fail();

    this.transcript.push(encodeHandshakeMessage(encryptedExtensions));
    if (certificateRequest) this.transcript.push(encodeHandshakeMessage(certificateRequest));
    this.transcript.push(encodeHandshakeMessage(certificate));

    const preVerify = transcriptHash(this.transcript);
    if (!PkiKeyPair.verify(leafCert.publicKey, preVerify, certificateVerify.signature)) return this.fail();
    this.transcript.push(encodeHandshakeMessage(certificateVerify));

    const preFinished = transcriptHash(this.transcript);
    const expectedServerFinished = computeFinished(handshakePhase.serverHandshakeTrafficSecret, preFinished);
    if (serverFinished.verifyData !== expectedServerFinished) return this.fail();
    this.transcript.push(encodeHandshakeMessage(serverFinished));

    const finalBundle: TlsHandshakeMessage[] = [];
    if (certificateRequest) {
      const clientCertificate: CertificateMessage = {
        kind: 'certificate', certificateList: this.config.clientCert ? [this.config.clientCert] : [],
      };
      finalBundle.push(clientCertificate);
      this.transcript.push(encodeHandshakeMessage(clientCertificate));

      if (this.config.clientCert && this.config.clientPrivateKey) {
        const clientCertificateVerify: CertificateVerify = {
          kind: 'certificate_verify',
          signature: PkiKeyPair.sign(this.config.clientPrivateKey, transcriptHash(this.transcript)),
        };
        finalBundle.push(clientCertificateVerify);
        this.transcript.push(encodeHandshakeMessage(clientCertificateVerify));
      }
    }

    const clientFinished: Finished = {
      kind: 'finished',
      verifyData: computeFinished(handshakePhase.clientHandshakeTrafficSecret, transcriptHash(this.transcript)),
    };
    finalBundle.push(clientFinished);

    this.state = 'done';
    this.result = 'success';
    return fragmentAsRecords('handshake', encodeMessages(finalBundle), true);
  }
}
