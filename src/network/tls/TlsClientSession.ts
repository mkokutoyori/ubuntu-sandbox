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
import { simulationNowMs } from '@/network/core/SystemClock';

import type { IEventBus } from '@/events/EventBus';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { generateKeyExchange, sharedSecret, isImplementedGroup, type KeyExchangeKeyPair } from './keyExchange';
import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { MAX_TLS_RECORD_LENGTH, type CipherSuite } from './types';
import type { TlsDomainEvent } from './events';
import {
  type ClientHello, type ServerHello, type LegacyClientExtensions, type EncryptedExtensionsMessage,
  type CertificateRequest, type CertificateMessage, type CertificateVerify, type Finished,
  type NewSessionTicket, type KeyUpdate, type TlsHandshakeMessage,
  encodeHandshakeMessage, decodeHandshakeMessage, encodeMessages, decodeMessages, decodeMessagesRaw, randomNonce,
} from './messages';
import { sealKeyUpdate, openKeyUpdate } from './keyUpdateRecords';
import { fragmentAsRecords, reassembleRecords, splitLeadingContentType, type TlsRecord } from './recordLayer';
import { hashLength } from './hkdf';
import { collapseFirstClientHello, deriveKeySchedule, computePskBinder, computeFinished, transcriptHash, nextTrafficSecret, expandLabel, certificateVerifyContent, ZERO_IKM } from './keySchedule';
import { signCertificateVerify, verifyCertificateVerify, CLIENT_HELLO_SIGNATURE_SCHEMES, schemeForKey } from './signature13';
import { alertFromRecord, alertToRecord, certificateAlert, fatalAlert, type AlertDescription, type TlsAlert } from './alerts';
import { DEFAULT_CIPHER_SUITES, parseTls13Ciphersuites } from './cipherSuites';
import { tls13CipherPermitted } from './legacy/securityPolicy';
import { type SessionTicket, deriveResumptionPsk } from './sessionTickets';
import {
  PROTOCOL_VERSION_WIRE, legacySuiteByName, permittedVersions, resolveLegacyPolicy,
  type LegacySuiteDefinition, type ResolvedLegacyPolicy, type LegacyVersion, type TlsProtocolVersion,
} from './legacy/legacyCipherSuites';
import { LegacyClientHandshake, newHelloRandom } from './legacy/LegacyHandshake';
import type { TrafficProtection } from './trafficProtection';
import { suiteInfo } from './suite13';
import type { Tls13Hash } from './hkdf';
import { stapleAlert } from './ocspStapling';
import type { OcspResponseMessage } from '@/network/pki/OcspWire';
import { isValidMaxFragmentLength, DEFAULT_MAX_FRAGMENT } from './maxFragment';
import type { ResumableLegacySession } from './legacy/legacySessions';
import { randomHex } from './legacy/LegacyHandshake';
import { sealFlight, openFlight, openLeadingHandshake, withoutChangeCipherSpec } from './handshakeProtection';

export interface TlsClientConfig {
  readonly verifier: CertificateVerifier;
  /**
   * Continue the handshake when the peer certificate does not verify,
   * recording the outcome on `peerVerified` instead of aborting. Off by
   * default: only an inspecting middlebox, which must terminate the
   * session before it can decide what to do with an untrusted peer, has
   * any business turning it on.
   */
  readonly allowUntrustedPeer?: boolean;
  /** Suites offered, in preference order; defaults to all 5 mandatory suites (RFC 8446 §B.4). */
  readonly cipherSuites?: readonly CipherSuite[];
  /** Presented only if the server actually sends a CertificateRequest (mTLS). */
  readonly clientCert?: X509Certificate;
  /** Intermediates sent after `clientCert` in the Certificate message. */
  readonly clientChain?: readonly X509Certificate[];
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
  /** Protocol versions offered; RFC 8996 removes 1.0/1.1 from the default. */
  readonly versions?: readonly TlsProtocolVersion[];
  /** TLS ≤ 1.2 suites (by IANA name) offered, in preference order. */
  readonly legacyCipherSuites?: readonly string[];
  /** OpenSSL cipher string for TLS ≤ 1.2 (`ssl/ssl_ciph.c` grammar, `@SECLEVEL=n` included). */
  readonly cipherList?: string;
  /** OpenSSL security level 0..5 (`ssl/ssl_cert.c`); default 1. */
  readonly securityLevel?: number;
  /** TLS 1.3 suites in OpenSSL's colon syntax (`SSL_CTX_set_ciphersuites`). */
  readonly tls13Ciphersuites?: string;
  /** RFC 7627 — offer `extended_master_secret` for TLS ≤ 1.2 (default true). */
  readonly extendedMasterSecret?: boolean;
  /** A session exported by `exportLegacySession()` to resume (RFC 5246 §7.3, RFC 5077). */
  readonly legacySession?: ResumableLegacySession;
  /** `SSL_OP_LEGACY_SERVER_CONNECT` : talk to a server lacking RFC 5746 secure renegotiation. */
  readonly allowUnsafeLegacyRenegotiation?: boolean;
  /** RFC 6066 §8 — send status_request and verify a stapled OCSP response. */
  readonly requestOcspStaple?: boolean;
  /** RFC 7633 must-staple behaviour: a missing or invalid staple fails with bad_certificate_status_response. */
  readonly requireOcspStaple?: boolean;
  /** Send status_request and keep the staple for the caller to judge (curl --cert-status, s_client -status) instead of aborting. */
  readonly collectOcspStaple?: boolean;
  /** RFC 6066 §4 — ask the server to limit records to this many bytes. */
  readonly maxFragmentLength?: number;
  /** RFC 8701 — inject GREASE values into the ClientHello lists. */
  readonly grease?: boolean;
}

const GREASE_VALUE = 0x0a0a;
const GREASE_NAME = 'grease_0a0a';
const GREASE_CIPHER_SUITE = 'TLS_GREASE_0A0A';

const MAX_TICKET_LIFETIME_SECONDS = 604800;
const MAX_PROTECTED_FRAGMENT = MAX_TLS_RECORD_LENGTH + 2048;

export const DEFAULT_CLIENT_VERSIONS: readonly TlsProtocolVersion[] = ['1.3', '1.2'];

type ClientState = 'idle' | 'awaiting-server-flight' | 'done';

export class TlsClientSession {
  result: 'success' | 'failure' | null = null;
  /** RFC 8446 §6 alert explaining the last failure, if any. */
  lastAlert: TlsAlert | null = null;
  /** The cipher suite the server actually chose, once ServerHello is processed. */
  negotiatedCipherSuite: string | null = null;
  negotiatedVersion: TlsProtocolVersion | null = null;
  /** RFC 7301 — the protocol the server actually chose, if any. */
  negotiatedAlpnProtocol: string | null = null;
  /** RFC 8446 §2.3 — whether the server accepted the 0-RTT data offered, if any was sent. */
  earlyDataAccepted: boolean | null = null;
  /** A ticket received via `receiveSessionTicket()`, ready to resume a future session. */
  receivedTicket: SessionTicket | null = null;
  peerCertificate: X509Certificate | null = null;
  peerCertificateChain: readonly X509Certificate[] = [];
  receivedStaple: OcspResponseMessage | null = null;
  peerVerified = false;
  peerVerificationReason: string | null = null;
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
  private versions: readonly TlsProtocolVersion[];
  private suiteOverride: readonly CipherSuite[] | null = null;
  private readonly policy: ResolvedLegacyPolicy;
  private legacy: LegacyClientHandshake | null = null;
  private lastClientHelloBytes: Uint8Array = new Uint8Array(0);
  private hash: Tls13Hash = 'sha256';
  private retried = false;
  negotiatedMaxFragmentLength: number | null = null;

  constructor(private readonly config: TlsClientConfig) {
    this.policy = resolveLegacyPolicy(config);
    this.versions = permittedVersions(config.versions ?? DEFAULT_CLIENT_VERSIONS, this.policy.securityLevel);
    // Un vrai client n'annonce pas un groupe dont il n'a pas le code : le
    // serveur le choisirait, et il faudrait alors soit abandonner plus
    // tard, soit fabriquer un secret. Le filtre est là pour que la
    // question ne se pose jamais.
    this.supportedGroups = (config.supportedGroups ?? ['x25519', 'secp256r1']).filter(isImplementedGroup);
    this.pskInput = config.resumptionTicket ? deriveResumptionPsk(config.resumptionTicket) : ZERO_IKM;
  }

  clientTraffic(): TrafficProtection {
    return this.legacy?.traffic?.outbound ?? { secret: this.clientApplicationTrafficSecret!, suite: this.negotiatedCipherSuite as CipherSuite, maxFragment: this.negotiatedMaxFragmentLength ?? DEFAULT_MAX_FRAGMENT };
  }

  private serverApplicationSequenceBase = 0;
  private ticketAttempted = false;

  serverTraffic(): TrafficProtection {
    return this.legacy?.traffic?.inbound ?? {
      secret: this.serverApplicationTrafficSecret!, suite: this.negotiatedCipherSuite as CipherSuite,
      maxFragment: this.negotiatedMaxFragmentLength ?? DEFAULT_MAX_FRAGMENT, sequenceBase: this.serverApplicationSequenceBase,
    };
  }

  private legacyExt: LegacyClientExtensions | null = null;

  private legacyExtensions(): LegacyClientExtensions {
    if (this.legacyExt === null) {
      const session = this.config.legacySession ?? null;
      const resumable = session !== null && this.legacyVersions().includes(session.state.version);
      this.legacyExt = {
        sessionId: resumable ? (session!.state.id !== '' ? session!.state.id : randomHex(32)) : '',
        extendedMasterSecret: this.config.extendedMasterSecret !== false,
        renegotiationInfo: '',
        sessionTicket: resumable ? (session!.ticket ?? '') : '',
      };
    }
    return this.legacyExt;
  }

  exportLegacySession(): ResumableLegacySession | null {
    return this.legacy?.exportedSession ?? null;
  }

  get legacyResumed(): boolean {
    return this.legacy?.resumed ?? false;
  }

  pskResumed = false;

  private withGrease<T>(values: readonly T[], grease: T): readonly T[] {
    return this.config.grease === true ? [grease, ...values] : values;
  }

  private tls13Offer(): readonly CipherSuite[] {
    const base = this.suiteOverride ?? this.config.cipherSuites
      ?? (this.config.tls13Ciphersuites !== undefined ? parseTls13Ciphersuites(this.config.tls13Ciphersuites) : DEFAULT_CIPHER_SUITES);
    return base.filter((suite) => tls13CipherPermitted(this.policy.securityLevel, suiteInfo(suite).strengthBits));
  }

  restrictToQuic(): void {
    this.versions = ['1.3'];
    this.suiteOverride = ['TLS_AES_128_GCM_SHA256'];
  }

  private offersTls13(): boolean {
    return this.versions.includes('1.3');
  }

  private legacyVersions(): LegacyVersion[] {
    return (['1.0', '1.1', '1.2'] as const).filter((version) => this.versions.includes(version));
  }

  private legacySuiteDefinitions(): readonly LegacySuiteDefinition[] {
    return this.legacyVersions().length === 0 ? [] : this.policy.suites;
  }

  /** Produces the initial `ClientHello` flight, offering a key_share for the first supported group. */
  start(): readonly TlsRecord[] {
    this.emit({ topic: 'tls.handshake.started', payload: { sessionId: this.sessionId, role: 'client' } });
    // Aucun groupe calculable : rien ne part sur le fil. C'est ce que
    // fait une vraie pile configurée avec des groupes qu'elle ne sait pas
    // faire — elle échoue avant d'écrire, plutôt que d'ouvrir une
    // conversation qu'elle ne peut pas conclure.
    if (this.supportedGroups.length === 0) { this.fail('handshake_failure'); return []; }
    if (this.versions.length === 0) { this.fail('protocol_version'); return []; }
    if (this.policy.error !== null) { this.fail('handshake_failure'); return []; }
    this.clientRandom = newHelloRandom();
    const records = this.sendClientHello(this.supportedGroups[0]);
    if (!this.config.resumptionTicket || !this.config.earlyData) return records;
    return [...records, ...fragmentAsRecords('application_data', this.config.earlyData, true)];
  }

  private sendClientHello(group: string): readonly TlsRecord[] {
    this.keyExchange = this.offersTls13() ? generateKeyExchange(group) : null;
    this.clientKeyShare = this.keyExchange?.share ?? '';
    const legacyOffered = this.legacyVersions();
    const legacyCeiling: LegacyVersion = legacyOffered[legacyOffered.length - 1] ?? '1.2';
    const ticket = this.config.resumptionTicket;
    const clientHello: ClientHello = {
      kind: 'client_hello', legacyVersion: legacyCeiling, random: this.clientRandom,
      cipherSuites: this.offersTls13() ? this.withGrease(this.tls13Offer(), GREASE_CIPHER_SUITE as CipherSuite) : [],
      legacyCipherSuites: this.withGrease(this.legacySuiteDefinitions().map((definition) => definition.code), GREASE_VALUE),
      legacyExtensions: this.legacyExtensions(),
      extensions: {
        supportedVersions: this.offersTls13() ? this.withGrease(this.versions, GREASE_NAME) : [], keyShare: this.clientKeyShare,
        supportedGroups: this.withGrease(this.supportedGroups, GREASE_NAME),
        signatureAlgorithms: this.withGrease(CLIENT_HELLO_SIGNATURE_SCHEMES, GREASE_NAME),
        alpn: this.config.alpn ? this.withGrease(this.config.alpn, GREASE_NAME) : undefined,
        serverName: this.config.serverName,
        ...(this.config.requestOcspStaple || this.config.requireOcspStaple || this.config.collectOcspStaple ? { statusRequest: true } : {}),
        ...(isValidMaxFragmentLength(this.config.maxFragmentLength) ? { maxFragmentLength: this.config.maxFragmentLength } : {}),
        preSharedKey: ticket?.ticket,
        ...(ticket ? { pskOffers: [{ identity: ticket.ticket, obfuscatedAge: this.obfuscatedTicketAge(ticket), binder: '00'.repeat(hashLength(suiteInfo(ticket.cipherSuite).hash)) }] } : {}),
        pskKeyExchangeModes: ticket ? ['psk_dhe_ke'] : undefined,
        earlyData: ticket && this.config.earlyData ? true : undefined,
      },
    };
    const clientHelloBytes = ticket ? this.bindClientHello(clientHello, ticket) : encodeHandshakeMessage(clientHello);
    this.lastClientHelloBytes = clientHelloBytes;
    this.transcript.push(clientHelloBytes);
    this.state = 'awaiting-server-flight';
    return fragmentAsRecords('handshake', clientHelloBytes, false);
  }

  private obfuscatedTicketAge(ticket: SessionTicket): number {
    const ageAdd = Number.parseInt(ticket.ticketAgeAdd ?? '0', 16);
    return (Math.max(0, simulationNowMs() - ticket.issuedAt) + ageAdd) >>> 0;
  }

  private bindClientHello(clientHello: ClientHello, ticket: SessionTicket): Uint8Array {
    const hash = suiteInfo(ticket.cipherSuite).hash;
    const placeholder = encodeHandshakeMessage(clientHello);
    const bindersLength = 2 + 1 + hashLength(hash);
    const partial = placeholder.subarray(0, placeholder.length - bindersLength);
    const prefix = [...this.transcript];
    if (this.retried) collapseFirstClientHello(prefix, hash);
    const binder = computePskBinder(this.pskInput, transcriptHash([...prefix, partial], hash), hash);
    const offer = clientHello.extensions.pskOffers![0];
    return encodeHandshakeMessage({
      ...clientHello,
      extensions: { ...clientHello.extensions, pskOffers: [{ ...offer, binder }] },
    });
  }

  /** Feeds the server's flight in; returns the client's next flight, or null on failure. */
  peerAlert: TlsAlert | null = null;

  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const received = incoming.length > 0 ? alertFromRecord(incoming[0]) : null;
    if (received !== null) return this.receiveAlert(received);
    const before = this.lastAlert;
    const flight = incoming.some((record) => record.fragment.length > MAX_PROTECTED_FRAGMENT)
      ? this.fail('record_overflow')
      : this.process(incoming);
    if (flight === null && this.result === 'failure' && this.lastAlert !== before && this.lastAlert !== null) {
      return [alertToRecord(this.lastAlert)];
    }
    return flight;
  }

  private receiveAlert(alert: TlsAlert): null {
    if (this.result !== null) return null;
    this.peerAlert = alert;
    this.lastAlert = alert;
    this.state = 'done';
    this.result = 'failure';
    this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'client', alert } });
    return null;
  }

  private process(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
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
    if (this.legacy !== null) return this.handleLegacy(incoming);
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    const { contentType: leadType, plaintext: leadBytes } = reassembleRecords(leading, false);
    if (leadType !== 'handshake') return this.fail('decode_error');
    const leadMessage = decodeHandshakeMessage(leadBytes);
    if (leadMessage.kind === 'server_hello' && leadMessage.extensions.supportedVersions !== '1.3') return this.startLegacy(incoming);

    if (leadMessage.kind === 'hello_retry_request') {
      if (rest.length > 0) return this.fail('unexpected_message');
      if (!this.supportedGroups.includes(leadMessage.selectedGroup)) return this.fail('handshake_failure');
      this.transcript.push(leadBytes);
      this.retried = true;
      return this.sendClientHello(leadMessage.selectedGroup);
    }
    if (leadMessage.kind !== 'server_hello') return this.fail('unexpected_message');

    return this.handleServerFlight(leadMessage, leadBytes, rest);
  }

  private startLegacy(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const legacyOffered = this.legacyVersions();
    if (legacyOffered.length === 0) return this.fail('protocol_version');
    const ceiling = legacyOffered[legacyOffered.length - 1];
    this.legacy = new LegacyClientHandshake({
      offeredVersions: legacyOffered,
      offeredSuites: this.legacySuiteDefinitions().map((definition) => definition.name),
      offeredGroups: this.supportedGroups, clientHelloBytes: this.lastClientHelloBytes,
      clientRandom: this.clientRandom, clientVersionWire: PROTOCOL_VERSION_WIRE[ceiling],
      offersTls13: this.offersTls13(), verifier: this.config.verifier,
      allowUntrustedPeer: this.config.allowUntrustedPeer === true, serverName: this.config.serverName,
      clientCert: this.config.clientCert, clientChain: this.config.clientChain, clientPrivateKey: this.config.clientPrivateKey,
      securityLevel: this.policy.securityLevel, resolveSuite: legacySuiteByName,
      clientExtensions: this.legacyExtensions(),
      session: this.config.legacySession ?? null,
      allowUnsafeRenegotiation: this.config.allowUnsafeLegacyRenegotiation === true,
      requestStatus: this.config.requestOcspStaple === true || this.config.requireOcspStaple === true || this.config.collectOcspStaple === true,
      enforceStaple: this.config.requestOcspStaple === true || this.config.requireOcspStaple === true,
      requireStaple: this.config.requireOcspStaple === true,
      requestedMaxFragment: isValidMaxFragmentLength(this.config.maxFragmentLength) ? this.config.maxFragmentLength : null,
      now: simulationNowMs,
    });
    return this.handleLegacy(incoming);
  }

  private handleLegacy(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const legacy = this.legacy!;
    const flight = legacy.handle(incoming);
    this.peerCertificate = legacy.peerCertificate;
    this.peerCertificateChain = legacy.peerCertificateChain;
    this.receivedStaple = legacy.receivedStaple;
    this.peerVerified = legacy.peerVerified;
    this.peerVerificationReason = legacy.peerVerificationReason;
    this.negotiatedVersion = legacy.negotiatedVersion;
    this.negotiatedCipherSuite = legacy.negotiatedSuite?.name ?? null;
    this.negotiatedAlpnProtocol = legacy.negotiatedAlpn;
    this.negotiatedMaxFragmentLength = legacy.negotiatedMaxFragment;
    if (legacy.result === 'failure') {
      this.lastAlert = legacy.lastAlert;
      this.state = 'done';
      this.result = 'failure';
      this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert! } });
      this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert! } });
    } else if (legacy.result === 'success') {
      this.state = 'done';
      this.result = 'success';
      this.emit({
        topic: 'tls.handshake.completed',
        payload: {
          sessionId: this.sessionId, role: 'client', cipherSuite: this.negotiatedCipherSuite!,
          protocolVersion: this.negotiatedVersion!, alpnProtocol: this.negotiatedAlpnProtocol, resumed: legacy.resumed,
        },
      });
    }
    return flight;
  }

  private handleServerFlight(
    serverHello: ServerHello, serverHelloBytes: Uint8Array, rest: readonly TlsRecord[],
  ): readonly TlsRecord[] | null {
    this.transcript.push(serverHelloBytes);

    const offeredSuites = this.tls13Offer();
    if ((serverHello.cipherSuite as string) === GREASE_CIPHER_SUITE) return this.fail('illegal_parameter');
    if (!offeredSuites.includes(serverHello.cipherSuite)) return this.fail('handshake_failure');
    this.negotiatedCipherSuite = serverHello.cipherSuite;
    this.negotiatedVersion = '1.3';
    this.hash = suiteInfo(serverHello.cipherSuite).hash;
    if (this.retried) collapseFirstClientHello(this.transcript, this.hash);

    const dheSharedSecret = this.keyExchange === null
      ? null
      : sharedSecret(this.keyExchange, serverHello.extensions.keyShare ?? '');
    if (dheSharedSecret === null) return this.fail('illegal_parameter');
    const effectivePsk = serverHello.extensions.preSharedKey ? this.pskInput : ZERO_IKM;
    const shTranscript = transcriptHash(this.transcript, this.hash);
    const handshakePhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]], this.hash), serverHello: shTranscript, serverFinished: shTranscript, clientFinished: shTranscript },
      effectivePsk, dheSharedSecret, this.hash,
    );
    this.clientHandshakeTrafficSecret = handshakePhase.clientHandshakeTrafficSecret;
    this.serverHandshakeTrafficSecret = handshakePhase.serverHandshakeTrafficSecret;
    const sessionResumed = Boolean(serverHello.extensions.preSharedKey);
    this.pskResumed = sessionResumed;
    if (sessionResumed) {
      this.emit({
        topic: 'tls.session.resumed',
        payload: { sessionId: this.sessionId, role: 'client', ticket: this.config.resumptionTicket!.ticket },
      });
    }

    const opened = openFlight(handshakePhase.serverHandshakeTrafficSecret, serverHello.cipherSuite, 0, withoutChangeCipherSpec(rest));
    if (opened === null) return this.fail('bad_record_mac');
    if (opened.contentType !== 'handshake') return this.fail('decode_error');
    const received = decodeMessagesRaw(opened.plaintext);
    const messages = received.map((entry) => entry.message);
    const rawOf = (message: TlsHandshakeMessage): Uint8Array => received.find((entry) => entry.message === message)!.raw;

    const encryptedExtensions = messages.find((m): m is EncryptedExtensionsMessage => m.kind === 'encrypted_extensions');
    const certificateRequest = messages.find((m): m is CertificateRequest => m.kind === 'certificate_request');
    const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate');
    const certificateVerify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify');
    const serverFinished = messages.find((m): m is Finished => m.kind === 'finished');
    if (!encryptedExtensions || !serverFinished) return this.fail('unexpected_message');
    if (sessionResumed ? certificate || certificateVerify : !certificate || !certificateVerify) return this.fail('unexpected_message');

    if (encryptedExtensions.extensions.alpn === GREASE_NAME) return this.fail('illegal_parameter');
    this.negotiatedAlpnProtocol = encryptedExtensions.extensions.alpn ?? null;
    const echoedFragment = encryptedExtensions.extensions.maxFragmentLength;
    if (echoedFragment !== undefined) {
      if (this.config.maxFragmentLength === undefined) return this.fail('unsupported_extension');
      if (echoedFragment !== this.config.maxFragmentLength) return this.fail('illegal_parameter');
      this.negotiatedMaxFragmentLength = echoedFragment;
    }
    this.earlyDataAccepted = encryptedExtensions.extensions.earlyData ?? false;

    if (!sessionResumed) {
      const leafCert = certificate!.certificateList[0];
      if (!leafCert) return this.fail('certificate_unknown');
      this.peerCertificate = leafCert;
      this.peerCertificateChain = certificate!.certificateList;
      this.receivedStaple = certificate!.ocspStaple ?? null;
      const verification = this.config.verifier.verify(
        leafCert, this.config.serverName, certificate!.certificateList.slice(1), 'serverAuth', this.policy.securityLevel,
      );
      this.peerVerified = verification.ok !== false;
      if (verification.ok === false) {
        this.peerVerificationReason = verification.reason;
        if (!this.config.allowUntrustedPeer) {
          this.lastAlert = certificateAlert(verification.reason);
          this.state = 'done';
          this.result = 'failure';
          this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert } });
          this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'client', alert: this.lastAlert } });
          return null;
        }
      }

      const stapleProblem = stapleAlert(
        this.config.verifier, leafCert, certificate!.certificateList.slice(1), certificate!.ocspStaple,
        this.config.requireOcspStaple === true,
      );
      if (stapleProblem !== null && (this.config.requestOcspStaple || this.config.requireOcspStaple)) return this.fail(stapleProblem);
      this.transcript.push(rawOf(encryptedExtensions));
      if (certificateRequest) this.transcript.push(rawOf(certificateRequest));
      this.transcript.push(rawOf(certificate!));

      const preVerify = certificateVerifyContent('server', transcriptHash(this.transcript, this.hash));
      if (certificateVerify!.signatureAlgorithm !== schemeForKey(leafCert.publicKey.algorithm)) return this.fail('illegal_parameter');
      if (!verifyCertificateVerify(leafCert.publicKey, preVerify, certificateVerify!.signatureAlgorithm, certificateVerify!.signature)) return this.fail('decrypt_error');
      this.transcript.push(rawOf(certificateVerify!));

    } else {
      this.transcript.push(rawOf(encryptedExtensions));
      const earlier = this.config.resumptionTicket?.peerCertificates;
      if (earlier !== undefined && earlier.length > 0) {
        this.peerCertificate = earlier[0];
        this.peerCertificateChain = earlier;
        this.peerVerified = true;
      }
    }

    const preFinished = transcriptHash(this.transcript, this.hash);
    const expectedServerFinished = computeFinished(handshakePhase.serverHandshakeTrafficSecret, preFinished, this.hash);
    if (serverFinished.verifyData !== expectedServerFinished) return this.fail('decrypt_error');
    this.transcript.push(rawOf(serverFinished));
    const throughServerFinished = transcriptHash(this.transcript, this.hash);
    const applicationPhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]], this.hash), serverHello: shTranscript, serverFinished: throughServerFinished, clientFinished: throughServerFinished },
      effectivePsk, dheSharedSecret, this.hash,
    );
    this.clientApplicationTrafficSecret = applicationPhase.clientApplicationTrafficSecret;
    this.serverApplicationTrafficSecret = applicationPhase.serverApplicationTrafficSecret;

    const finalBundle: TlsHandshakeMessage[] = [];
    if (certificateRequest) {
      const clientCertificate: CertificateMessage = {
        kind: 'certificate', certificateList: this.config.clientCert ? [this.config.clientCert, ...(this.config.clientChain ?? [])] : [],
      };
      finalBundle.push(clientCertificate);
      this.transcript.push(encodeHandshakeMessage(clientCertificate));

      if (this.config.clientCert && this.config.clientPrivateKey) {
        const clientSignature = signCertificateVerify(
          this.config.clientPrivateKey, certificateVerifyContent('client', transcriptHash(this.transcript, this.hash)),
        );
        if (clientSignature === null) return this.fail('handshake_failure');
        const clientCertificateVerify: CertificateVerify = {
          kind: 'certificate_verify', signatureAlgorithm: clientSignature.scheme, signature: clientSignature.signature,
        };
        finalBundle.push(clientCertificateVerify);
        this.transcript.push(encodeHandshakeMessage(clientCertificateVerify));
      }
    }

    const clientFinished: Finished = {
      kind: 'finished',
      verifyData: computeFinished(handshakePhase.clientHandshakeTrafficSecret, transcriptHash(this.transcript, this.hash), this.hash),
    };
    finalBundle.push(clientFinished);
    this.transcript.push(encodeHandshakeMessage(clientFinished));
    this.resumptionMasterSecret = expandLabel(applicationPhase.masterSecret, 'res master', transcriptHash(this.transcript, this.hash), this.hash);

    this.state = 'done';
    this.result = 'success';
    this.emit({
      topic: 'tls.handshake.completed',
      payload: {
        sessionId: this.sessionId, role: 'client', cipherSuite: this.negotiatedCipherSuite!,
        protocolVersion: '1.3', alpnProtocol: this.negotiatedAlpnProtocol, resumed: sessionResumed,
      },
    });
    return sealFlight(handshakePhase.clientHandshakeTrafficSecret, serverHello.cipherSuite, 0, encodeMessages(finalBundle)).records;
  }

  /**
   * Decodes a post-handshake `NewSessionTicket` flight (only meaningful
   * after `result === 'success'`, once `resumptionMasterSecret` is known)
   * and stores it in `receivedTicket`, ready to configure a future
   * `TlsClientSession`'s `resumptionTicket`.
   */
  receiveSessionTicket(records: readonly TlsRecord[]): number {
    if (this.result !== 'success' || !this.resumptionMasterSecret || !this.negotiatedCipherSuite || this.ticketAttempted) return 0;
    this.ticketAttempted = true;
    const opened = openLeadingHandshake(this.serverApplicationTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, this.serverApplicationSequenceBase, records);
    if (opened === null) return 0;
    this.serverApplicationSequenceBase += opened.consumed;
    const message = decodeHandshakeMessage(opened.plaintext) as NewSessionTicket;
    if (message.kind !== 'new_session_ticket') return opened.consumed;
    if (message.ticketLifetime > MAX_TICKET_LIFETIME_SECONDS) return opened.consumed;
    this.receivedTicket = {
      ticket: message.ticket,
      resumptionMasterSecret: this.resumptionMasterSecret,
      ticketNonce: message.ticketNonce,
      ticketAgeAdd: message.ticketAgeAdd,
      ...(this.peerCertificate ? { peerCertificates: this.peerCertificateChain.length > 0 ? this.peerCertificateChain : [this.peerCertificate] } : {}),
      cipherSuite: this.negotiatedCipherSuite as CipherSuite,
      ticketLifetime: message.ticketLifetime,
      issuedAt: simulationNowMs(),
      consumed: false,
    };
    return opened.consumed;
  }

  /**
   * RFC 8446 §4.6.3 — ratchets this side's own sending secret
   * (`clientApplicationTrafficSecret`) and returns the wire flight; the peer
   * must feed it into `receiveKeyUpdate` to stay in sync. `requestUpdate`
   * asks the peer to reciprocate with its own KeyUpdate.
   */
  sendKeyUpdate(requestUpdate = false, sequence = 0): readonly TlsRecord[] {
    const records = sealKeyUpdate(this.clientApplicationTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, 0, sequence, requestUpdate);
    this.clientApplicationTrafficSecret = nextTrafficSecret(this.clientApplicationTrafficSecret!, this.hash);
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'client', direction: 'client-to-server', requestUpdate },
    });
    return records;
  }

  receiveKeyUpdate(records: readonly TlsRecord[], receiveSequence = 0, sendSequence = 0): readonly TlsRecord[] | null {
    const message = openKeyUpdate(this.serverApplicationTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, 0, receiveSequence, records);
    if (message === null) return null;
    this.ratchetReceiving();
    return message.requestUpdate ? this.sendKeyUpdate(false, sendSequence) : null;
  }

  ratchetReceiving(): void {
    this.serverApplicationTrafficSecret = nextTrafficSecret(this.serverApplicationTrafficSecret!, this.hash);
    this.serverApplicationSequenceBase = 0;
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'client', direction: 'server-to-client', requestUpdate: false },
    });
  }
}
