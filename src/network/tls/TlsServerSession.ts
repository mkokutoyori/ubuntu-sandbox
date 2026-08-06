/**
 * TLS 1.3 (RFC 8446 §4) server-side handshake — nominal 1-RTT path, plus
 * optional mutual authentication (§4.3.2 `CertificateRequest`) and
 * `HelloRetryRequest` (§4.1.4): `ClientHello` -> `ServerHello`
 * (unprotected) + `EncryptedExtensions`/[`CertificateRequest`]/
 * `Certificate`/`CertificateVerify`/`Finished` (protected, one flight) ->
 * client `Finished` (plus, if requested, the client's own `Certificate`/
 * `CertificateVerify`) -> established. If the client's offered group
 * isn't supported but a mutual one exists in its `supported_groups` list,
 * the server instead replies with a `HelloRetryRequest` and waits for a
 * second `ClientHello`. Both `CertificateVerify` messages carry a real
 * (simulated) `PkiKeyPair` signature over the transcript, and `Finished`
 * is bound to the correct handshake traffic secret — a step up in
 * fidelity from `EapTlsHandshake.ts`'s 2-RTT model, which this module
 * does not reuse (see `PRD-TLS.md` §2.1.1/§2.1.5/§2.1.6).
 */
import type { IEventBus } from '@/events/EventBus';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { generateKeyExchange, sharedSecret } from './keyExchange';
import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { HELLO_RETRY_REQUEST_RANDOM, type CipherSuite } from './types';
import type { TlsDomainEvent } from './events';
import {
  type ClientHello, type ServerHello, type HelloRetryRequest, type EncryptedExtensionsMessage,
  type CertificateRequest, type CertificateMessage, type CertificateVerify, type Finished,
  type NewSessionTicket, type KeyUpdate, type TlsHandshakeMessage,
  encodeHandshakeMessage, decodeHandshakeMessage, encodeMessages, decodeMessages, randomNonce,
} from './messages';
import { fragmentAsRecords, reassembleRecords, splitLeadingContentType, type TlsRecord } from './recordLayer';
import { deriveKeySchedule, computeFinished, transcriptHash, nextTrafficSecret, ZERO_IKM } from './keySchedule';
import { certificateAlert, fatalAlert, type AlertDescription, type TlsAlert } from './alerts';
import { MANDATORY_CIPHER_SUITES, selectCipherSuite } from './cipherSuites';
import { selectAlpnProtocol } from './alpn';
import { type SessionTicket, SessionTicketStore, deriveResumptionPsk } from './sessionTickets';

export interface TlsServerConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
  /** Top preference; tried first against what the client actually offered (RFC 8446 §4.1.1). */
  readonly cipherSuite?: CipherSuite;
  /** RFC 8446 §4.3.2 — request the peer's certificate (mTLS). Requires `verifier`. */
  readonly requestClientCert?: boolean;
  /** Verifies the client's certificate chain; required when `requestClientCert` is set. */
  readonly verifier?: CertificateVerifier;
  /** Groups this server accepts a key_share for; defaults to `['x25519']`. */
  readonly supportedGroups?: readonly string[];
  /** RFC 7301 — protocols this server supports, in preference order. */
  readonly alpnProtocols?: readonly string[];
  /** Shared session-ticket registry (§4.6.1) — set to issue tickets and accept PSK/0-RTT resumption. */
  readonly sessionTicketStore?: SessionTicketStore;
  /** RFC 8446 §2.1.12 observability — publishes `tls.*` events (`events.ts`) if set. */
  readonly eventBus?: IEventBus;
}

function groupOf(keyShare: string): string {
  return keyShare.split(':')[0];
}

type ServerState = 'idle' | 'awaiting-second-client-hello' | 'awaiting-client-final' | 'done';

export class TlsServerSession {
  result: 'accept' | 'reject' | null = null;
  /** RFC 8446 §6 alert explaining the last failure, if any. */
  lastAlert: TlsAlert | null = null;
  /** The cipher suite actually negotiated, once a ClientHello has been processed. */
  negotiatedCipherSuite: CipherSuite | null = null;
  /** RFC 7301 — the protocol actually negotiated, if any. */
  negotiatedAlpnProtocol: string | null = null;
  /** RFC 8446 §2.3/§4.2.10 — 0-RTT data received alongside a validly-resumed ClientHello, if any. */
  receivedEarlyData: Uint8Array | null = null;
  /**
   * RFC 8446 §7.2 — this side's current application traffic secrets, set
   * once the handshake completes and ratcheted independently per direction
   * by `sendKeyUpdate`/`receiveKeyUpdate` (§4.6.3).
   */
  clientApplicationTrafficSecret: string | null = null;
  serverApplicationTrafficSecret: string | null = null;
  /**
   * RFC 9001 §5.3 — the Handshake-space secrets (`client_handshake_traffic_secret`/
   * `server_handshake_traffic_secret`), set once the server flight is built.
   * Exposed for consumers deriving Handshake-space keys on top of this
   * engine (e.g. QUIC's `PacketProtection.ts`), not just this module's own
   * Finished computation.
   */
  clientHandshakeTrafficSecret: string | null = null;
  serverHandshakeTrafficSecret: string | null = null;
  /** Stable per-connection correlator for `events.ts` payloads (§2.1.12). */
  readonly sessionId = randomNonce('tls-session');

  private state: ServerState = 'idle';
  private readonly cipherSuitePreference: readonly CipherSuite[];
  private readonly supportedGroups: readonly string[];
  private readonly alpnProtocols: readonly string[];
  private resumptionMasterSecret: string | null = null;
  private earlyDataAccepted = false;
  private sessionResumed = false;
  private readonly transcript: Uint8Array[] = [];

  constructor(private readonly config: TlsServerConfig) {
    const preferred = config.cipherSuite;
    this.cipherSuitePreference = preferred
      ? [preferred, ...MANDATORY_CIPHER_SUITES.filter((s) => s !== preferred)]
      : MANDATORY_CIPHER_SUITES;
    this.supportedGroups = config.supportedGroups ?? ['x25519'];
    this.alpnProtocols = config.alpnProtocols ?? [];
  }

  /** Feeds the peer's flight in; returns this side's next flight, or null once nothing more is to be sent. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    try {
      if (this.state === 'idle') return this.handleFirstClientHello(incoming);
      if (this.state === 'awaiting-second-client-hello') return this.handleSecondClientHello(incoming);
      if (this.state === 'awaiting-client-final') return this.handleClientFinal(incoming);
      return null;
    } catch {
      return this.reject('decode_error');
    }
  }

  private emit(event: TlsDomainEvent): void {
    this.config.eventBus?.publish(event);
  }

  private reject(description: AlertDescription = 'handshake_failure'): null {
    this.lastAlert = fatalAlert(description);
    this.state = 'done';
    this.result = 'reject';
    this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert } });
    this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert } });
    return null;
  }

  private handleFirstClientHello(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    this.emit({ topic: 'tls.handshake.started', payload: { sessionId: this.sessionId, role: 'server' } });
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    const { contentType, plaintext: clientHelloBytes } = reassembleRecords(leading, false);
    if (contentType !== 'handshake') return this.reject('decode_error');
    const clientHello = decodeHandshakeMessage(clientHelloBytes) as ClientHello;
    this.transcript.push(clientHelloBytes);

    if (this.supportedGroups.includes(groupOf(clientHello.extensions.keyShare))) {
      const pskInput = this.resolvePsk(clientHello);
      if (pskInput && rest.length > 0) {
        this.earlyDataAccepted = true;
        this.receivedEarlyData = reassembleRecords(rest, true).plaintext;
      }
      return this.proceedWithServerFlight(clientHello, pskInput ?? ZERO_IKM, pskInput !== null);
    }

    const mutualGroup = this.supportedGroups.find((g) => clientHello.extensions.supportedGroups.includes(g));
    if (!mutualGroup) return this.reject('handshake_failure');

    const helloRetryRequest: HelloRetryRequest = {
      kind: 'hello_retry_request', random: HELLO_RETRY_REQUEST_RANDOM, selectedGroup: mutualGroup,
    };
    const hrrBytes = encodeHandshakeMessage(helloRetryRequest);
    this.transcript.push(hrrBytes);
    this.state = 'awaiting-second-client-hello';
    return fragmentAsRecords('handshake', hrrBytes, false);
  }

  /** Redeems the client's PSK ticket, if offered and valid; null if not offered, unknown, or expired. */
  private resolvePsk(clientHello: ClientHello): string | null {
    if (!clientHello.extensions.preSharedKey || !this.config.sessionTicketStore) return null;
    const ticket = this.config.sessionTicketStore.redeem(clientHello.extensions.preSharedKey, Date.now());
    if (!ticket) return null;
    return deriveResumptionPsk(ticket);
  }

  private handleSecondClientHello(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext: clientHelloBytes } = reassembleRecords(incoming, false);
    if (contentType !== 'handshake') return this.reject('decode_error');
    const clientHello = decodeHandshakeMessage(clientHelloBytes) as ClientHello;
    if (!this.supportedGroups.includes(groupOf(clientHello.extensions.keyShare))) return this.reject('handshake_failure');
    this.transcript.push(clientHelloBytes);
    return this.proceedWithServerFlight(clientHello, ZERO_IKM, false);
  }

  private proceedWithServerFlight(
    clientHello: ClientHello, pskInput: string, pskAccepted: boolean,
  ): readonly TlsRecord[] | null {
    const negotiatedSuite = selectCipherSuite(clientHello.cipherSuites, this.cipherSuitePreference);
    if (!negotiatedSuite) return this.reject('handshake_failure');
    this.negotiatedCipherSuite = negotiatedSuite;
    this.negotiatedAlpnProtocol = selectAlpnProtocol(clientHello.extensions.alpn, this.alpnProtocols);

    const serverRandom = randomNonce('srv');
    // La part du serveur porte désormais son groupe, comme celle du
    // client : sans ce préfixe le client ne saurait pas quelle courbe
    // interpréter, et le §4.2.8 en fait de toute façon un `NamedGroup`.
    const echange = generateKeyExchange(groupOf(clientHello.extensions.keyShare));
    const serverKeyShare = echange.share;
    const serverHello: ServerHello = {
      kind: 'server_hello', random: serverRandom, cipherSuite: negotiatedSuite,
      extensions: {
        supportedVersions: '1.3', keyShare: serverKeyShare,
        preSharedKey: pskAccepted ? 'accepted' : undefined,
      },
    };
    const serverHelloBytes = encodeHandshakeMessage(serverHello);
    this.transcript.push(serverHelloBytes);

    const dheSharedSecret = sharedSecret(
      echange,
      clientHello.extensions.keyShare,
      [clientHello.random, serverRandom, clientHello.extensions.keyShare, serverKeyShare].join('|'),
    );
    if (dheSharedSecret === null) return this.reject('illegal_parameter');
    // Simplification: application/resumption secrets are derived from the
    // CH+SH transcript checkpoint rather than the true through-Finished
    // one — per-session uniqueness already comes from dheSharedSecret/
    // pskInput (both random-nonce-derived), and neither is ever used to
    // decrypt anything for real at this fidelity level (§2.1's convention).
    const shTranscript = transcriptHash(this.transcript);
    const handshakePhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]]), serverHello: shTranscript, serverFinished: shTranscript, clientFinished: shTranscript },
      pskInput, dheSharedSecret,
    );
    this.clientHandshakeTrafficSecret = handshakePhase.clientHandshakeTrafficSecret;
    this.serverHandshakeTrafficSecret = handshakePhase.serverHandshakeTrafficSecret;
    this.resumptionMasterSecret = handshakePhase.resumptionMasterSecret;
    this.clientApplicationTrafficSecret = handshakePhase.clientApplicationTrafficSecret;
    this.serverApplicationTrafficSecret = handshakePhase.serverApplicationTrafficSecret;
    if (pskAccepted) {
      this.sessionResumed = true;
      this.emit({
        topic: 'tls.session.resumed',
        payload: { sessionId: this.sessionId, role: 'server', ticket: clientHello.extensions.preSharedKey! },
      });
    }

    const bundle: TlsHandshakeMessage[] = [];
    const encryptedExtensions: EncryptedExtensionsMessage = {
      kind: 'encrypted_extensions',
      extensions: { alpn: this.negotiatedAlpnProtocol ?? undefined, earlyData: this.earlyDataAccepted || undefined },
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

  private handleClientFinal(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext } = reassembleRecords(incoming, true);
    if (contentType !== 'handshake') return this.reject('decode_error');
    const messages = decodeMessages(plaintext);

    if (this.config.requestClientCert) {
      const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate');
      const certificateVerify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify');
      if (!certificate || certificate.certificateList.length === 0 || !certificateVerify) {
        return this.reject('certificate_unknown');
      }
      const leafCert = certificate.certificateList[0];
      if (!this.config.verifier) return this.reject('certificate_unknown');
      const verification = this.config.verifier.verify(leafCert);
      if (verification.ok === false) {
        this.lastAlert = certificateAlert(verification.reason);
        this.state = 'done';
        this.result = 'reject';
        this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert } });
        this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert } });
        return null;
      }

      this.transcript.push(encodeHandshakeMessage(certificate));
      const preVerify = transcriptHash(this.transcript);
      if (!PkiKeyPair.verify(leafCert.publicKey, preVerify, certificateVerify.signature)) return this.reject('decrypt_error');
      this.transcript.push(encodeHandshakeMessage(certificateVerify));
    }

    const finished = messages.find((m): m is Finished => m.kind === 'finished');
    if (!finished) return this.reject('unexpected_message');
    const expected = computeFinished(this.clientHandshakeTrafficSecret!, transcriptHash(this.transcript));
    if (finished.verifyData !== expected) return this.reject('decrypt_error');
    this.state = 'done';
    this.result = 'accept';
    this.emit({
      topic: 'tls.handshake.completed',
      payload: {
        sessionId: this.sessionId, role: 'server', cipherSuite: this.negotiatedCipherSuite!,
        alpnProtocol: this.negotiatedAlpnProtocol, resumed: this.sessionResumed,
      },
    });

    if (!this.config.sessionTicketStore) return null;
    const ticket: SessionTicket = {
      ticket: randomNonce('ticket'),
      resumptionMasterSecret: this.resumptionMasterSecret!,
      ticketNonce: randomNonce('ticket-nonce'),
      cipherSuite: this.negotiatedCipherSuite!,
      ticketLifetime: 7200,
      issuedAt: Date.now(),
      consumed: false,
    };
    this.config.sessionTicketStore.issue(ticket);
    const newSessionTicket: NewSessionTicket = {
      kind: 'new_session_ticket', ticketLifetime: ticket.ticketLifetime, ticketAgeAdd: randomNonce('age-add'),
      ticketNonce: ticket.ticketNonce, ticket: ticket.ticket, extensions: { earlyData: true },
    };
    return fragmentAsRecords('handshake', encodeHandshakeMessage(newSessionTicket), true);
  }

  /**
   * RFC 8446 §4.6.3 — ratchets this side's own sending secret
   * (`serverApplicationTrafficSecret`) and returns the wire flight; the peer
   * must feed it into `receiveKeyUpdate` to stay in sync. `requestUpdate`
   * asks the peer to reciprocate with its own KeyUpdate.
   */
  sendKeyUpdate(requestUpdate = false): readonly TlsRecord[] {
    const keyUpdate: KeyUpdate = { kind: 'key_update', requestUpdate };
    const records = fragmentAsRecords('handshake', encodeHandshakeMessage(keyUpdate), true);
    this.serverApplicationTrafficSecret = nextTrafficSecret(this.serverApplicationTrafficSecret!);
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'server', direction: 'server-to-client', requestUpdate },
    });
    return records;
  }

  /**
   * RFC 8446 §4.6.3 — processes a peer KeyUpdate: ratchets the matching
   * receiving secret (`clientApplicationTrafficSecret`) and, if the peer
   * requested a reciprocal update, returns this side's own KeyUpdate (never
   * itself setting `requestUpdate`, to avoid an update ping-pong).
   */
  receiveKeyUpdate(records: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext } = reassembleRecords(records, true);
    if (contentType !== 'handshake') return null;
    const message = decodeHandshakeMessage(plaintext);
    if (message.kind !== 'key_update') return null;
    this.clientApplicationTrafficSecret = nextTrafficSecret(this.clientApplicationTrafficSecret!);
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'server', direction: 'client-to-server', requestUpdate: message.requestUpdate },
    });
    return message.requestUpdate ? this.sendKeyUpdate(false) : null;
  }
}
