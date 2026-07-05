/**
 * TLS 1.3 (RFC 8446 §4) server-side handshake — nominal 1-RTT path, plus
 * optional mutual authentication (§4.3.2 `CertificateRequest`): `ClientHello`
 * -> `ServerHello` (unprotected) + `EncryptedExtensions`/[`CertificateRequest`]/
 * `Certificate`/`CertificateVerify`/`Finished` (protected, one flight) ->
 * client `Finished` (plus, if requested, the client's own `Certificate`/
 * `CertificateVerify`) -> established. Both `CertificateVerify` messages
 * carry a real (simulated) `PkiKeyPair` signature over the transcript, and
 * `Finished` is bound to the correct handshake traffic secret — a step up
 * in fidelity from `EapTlsHandshake.ts`'s 2-RTT model, which this module
 * does not reuse (see `PRD-TLS.md` §2.1.1/§2.1.6). No `HelloRetryRequest`
 * in this phase (see `PRD-TLS.md` §2.1.5, a later phase).
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
import { fragmentAsRecords, reassembleRecords, type TlsRecord } from './recordLayer';
import { deriveKeySchedule, computeFinished, transcriptHash, ZERO_IKM } from './keySchedule';

export interface TlsServerConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
  readonly cipherSuite?: CipherSuite;
  /** RFC 8446 §4.3.2 — request the peer's certificate (mTLS). Requires `verifier`. */
  readonly requestClientCert?: boolean;
  /** Verifies the client's certificate chain; required when `requestClientCert` is set. */
  readonly verifier?: CertificateVerifier;
}

type ServerState = 'idle' | 'awaiting-client-final' | 'done';

export class TlsServerSession {
  result: 'accept' | 'reject' | null = null;

  private state: ServerState = 'idle';
  private readonly cipherSuite: CipherSuite;
  private clientHandshakeTrafficSecret: string | null = null;
  private readonly transcript: Uint8Array[] = [];

  constructor(private readonly config: TlsServerConfig) {
    this.cipherSuite = config.cipherSuite ?? 'TLS_AES_128_GCM_SHA256';
  }

  /** Feeds the peer's flight in; returns this side's next flight, or null once nothing more is to be sent. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    try {
      if (this.state === 'idle') return this.handleClientHello(incoming);
      if (this.state === 'awaiting-client-final') return this.handleClientFinal(incoming);
      return null;
    } catch {
      return this.reject();
    }
  }

  private reject(): null {
    this.state = 'done';
    this.result = 'reject';
    return null;
  }

  private handleClientHello(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext: clientHelloBytes } = reassembleRecords(incoming, false);
    if (contentType !== 'handshake') return this.reject();
    const clientHello = decodeHandshakeMessage(clientHelloBytes) as ClientHello;
    this.transcript.push(clientHelloBytes);

    const serverRandom = randomNonce('srv');
    const serverKeyShare = randomNonce('ks-srv');
    const serverHello: ServerHello = {
      kind: 'server_hello', random: serverRandom, cipherSuite: this.cipherSuite,
      extensions: { supportedVersions: '1.3', keyShare: serverKeyShare },
    };
    const serverHelloBytes = encodeHandshakeMessage(serverHello);
    this.transcript.push(serverHelloBytes);

    const dheSharedSecret = simulatedDigest(
      [clientHello.random, serverRandom, clientHello.extensions.keyShare, serverKeyShare].join('|'),
    );
    const handshakePhase = deriveKeySchedule(
      { clientHello: transcriptHash([clientHelloBytes]), serverHello: transcriptHash(this.transcript), serverFinished: '', clientFinished: '' },
      ZERO_IKM, dheSharedSecret,
    );
    this.clientHandshakeTrafficSecret = handshakePhase.clientHandshakeTrafficSecret;

    const bundle: TlsHandshakeMessage[] = [];
    const encryptedExtensions: EncryptedExtensionsMessage = {
      kind: 'encrypted_extensions', extensions: { alpn: clientHello.extensions.alpn?.[0] },
    };
    bundle.push(encryptedExtensions);
    this.transcript.push(encodeHandshakeMessage(encryptedExtensions));

    if (this.config.requestClientCert) {
      const certificateRequest: CertificateRequest = {
        kind: 'certificate_request', certificateRequestContext: '', signatureAlgorithms: ['ecdsa_secp256r1_sha256'],
      };
      bundle.push(certificateRequest);
      this.transcript.push(encodeHandshakeMessage(certificateRequest));
    }

    const certificate: CertificateMessage = { kind: 'certificate', certificateList: [this.config.serverCert] };
    bundle.push(certificate);
    this.transcript.push(encodeHandshakeMessage(certificate));

    const certificateVerify: CertificateVerify = {
      kind: 'certificate_verify',
      signature: PkiKeyPair.sign(this.config.serverPrivateKey, transcriptHash(this.transcript)),
    };
    bundle.push(certificateVerify);
    this.transcript.push(encodeHandshakeMessage(certificateVerify));

    const finished: Finished = {
      kind: 'finished',
      verifyData: computeFinished(handshakePhase.serverHandshakeTrafficSecret, transcriptHash(this.transcript)),
    };
    bundle.push(finished);
    this.transcript.push(encodeHandshakeMessage(finished));

    this.state = 'awaiting-client-final';
    return [
      ...fragmentAsRecords('handshake', serverHelloBytes, false),
      ...fragmentAsRecords('handshake', encodeMessages(bundle), true),
    ];
  }

  private handleClientFinal(incoming: readonly TlsRecord[]): null {
    const { contentType, plaintext } = reassembleRecords(incoming, true);
    if (contentType !== 'handshake') return this.reject();
    const messages = decodeMessages(plaintext);

    if (this.config.requestClientCert) {
      const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate');
      const certificateVerify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify');
      if (!certificate || certificate.certificateList.length === 0 || !certificateVerify) return this.reject();
      const leafCert = certificate.certificateList[0];
      if (!this.config.verifier || !this.config.verifier.verify(leafCert).ok) return this.reject();

      this.transcript.push(encodeHandshakeMessage(certificate));
      const preVerify = transcriptHash(this.transcript);
      if (!PkiKeyPair.verify(leafCert.publicKey, preVerify, certificateVerify.signature)) return this.reject();
      this.transcript.push(encodeHandshakeMessage(certificateVerify));
    }

    const finished = messages.find((m): m is Finished => m.kind === 'finished');
    if (!finished) return this.reject();
    const expected = computeFinished(this.clientHandshakeTrafficSecret!, transcriptHash(this.transcript));
    this.state = 'done';
    this.result = finished.verifyData === expected ? 'accept' : 'reject';
    return null;
  }
}
