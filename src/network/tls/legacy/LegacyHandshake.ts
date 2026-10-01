import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import {
  materialToPrivateKey, materialToPublicKey, rsaDecryptPkcs1, rsaEncryptPkcs1,
} from '@/crypto/rsa';
import {
  generateModpKeyPair, modpGroup, modpSharedSecret, modpToHex, modpFromHex,
} from '@/crypto/dh/modp';
import type { PkiPrivateKey } from '@/network/pki/PkiKeyPair';
import type { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { certificateAlert, fatalAlert, type AlertDescription, type TlsAlert } from '../alerts';
import { generateKeyExchange, sharedSecret, isImplementedGroup, type KeyExchangeKeyPair } from '../keyExchange';
import { fragmentPlaintext, splitLeadingContentType, type TlsRecord } from '../recordLayer';
import {
  PROTOCOL_VERSION_WIRE, isForwardSecret, type LegacySuiteDefinition, type LegacyVersion,
} from './legacyCipherSuites';
import {
  LegacyRecordProtection, deriveKeyBlock, finishedVerifyData, masterSecret, extendedMasterSecret, handshakeHash,
} from './legacyCrypto';
import {
  decodeLegacyMessages, encodeLegacyBundle, encodeLegacyMessage,
  type ClientKeyExchange, type KeyExchangeParams, type LegacyCertificate, type LegacyCertificateRequest,
  type LegacyCertificateVerify, type LegacyFinished, type LegacyServerHello, type ServerHelloDone,
  type ServerKeyExchange, type LegacyNewSessionTicket, type LegacyCertificateStatus,
} from './legacyMessages';
import type { LegacyClientExtensions } from '../messages';
import type { SignedOcspResponse } from '@/network/pki/OcspResponder';
import { stapleAlert } from '../ocspStapling';
import {
  LegacySessionStore, LegacyTicketCodec, type LegacySessionState, type ResumableLegacySession,
} from './legacySessions';
import { dhPermitted } from './securityPolicy';
import { signLegacy, signatureAlgorithmName, verifyLegacy } from './legacySignature';

const RANDOM_BYTES = 32;
const DOWNGRADE_TAIL_TLS12 = '444f574e47524401';
const DOWNGRADE_TAIL_TLS11_OR_LOWER = '444f574e47524400';
const PRE_MASTER_LENGTH = 48;

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToHex(bytes);
}

export function newHelloRandom(): string {
  return randomHex(RANDOM_BYTES);
}

export function downgradeSentinel(random: string): 'tls12' | 'tls11-or-lower' | null {
  const tail = random.slice(-16).toLowerCase();
  if (tail === DOWNGRADE_TAIL_TLS12) return 'tls12';
  if (tail === DOWNGRADE_TAIL_TLS11_OR_LOWER) return 'tls11-or-lower';
  return null;
}

function isHelloRandom(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function handshakeRecords(version: LegacyVersion, bytes: Uint8Array): TlsRecord[] {
  return fragmentPlaintext('handshake', bytes).map((record) => ({
    ...record, legacyVersion: PROTOCOL_VERSION_WIRE[version],
  }));
}

function changeCipherSpec(version: LegacyVersion): TlsRecord {
  return { contentType: 'change_cipher_spec', legacyVersion: PROTOCOL_VERSION_WIRE[version], fragment: Uint8Array.of(1) };
}

function isChangeCipherSpec(record: TlsRecord | undefined): boolean {
  return record !== undefined && record.contentType === 'change_cipher_spec'
    && record.fragment.length === 1 && record.fragment[0] === 1;
}

function reassembleHandshake(records: readonly TlsRecord[]): Uint8Array | null {
  if (records.length === 0) return null;
  return concat(...records.map((record) => record.fragment));
}

function parametersBytes(params: KeyExchangeParams): Uint8Array {
  return utf8ToBytes(JSON.stringify(params));
}

function keyExchangeSignedData(clientRandom: string, serverRandom: string, params: KeyExchangeParams): Uint8Array {
  return concat(hexToBytes(clientRandom), hexToBytes(serverRandom), parametersBytes(params));
}

export interface LegacyTraffic {
  readonly outbound: LegacyRecordProtection;
  readonly inbound: LegacyRecordProtection;
}

interface DerivedKeys {
  readonly master: Uint8Array;
  readonly clientWrite: () => LegacyRecordProtection;
  readonly serverWrite: () => LegacyRecordProtection;
}

function deriveProtections(
  version: LegacyVersion, suite: LegacySuiteDefinition, preMaster: Uint8Array,
  clientRandom: string, serverRandom: string, sessionHash: Uint8Array | null = null,
): DerivedKeys {
  const master = sessionHash !== null
    ? extendedMasterSecret(version, suite.prf, preMaster, sessionHash)
    : masterSecret(version, suite.prf, preMaster, hexToBytes(clientRandom), hexToBytes(serverRandom));
  return protectionsFromMaster(version, suite, master, clientRandom, serverRandom);
}

function protectionsFromMaster(
  version: LegacyVersion, suite: LegacySuiteDefinition, master: Uint8Array,
  clientRandom: string, serverRandom: string,
): DerivedKeys {
  const block = deriveKeyBlock(version, suite, master, hexToBytes(clientRandom), hexToBytes(serverRandom));
  return {
    master,
    clientWrite: () => new LegacyRecordProtection(version, suite, block.client),
    serverWrite: () => new LegacyRecordProtection(version, suite, block.server),
  };
}

function certificateSupportsSuite(certificate: X509Certificate, suite: LegacySuiteDefinition): boolean {
  const algorithm = certificate.publicKey.algorithm;
  return suite.keyExchange === 'ECDHE_ECDSA' ? algorithm === 'ecdsa' : algorithm === 'rsa';
}

export function suiteMatchesCertificate(certificate: X509Certificate, suite: LegacySuiteDefinition): boolean {
  return certificateSupportsSuite(certificate, suite);
}

export interface LegacyServerSetup {
  readonly version: LegacyVersion;
  readonly suite: LegacySuiteDefinition;
  readonly clientHelloBytes: Uint8Array;
  readonly clientRandom: string;
  readonly clientVersionWire: number;
  readonly offeredGroups: readonly string[];
  readonly alpn: string | null;
  readonly serverSupportsTls13: boolean;
  readonly serverCert: X509Certificate;
  readonly serverChain: readonly X509Certificate[];
  readonly serverPrivateKey: PkiPrivateKey;
  readonly serverGroups: readonly string[];
  readonly dhGroupId: number;
  readonly requestClientCert: boolean;
  readonly verifier?: CertificateVerifier;
  readonly securityLevel: number;
  readonly clientExtensions: LegacyClientExtensions;
  readonly extendedMasterSecret: boolean;
  readonly sessionStore?: LegacySessionStore;
  readonly ticketCodec?: LegacyTicketCodec;
  readonly sessionLifetimeSeconds: number;
  readonly statusStaple: SignedOcspResponse | null;
  readonly maxFragmentLength: number | null;
  readonly acceptResumedSuite: (name: string) => boolean;
  readonly resolveSuite: (name: string) => LegacySuiteDefinition | undefined;
  readonly now: () => number;
}

type ServerLegacyState = 'awaiting-client-flight' | 'awaiting-resumed-finished' | 'done';

export class LegacyServerHandshake {
  result: 'accept' | 'reject' | null = null;
  lastAlert: TlsAlert | null = null;
  peerCertificate: X509Certificate | null = null;
  traffic: LegacyTraffic | null = null;

  private state: ServerLegacyState = 'awaiting-client-flight';
  private readonly messages: Uint8Array[] = [];
  private readonly serverRandom: string;
  private suite: LegacySuiteDefinition;
  private sessionId = '';
  private resumedMaster: Uint8Array | null = null;
  private resumed = false;
  private ems = false;
  private issueTicket = false;
  private ecdhe: KeyExchangeKeyPair | null = null;
  private dh: ReturnType<typeof generateModpKeyPair> | null = null;

  constructor(private readonly setup: LegacyServerSetup) {
    this.suite = setup.suite;
    this.messages.push(setup.clientHelloBytes);
    const tail = !setup.serverSupportsTls13
      ? randomHex(8)
      : setup.version === '1.2' ? DOWNGRADE_TAIL_TLS12 : DOWNGRADE_TAIL_TLS11_OR_LOWER;
    this.serverRandom = randomHex(RANDOM_BYTES - 8) + tail;
  }

  get negotiatedVersion(): LegacyVersion { return this.setup.version; }

  get negotiatedSuite(): LegacySuiteDefinition { return this.suite; }

  get wasResumed(): boolean { return this.resumed; }

  private helloExtensions(): LegacyServerHello['extensions'] {
    const client = this.setup.clientExtensions;
    return {
      alpn: this.setup.alpn ?? undefined,
      ...(this.ems ? { extendedMasterSecret: true } : {}),
      ...(client.renegotiationInfo !== null ? { renegotiationInfo: '' } : {}),
      ...(this.issueTicket ? { sessionTicket: true } : {}),
      ...(this.setup.statusStaple !== null ? { statusRequest: true } : {}),
      ...(this.setup.maxFragmentLength !== null ? { maxFragmentLength: this.setup.maxFragmentLength } : {}),
    };
  }

  private applyFragmentLimit(inbound: LegacyRecordProtection, outbound: LegacyRecordProtection): void {
    const limit = this.setup.maxFragmentLength;
    if (limit === null) return;
    inbound.maxFragment = limit;
    outbound.maxFragment = limit;
  }

  private findResumable(): { state: LegacySessionState; id: string } | 'abort' | null {
    const client = this.setup.clientExtensions;
    let state: LegacySessionState | null = null;
    let id = client.sessionId;
    if (client.sessionTicket !== null && client.sessionTicket !== '' && this.setup.ticketCodec) {
      state = this.setup.ticketCodec.open(client.sessionTicket);
      if (state !== null && id === '') id = state.id;
    }
    if (state === null && client.sessionId !== '' && this.setup.sessionStore) {
      state = this.setup.sessionStore.get(client.sessionId);
    }
    if (state === null) return null;
    if (state.version !== this.setup.version || !this.setup.acceptResumedSuite(state.suiteName)) return null;
    if (state.extendedMasterSecret && !client.extendedMasterSecret) return 'abort';
    if (!state.extendedMasterSecret && this.ems) return null;
    return { state, id };
  }

  start(): readonly TlsRecord[] | null {
    const { version } = this.setup;
    const client = this.setup.clientExtensions;
    if (client.renegotiationInfo !== null && client.renegotiationInfo !== '') return this.reject('handshake_failure');
    this.ems = this.setup.extendedMasterSecret && client.extendedMasterSecret;

    const resumable = this.findResumable();
    if (resumable === 'abort') return this.reject('handshake_failure');
    if (resumable !== null) return this.startAbbreviated(resumable.state, resumable.id);

    this.issueTicket = this.setup.ticketCodec !== undefined && client.sessionTicket !== null;
    this.sessionId = this.setup.sessionStore ? randomHex(32) : '';
    const suite = this.suite;
    const bundle: object[] = [];
    const serverHello: LegacyServerHello = {
      kind: 'legacy_server_hello', version, random: this.serverRandom, sessionId: this.sessionId,
      cipherSuite: suite.name, compressionMethod: 'null', extensions: this.helloExtensions(),
    };
    bundle.push(serverHello);
    const certificate: LegacyCertificate = { kind: 'legacy_certificate', certificateList: [this.setup.serverCert, ...this.setup.serverChain] };
    bundle.push(certificate);
    if (this.setup.statusStaple !== null) {
      const status: LegacyCertificateStatus = { kind: 'legacy_certificate_status', response: this.setup.statusStaple };
      bundle.push(status);
    }

    if (suite.keyExchange !== 'RSA') {
      const params = this.generateParams();
      if (params === null) return this.reject('handshake_failure');
      const signed = keyExchangeSignedData(this.setup.clientRandom, this.serverRandom, params);
      const serverKeyExchange: ServerKeyExchange = {
        kind: 'server_key_exchange', params,
        signatureAlgorithm: signatureAlgorithmName(this.setup.serverPrivateKey.algorithm, version),
        signature: signLegacy(this.setup.serverPrivateKey, version, signed),
      };
      bundle.push(serverKeyExchange);
    }
    if (this.setup.requestClientCert) {
      const request: LegacyCertificateRequest = {
        kind: 'legacy_certificate_request', certificateTypes: ['rsa_sign', 'ecdsa_sign'],
        signatureAlgorithms: version === '1.2' ? ['rsa_pkcs1_sha256', 'ecdsa_secp256r1_sha256'] : [],
      };
      bundle.push(request);
    }
    const done: ServerHelloDone = { kind: 'server_hello_done' };
    bundle.push(done);

    for (const message of bundle) this.messages.push(encodeLegacyMessage(message));
    return handshakeRecords(version, encodeLegacyBundle(bundle));
  }

  private startAbbreviated(state: LegacySessionState, id: string): readonly TlsRecord[] | null {
    const { version } = this.setup;
    const suite = this.setup.resolveSuite(state.suiteName);
    if (!suite) return this.reject('handshake_failure');
    this.suite = suite;
    this.resumed = true;
    this.sessionId = id;
    this.ems = state.extendedMasterSecret;
    const serverHello: LegacyServerHello = {
      kind: 'legacy_server_hello', version, random: this.serverRandom, sessionId: id,
      cipherSuite: suite.name, compressionMethod: 'null', extensions: this.helloExtensions(),
    };
    this.messages.push(encodeLegacyMessage(serverHello));
    const master = hexToBytes(state.master);
    this.resumedMaster = master;
    const derived = protectionsFromMaster(version, suite, master, this.setup.clientRandom, this.serverRandom);
    const outbound = derived.serverWrite();
    const inbound = derived.clientWrite();
    const finished: LegacyFinished = {
      kind: 'legacy_finished',
      verifyData: bytesToHex(finishedVerifyData(version, suite.prf, master, 'server', this.messages)),
    };
    const sealed = outbound.seal(0, {
      contentType: 'handshake', legacyVersion: PROTOCOL_VERSION_WIRE[version], fragment: encodeLegacyMessage(finished),
    });
    this.messages.push(encodeLegacyMessage(finished));
    outbound.sequenceBase = 1;
    this.applyFragmentLimit(inbound, outbound);
    this.traffic = { inbound, outbound };
    this.state = 'awaiting-resumed-finished';
    return [...handshakeRecords(version, encodeLegacyBundle([serverHello])), changeCipherSpec(version), sealed];
  }

  private finishResumed(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { version } = this.setup;
    if (!isChangeCipherSpec(incoming[0])) return this.reject('unexpected_message');
    const record = incoming[1];
    if (!record || record.contentType !== 'handshake') return this.reject('unexpected_message');
    const opened = this.traffic!.inbound.open(0, record);
    if (opened === null) return this.reject('bad_record_mac');
    const finished = decodeLegacyMessages(opened.fragment)[0] as LegacyFinished | undefined;
    if (!finished || finished.kind !== 'legacy_finished') return this.reject('unexpected_message');
    const expected = bytesToHex(finishedVerifyData(version, this.suite.prf, this.resumedMaster!, 'client', this.messages));
    if (finished.verifyData !== expected) return this.reject('decrypt_error');
    this.traffic!.inbound.sequenceBase = 1;
    this.state = 'done';
    this.result = 'accept';
    return null;
  }

  private generateParams(): KeyExchangeParams | null {
    const suite = this.suite;
    if (suite.keyExchange === 'DHE_RSA') {
      const group = modpGroup(this.setup.dhGroupId);
      if (!group) return null;
      this.dh = generateModpKeyPair(group);
      return { type: 'dh', p: modpToHex(group.prime), g: modpToHex(group.generator), ys: modpToHex(this.dh.publicKey) };
    }
    const group = this.setup.serverGroups.find((g) => isImplementedGroup(g) && this.setup.offeredGroups.includes(g));
    if (!group) return null;
    this.ecdhe = generateKeyExchange(group);
    return { type: 'ecdh', group, publicKey: this.ecdhe.share };
  }

  private reject(description: AlertDescription): null {
    this.lastAlert = fatalAlert(description);
    this.state = 'done';
    this.result = 'reject';
    return null;
  }

  private rejectCertificate(reason: Parameters<typeof certificateAlert>[0]): null {
    this.lastAlert = certificateAlert(reason);
    this.state = 'done';
    this.result = 'reject';
    return null;
  }

  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    if (this.state === 'done') return null;
    try {
      if (this.state === 'awaiting-resumed-finished') return this.finishResumed(incoming);
      return this.handleClientFlight(incoming);
    } catch {
      return this.reject('decode_error');
    }
  }

  private premasterFrom(exchange: ClientKeyExchange['exchange']): Uint8Array | null {
    const suite = this.suite;
    if (suite.keyExchange === 'RSA') {
      if (exchange.type !== 'rsa') return null;
      const key = materialToPrivateKey(this.setup.serverPrivateKey.material);
      const fallback = concat(
        Uint8Array.of((this.setup.clientVersionWire >> 8) & 0xff, this.setup.clientVersionWire & 0xff),
        hexToBytes(randomHex(PRE_MASTER_LENGTH - 2)),
      );
      if (key === null) return fallback;
      const decrypted = rsaDecryptPkcs1(key, hexToBytes(exchange.encryptedPreMasterSecret));
      const versionMatches = decrypted !== null && decrypted.length === PRE_MASTER_LENGTH
        && decrypted[0] === ((this.setup.clientVersionWire >> 8) & 0xff)
        && decrypted[1] === (this.setup.clientVersionWire & 0xff);
      return versionMatches ? decrypted : fallback;
    }
    if (suite.keyExchange === 'DHE_RSA') {
      if (exchange.type !== 'dh' || this.dh === null) return null;
      const secret = modpSharedSecret(this.dh, modpFromHex(exchange.yc));
      return secret === null ? null : hexToBytes(modpToHex(secret));
    }
    if (exchange.type !== 'ecdh' || this.ecdhe === null) return null;
    const secret = sharedSecret(this.ecdhe, exchange.publicKey);
    return secret === null ? null : hexToBytes(secret);
  }

  private handleClientFlight(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { version } = this.setup;
    const suite = this.suite;
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    const bundleBytes = reassembleHandshake(leading);
    if (bundleBytes === null) return this.reject('unexpected_message');
    const bundle = decodeLegacyMessages(bundleBytes);

    let certificate: LegacyCertificate | undefined;
    let keyExchange: ClientKeyExchange | undefined;
    let certificateVerify: LegacyCertificateVerify | undefined;
    for (const message of bundle) {
      if (message.kind === 'legacy_certificate') certificate = message as LegacyCertificate;
      else if (message.kind === 'client_key_exchange') keyExchange = message as ClientKeyExchange;
      else if (message.kind === 'legacy_certificate_verify') certificateVerify = message as LegacyCertificateVerify;
      else return this.reject('unexpected_message');
    }
    if (!keyExchange) return this.reject('unexpected_message');

    let verifiedLeaf: X509Certificate | null = null;
    if (this.setup.requestClientCert) {
      if (!certificate) return this.reject('unexpected_message');
      if (certificate.certificateList.length === 0) return this.reject('handshake_failure');
      if (!this.setup.verifier || !certificateVerify) return this.reject('handshake_failure');
      verifiedLeaf = certificate.certificateList[0];
      const verification = this.setup.verifier.verify(verifiedLeaf, undefined, certificate.certificateList.slice(1), 'clientAuth', this.setup.securityLevel);
      if (verification.ok === false) return this.rejectCertificate(verification.reason);
      this.peerCertificate = verifiedLeaf;
    } else if (certificate) {
      return this.reject('unexpected_message');
    }

    let sessionHash: Uint8Array | null = null;
    for (const message of bundle) {
      if (message.kind === 'legacy_certificate_verify') {
        const signed = concat(...this.messages);
        if (!verifyLegacy(verifiedLeaf!.publicKey, version, signed, (message as LegacyCertificateVerify).signature)) {
          return this.reject('decrypt_error');
        }
      }
      this.messages.push(encodeLegacyMessage(message));
      if (message.kind === 'client_key_exchange') sessionHash = handshakeHash(version, suite.prf, this.messages);
    }

    const preMaster = this.premasterFrom(keyExchange.exchange);
    if (preMaster === null) return this.reject('illegal_parameter');
    const derived = deriveProtections(
      version, suite, preMaster, this.setup.clientRandom, this.serverRandom, this.ems ? sessionHash : null,
    );
    const inbound = derived.clientWrite();
    const outbound = derived.serverWrite();

    if (!isChangeCipherSpec(rest[0])) return this.reject('unexpected_message');
    const finishedRecord = rest[1];
    if (!finishedRecord || finishedRecord.contentType !== 'handshake') return this.reject('unexpected_message');
    const opened = inbound.open(0, finishedRecord);
    if (opened === null) return this.reject('bad_record_mac');
    const finished = decodeLegacyMessages(opened.fragment)[0] as LegacyFinished | undefined;
    if (!finished || finished.kind !== 'legacy_finished') return this.reject('unexpected_message');
    const expected = bytesToHex(finishedVerifyData(version, suite.prf, derived.master, 'client', this.messages));
    if (finished.verifyData !== expected) return this.reject('decrypt_error');
    this.messages.push(encodeLegacyMessage(finished));

    const state: LegacySessionState = {
      id: this.sessionId !== '' ? this.sessionId : randomHex(32), version, suiteName: suite.name,
      master: bytesToHex(derived.master), extendedMasterSecret: this.ems,
      createdAt: this.setup.now(), lifetimeSeconds: this.setup.sessionLifetimeSeconds,
    };
    const prefix: TlsRecord[] = [];
    if (this.issueTicket) {
      const ticketMessage: LegacyNewSessionTicket = {
        kind: 'legacy_new_session_ticket', lifetimeHint: this.setup.sessionLifetimeSeconds,
        ticket: this.setup.ticketCodec!.seal(state),
      };
      this.messages.push(encodeLegacyMessage(ticketMessage));
      prefix.push(...handshakeRecords(version, encodeLegacyBundle([ticketMessage])));
    }
    const serverFinished: LegacyFinished = {
      kind: 'legacy_finished',
      verifyData: bytesToHex(finishedVerifyData(version, suite.prf, derived.master, 'server', this.messages)),
    };
    const sealed = outbound.seal(0, {
      contentType: 'handshake', legacyVersion: PROTOCOL_VERSION_WIRE[version],
      fragment: encodeLegacyMessage(serverFinished),
    });
    inbound.sequenceBase = 1;
    outbound.sequenceBase = 1;
    this.applyFragmentLimit(inbound, outbound);
    this.traffic = { inbound, outbound };
    if (this.setup.sessionStore && this.sessionId !== '') this.setup.sessionStore.put(state);
    this.state = 'done';
    this.result = 'accept';
    return [...prefix, changeCipherSpec(version), sealed];
  }
}

export interface LegacyClientSetup {
  readonly offeredVersions: readonly LegacyVersion[];
  readonly offeredSuites: readonly string[];
  readonly offeredGroups: readonly string[];
  readonly clientHelloBytes: Uint8Array;
  readonly clientRandom: string;
  readonly clientVersionWire: number;
  readonly offersTls13: boolean;
  readonly verifier: CertificateVerifier;
  readonly allowUntrustedPeer: boolean;
  readonly serverName?: string;
  readonly clientCert?: X509Certificate;
  readonly clientPrivateKey?: PkiPrivateKey;
  readonly securityLevel: number;
  readonly resolveSuite: (name: string) => LegacySuiteDefinition | undefined;
  readonly clientExtensions: LegacyClientExtensions;
  readonly session: ResumableLegacySession | null;
  readonly allowUnsafeRenegotiation: boolean;
  readonly requestStatus: boolean;
  readonly requireStaple: boolean;
  readonly requestedMaxFragment: number | null;
  readonly now: () => number;
}

type ClientLegacyState = 'awaiting-server-flight' | 'awaiting-server-finished' | 'done';

export class LegacyClientHandshake {
  result: 'success' | 'failure' | null = null;
  lastAlert: TlsAlert | null = null;
  peerCertificate: X509Certificate | null = null;
  peerVerified = false;
  peerVerificationReason: string | null = null;
  traffic: LegacyTraffic | null = null;
  negotiatedVersion: LegacyVersion | null = null;
  negotiatedSuite: LegacySuiteDefinition | null = null;
  negotiatedAlpn: string | null = null;
  negotiatedMaxFragment: number | null = null;

  private state: ClientLegacyState = 'awaiting-server-flight';
  private readonly messages: Uint8Array[] = [];
  private derived: DerivedKeys | null = null;
  private serverRandom = '';
  private serverSessionId = '';
  private usedEms = false;
  private receivedTicket: { ticket: string; lifetimeHint: number } | null = null;
  resumed = false;
  exportedSession: ResumableLegacySession | null = null;

  constructor(private readonly setup: LegacyClientSetup) {
    this.messages.push(setup.clientHelloBytes);
  }

  private fail(description: AlertDescription): null {
    this.lastAlert = fatalAlert(description);
    this.state = 'done';
    this.result = 'failure';
    return null;
  }

  private failCertificate(reason: Parameters<typeof certificateAlert>[0]): null {
    this.lastAlert = certificateAlert(reason);
    this.state = 'done';
    this.result = 'failure';
    return null;
  }

  handle(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    if (this.state === 'done') return null;
    try {
      return this.state === 'awaiting-server-flight'
        ? this.handleServerFlight(incoming)
        : this.handleServerFinished(incoming);
    } catch {
      return this.fail('decode_error');
    }
  }

  private handleServerFlight(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const { leading, rest: trailing } = splitLeadingContentType(incoming, 'handshake');
    const bytes = reassembleHandshake(leading);
    if (bytes === null) return this.fail('unexpected_message');
    const bundle = decodeLegacyMessages(bytes);
    const serverHello = bundle.find((m): m is LegacyServerHello => m.kind === 'legacy_server_hello');
    const certificate = bundle.find((m): m is LegacyCertificate => m.kind === 'legacy_certificate');
    const serverKeyExchange = bundle.find((m): m is ServerKeyExchange => m.kind === 'server_key_exchange');
    const certificateStatus = bundle.find((m): m is LegacyCertificateStatus => m.kind === 'legacy_certificate_status');
    const certificateRequest = bundle.find((m): m is LegacyCertificateRequest => m.kind === 'legacy_certificate_request');
    const done = bundle.find((m) => m.kind === 'server_hello_done');
    if (!serverHello) return this.fail('unexpected_message');

    const { setup } = this;
    if (!setup.offeredVersions.includes(serverHello.version)) return this.fail('illegal_parameter');
    if (!isHelloRandom(serverHello.random)) return this.fail('illegal_parameter');
    const sentinel = downgradeSentinel(serverHello.random);
    if (setup.offersTls13 && sentinel !== null) return this.fail('illegal_parameter');
    if (serverHello.compressionMethod !== 'null') return this.fail('illegal_parameter');
    if (!setup.offeredSuites.includes(serverHello.cipherSuite)) return this.fail('illegal_parameter');
    const suite = setup.resolveSuite(serverHello.cipherSuite);
    if (!suite) return this.fail('illegal_parameter');
    this.negotiatedVersion = serverHello.version;
    this.negotiatedSuite = suite;
    this.negotiatedAlpn = serverHello.extensions.alpn ?? null;
    this.serverRandom = serverHello.random;
    this.serverSessionId = serverHello.sessionId;
    const version = serverHello.version;

    const echoedFragment = serverHello.extensions.maxFragmentLength;
    if (echoedFragment !== undefined) {
      if (setup.requestedMaxFragment === null) return this.fail('unsupported_extension');
      if (echoedFragment !== setup.requestedMaxFragment) return this.fail('illegal_parameter');
      this.negotiatedMaxFragment = echoedFragment;
    }
    const offeredEms = setup.clientExtensions.extendedMasterSecret;
    const serverEms = serverHello.extensions.extendedMasterSecret === true;
    if (serverEms && !offeredEms) return this.fail('unsupported_extension');
    if (setup.clientExtensions.renegotiationInfo !== null) {
      const echoed = serverHello.extensions.renegotiationInfo;
      if (echoed === undefined && !setup.allowUnsafeRenegotiation) return this.fail('handshake_failure');
      if (echoed !== undefined && echoed !== '') return this.fail('handshake_failure');
    }
    if (setup.session && serverHello.sessionId !== '' && serverHello.sessionId === setup.clientExtensions.sessionId) {
      return this.resumeAbbreviated(serverHello, suite, trailing);
    }
    if (!certificate || !done) return this.fail('unexpected_message');
    this.usedEms = serverEms;

    const leaf = certificate.certificateList[0];
    if (!leaf) return this.fail('bad_certificate');
    this.peerCertificate = leaf;
    const verification = setup.verifier.verify(leaf, setup.serverName, certificate.certificateList.slice(1), 'serverAuth', setup.securityLevel);
    this.peerVerified = verification.ok !== false;
    if (verification.ok === false) {
      this.peerVerificationReason = verification.reason;
      if (!setup.allowUntrustedPeer) return this.failCertificate(verification.reason);
    }
    if (setup.requestStatus && serverHello.extensions.statusRequest !== true && certificateStatus !== undefined) return this.fail('unsupported_extension');
    if (!setup.requestStatus && certificateStatus !== undefined) return this.fail('unsupported_extension');
    if (setup.requestStatus) {
      const stapleProblem = stapleAlert(
        setup.verifier, leaf, certificate.certificateList.slice(1), certificateStatus?.response, setup.requireStaple,
      );
      if (stapleProblem !== null) return this.fail(stapleProblem);
    }
    if (!suiteMatchesCertificate(leaf, suite)) return this.fail('illegal_parameter');
    if (isForwardSecret(suite) !== (serverKeyExchange !== undefined)) return this.fail('unexpected_message');

    let exchange: ClientKeyExchange['exchange'];
    let preMaster: Uint8Array;
    if (suite.keyExchange === 'RSA') {
      const key = materialToPublicKey(leaf.publicKey.material);
      if (key === null) return this.fail('bad_certificate');
      preMaster = concat(
        Uint8Array.of((setup.clientVersionWire >> 8) & 0xff, setup.clientVersionWire & 0xff),
        hexToBytes(randomHex(PRE_MASTER_LENGTH - 2)),
      );
      exchange = { type: 'rsa', encryptedPreMasterSecret: bytesToHex(rsaEncryptPkcs1(key, preMaster)) };
    } else {
      const params = serverKeyExchange!.params;
      const signed = keyExchangeSignedData(setup.clientRandom, serverHello.random, params);
      if (!verifyLegacy(leaf.publicKey, version, signed, serverKeyExchange!.signature)) return this.fail('decrypt_error');
      if (suite.keyExchange === 'DHE_RSA') {
        if (params.type !== 'dh') return this.fail('illegal_parameter');
        const p = modpFromHex(params.p);
        if (!dhPermitted(setup.securityLevel, p.toString(2).length)) return this.fail('handshake_failure');
        const g = modpFromHex(params.g);
        const own = generateModpKeyPair({ id: 0, bits: p.toString(2).length, prime: p, generator: g });
        const secret = modpSharedSecret(own, modpFromHex(params.ys));
        if (secret === null) return this.fail('illegal_parameter');
        preMaster = hexToBytes(modpToHex(secret));
        exchange = { type: 'dh', yc: modpToHex(own.publicKey) };
      } else {
        if (params.type !== 'ecdh') return this.fail('illegal_parameter');
        if (!setup.offeredGroups.includes(params.group) || !isImplementedGroup(params.group)) {
          return this.fail('illegal_parameter');
        }
        const own = generateKeyExchange(params.group);
        const secret = sharedSecret(own, params.publicKey);
        if (secret === null) return this.fail('illegal_parameter');
        preMaster = hexToBytes(secret);
        exchange = { type: 'ecdh', publicKey: own.share };
      }
    }

    for (const message of bundle) this.messages.push(encodeLegacyMessage(message));

    const out: object[] = [];
    if (certificateRequest) {
      const clientCertificate: LegacyCertificate = {
        kind: 'legacy_certificate', certificateList: setup.clientCert ? [setup.clientCert] : [],
      };
      out.push(clientCertificate);
      this.messages.push(encodeLegacyMessage(clientCertificate));
    }
    const clientKeyExchange: ClientKeyExchange = { kind: 'client_key_exchange', exchange };
    out.push(clientKeyExchange);
    this.messages.push(encodeLegacyMessage(clientKeyExchange));
    const sessionHashMessages = [...this.messages];
    if (certificateRequest && setup.clientCert && setup.clientPrivateKey) {
      const verify: LegacyCertificateVerify = {
        kind: 'legacy_certificate_verify',
        signature: signLegacy(setup.clientPrivateKey, version, concat(...this.messages)),
      };
      out.push(verify);
      this.messages.push(encodeLegacyMessage(verify));
    }

    const sessionHash = this.usedEms ? handshakeHash(version, suite.prf, sessionHashMessages) : null;
    this.derived = deriveProtections(version, suite, preMaster, setup.clientRandom, serverHello.random, sessionHash);
    const outbound = this.derived.clientWrite();
    const inbound = this.derived.serverWrite();
    const finished: LegacyFinished = {
      kind: 'legacy_finished',
      verifyData: bytesToHex(finishedVerifyData(version, suite.prf, this.derived.master, 'client', this.messages)),
    };
    const sealed = outbound.seal(0, {
      contentType: 'handshake', legacyVersion: PROTOCOL_VERSION_WIRE[version],
      fragment: encodeLegacyMessage(finished),
    });
    this.messages.push(encodeLegacyMessage(finished));
    outbound.sequenceBase = 1;
    this.applyFragmentLimit(inbound, outbound);
    this.traffic = { inbound, outbound };
    this.state = 'awaiting-server-finished';
    return [...handshakeRecords(version, encodeLegacyBundle(out)), changeCipherSpec(version), sealed];
  }

  private applyFragmentLimit(inbound: LegacyRecordProtection, outbound: LegacyRecordProtection): void {
    if (this.negotiatedMaxFragment === null) return;
    inbound.maxFragment = this.negotiatedMaxFragment;
    outbound.maxFragment = this.negotiatedMaxFragment;
  }

  private resumeAbbreviated(
    serverHello: LegacyServerHello, suite: LegacySuiteDefinition, trailing: readonly TlsRecord[],
  ): readonly TlsRecord[] | null {
    const { setup } = this;
    const state = setup.session!.state;
    const version = serverHello.version;
    if (state.version !== version || state.suiteName !== suite.name) return this.fail('illegal_parameter');
    const serverEms = serverHello.extensions.extendedMasterSecret === true;
    if (serverEms !== state.extendedMasterSecret) return this.fail('handshake_failure');
    this.resumed = true;
    this.usedEms = serverEms;
    this.messages.push(encodeLegacyMessage(serverHello));
    const master = hexToBytes(state.master);
    this.derived = { ...protectionsFromMaster(version, suite, master, setup.clientRandom, serverHello.random) };
    const outbound = this.derived.clientWrite();
    const inbound = this.derived.serverWrite();
    if (!isChangeCipherSpec(trailing[0])) return this.fail('unexpected_message');
    const record = trailing[1];
    if (!record || record.contentType !== 'handshake') return this.fail('unexpected_message');
    const opened = inbound.open(0, record);
    if (opened === null) return this.fail('bad_record_mac');
    const serverFinished = decodeLegacyMessages(opened.fragment)[0] as LegacyFinished | undefined;
    if (!serverFinished || serverFinished.kind !== 'legacy_finished') return this.fail('unexpected_message');
    const expected = bytesToHex(finishedVerifyData(version, suite.prf, master, 'server', this.messages));
    if (serverFinished.verifyData !== expected) return this.fail('decrypt_error');
    this.messages.push(encodeLegacyMessage(serverFinished));
    inbound.sequenceBase = 1;

    const finished: LegacyFinished = {
      kind: 'legacy_finished',
      verifyData: bytesToHex(finishedVerifyData(version, suite.prf, master, 'client', this.messages)),
    };
    const sealed = outbound.seal(0, {
      contentType: 'handshake', legacyVersion: PROTOCOL_VERSION_WIRE[version], fragment: encodeLegacyMessage(finished),
    });
    outbound.sequenceBase = 1;
    this.applyFragmentLimit(inbound, outbound);
    this.traffic = { inbound, outbound };
    this.exportedSession = setup.session;
    this.state = 'done';
    this.result = 'success';
    return [changeCipherSpec(version), sealed];
  }

  private recordSession(master: Uint8Array): void {
    const version = this.negotiatedVersion!;
    const suite = this.negotiatedSuite!;
    const ticket = this.receivedTicket;
    if (this.serverSessionId === '' && ticket === null) return;
    const lifetime = ticket?.lifetimeHint && ticket.lifetimeHint > 0 ? ticket.lifetimeHint : 300;
    this.exportedSession = {
      state: {
        id: this.serverSessionId !== '' ? this.serverSessionId : this.setup.clientExtensions.sessionId,
        version, suiteName: suite.name, master: bytesToHex(master), extendedMasterSecret: this.usedEms,
        createdAt: this.setup.now(), lifetimeSeconds: lifetime,
      },
      ticket: ticket?.ticket ?? null,
    };
  }

  private handleServerFinished(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const version = this.negotiatedVersion!;
    const suite = this.negotiatedSuite!;
    const { leading, rest } = splitLeadingContentType(incoming, 'handshake');
    if (leading.length > 0) {
      const ticketBundle = decodeLegacyMessages(reassembleHandshake(leading)!);
      for (const message of ticketBundle) {
        if (message.kind !== 'legacy_new_session_ticket') return this.fail('unexpected_message');
        const nst = message as LegacyNewSessionTicket;
        this.receivedTicket = { ticket: nst.ticket, lifetimeHint: nst.lifetimeHint };
        this.messages.push(encodeLegacyMessage(nst));
      }
    }
    if (!isChangeCipherSpec(rest[0])) return this.fail('unexpected_message');
    const record = rest[1];
    if (!record || record.contentType !== 'handshake') return this.fail('unexpected_message');
    const opened = this.traffic!.inbound.open(0, record);
    if (opened === null) return this.fail('bad_record_mac');
    const finished = decodeLegacyMessages(opened.fragment)[0] as LegacyFinished | undefined;
    if (!finished || finished.kind !== 'legacy_finished') return this.fail('unexpected_message');
    const expected = bytesToHex(finishedVerifyData(version, suite.prf, this.derived!.master, 'server', this.messages));
    if (finished.verifyData !== expected) return this.fail('decrypt_error');
    this.traffic!.inbound.sequenceBase = 1;
    this.recordSession(this.derived!.master);
    this.state = 'done';
    this.result = 'success';
    return null;
  }
}
