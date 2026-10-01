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
  LegacyRecordProtection, deriveKeyBlock, finishedVerifyData, masterSecret,
} from './legacyCrypto';
import {
  decodeLegacyMessages, encodeLegacyBundle, encodeLegacyMessage,
  type ClientKeyExchange, type KeyExchangeParams, type LegacyCertificate, type LegacyCertificateRequest,
  type LegacyCertificateVerify, type LegacyFinished, type LegacyServerHello, type ServerHelloDone,
  type ServerKeyExchange,
} from './legacyMessages';
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
  clientRandom: string, serverRandom: string,
): DerivedKeys {
  const master = masterSecret(version, suite.prf, preMaster, hexToBytes(clientRandom), hexToBytes(serverRandom));
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
}

type ServerLegacyState = 'awaiting-client-flight' | 'done';

export class LegacyServerHandshake {
  result: 'accept' | 'reject' | null = null;
  lastAlert: TlsAlert | null = null;
  peerCertificate: X509Certificate | null = null;
  traffic: LegacyTraffic | null = null;

  private state: ServerLegacyState = 'awaiting-client-flight';
  private readonly messages: Uint8Array[] = [];
  private readonly serverRandom: string;
  private ecdhe: KeyExchangeKeyPair | null = null;
  private dh: ReturnType<typeof generateModpKeyPair> | null = null;

  constructor(private readonly setup: LegacyServerSetup) {
    this.messages.push(setup.clientHelloBytes);
    const tail = !setup.serverSupportsTls13
      ? randomHex(8)
      : setup.version === '1.2' ? DOWNGRADE_TAIL_TLS12 : DOWNGRADE_TAIL_TLS11_OR_LOWER;
    this.serverRandom = randomHex(RANDOM_BYTES - 8) + tail;
  }

  get negotiatedVersion(): LegacyVersion { return this.setup.version; }

  start(): readonly TlsRecord[] | null {
    const { suite, version } = this.setup;
    const bundle: object[] = [];
    const serverHello: LegacyServerHello = {
      kind: 'legacy_server_hello', version, random: this.serverRandom, sessionId: '',
      cipherSuite: suite.name, compressionMethod: 'null',
      extensions: { alpn: this.setup.alpn ?? undefined },
    };
    bundle.push(serverHello);
    const certificate: LegacyCertificate = { kind: 'legacy_certificate', certificateList: [this.setup.serverCert, ...this.setup.serverChain] };
    bundle.push(certificate);

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

  private generateParams(): KeyExchangeParams | null {
    const { suite } = this.setup;
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
    if (this.state !== 'awaiting-client-flight') return null;
    try {
      return this.handleClientFlight(incoming);
    } catch {
      return this.reject('decode_error');
    }
  }

  private premasterFrom(exchange: ClientKeyExchange['exchange']): Uint8Array | null {
    const { suite } = this.setup;
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
    const { version, suite } = this.setup;
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

    for (const message of bundle) {
      if (message.kind === 'legacy_certificate_verify') {
        const signed = concat(...this.messages);
        if (!verifyLegacy(verifiedLeaf!.publicKey, version, signed, (message as LegacyCertificateVerify).signature)) {
          return this.reject('decrypt_error');
        }
      }
      this.messages.push(encodeLegacyMessage(message));
    }

    const preMaster = this.premasterFrom(keyExchange.exchange);
    if (preMaster === null) return this.reject('illegal_parameter');
    const derived = deriveProtections(version, suite, preMaster, this.setup.clientRandom, this.serverRandom);
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
    this.traffic = { inbound, outbound };
    this.state = 'done';
    this.result = 'accept';
    return [changeCipherSpec(version), sealed];
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

  private state: ClientLegacyState = 'awaiting-server-flight';
  private readonly messages: Uint8Array[] = [];
  private derived: DerivedKeys | null = null;
  private serverRandom = '';

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
    const bytes = reassembleHandshake(incoming);
    if (bytes === null) return this.fail('unexpected_message');
    const bundle = decodeLegacyMessages(bytes);
    const serverHello = bundle.find((m): m is LegacyServerHello => m.kind === 'legacy_server_hello');
    const certificate = bundle.find((m): m is LegacyCertificate => m.kind === 'legacy_certificate');
    const serverKeyExchange = bundle.find((m): m is ServerKeyExchange => m.kind === 'server_key_exchange');
    const certificateRequest = bundle.find((m): m is LegacyCertificateRequest => m.kind === 'legacy_certificate_request');
    const done = bundle.find((m) => m.kind === 'server_hello_done');
    if (!serverHello || !certificate || !done) return this.fail('unexpected_message');

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
    const version = serverHello.version;

    const leaf = certificate.certificateList[0];
    if (!leaf) return this.fail('bad_certificate');
    this.peerCertificate = leaf;
    const verification = setup.verifier.verify(leaf, setup.serverName, certificate.certificateList.slice(1), 'serverAuth', setup.securityLevel);
    this.peerVerified = verification.ok !== false;
    if (verification.ok === false) {
      this.peerVerificationReason = verification.reason;
      if (!setup.allowUntrustedPeer) return this.failCertificate(verification.reason);
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
    if (certificateRequest && setup.clientCert && setup.clientPrivateKey) {
      const verify: LegacyCertificateVerify = {
        kind: 'legacy_certificate_verify',
        signature: signLegacy(setup.clientPrivateKey, version, concat(...this.messages)),
      };
      out.push(verify);
      this.messages.push(encodeLegacyMessage(verify));
    }

    this.derived = deriveProtections(version, suite, preMaster, setup.clientRandom, serverHello.random);
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
    this.traffic = { inbound, outbound };
    this.state = 'awaiting-server-finished';
    return [...handshakeRecords(version, encodeLegacyBundle(out)), changeCipherSpec(version), sealed];
  }

  private handleServerFinished(incoming: readonly TlsRecord[]): readonly TlsRecord[] | null {
    const version = this.negotiatedVersion!;
    const suite = this.negotiatedSuite!;
    if (!isChangeCipherSpec(incoming[0])) return this.fail('unexpected_message');
    const record = incoming[1];
    if (!record || record.contentType !== 'handshake') return this.fail('unexpected_message');
    const opened = this.traffic!.inbound.open(0, record);
    if (opened === null) return this.fail('bad_record_mac');
    const finished = decodeLegacyMessages(opened.fragment)[0] as LegacyFinished | undefined;
    if (!finished || finished.kind !== 'legacy_finished') return this.fail('unexpected_message');
    const expected = bytesToHex(finishedVerifyData(version, suite.prf, this.derived!.master, 'server', this.messages));
    if (finished.verifyData !== expected) return this.fail('decrypt_error');
    this.traffic!.inbound.sequenceBase = 1;
    this.state = 'done';
    this.result = 'success';
    return null;
  }
}
