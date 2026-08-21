/**
 * TLS 1.3 (RFC 8446 §4) client-side handshake — see `TlsServerSession.ts`
 * for the server side and the overall design note, including mTLS
 * (`CertificateRequest`/`Certificate`/`CertificateVerify` in the client ->
 * server direction, §4.3.2/§4.4.2) and `HelloRetryRequest` (§4.1.4): if the
 * server responds with an HRR instead of a `ServerHello`, this session
 * regenerates its `ClientHello` with a key_share for the requested group
 * and resends, staying in the same state (the caller's driving loop sees
 * one extra round trip, exactly as a real client/server pair would).
 * Verifies the server's certificate chain via the real (project-standard)
 * `CertificateVerifier`, the `CertificateVerify` signature via
 * `PkiKeyPair.verify`, and the server's `Finished` before ever trusting
 * the connection — failure at any of these three checks happens before
 * any `application_data` is exchanged.
 */
import type { IEventBus } from '@/events/EventBus';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { generateKeyExchange, sharedSecret, isImplementedGroup, type KeyExchangeKeyPair } from './keyExchange';
import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CipherSuite } from './types';
import type { TlsDomainEvent } from './events';
import {
  type ClientHello, type ServerHello, type EncryptedExtensionsMessage,
  type CertificateRequest, type CertificateMessage, type CertificateVerify, type Finished,
  type NewSessionTicket, type KeyUpdate, type TlsHandshakeMessage,
  encodeHandshakeMessage, decodeHandshakeMessage, encodeMessages, decodeMessages, randomNonce,
} from './messages';
import { fragmentAsRecords, reassembleRecords, splitLeadingContentType, type TlsRecord } from './recordLayer';
import { deriveKeySchedule, computeFinished, transcriptHash, nextTrafficSecret, ZERO_IKM } from './keySchedule';
import { certificateAlert, fatalAlert, type AlertDescription, type TlsAlert } from './alerts';
import { MANDATORY_CIPHER_SUITES } from './cipherSuites';
import { type SessionTicket, deriveResumptionPsk } from './sessionTickets';

export interface TlsClientConfig {
  readonly verifier: CertificateVerifier;
  /** Suites offered, in preference order; defaults to all 5 mandatory suites (RFC 8446 §B.4). */
  readonly cipherSuites?: readonly CipherSuite[];
  /** Presented only if the server actually sends a CertificateRequest (mTLS). */
  readonly clientCert?: X509Certificate;
  readonly clientPrivateKey?: PkiPrivateKey;
  /** Groups this client can offer a key_share for; defaults to `['x25519']`. The first entry is offered up front. */
  readonly supportedGroups?: readonly string[];
  /** RFC 7301 — protocols offered, in preference order (e.g. `['h2', 'http/1.1']`). */
  readonly alpn?: readonly string[];
  /** RFC 6066 §3 — the host_name this client is asking for. */
  readonly serverName?: string;
  /** A ticket from a prior session's NewSessionTicket — offers PSK resumption (§4.2.11). */
  readonly resumptionTicket?: SessionTicket;
  /** Sent as 0-RTT data alongside ClientHello (§2.3) — only honored together with `resumptionTicket`. */
  readonly earlyData?: Uint8Array;
  /** RFC 8446 §2.1.12 observability — publishes `tls.*` events (`events.ts`) if set. */
  readonly eventBus?: IEventBus;
}

type ClientState = 'idle' | 'awaiting-server-flight' | 'done';

export class TlsClientSession {
  result: 'success' | 'failure' | null = null;
  /** RFC 8446 §6 alert explaining the last failure, if any. */
  lastAlert: TlsAlert | null = null;
  /** The cipher suite the server actually chose, once ServerHello is processed. */
  negotiatedCipherSuite: CipherSuite | null = null;
  /** RFC 7301 — the protocol the server actually chose, if any. */
  negotiatedAlpnProtocol: string | null = null;
  /** RFC 8446 §2.3 — whether the server accepted the 0-RTT data offered, if any was sent. */
  earlyDataAccepted: boolean | null = null;
  /** A ticket received via `receiveSessionTicket()`, ready to resume a future session. */
  receivedTicket: SessionTicket | null = null;
  peerCertificate: X509Certificate | null = null;
  /**
   * RFC 8446 §7.2 — this side's current application traffic secrets, set
   * once the handshake succeeds and ratcheted independently per direction
   * by `sendKeyUpdate`/`receiveKeyUpdate` (§4.6.3).
   */
  clientApplicationTrafficSecret: string | null = null;
  serverApplicationTrafficSecret: string | null = null;
  /**
   * RFC 9001 §5.3 — the Handshake-space secrets (`client_handshake_traffic_secret`/
   * `server_handshake_traffic_secret`), set once the server flight is
   * processed. Exposed for consumers deriving Handshake-space keys on top
   * of this engine (e.g. QUIC's `PacketProtection.ts`), not just this
   * module's own Finished computation.
   */
  clientHandshakeTrafficSecret: string | null = null;
  serverHandshakeTrafficSecret: string | null = null;
  /** Stable per-connection correlator for `events.ts` payloads (§2.1.12). */
  readonly sessionId = randomNonce('tls-session');

  private state: ClientState = 'idle';
  private readonly supportedGroups: readonly string[];
  private readonly pskInput: string;
  private clientRandom = '';
  private clientKeyShare = '';
  private keyExchange: KeyExchangeKeyPair | null = null;
  private resumptionMasterSecret: string | null = null;
  private readonly transcript: Uint8Array[] = [];

  constructor(private readonly config: TlsClientConfig) {
    // Un vrai client n'annonce pas un groupe dont il n'a pas le code : le
    // serveur le choisirait, et il faudrait alors soit abandonner plus
    // tard, soit fabriquer un secret. Le filtre est là pour que la
    // question ne se pose jamais.
    this.supportedGroups = (config.supportedGroups ?? ['x25519']).filter(isImplementedGroup);
    this.pskInput = config.resumptionTicket ? deriveResumptionPsk(config.resumptionTicket) : ZERO_IKM;
  }

  /** Produces the initial `ClientHello` flight, offering a key_share for the first supported group. */
  start(): readonly TlsRecord[] {
    this.emit({ topic: 'tls.handshake.started', payload: { sessionId: this.sessionId, role: 'client' } });
    // Aucun groupe calculable : rien ne part sur le fil. C'est ce que
    // fait une vraie pile configurée avec des groupes qu'elle ne sait pas
    // faire — elle échoue avant d'écrire, plutôt que d'ouvrir une
    // conversation qu'elle ne peut pas conclure.
    if (this.supportedGroups.length === 0) { this.fail('handshake_failure'); return []; }
    this.clientRandom = randomNonce('cli');
    const records = this.sendClientHello(this.supportedGroups[0]);
    if (!this.config.resumptionTicket || !this.config.earlyData) return records;
    return [...records, ...fragmentAsRecords('application_data', this.config.earlyData, true)];
  }

  private sendClientHello(group: string): readonly TlsRecord[] {
    this.keyExchange = generateKeyExchange(group);
    this.clientKeyShare = this.keyExchange.share;
    const ticket = this.config.resumptionTicket;
    const clientHello: ClientHello = {
      kind: 'client_hello', legacyVersion: '1.2', random: this.clientRandom,
      cipherSuites: this.config.cipherSuites ?? MANDATORY_CIPHER_SUITES,
      extensions: {
        supportedVersions: ['1.3'], keyShare: this.clientKeyShare,
        supportedGroups: this.supportedGroups, signatureAlgorithms: ['ecdsa_secp256r1_sha256'],
        alpn: this.config.alpn,
        serverName: this.config.serverName,
        preSharedKey: ticket?.ticket,
        pskKeyExchangeModes: ticket ? ['psk_dhe_ke'] : undefined,
        earlyData: ticket && this.config.earlyData ? true : undefined,
      },
    };
    const clientHelloBytes = encodeHandshakeMessage(clientHello);
    this.transcript.push(clientHelloBytes);
    this.state = 'awaiting-server-flight';
    return fragmentAsRecords('handshake', clientHelloBytes, false);
  }

  /** Feeds the server's flight in; returns the client's next flight, or null on failure. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    if (this.state !== 'awaiting-server-flight') return null;
    try {
      return this.handleServerMessage(incoming);
    } catch {
      return this.fail('decode_error');
    }
  }

  private emit(event: TlsDomainEvent): void {
    this.config.eventBus?.publish(event);
  }

  private fail(description: AlertDescription = 'handshake_failure'): null {
    this.lastAlert = fatalAlert(description);
    this.state = 'done';
    this.result = 'failure';
    this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert } });
    this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert } });
    return null;
  }

  private handleServerMessage(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    const { contentType: leadType, plaintext: leadBytes } = reassembleRecords(leading, false);
    if (leadType !== 'handshake') return this.fail('decode_error');
    const leadMessage = decodeHandshakeMessage(leadBytes);

    if (leadMessage.kind === 'hello_retry_request') {
      if (rest.length > 0) return this.fail('unexpected_message');
      if (!this.supportedGroups.includes(leadMessage.selectedGroup)) return this.fail('handshake_failure');
      this.transcript.push(leadBytes);
      return this.sendClientHello(leadMessage.selectedGroup);
    }
    if (leadMessage.kind !== 'server_hello') return this.fail('unexpected_message');

    return this.handleServerFlight(leadMessage, leadBytes, rest);
  }

  private handleServerFlight(
    serverHello: ServerHello, serverHelloBytes: Uint8Array, rest: readonly TlsRecord[],
  ): readonly TlsRecord[] | null {
    this.transcript.push(serverHelloBytes);

    const { contentType: bundleType, plaintext: bundleBytes } = reassembleRecords(rest, true);
    if (bundleType !== 'handshake') return this.fail('decode_error');
    const messages = decodeMessages(bundleBytes);

    const encryptedExtensions = messages.find((m): m is EncryptedExtensionsMessage => m.kind === 'encrypted_extensions');
    const certificateRequest = messages.find((m): m is CertificateRequest => m.kind === 'certificate_request');
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate');
    const certificateVerify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify');
    const serverFinished = messages.find((m): m is Finished => m.kind === 'finished');
    if (!encryptedExtensions || !certificate || !certificateVerify || !serverFinished) return this.fail('unexpected_message');

    const offeredSuites = this.config.cipherSuites ?? MANDATORY_CIPHER_SUITES;
    if (!offeredSuites.includes(serverHello.cipherSuite)) return this.fail('handshake_failure');
    this.negotiatedCipherSuite = serverHello.cipherSuite;
    this.negotiatedAlpnProtocol = encryptedExtensions.extensions.alpn ?? null;
    this.earlyDataAccepted = encryptedExtensions.extensions.earlyData ?? false;

    // Étage 3 : un vrai X25519 sur la part du serveur, avec le scalaire
    // privé que ce client n'a jamais transmis. Un témoin de la poignée de
    // main ne peut plus le recalculer, ce qui était le cas quand ce secret
    // n'était qu'un condensé des quatre valeurs publiques.
    const dheSharedSecret = this.keyExchange === null
      ? null
      : sharedSecret(this.keyExchange, serverHello.extensions.keyShare ?? '');
    // §7.4.2 : un secret partagé tout à zéro fait abandonner la poignée de
    // main, parce que l'attaquant le connaîtrait d'avance.
    if (dheSharedSecret === null) return this.fail('illegal_parameter');
    // RFC 8446 §4.2.11 — the server only actually uses the offered PSK if
    // it echoes acceptance in ServerHello; otherwise it fell back to a full
    // handshake and both sides must derive keys from DHE alone, or Finished
    // verification would never match.
    const effectivePsk = serverHello.extensions.preSharedKey ? this.pskInput : ZERO_IKM;
    // Same simplification as the server side (see TlsServerSession.ts): the
    // resumption/application secrets are derived from the CH+SH checkpoint.
    const shTranscript = transcriptHash(this.transcript);
    const handshakePhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]]), serverHello: shTranscript, serverFinished: shTranscript, clientFinished: shTranscript },
      effectivePsk, dheSharedSecret,
    );
    this.resumptionMasterSecret = handshakePhase.resumptionMasterSecret;
    this.clientApplicationTrafficSecret = handshakePhase.clientApplicationTrafficSecret;
    this.serverApplicationTrafficSecret = handshakePhase.serverApplicationTrafficSecret;
    this.clientHandshakeTrafficSecret = handshakePhase.clientHandshakeTrafficSecret;
    this.serverHandshakeTrafficSecret = handshakePhase.serverHandshakeTrafficSecret;
    const sessionResumed = Boolean(serverHello.extensions.preSharedKey);
    if (sessionResumed) {
      this.emit({
        topic: 'tls.session.resumed',
        payload: { sessionId: this.sessionId, role: 'client', ticket: this.config.resumptionTicket!.ticket },
      });
    }

    const leafCert = certificate.certificateList[0];
    if (!leafCert) return this.fail('certificate_unknown');
    this.peerCertificate = leafCert;
    const verification = this.config.verifier.verify(leafCert);
    if (verification.ok === false) {
      this.lastAlert = certificateAlert(verification.reason);
      this.state = 'done';
      this.result = 'failure';
      this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert } });
      this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert } });
      return null;
    }

    this.transcript.push(encodeHandshakeMessage(encryptedExtensions));
    if (certificateRequest) this.transcript.push(encodeHandshakeMessage(certificateRequest));
    this.transcript.push(encodeHandshakeMessage(certificate));

    const preVerify = transcriptHash(this.transcript);
    if (!PkiKeyPair.verify(leafCert.publicKey, preVerify, certificateVerify.signature)) return this.fail('decrypt_error');
    this.transcript.push(encodeHandshakeMessage(certificateVerify));

    const preFinished = transcriptHash(this.transcript);
    const expectedServerFinished = computeFinished(handshakePhase.serverHandshakeTrafficSecret, preFinished);
    if (serverFinished.verifyData !== expectedServerFinished) return this.fail('decrypt_error');
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
    this.emit({
      topic: 'tls.handshake.completed',
      payload: {
        sessionId: this.sessionId, role: 'client', cipherSuite: this.negotiatedCipherSuite!,
        alpnProtocol: this.negotiatedAlpnProtocol, resumed: sessionResumed,
      },
    });
    return fragmentAsRecords('handshake', encodeMessages(finalBundle), true);
  }

  /**
   * Decodes a post-handshake `NewSessionTicket` flight (only meaningful
   * after `result === 'success'`, once `resumptionMasterSecret` is known)
   * and stores it in `receivedTicket`, ready to configure a future
   * `TlsClientSession`'s `resumptionTicket`.
   */
  receiveSessionTicket(records: readonly TlsRecord[]): void {
    if (this.result !== 'success' || !this.resumptionMasterSecret || !this.negotiatedCipherSuite) return;
    const { contentType, plaintext } = reassembleRecords(records, true);
    if (contentType !== 'handshake') return;
    const message = decodeHandshakeMessage(plaintext) as NewSessionTicket;
    if (message.kind !== 'new_session_ticket') return;
    this.receivedTicket = {
      ticket: message.ticket,
      resumptionMasterSecret: this.resumptionMasterSecret,
      ticketNonce: message.ticketNonce,
      cipherSuite: this.negotiatedCipherSuite,
      ticketLifetime: message.ticketLifetime,
      issuedAt: Date.now(),
      consumed: false,
    };
  }

  /**
   * RFC 8446 §4.6.3 — ratchets this side's own sending secret
   * (`clientApplicationTrafficSecret`) and returns the wire flight; the peer
   * must feed it into `receiveKeyUpdate` to stay in sync. `requestUpdate`
   * asks the peer to reciprocate with its own KeyUpdate.
   */
  sendKeyUpdate(requestUpdate = false): readonly TlsRecord[] {
    const keyUpdate: KeyUpdate = { kind: 'key_update', requestUpdate };
    const records = fragmentAsRecords('handshake', encodeHandshakeMessage(keyUpdate), true);
    this.clientApplicationTrafficSecret = nextTrafficSecret(this.clientApplicationTrafficSecret!);
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'client', direction: 'client-to-server', requestUpdate },
    });
    return records;
  }

  /**
   * RFC 8446 §4.6.3 — processes a peer KeyUpdate: ratchets the matching
   * receiving secret (`serverApplicationTrafficSecret`) and, if the peer
   * requested a reciprocal update, returns this side's own KeyUpdate (never
   * itself setting `requestUpdate`, to avoid an update ping-pong).
   */
  receiveKeyUpdate(records: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext } = reassembleRecords(records, true);
    if (contentType !== 'handshake') return null;
    const message = decodeHandshakeMessage(plaintext);
    if (message.kind !== 'key_update') return null;
    this.serverApplicationTrafficSecret = nextTrafficSecret(this.serverApplicationTrafficSecret!);
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'client', direction: 'server-to-client', requestUpdate: message.requestUpdate },
    });
    return message.requestUpdate ? this.sendKeyUpdate(false) : null;
  }
}
