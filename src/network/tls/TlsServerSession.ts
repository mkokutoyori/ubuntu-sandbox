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
import { simulationNowMs } from '@/network/core/SystemClock';

import type { IEventBus } from '@/events/EventBus';
import { simulatedDigest } from '@/network/dns/dnssec/Digest';
import { generateKeyExchange, sharedSecret, isImplementedGroup } from './keyExchange';
import { PkiKeyPair, type PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import { certificateMatchesHostname, type CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { HELLO_RETRY_REQUEST_RANDOM, MAX_TLS_RECORD_LENGTH, type CipherSuite } from './types';
import type { TlsDomainEvent } from './events';
import {
  type ClientHello, type ServerHello, type HelloRetryRequest, type EncryptedExtensionsMessage,
  type CertificateRequest, type CertificateMessage, type CertificateVerify, type Finished,
  type NewSessionTicket, type KeyUpdate, type TlsHandshakeMessage,
  encodeHandshakeMessage, decodeHandshakeMessage, encodeMessages, decodeMessages, decodeMessagesRaw, randomNonce,
} from './messages';
import { sealKeyUpdate, openKeyUpdate } from './keyUpdateRecords';
import { fragmentAsRecords, reassembleRecords, splitLeadingContentType, type TlsRecord } from './recordLayer';
import { randomHex } from './legacy/LegacyHandshake';
import { deriveRecordKeys, openRecord } from './recordProtection';
import { EarlyDataReceiver, earlyTrafficSecret } from './earlyData';
import { sealFlight, openLeadingHandshake, withoutChangeCipherSpec, COMPATIBILITY_CHANGE_CIPHER_SPEC } from './handshakeProtection';
import { collapseFirstClientHello, deriveKeySchedule, computePskBinder, computeFinished, transcriptHash, nextTrafficSecret, expandLabel, certificateVerifyContent, ZERO_IKM } from './keySchedule';
import { signCertificateVerify, verifyCertificateVerify, SUPPORTED_SIGNATURE_SCHEMES, schemeForKey } from './signature13';
import { alertFromRecord, alertToRecord, certificateAlert, fatalAlert, type AlertDescription, type TlsAlert } from './alerts';
import { DEFAULT_CIPHER_SUITES, parseTls13Ciphersuites, selectCipherSuite } from './cipherSuites';
import { tls13CipherPermitted } from './legacy/securityPolicy';
import { selectAlpnProtocol } from './alpn';
import { type SessionTicket, SessionTicketStore, deriveResumptionPsk } from './sessionTickets';
import {
  PROTOCOL_VERSIONS_BY_PREFERENCE, permittedVersions, resolveLegacyPolicy, suiteUsableAt,
  type LegacySuiteDefinition, type ResolvedLegacyPolicy, type LegacyVersion, type TlsProtocolVersion,
} from './legacy/legacyCipherSuites';
import { modpGroup, type ModpGroup } from '@/crypto/dh/modp';
import { allowsMissingCertificate, continuesAfterVerificationFailure, type ClientCertPolicy } from './clientAuthPolicy';
import { LegacyServerHandshake, suiteMatchesCertificate, type LegacyRenegotiationContext } from './legacy/LegacyHandshake';
import { PROTOCOL_VERSION_WIRE } from './legacy/legacyCipherSuites';
import { legacySuiteByName } from './legacy/legacyCipherSuites';
import { offeredVersions } from './legacy/versionNegotiation';
import type { TrafficProtection } from './trafficProtection';
import { suiteInfo } from './suite13';
import type { Tls13Hash } from './hkdf';
import { resolveStaple, type OcspStapleSource } from './ocspStapling';
import { isValidMaxFragmentLength, DEFAULT_MAX_FRAGMENT } from './maxFragment';
import { LegacySessionStore, LegacyTicketCodec, DEFAULT_SESSION_TIMEOUT_SECONDS } from './legacy/legacySessions';

export interface TlsServerConfig {
  readonly serverCert: X509Certificate;
  readonly serverPrivateKey: PkiPrivateKey;
  /** RFC 8446 §4.4.2 — intermediates sent after the leaf, in issuing order. */
  readonly serverChain?: readonly X509Certificate[];
  /** RFC 6066 §3 — further credentials chosen by the client's server_name (first match wins, else `serverCert`). */
  readonly sniCredentials?: readonly TlsServerCredential[];
  /** RFC 6066 §3 — answer an unknown server_name with a fatal `unrecognized_name` instead of the default credential. */
  readonly rejectUnknownServerName?: boolean;
  /** RFC 6066 §8 — a signed OCSP response (or a provider) stapled when the client sends status_request. */
  readonly ocspStaple?: OcspStapleSource;
  /** RFC 6066 §4 — honour a client's max_fragment_length request (default false, like OpenSSL). */
  readonly acceptMaxFragmentLength?: boolean;
  /** mTLS: `strict` aborts on a missing or invalid client certificate (default), `lenient` records the outcome and continues (nginx `ssl_verify_client on`), `optional` tolerates a missing one (Apache `SSLVerifyClient optional`), `optional_no_ca` also tolerates an unverifiable issuer. */
  readonly clientCertPolicy?: ClientCertPolicy;
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
  /** Protocol versions this server accepts; RFC 8996 removes 1.0/1.1 from the default. */
  readonly protocols?: readonly TlsProtocolVersion[];
  /** TLS ≤ 1.2 suites (by IANA name) this server accepts, in its preference order. */
  readonly legacyCipherSuites?: readonly string[];
  /** OpenSSL cipher string for TLS ≤ 1.2 (`ssl/ssl_ciph.c` grammar, `@SECLEVEL=n` included). */
  readonly cipherList?: string;
  /** OpenSSL security level 0..5 (`ssl/ssl_cert.c`); default 1. */
  readonly securityLevel?: number;
  /** TLS 1.3 suites in OpenSSL's colon syntax (`SSL_CTX_set_ciphersuites`); default `TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256`. */
  readonly tls13Ciphersuites?: string;
  /** RFC 7627 — negotiate `extended_master_secret` for TLS ≤ 1.2 (default true). */
  readonly extendedMasterSecret?: boolean;
  /** RFC 5246 §7.3 — server session cache enabling session-ID resumption for TLS ≤ 1.2. */
  readonly legacySessionStore?: LegacySessionStore;
  /** RFC 5077 — 32-byte key sealing stateless session tickets for TLS ≤ 1.2. */
  readonly sessionTicketKey?: Uint8Array;
  /** Lifetime of a TLS ≤ 1.2 session in seconds (default: the store's, else 300). */
  readonly sessionTimeoutSeconds?: number;
  /** Choose among mutual TLS ≤ 1.2 suites by the server's order (default) or the client's. */
  readonly preferServerCiphers?: boolean;
  /** RFC 3526 group id offered for finite-field DHE (default 14, 2048 bits). */
  readonly dhGroupId?: number;
  /** Explicit finite-field DHE parameters (nginx `ssl_dhparam`); take precedence over `dhGroupId`. */
  readonly dhParameters?: { readonly prime: bigint; readonly generator: bigint };
  /** RFC 6066 §3 — answer a handshake that selects the default credential with a fatal `unrecognized_name` (nginx `ssl_reject_handshake`). */
  readonly rejectHandshake?: boolean;
  /** RFC 8446 §4.2.10 — accept 0-RTT data and advertise `max_early_data_size` in tickets (default true; nginx `ssl_early_data`). */
  readonly earlyData?: boolean;
  /** RFC 5746 — accept a renegotiation started by the client (default true); false answers a no_renegotiation warning. */
  readonly allowRenegotiation?: boolean;
  /** Ceiling on the plaintext this side puts in one record, below the RFC 8449 limit (nginx `ssl_buffer_size`). */
  readonly sendBufferSize?: number;
}

const MAX_PROTECTED_FRAGMENT = MAX_TLS_RECORD_LENGTH + 2048;

export interface TlsServerCredential {
  readonly cert: X509Certificate;
  readonly privateKey: PkiPrivateKey;
  readonly chain?: readonly X509Certificate[];
  /** Names this credential answers (exact or `*.label`); default: whatever its certificate matches (RFC 6125). */
  readonly hostnames?: readonly string[];
  /** Selecting this credential ends the handshake with `unrecognized_name`. */
  readonly rejectHandshake?: boolean;
  /** Predicate over the client's server_name, replacing `hostnames` when the owner has its own matching rules. */
  readonly matches?: (serverName: string) => boolean;
  /** Versions this credential's virtual host allows; replaces the port-wide list once the credential is selected (mod_ssl `protocol_set`). */
  readonly protocols?: readonly TlsProtocolVersion[];
}

interface ActiveCredential {
  readonly cert: X509Certificate;
  readonly privateKey: PkiPrivateKey;
  readonly chain: readonly X509Certificate[];
}

function serverNameMatches(pattern: string, name: string): boolean {
  const wanted = name.toLowerCase().replace(/\.$/, '');
  const candidate = pattern.toLowerCase().replace(/\.$/, '');
  if (candidate === wanted) return true;
  if (!candidate.startsWith('*.')) return false;
  const rest = wanted.split('.').slice(1).join('.');
  return wanted.includes('.') && rest === candidate.slice(2);
}

export const DEFAULT_SERVER_PROTOCOLS: readonly TlsProtocolVersion[] = ['1.3', '1.2'];

const TICKET_AGE_ALLOWANCE_MS = 10_000;

interface RedeemedPsk {
  readonly psk: string;
  readonly hash: Tls13Hash;
  readonly index: number;
  readonly identity: string;
  readonly cipherSuite: CipherSuite;
  readonly ageAcceptable: boolean;
}

function groupOf(keyShare: string): string {
  return keyShare.split(':')[0];
}

type ServerState = 'idle' | 'awaiting-second-client-hello' | 'awaiting-client-final' | 'legacy' | 'done';

export class TlsServerSession {
  result: 'accept' | 'reject' | null = null;
  /** RFC 8446 §6 alert explaining the last failure, if any. */
  lastAlert: TlsAlert | null = null;
  /** The cipher suite actually negotiated, once a ClientHello has been processed. */
  negotiatedCipherSuite: string | null = null;
  negotiatedVersion: TlsProtocolVersion | null = null;
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
  private serverApplicationSequenceBase = 0;
  private trailingRecords: readonly TlsRecord[] = [];

  takeTrailingRecords(): readonly TlsRecord[] {
    const taken = this.trailingRecords;
    this.trailingRecords = [];
    return taken;
  }
  serverHandshakeTrafficSecret: string | null = null;
  /** Stable per-connection correlator for `events.ts` payloads (§2.1.12). */
  readonly sessionId = randomNonce('tls-session');

  private state: ServerState = 'idle';
  private cipherSuitePreference: readonly CipherSuite[];
  private readonly supportedGroups: readonly string[];
  private readonly alpnProtocols: readonly string[];
  private resumptionMasterSecret: string | null = null;
  private masterSecret: string | null = null;
  private hash: Tls13Hash = 'sha256';
  private retried = false;
  private renegotiationHandshake: LegacyServerHandshake | null = null;
  private renegotiationCompleted = false;
  renegotiations = 0;
  private earlyDataAccepted = false;
  private earlyDataOffered = false;
  private endOfEarlyDataRecorded = false;
  private earlyReceiver: EarlyDataReceiver | null = null;
  private pendingEarlyRecords: readonly TlsRecord[] = [];
  private sessionResumed = false;
  private readonly transcript: Uint8Array[] = [];
  negotiatedMaxFragmentLength: number | null = null;
  peerCertificate: X509Certificate | null = null;
  peerCertificateChain: readonly X509Certificate[] = [];
  negotiatedServerName: string | null = null;
  peerVerified = false;
  peerVerificationReason: string | null = null;
  private credentials: ActiveCredential;
  private protocols: readonly TlsProtocolVersion[];
  private readonly policy: ResolvedLegacyPolicy;
  private legacy: LegacyServerHandshake | null = null;

  constructor(private readonly config: TlsServerConfig) {
    const preferred = config.cipherSuite;
    const configured = config.tls13Ciphersuites !== undefined ? parseTls13Ciphersuites(config.tls13Ciphersuites) : DEFAULT_CIPHER_SUITES;
    const permitted = configured.filter((suite) => tls13CipherPermitted(this.policyLevel(config), suiteInfo(suite).strengthBits));
    this.cipherSuitePreference = preferred
      ? [preferred, ...permitted.filter((s) => s !== preferred)]
      : permitted;
    // Symétrique du client : le serveur ne peut pas SÉLECTIONNER un
    // groupe dont il n'a pas le code, ni par key_share ni par
    // HelloRetryRequest. Sans ce filtre il en imposait un au client, et
    // la poignée de main se concluait sur un secret fabriqué.
    this.supportedGroups = (config.supportedGroups ?? ['x25519']).filter(isImplementedGroup);
    this.alpnProtocols = config.alpnProtocols ?? [];
    this.credentials = { cert: config.serverCert, privateKey: config.serverPrivateKey, chain: config.serverChain ?? [] };
    this.policy = resolveLegacyPolicy(config);
    this.protocols = permittedVersions(config.protocols ?? DEFAULT_SERVER_PROTOCOLS, this.policy.securityLevel);
  }

  restrictToQuic(): void {
    this.protocols = ['1.3'];
    this.cipherSuitePreference = ['TLS_AES_128_GCM_SHA256'];
  }

  private dhGroup(): ModpGroup {
    const explicit = this.config.dhParameters;
    if (explicit) return { id: 0, bits: explicit.prime.toString(2).length, prime: explicit.prime, generator: explicit.generator };
    return modpGroup(this.config.dhGroupId ?? 14) ?? modpGroup(14)!;
  }

  get sessionReused(): boolean {
    return this.legacy ? this.legacy.wasResumed : this.sessionResumed;
  }

  private policyLevel(config: TlsServerConfig): number {
    return resolveLegacyPolicy(config).securityLevel;
  }

  clientTraffic(): TrafficProtection {
    return this.legacy?.traffic?.inbound ?? { secret: this.clientApplicationTrafficSecret!, suite: this.negotiatedCipherSuite as CipherSuite, maxFragment: this.negotiatedMaxFragmentLength ?? DEFAULT_MAX_FRAGMENT };
  }

  serverTraffic(): TrafficProtection {
    const ceiling = this.config.sendBufferSize;
    const legacyOutbound = this.legacy?.traffic?.outbound;
    if (legacyOutbound) {
      if (ceiling !== undefined) legacyOutbound.maxFragment = Math.min(legacyOutbound.maxFragment, ceiling);
      return legacyOutbound;
    }
    const negotiated = this.negotiatedMaxFragmentLength ?? DEFAULT_MAX_FRAGMENT;
    return {
      secret: this.serverApplicationTrafficSecret!, suite: this.negotiatedCipherSuite as CipherSuite,
      maxFragment: ceiling === undefined ? negotiated : Math.min(negotiated, ceiling),
      sequenceBase: this.serverApplicationSequenceBase,
    };
  }

  /** Feeds the peer's flight in; returns this side's next flight, or null once nothing more is to be sent. */
  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const received = incoming.length > 0 ? alertFromRecord(incoming[0]) : null;
    if (received !== null) return this.receiveAlert(received);
    const before = this.lastAlert;
    const flight = incoming.some((record) => record.fragment.length > MAX_PROTECTED_FRAGMENT)
      ? this.reject('record_overflow')
      : this.process(incoming);
    if (flight === null && this.result === 'reject' && this.lastAlert !== before && this.lastAlert !== null) {
      return [alertToRecord(this.lastAlert)];
    }
    return flight;
  }

  peerAlert: TlsAlert | null = null;

  private receiveAlert(alert: TlsAlert): null {
    if (this.result !== null) return null;
    this.peerAlert = alert;
    this.lastAlert = alert;
    this.state = 'done';
    this.result = 'reject';
    this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'server', alert } });
    return null;
  }

  private process(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    try {
      if (this.state === 'idle') return this.handleFirstClientHello(incoming);
      if (this.state === 'awaiting-second-client-hello') return this.handleSecondClientHello(incoming);
      if (this.state === 'awaiting-client-final') return this.handleClientFinal(incoming);
      if (this.state === 'legacy') return this.handleLegacy(incoming);
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
    this.negotiatedServerName = clientHello.extensions.serverName || null;
    if (!this.selectCredentials(clientHello.extensions.serverName)) return this.reject('unrecognized_name');

    const offered = offeredVersions(clientHello);
    const chosen = PROTOCOL_VERSIONS_BY_PREFERENCE.find((v) => this.protocols.includes(v) && offered.includes(v));
    if (!chosen) return this.reject('protocol_version');
    if (chosen !== '1.3') return this.startLegacy(clientHello, clientHelloBytes, chosen);
    this.negotiatedVersion = '1.3';

    if (this.supportedGroups.includes(groupOf(clientHello.extensions.keyShare))) {
      const redeemed = this.resolvePsk(clientHello, clientHelloBytes);
      if (redeemed === 'binder_mismatch') return this.reject('decrypt_error');
      return this.proceedWithServerFlight(clientHello, redeemed, rest);
    }

    const mutualGroup = this.supportedGroups.find((g) => clientHello.extensions.supportedGroups.includes(g));
    if (!mutualGroup) return this.reject('handshake_failure');

    const helloRetryRequest: HelloRetryRequest = {
      kind: 'hello_retry_request', random: HELLO_RETRY_REQUEST_RANDOM, selectedGroup: mutualGroup,
      cipherSuite: this.selectCipherSuite(clientHello) ?? 'TLS_AES_128_GCM_SHA256',
      ...(clientHello.legacyExtensions?.sessionId ? { sessionIdEcho: clientHello.legacyExtensions.sessionId } : {}),
    };
    const hrrBytes = encodeHandshakeMessage(helloRetryRequest);
    this.transcript.push(hrrBytes);
    this.retried = true;
    this.state = 'awaiting-second-client-hello';
    return fragmentAsRecords('handshake', hrrBytes, false);
  }

  private negotiateMaxFragment(clientHello: ClientHello): void {
    const requested = clientHello.extensions.maxFragmentLength;
    if (this.config.acceptMaxFragmentLength === true && isValidMaxFragmentLength(requested)) {
      this.negotiatedMaxFragmentLength = requested;
    }
  }

  private selectCredentials(serverName: string | undefined): boolean {
    if (serverName === undefined || serverName === '') return this.config.rejectHandshake !== true;
    for (const credential of this.config.sniCredentials ?? []) {
      const names = credential.hostnames;
      const matches = credential.matches !== undefined
        ? credential.matches(serverName)
        : names !== undefined
        ? names.some((pattern) => serverNameMatches(pattern, serverName))
        : certificateMatchesHostname(credential.cert, serverName);
      if (matches) {
        this.credentials = { cert: credential.cert, privateKey: credential.privateKey, chain: credential.chain ?? [] };
        if (credential.protocols) this.protocols = permittedVersions(credential.protocols, this.policy.securityLevel);
        return credential.rejectHandshake !== true;
      }
    }
    if (this.config.rejectHandshake === true) return false;
    return this.config.rejectUnknownServerName !== true || (this.config.sniCredentials ?? []).length === 0
      ? true
      : certificateMatchesHostname(this.config.serverCert, serverName);
  }

  private alpnRefused(clientHello: ClientHello): boolean {
    const offered = clientHello.extensions.alpn;
    return this.alpnProtocols.length > 0 && offered !== undefined && offered.length > 0
      && this.negotiatedAlpnProtocol === null;
  }

  private startLegacy(
    clientHello: ClientHello, clientHelloBytes: Uint8Array, version: LegacyVersion,
    renegotiation?: LegacyRenegotiationContext,
  ): readonly TlsRecord[] | null {
    if (!/^[0-9a-f]{64}$/i.test(clientHello.random)) return this.reject('decode_error');
    const offeredSuites = clientHello.legacyCipherSuites ?? [];
    const usable = (definition: LegacySuiteDefinition | undefined): boolean =>
      definition !== undefined && this.policy.suites.includes(definition) && offeredSuites.includes(definition.code) && suiteUsableAt(definition, version)
      && suiteMatchesCertificate(this.credentials.cert, definition);
    const serverOrder = this.policy.suites;
    const suite = this.config.preferServerCiphers === false
      ? offeredSuites.map((code) => serverOrder.find((definition) => definition.code === code)).find(
        (definition): definition is LegacySuiteDefinition => definition !== undefined && usable(definition),
      )
      : serverOrder.find(usable);
    if (!suite) return this.reject('handshake_failure');
    this.negotiatedVersion = version;
    this.negotiatedCipherSuite = suite.name;
    this.negotiatedAlpnProtocol = selectAlpnProtocol(clientHello.extensions.alpn, this.alpnProtocols);
    if (this.alpnRefused(clientHello)) return this.reject('no_application_protocol');
    this.negotiateMaxFragment(clientHello);
    const clientVersionWire = clientHello.legacyVersion === '1.0' ? 0x0301 : clientHello.legacyVersion === '1.1' ? 0x0302 : 0x0303;
    const extensions = clientHello.legacyExtensions ?? { sessionId: '', extendedMasterSecret: false, renegotiationInfo: null, sessionTicket: null };
    const handshake = new LegacyServerHandshake({
      ...(renegotiation ? { renegotiation } : {}),
      clientExtensions: extensions,
      clientSignatureAlgorithms: clientHello.extensions.signatureAlgorithms,
      statusStaple: clientHello.extensions.statusRequest ? resolveStaple(this.config.ocspStaple, this.credentials.cert) ?? null : null,
      maxFragmentLength: this.negotiatedMaxFragmentLength,
      extendedMasterSecret: this.config.extendedMasterSecret !== false,
      sessionStore: this.config.legacySessionStore,
      ticketCodec: this.config.sessionTicketKey ? new LegacyTicketCodec(this.config.sessionTicketKey) : undefined,
      sessionLifetimeSeconds: this.config.sessionTimeoutSeconds ?? this.config.legacySessionStore?.timeoutSeconds ?? DEFAULT_SESSION_TIMEOUT_SECONDS,
      acceptResumedSuite: (name) => usable(legacySuiteByName(name)),
      resolveSuite: legacySuiteByName,
      now: simulationNowMs,
      version, suite, clientHelloBytes, clientRandom: clientHello.random, clientVersionWire,
      offeredGroups: clientHello.extensions.supportedGroups, alpn: this.negotiatedAlpnProtocol,
      serverSupportsTls13: this.protocols.includes('1.3'),
      serverCert: this.credentials.cert, serverChain: this.credentials.chain, serverPrivateKey: this.credentials.privateKey,
      serverGroups: this.supportedGroups, securityLevel: this.policy.securityLevel, dhGroup: this.dhGroup(),
      requestClientCert: this.config.requestClientCert === true, verifier: this.config.verifier,
      clientCertPolicy: this.config.clientCertPolicy,
    });
    if (renegotiation) {
      this.renegotiationHandshake = handshake;
      const answer = handshake.start();
      this.negotiatedCipherSuite = handshake.negotiatedSuite.name;
      return this.settleRenegotiation(handshake, answer);
    }
    this.legacy = handshake;
    const flight = this.legacy.start();
    this.negotiatedCipherSuite = this.legacy.negotiatedSuite.name;
    this.state = 'legacy';
    this.syncLegacy();
    return flight;
  }

  get renegotiating(): boolean {
    return this.renegotiationHandshake !== null;
  }

  takeRenegotiationCompleted(): boolean {
    const completed = this.renegotiationCompleted;
    this.renegotiationCompleted = false;
    return completed;
  }

  private settleRenegotiation(handshake: LegacyServerHandshake, flight: readonly TlsRecord[] | null): readonly TlsRecord[] | null {
    if (handshake.result === 'accept') {
      this.legacy = handshake;
      this.renegotiationHandshake = null;
      this.renegotiationCompleted = true;
      this.renegotiations++;
      this.peerCertificate = handshake.peerCertificate;
      this.peerCertificateChain = handshake.peerCertificateChain;
      this.peerVerified = handshake.peerVerified;
      this.peerVerificationReason = handshake.peerVerificationReason;
    } else if (handshake.result === 'reject') {
      this.renegotiationHandshake = null;
      this.result = 'reject';
      this.state = 'done';
      this.lastAlert = handshake.lastAlert;
    }
    return flight;
  }

  requestRenegotiation(sendSequence: number): readonly TlsRecord[] | null {
    const current = this.legacy;
    if (current === null || current.traffic === null || this.result !== 'accept' || this.renegotiationHandshake !== null) return null;
    const request: TlsRecord = {
      contentType: 'handshake', legacyVersion: PROTOCOL_VERSION_WIRE[current.negotiatedVersion],
      fragment: Uint8Array.of(0, 0, 0, 0),
    };
    return [current.traffic.outbound.seal(sendSequence, request)];
  }

  handleRenegotiation(
    records: readonly TlsRecord[], receiveSequence: number, sendSequence: number,
  ): readonly TlsRecord[] | null {
    if (this.renegotiationHandshake !== null) {
      const handshake = this.renegotiationHandshake;
      return this.settleRenegotiation(handshake, handshake.handle(records));
    }
    const current = this.legacy;
    if (current === null || current.traffic === null || this.result !== 'accept') return null;
    const leading = splitLeadingContentType(records, 'handshake').leading;
    if (leading.length === 0) return null;
    if (this.config.allowRenegotiation === false) {
      const warning = alertToRecord({ level: 'warning', description: 'no_renegotiation' });
      return [current.traffic.outbound.seal(sendSequence, warning)];
    }
    const opened: TlsRecord[] = [];
    for (const [index, record] of leading.entries()) {
      const plain = current.traffic.inbound.open(receiveSequence + index, record);
      if (plain === null) return this.reject('bad_record_mac');
      opened.push(plain);
    }
    const helloBytes = opened.reduce((joined, record) => {
      const out = new Uint8Array(joined.length + record.fragment.length);
      out.set(joined); out.set(record.fragment, joined.length);
      return out;
    }, new Uint8Array(0));
    let hello: ClientHello;
    try {
      hello = decodeHandshakeMessage(helloBytes) as ClientHello;
    } catch {
      return this.reject('decode_error');
    }
    if (hello.kind !== 'client_hello') return this.reject('unexpected_message');
    if (!this.selectCredentials(hello.extensions.serverName)) return this.reject('unrecognized_name');
    return this.startLegacy(hello, helloBytes, current.negotiatedVersion, {
      inbound: current.traffic.inbound, outbound: current.traffic.outbound,
      inboundSequence: receiveSequence + leading.length, outboundSequence: sendSequence,
      clientVerifyData: current.clientVerifyData, serverVerifyData: current.serverVerifyData,
    });
  }

  private handleLegacy(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const flight = this.legacy!.handle(incoming);
    this.syncLegacy();
    return flight;
  }

  private syncLegacy(): void {
    const legacy = this.legacy!;
    if (legacy.result === null || this.result !== null) return;
    this.result = legacy.result;
    this.state = 'done';
    this.peerCertificate = legacy.peerCertificate;
    this.peerCertificateChain = legacy.peerCertificateChain;
    this.peerVerified = legacy.peerVerified;
    this.peerVerificationReason = legacy.peerVerificationReason;
    if (legacy.result === 'reject') {
      this.lastAlert = legacy.lastAlert;
      this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert! } });
      this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert! } });
      return;
    }
    this.emit({
      topic: 'tls.handshake.completed',
      payload: {
        sessionId: this.sessionId, role: 'server', cipherSuite: this.negotiatedCipherSuite!,
        protocolVersion: this.negotiatedVersion!, alpnProtocol: this.negotiatedAlpnProtocol, resumed: legacy.wasResumed,
      },
    });
  }

  /** Redeems the client's PSK ticket, if offered and valid; null if not offered, unknown, or expired. */
  private resolvePsk(
    clientHello: ClientHello, clientHelloBytes: Uint8Array, prefix: readonly Uint8Array[] = [],
  ): RedeemedPsk | 'binder_mismatch' | null {
    const store = this.config.sessionTicketStore;
    const offers = clientHello.extensions.pskOffers
      ?? (clientHello.extensions.preSharedKey ? [{ identity: clientHello.extensions.preSharedKey, obfuscatedAge: 0, binder: '' }] : []);
    if (offers.length === 0 || !store) return null;
    if (!(clientHello.extensions.pskKeyExchangeModes ?? []).includes('psk_dhe_ke')) return null;
    const bindersLength = 2 + offers.reduce((total, offer) => total + 1 + offer.binder.length / 2, 0);
    const partial = clientHelloBytes.subarray(0, clientHelloBytes.length - bindersLength);
    const now = simulationNowMs();
    for (const [index, offer] of offers.entries()) {
      const candidate = store.peek(offer.identity, now);
      if (!candidate) continue;
      const hash = suiteInfo(candidate.cipherSuite).hash;
      const psk = deriveResumptionPsk(candidate);
      if (offer.binder !== computePskBinder(psk, transcriptHash([...prefix, partial], hash), hash)) return 'binder_mismatch';
      const ticket = store.redeem(offer.identity, now);
      if (!ticket) continue;
      const clientAge = ((offer.obfuscatedAge - Number.parseInt(candidate.ticketAgeAdd ?? '0', 16)) >>> 0);
      const ageAcceptable = Math.abs(clientAge - Math.max(0, now - candidate.issuedAt)) <= TICKET_AGE_ALLOWANCE_MS;
      return { psk, hash, index, identity: offer.identity, cipherSuite: candidate.cipherSuite, ageAcceptable };
    }
    return null;
  }

  private handleSecondClientHello(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { contentType, plaintext: clientHelloBytes } = reassembleRecords(withoutChangeCipherSpec(incoming), false);
    if (contentType !== 'handshake') return this.reject('decode_error');
    const clientHello = decodeHandshakeMessage(clientHelloBytes) as ClientHello;
    if (!this.supportedGroups.includes(groupOf(clientHello.extensions.keyShare))) return this.reject('handshake_failure');
    const bindingPrefix = [...this.transcript];
    const retriedHash = suiteInfo(this.selectCipherSuite(clientHello) ?? 'TLS_AES_128_GCM_SHA256').hash;
    collapseFirstClientHello(bindingPrefix, retriedHash);
    const redeemed = this.resolvePsk(clientHello, clientHelloBytes, bindingPrefix);
    if (redeemed === 'binder_mismatch') return this.reject('decrypt_error');
    this.transcript.push(clientHelloBytes);
    return this.proceedWithServerFlight(clientHello, redeemed, []);
  }

  private selectCipherSuite(clientHello: ClientHello): CipherSuite | null {
    return this.config.preferServerCiphers === false
      ? clientHello.cipherSuites.find((suite) => this.cipherSuitePreference.includes(suite)) ?? null
      : selectCipherSuite(clientHello.cipherSuites, this.cipherSuitePreference);
  }

  private proceedWithServerFlight(
    clientHello: ClientHello, redeemed: RedeemedPsk | null, earlyRecords: readonly TlsRecord[],
  ): readonly TlsRecord[] | null {
    const negotiatedSuite = this.selectCipherSuite(clientHello);
    if (!negotiatedSuite) return this.reject('handshake_failure');
    this.negotiatedCipherSuite = negotiatedSuite;
    this.hash = suiteInfo(negotiatedSuite).hash;
    if (this.retried) collapseFirstClientHello(this.transcript, this.hash);
    this.negotiateMaxFragment(clientHello);
    const pskAccepted = redeemed !== null && redeemed.hash === this.hash;
    const pskInput = pskAccepted ? redeemed.psk : ZERO_IKM;
    this.earlyDataOffered = clientHello.extensions.earlyData === true;
    if (pskAccepted && this.earlyDataOffered && !this.retried && this.config.earlyData !== false
      && redeemed!.cipherSuite === negotiatedSuite && redeemed!.ageAcceptable) {
      this.earlyDataAccepted = true;
      this.earlyReceiver = new EarlyDataReceiver(
        earlyTrafficSecret(pskInput, transcriptHash([this.transcript[0]], this.hash), this.hash), negotiatedSuite,
      );
      this.pendingEarlyRecords = this.earlyReceiver.feed(withoutChangeCipherSpec(earlyRecords));
      this.receivedEarlyData = this.earlyReceiver.plaintext;
    }
    this.negotiatedAlpnProtocol = selectAlpnProtocol(clientHello.extensions.alpn, this.alpnProtocols);
    if (this.alpnRefused(clientHello)) return this.reject('no_application_protocol');

    const serverRandom = randomHex(32);
    // La part du serveur porte désormais son groupe, comme celle du
    // client : sans ce préfixe le client ne saurait pas quelle courbe
    // interpréter, et le §4.2.8 en fait de toute façon un `NamedGroup`.
    const echange = generateKeyExchange(groupOf(clientHello.extensions.keyShare));
    const serverKeyShare = echange.share;
    const serverHello: ServerHello = {
      kind: 'server_hello', random: serverRandom, cipherSuite: negotiatedSuite,
      ...(clientHello.legacyExtensions?.sessionId ? { sessionIdEcho: clientHello.legacyExtensions.sessionId } : {}),
      extensions: {
        supportedVersions: '1.3', keyShare: serverKeyShare,
        preSharedKey: pskAccepted ? 'accepted' : undefined,
        ...(pskAccepted ? { pskSelectedIdentity: redeemed.index } : {}),
      },
    };
    const serverHelloBytes = encodeHandshakeMessage(serverHello);
    this.transcript.push(serverHelloBytes);

    const dheSharedSecret = sharedSecret(echange, clientHello.extensions.keyShare);
    if (dheSharedSecret === null) return this.reject('illegal_parameter');
    // Simplification: application/resumption secrets are derived from the
    // CH+SH transcript checkpoint rather than the true through-Finished
    // one — per-session uniqueness already comes from dheSharedSecret/
    // pskInput (both random-nonce-derived), and neither is ever used to
    // decrypt anything for real at this fidelity level (§2.1's convention).
    const shTranscript = transcriptHash(this.transcript, this.hash);
    const handshakePhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]], this.hash), serverHello: shTranscript, serverFinished: shTranscript, clientFinished: shTranscript },
      pskInput, dheSharedSecret, this.hash,
    );
    this.clientHandshakeTrafficSecret = handshakePhase.clientHandshakeTrafficSecret;
    this.serverHandshakeTrafficSecret = handshakePhase.serverHandshakeTrafficSecret;
    if (pskAccepted) {
      this.sessionResumed = true;
      this.emit({
        topic: 'tls.session.resumed',
        payload: { sessionId: this.sessionId, role: 'server', ticket: redeemed!.identity },
      });
    }

    const bundle: TlsHandshakeMessage[] = [];
    const encryptedExtensions: EncryptedExtensionsMessage = {
      kind: 'encrypted_extensions',
      extensions: {
        alpn: this.negotiatedAlpnProtocol ?? undefined, earlyData: this.earlyDataAccepted || undefined,
        ...(this.negotiatedMaxFragmentLength !== null ? { maxFragmentLength: this.negotiatedMaxFragmentLength } : {}),
      },
    };
    bundle.push(encryptedExtensions);
    this.transcript.push(encodeHandshakeMessage(encryptedExtensions));

    if (this.config.requestClientCert && !this.sessionResumed) {
      const certificateRequest: CertificateRequest = {
        kind: 'certificate_request', certificateRequestContext: '', signatureAlgorithms: SUPPORTED_SIGNATURE_SCHEMES,
      };
      bundle.push(certificateRequest);
      this.transcript.push(encodeHandshakeMessage(certificateRequest));
    }

    if (!this.sessionResumed) {
      const staple = clientHello.extensions.statusRequest ? resolveStaple(this.config.ocspStaple, this.credentials.cert) : undefined;
      const certificate: CertificateMessage = {
        kind: 'certificate', certificateList: [this.credentials.cert, ...this.credentials.chain],
        ...(staple ? { ocspStaple: staple } : {}),
      };
      bundle.push(certificate);
      this.transcript.push(encodeHandshakeMessage(certificate));

      const serverSignature = signCertificateVerify(
        this.credentials.privateKey, certificateVerifyContent('server', transcriptHash(this.transcript, this.hash)),
      );
      if (serverSignature === null || !clientHello.extensions.signatureAlgorithms.includes(serverSignature.scheme)) {
        return this.reject('handshake_failure');
      }
      const certificateVerify: CertificateVerify = {
        kind: 'certificate_verify', signatureAlgorithm: serverSignature.scheme, signature: serverSignature.signature,
      };
      bundle.push(certificateVerify);
      this.transcript.push(encodeHandshakeMessage(certificateVerify));

    }

    const finished: Finished = {
      kind: 'finished',
      verifyData: computeFinished(handshakePhase.serverHandshakeTrafficSecret, transcriptHash(this.transcript, this.hash), this.hash),
    };
    bundle.push(finished);
    this.transcript.push(encodeHandshakeMessage(finished));

    const throughServerFinished = transcriptHash(this.transcript, this.hash);
    const applicationPhase = deriveKeySchedule(
      { clientHello: transcriptHash([this.transcript[0]], this.hash), serverHello: shTranscript, serverFinished: throughServerFinished, clientFinished: throughServerFinished },
      pskInput, dheSharedSecret, this.hash,
    );
    this.masterSecret = applicationPhase.masterSecret;
    this.clientApplicationTrafficSecret = applicationPhase.clientApplicationTrafficSecret;
    this.serverApplicationTrafficSecret = applicationPhase.serverApplicationTrafficSecret;

    this.state = 'awaiting-client-final';
    const sealed = sealFlight(handshakePhase.serverHandshakeTrafficSecret, negotiatedSuite, 0, encodeMessages(bundle));
    return [
      ...fragmentAsRecords('handshake', serverHelloBytes, false),
      ...(clientHello.legacyExtensions?.sessionId ? [COMPATIBILITY_CHANGE_CIPHER_SPEC] : []),
      ...sealed.records,
    ];
  }

  private handleClientFinal(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    let protectedRecords: readonly TlsRecord[] = [...this.pendingEarlyRecords, ...withoutChangeCipherSpec(incoming)];
    this.pendingEarlyRecords = [];
    if (this.earlyReceiver !== null && !this.earlyReceiver.finished) {
      protectedRecords = this.earlyReceiver.feed(protectedRecords);
      this.receivedEarlyData = this.earlyReceiver.plaintext;
      if (!this.earlyReceiver.finished && protectedRecords.length === 0) return null;
    }
    if (this.earlyReceiver?.endOfEarlyDataRaw && !this.endOfEarlyDataRecorded) {
      this.transcript.push(this.earlyReceiver.endOfEarlyDataRaw);
      this.endOfEarlyDataRecorded = true;
    }
    if (this.earlyDataOffered && !this.earlyDataAccepted) {
      const probe = deriveRecordKeys(this.clientHandshakeTrafficSecret!, this.negotiatedCipherSuite as CipherSuite);
      while (protectedRecords.length > 0 && openRecord(probe, 0, protectedRecords[0]) === null) protectedRecords = protectedRecords.slice(1);
      if (protectedRecords.length === 0) return null;
    }
    const opened = openLeadingHandshake(this.clientHandshakeTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, 0, protectedRecords);
    if (opened === null) return this.reject('bad_record_mac');
    this.trailingRecords = protectedRecords.slice(opened.consumed);
    const received = decodeMessagesRaw(opened.plaintext);
    const messages = received.map((entry) => entry.message);
    const rawOf = (message: TlsHandshakeMessage): Uint8Array => received.find((entry) => entry.message === message)!.raw;

    if (this.config.requestClientCert) {
      const certificate = messages.find((m): m is CertificateMessage => m.kind === 'certificate');
      const certificateVerify = messages.find((m): m is CertificateVerify => m.kind === 'certificate_verify');
      const policy = this.config.clientCertPolicy;
      if (!certificate) return this.reject('unexpected_message');
      this.transcript.push(rawOf(certificate));
      if (certificate.certificateList.length === 0 || !certificateVerify) {
        if (!allowsMissingCertificate(policy)) return this.reject('certificate_required');
        this.peerVerificationReason = 'no-certificate';
      } else {
        const leafCert = certificate.certificateList[0];
        this.peerCertificate = leafCert;
        this.peerCertificateChain = certificate.certificateList;
        if (!this.config.verifier) return this.reject('certificate_unknown');
        const verification = this.config.verifier.verify(leafCert, undefined, certificate.certificateList.slice(1), 'clientAuth', this.policy.securityLevel);
        this.peerVerified = verification.ok !== false;
        if (verification.ok === false) {
          this.peerVerificationReason = verification.reason;
          if (!continuesAfterVerificationFailure(policy, verification.reason)) {
            this.lastAlert = certificateAlert(verification.reason);
            this.state = 'done';
            this.result = 'reject';
            this.emit({ topic: 'tls.handshake.failed', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert } });
            this.emit({ topic: 'tls.alert.sent', payload: { sessionId: this.sessionId, role: 'server', alert: this.lastAlert } });
            return null;
          }
        }
        const preVerify = certificateVerifyContent('client', transcriptHash(this.transcript, this.hash));
        if (certificateVerify.signatureAlgorithm !== schemeForKey(leafCert.publicKey.algorithm)) return this.reject('illegal_parameter');
        if (!verifyCertificateVerify(leafCert.publicKey, preVerify, certificateVerify.signatureAlgorithm, certificateVerify.signature)) return this.reject('decrypt_error');
        this.transcript.push(rawOf(certificateVerify));
      }
    }

    const finished = messages.find((m): m is Finished => m.kind === 'finished');
    if (!finished) return this.reject('unexpected_message');
    const expected = computeFinished(this.clientHandshakeTrafficSecret!, transcriptHash(this.transcript, this.hash), this.hash);
    if (finished.verifyData !== expected) return this.reject('decrypt_error');
    this.transcript.push(rawOf(finished));
    this.resumptionMasterSecret = expandLabel(this.masterSecret!, 'res master', transcriptHash(this.transcript, this.hash), this.hash);
    this.state = 'done';
    this.result = 'accept';
    this.emit({
      topic: 'tls.handshake.completed',
      payload: {
        sessionId: this.sessionId, role: 'server', cipherSuite: this.negotiatedCipherSuite!,
        protocolVersion: '1.3', alpnProtocol: this.negotiatedAlpnProtocol, resumed: this.sessionResumed,
      },
    });

    if (!this.config.sessionTicketStore) return null;
    const ticketAgeAdd = randomHex(4);
    const ticket: SessionTicket = {
      ticket: randomHex(16),
      resumptionMasterSecret: this.resumptionMasterSecret!,
      ticketNonce: randomHex(8),
      ticketAgeAdd,
      cipherSuite: this.negotiatedCipherSuite as CipherSuite,
      ticketLifetime: 7200,
      issuedAt: simulationNowMs(),
      consumed: false,
    };
    this.config.sessionTicketStore.issue(ticket);
    const newSessionTicket: NewSessionTicket = {
      kind: 'new_session_ticket', ticketLifetime: ticket.ticketLifetime, ticketAgeAdd,
      ticketNonce: ticket.ticketNonce, ticket: ticket.ticket, extensions: { earlyData: this.config.earlyData !== false },
    };
    const sealedTicket = sealFlight(this.serverApplicationTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, 0, encodeHandshakeMessage(newSessionTicket));
    this.serverApplicationSequenceBase = sealedTicket.nextSeq;
    return sealedTicket.records;
  }

  /**
   * RFC 8446 §4.6.3 — ratchets this side's own sending secret
   * (`serverApplicationTrafficSecret`) and returns the wire flight; the peer
   * must feed it into `receiveKeyUpdate` to stay in sync. `requestUpdate`
   * asks the peer to reciprocate with its own KeyUpdate.
   */
  sendKeyUpdate(requestUpdate = false, sequence = 0): readonly TlsRecord[] {
    const records = sealKeyUpdate(this.serverApplicationTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, this.serverApplicationSequenceBase, sequence, requestUpdate);
    this.serverApplicationTrafficSecret = nextTrafficSecret(this.serverApplicationTrafficSecret!, this.hash);
    this.serverApplicationSequenceBase = 0;
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'server', direction: 'server-to-client', requestUpdate },
    });
    return records;
  }

  receiveKeyUpdate(records: readonly TlsRecord[], receiveSequence = 0, sendSequence = 0): readonly TlsRecord[] | null {
    const message = openKeyUpdate(this.clientApplicationTrafficSecret!, this.negotiatedCipherSuite as CipherSuite, 0, receiveSequence, records);
    if (message === null) return null;
    this.ratchetReceiving();
    return message.requestUpdate ? this.sendKeyUpdate(false, sendSequence) : null;
  }

  applyPeerKeyUpdates(count: number, replyRequested: boolean, sendSequence: number): readonly TlsRecord[] {
    for (let index = 0; index < count; index++) this.ratchetReceiving();
    return replyRequested ? this.sendKeyUpdate(false, sendSequence) : [];
  }

  ratchetReceiving(): void {
    this.clientApplicationTrafficSecret = nextTrafficSecret(this.clientApplicationTrafficSecret!, this.hash);
    this.emit({
      topic: 'tls.key_update',
      payload: { sessionId: this.sessionId, role: 'server', direction: 'client-to-server', requestUpdate: false },
    });
  }
}
