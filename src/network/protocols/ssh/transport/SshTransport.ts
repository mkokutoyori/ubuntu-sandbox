import type { TcpStream } from '@/network/tcp/types';
import { binaryStringToBytes, bytesToBinaryString, bytesToUtf8, utf8ToBytes } from '@/crypto/encoding';
import {
  sshPublicKeyFromBlob, type SshPrivateKey,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { SshReader, SshWriter } from '../wire/SshDataTypes';
import { hostKeySignatureAlgorithmsFor, signWithAlgorithm, verifyUserauthSignature } from '../auth/UserauthSignature';
import { identificationLine, scanIdentification, type SshIdentification } from './SshIdentification';
import {
  decodeKexInit, encodeKexInit, negotiate, KEX_COOKIE_LENGTH,
  type KexProposal, type NegotiatedAlgorithms, type NegotiationFailure,
} from './SshKexInit';
import {
  CLEARTEXT, PacketReader, cipherSpec, encodePacket, macSpec,
  type PacketProtection,
} from './SshBinaryPacket';
import {
  GEX_MAX_BITS, deriveKey, estimateGroupBits, exchangeHash, groupExchangeRequestValid, kexMethod, readKexValue,
  selectExchangeGroup, systemRandom, writeKexValue,
  type EphemeralKey, type GroupExchangeParameters, type GroupExchangeRequest, type KexMethod, type KeyLetter,
  type RandomSource,
} from './SshKeyExchange';
import {
  EXT_INFO_CLIENT, IMPLEMENTED_CIPHERS, IMPLEMENTED_COMPRESSION, IMPLEMENTED_HOST_KEY_ALGORITHMS,
  IMPLEMENTED_KEX_METHODS, IMPLEMENTED_MACS, OPENSSH_CIPHERS, OPENSSH_HOST_KEY_ALGORITHMS,
  OPENSSH_KEX_ALGORITHMS, OPENSSH_MACS, SERVER_SIGNATURE_ALGORITHMS, implementedOnly, isAeadCipher,
} from './SshAlgorithms';
import {
  SSH_DISCONNECT_BY_APPLICATION, SSH_DISCONNECT_HOST_KEY_NOT_VERIFIABLE, SSH_DISCONNECT_KEY_EXCHANGE_FAILED,
  SSH_DISCONNECT_PROTOCOL_ERROR, SSH_DISCONNECT_PROTOCOL_VERSION_NOT_SUPPORTED,
  SSH_MSG_DEBUG, SSH_MSG_DISCONNECT, SSH_MSG_EXT_INFO, SSH_MSG_IGNORE,
  SSH_MSG_KEXDH_INIT, SSH_MSG_KEXDH_REPLY, SSH_MSG_KEXINIT, SSH_MSG_LOCAL_LEGACY_FRAME,
  SSH_MSG_KEX_DH_GEX_GROUP, SSH_MSG_KEX_DH_GEX_INIT, SSH_MSG_KEX_DH_GEX_REPLY, SSH_MSG_KEX_DH_GEX_REQUEST,
  SSH_MSG_NEWKEYS, SSH_MSG_SERVICE_ACCEPT, SSH_MSG_SERVICE_REQUEST, SSH_MSG_UNIMPLEMENTED,
  SSH_USERAUTH_SERVICE,
} from './SshMessageNumbers';

const SUPPORTED_PROTOCOL_VERSIONS = ['2.0', '1.99'];
const SERVER_SIG_ALGS = 'server-sig-algs';
const PUBLICKEY_HOSTBOUND = 'publickey-hostbound@openssh.com';

export interface SshServerHostKey {
  readonly publicKeyBlob: Uint8Array;
  readonly privateKey: SshPrivateKey;
}

export interface SshAlgorithmPreferences {
  readonly kex?: readonly string[];
  readonly hostKey?: readonly string[];
  readonly ciphers?: readonly string[];
  readonly macs?: readonly string[];
}

export interface SshTransportConfig {
  readonly role: 'client' | 'server';
  readonly identification: string;
  readonly hostKeys?: readonly SshServerHostKey[];
  readonly hostKeyAlgorithms?: readonly string[];
  readonly algorithms?: SshAlgorithmPreferences;
  readonly verifyHostKey?: (algorithm: string, blob: Uint8Array) => boolean;
  readonly random?: RandomSource;
  readonly groupExchangeMinBits?: number;
  readonly groupExchangeClientMinBits?: number;
  readonly extInfo?: boolean;
}

const OPENSSH_GEX_CLIENT_MIN_BITS = 2048;

export interface SshTransportEstablished {
  readonly ok: true;
  readonly sessionId: Uint8Array;
  readonly peerIdentification: SshIdentification;
  readonly hostKeyAlgorithm: string;
  readonly hostKeyBlob: Uint8Array;
  readonly algorithms: NegotiatedAlgorithms;
  readonly serverSignatureAlgorithms: readonly string[] | null;
}

export type SshTransportFailureKind =
  | 'closed' | 'identification' | 'negotiation' | 'protocol' | 'corrupt' | 'signature' | 'hostkey' | 'disconnect';

export interface SshTransportFailure {
  readonly ok: false;
  readonly kind: SshTransportFailureKind;
  readonly message: string;
  readonly negotiation?: { readonly failure: NegotiationFailure; readonly peerOffer: readonly string[] };
  readonly disconnect?: { readonly reason: number; readonly description: string };
  readonly identified?: boolean;
  readonly log?: string;
}

export type SshTransportOutcome = SshTransportEstablished | SshTransportFailure;

type Phase = 'kexinit' | 'kex' | 'newkeys' | 'service' | 'open' | 'closed';

function hostKeyAlgorithmsOf(key: SshServerHostKey): readonly string[] {
  const parsed = sshPublicKeyFromBlob(key.publicKeyBlob);
  return parsed === null ? [] : hostKeySignatureAlgorithmsFor(parsed);
}

export class SshTransport {
  readonly established: Promise<SshTransportOutcome>;
  private settle: (outcome: SshTransportOutcome) => void = () => {};
  private outcome: SshTransportOutcome | null = null;
  private textBuffer = '';
  private peer: SshIdentification | null = null;
  private readonly reader = new PacketReader();
  private incoming: PacketProtection = CLEARTEXT;
  private outgoing: PacketProtection = CLEARTEXT;
  private nextIncoming: PacketProtection | null = null;
  private sendSeq = 0;
  private recvSeq = 0;
  private readonly myProposal: KexProposal;
  private readonly myKexInit: Uint8Array;
  private peerKexInit: Uint8Array | null = null;
  private peerOffersExtInfo = false;
  private serverSignatureAlgorithms: readonly string[] | null = null;
  private negotiated: NegotiatedAlgorithms | null = null;
  private method: KexMethod | null = null;
  private ephemeral: EphemeralKey | null = null;
  private exchangeGroup: GroupExchangeParameters | null = null;
  private requestedGroup: GroupExchangeRequest | null = null;
  private sessionId: Uint8Array | null = null;
  private hostKey: { readonly algorithm: string; readonly blob: Uint8Array } | null = null;
  private phase: Phase = 'kexinit';
  private skipNextPacket = false;
  private processing = true;
  private peerClosed: string | null = null;
  private closeNotified = false;
  private userAuthenticated = false;
  private receivedDisconnect: { readonly reason: number; readonly description: string } | null = null;
  private readonly handlers = new Set<(payload: Uint8Array) => void>();
  private readonly undelivered: Uint8Array[] = [];
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private readonly random: RandomSource;

  constructor(private readonly conn: TcpStream, private readonly config: SshTransportConfig) {
    this.random = config.random ?? systemRandom;
    this.established = new Promise((resolve) => { this.settle = resolve; });
    this.myProposal = this.proposal();
    this.myKexInit = encodeKexInit(this.myProposal, this.random(KEX_COOKIE_LENGTH));
    conn.onData((data) => this.receive(data));
    conn.onClose?.((reason) => this.lost(reason));
    conn.write(identificationLine(config.identification));
    this.sendPacket(this.myKexInit);
    this.processing = false;
    this.drain();
  }

  get settled(): SshTransportOutcome | null {
    return this.outcome;
  }

  get peerIdentification(): SshIdentification | null {
    return this.peer;
  }

  get peerDisconnect(): { readonly reason: number; readonly description: string } | null {
    return this.receivedDisconnect;
  }

  get isOpen(): boolean {
    return this.phase === 'open';
  }

  send(payload: Uint8Array): void {
    if (this.phase !== 'open') return;
    this.sendPacket(payload);
  }

  onMessage(handler: (payload: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    while (this.undelivered.length > 0) handler(this.undelivered.shift()!);
    return () => { this.handlers.delete(handler); };
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => { this.closeHandlers.delete(handler); };
  }

  markAuthenticated(): void {
    this.userAuthenticated = true;
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.shutDown('closed');
  }

  disconnect(reason: number, description: string): void {
    if (this.phase === 'closed') return;
    this.sendPacket(new SshWriter()
      .writeByte(SSH_MSG_DISCONNECT).writeUint32(reason).writeString(description).writeString('')
      .toBytes());
    this.shutDown(description);
  }

  private proposal(): KexProposal {
    const server = this.config.role === 'server';
    const preferences = this.config.algorithms ?? {};
    const hostKey = server
      ? implementedOnly(preferences.hostKey ?? OPENSSH_HOST_KEY_ALGORITHMS,
        (this.config.hostKeys ?? []).flatMap(hostKeyAlgorithmsOf))
      : implementedOnly(preferences.hostKey ?? this.config.hostKeyAlgorithms ?? OPENSSH_HOST_KEY_ALGORITHMS,
        IMPLEMENTED_HOST_KEY_ALGORITHMS);
    const kex = implementedOnly(preferences.kex ?? OPENSSH_KEX_ALGORITHMS, IMPLEMENTED_KEX_METHODS);
    const ciphers = implementedOnly(preferences.ciphers ?? OPENSSH_CIPHERS, IMPLEMENTED_CIPHERS);
    const macs = implementedOnly(preferences.macs ?? OPENSSH_MACS, IMPLEMENTED_MACS);
    return {
      kex: server || this.config.extInfo === false ? kex : [...kex, EXT_INFO_CLIENT],
      hostKey,
      encryptionClientToServer: ciphers,
      encryptionServerToClient: ciphers,
      macClientToServer: macs,
      macServerToClient: macs,
      compressionClientToServer: IMPLEMENTED_COMPRESSION,
      compressionServerToClient: IMPLEMENTED_COMPRESSION,
      languageClientToServer: [],
      languageServerToClient: [],
      firstKexPacketFollows: false,
    };
  }

  private sendPacket(payload: Uint8Array): void {
    const wire = encodePacket(payload, this.outgoing, this.sendSeq, this.random);
    this.sendSeq = (this.sendSeq + 1) >>> 0;
    this.conn.write(bytesToBinaryString(wire));
  }

  private receive(data: string): void {
    if (this.phase === 'closed') return;
    if (this.peer === null) this.textBuffer += data;
    else this.reader.push(binaryStringToBytes(data));
    this.drain();
  }

  private drain(): void {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.phase !== 'closed') {
        if (this.peer === null) {
          if (!this.readIdentification()) break;
          continue;
        }
        const result = this.reader.read(this.incoming, this.recvSeq);
        if (result.kind === 'incomplete') break;
        if (result.kind === 'corrupt') {
          this.conclude({ ok: false, kind: 'corrupt', message: result.error, ...(result.log ? { log: result.log } : {}) });
          if (result.disconnect === null) this.shutDown(result.error);
          else this.disconnect(SSH_DISCONNECT_PROTOCOL_ERROR, result.disconnect);
          break;
        }
        this.recvSeq = (this.recvSeq + 1) >>> 0;
        this.dispatch(result.payload);
      }
    } finally {
      this.processing = false;
    }
    if (this.peerClosed !== null) this.finishLost(this.peerClosed);
  }

  private readIdentification(): boolean {
    const scan = scanIdentification(this.textBuffer);
    if (scan.kind === 'incomplete') return false;
    if (scan.kind === 'invalid') {
      this.conclude({ ok: false, kind: 'identification', message: 'Invalid SSH identification string.' });
      this.shutDown('invalid identification');
      return false;
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(scan.identification.protoVersion)) {
      this.abort(SSH_DISCONNECT_PROTOCOL_VERSION_NOT_SUPPORTED, 'Protocol major versions differ.', 'identification');
      return false;
    }
    this.peer = scan.identification;
    const rest = this.textBuffer.slice(scan.consumed);
    this.textBuffer = '';
    this.reader.push(binaryStringToBytes(rest));
    return true;
  }

  private dispatch(payload: Uint8Array): void {
    const type = payload[0];
    if (this.skipNextPacket) {
      this.skipNextPacket = false;
      return;
    }
    switch (type) {
      case SSH_MSG_DISCONNECT: return this.receiveDisconnect(payload);
      case SSH_MSG_IGNORE:
      case SSH_MSG_DEBUG:
      case SSH_MSG_UNIMPLEMENTED:
        return;
      case SSH_MSG_KEXINIT: return this.receiveKexInit(payload);
      case SSH_MSG_KEXDH_INIT:
        return this.method?.groupExchange ? this.unexpectedKexMessage(type) : this.receiveKexdhInit(payload);
      case SSH_MSG_KEXDH_REPLY:
        return this.method?.groupExchange ? this.receiveGroupExchangeGroup(payload) : this.receiveKexdhReply(payload);
      case SSH_MSG_KEX_DH_GEX_INIT:
        return this.method?.groupExchange ? this.receiveKexdhInit(payload) : this.unexpectedKexMessage(type);
      case SSH_MSG_KEX_DH_GEX_REPLY:
        return this.method?.groupExchange ? this.receiveKexdhReply(payload) : this.unexpectedKexMessage(type);
      case SSH_MSG_KEX_DH_GEX_REQUEST:
        return this.method?.groupExchange ? this.receiveGroupExchangeRequest(payload) : this.unexpectedKexMessage(type);
      case SSH_MSG_NEWKEYS: return this.receiveNewKeys();
      case SSH_MSG_EXT_INFO: return this.receiveExtInfo(payload);
      case SSH_MSG_SERVICE_REQUEST: return this.receiveServiceRequest(payload);
      case SSH_MSG_SERVICE_ACCEPT: return this.receiveServiceAccept(payload);
      default:
        if (this.phase !== 'open') {
          this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, `protocol error: rcvd type ${type}`, 'protocol');
          return;
        }
        if (this.handlers.size === 0) { this.undelivered.push(payload); return; }
        for (const handler of [...this.handlers]) handler(payload);
    }
  }

  private unexpectedKexMessage(type: number): void {
    this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, `protocol error: rcvd type ${type}`, 'protocol');
  }

  private receiveDisconnect(payload: Uint8Array): void {
    let reason = 0;
    let description = '';
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      reason = reader.readUint32();
      description = reader.readString();
    } catch {
      description = '';
    }
    this.receivedDisconnect = { reason, description };
    this.conclude({
      ok: false, kind: 'disconnect', message: description, disconnect: { reason, description },
    });
    this.phase = 'closed';
    this.notifyClosed(description);
    queueMicrotask(() => this.conn.close());
  }

  private receiveKexInit(payload: Uint8Array): void {
    if (this.phase !== 'kexinit') {
      this.abort(SSH_DISCONNECT_KEY_EXCHANGE_FAILED, 'key re-exchange is not supported', 'protocol');
      return;
    }
    const peerInit = decodeKexInit(payload);
    if (peerInit === null) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'invalid KEXINIT', 'protocol');
      return;
    }
    this.peerKexInit = payload;
    const client = this.config.role === 'client';
    this.peerOffersExtInfo = !client && this.config.extInfo !== false && peerInit.proposal.kex.includes(EXT_INFO_CLIENT);
    const [clientProposal, serverProposal] = client
      ? [this.myProposal, peerInit.proposal] : [peerInit.proposal, this.myProposal];
    const result = negotiate(clientProposal, serverProposal, this.config.role, isAeadCipher);
    if ('failure' in result) {
      this.conclude({
        ok: false, kind: 'negotiation',
        message: `no matching ${result.failure} found. Their offer: ${result.peerOffer.join(',')}`,
        negotiation: { failure: result.failure, peerOffer: result.peerOffer },
      });
      this.shutDown(`no matching ${result.failure} found`);
      return;
    }
    this.negotiated = result.algorithms;
    this.method = kexMethod(result.algorithms.kex)!;
    const guessed = peerInit.proposal.firstKexPacketFollows
      && (peerInit.proposal.kex[0] !== result.algorithms.kex
        || peerInit.proposal.hostKey[0] !== result.algorithms.hostKey);
    if (guessed) this.skipNextPacket = true;
    this.phase = 'kex';
    if (client && this.method.groupExchange) {
      const request = this.groupExchangeRequest();
      this.requestedGroup = request;
      this.sendPacket(new SshWriter()
        .writeByte(SSH_MSG_KEX_DH_GEX_REQUEST).writeUint32(request.min).writeUint32(request.n).writeUint32(request.max)
        .toBytes());
    } else if (client) {
      this.ephemeral = this.method.generate(this.random, this.keyMaterialNeeded());
      this.sendPacket(writeKexValue(new SshWriter().writeByte(SSH_MSG_KEXDH_INIT),
        this.method.encoding, this.ephemeral.publicKey).toBytes());
    }
  }

  private groupExchangeRequest(): GroupExchangeRequest {
    return {
      min: this.config.groupExchangeClientMinBits ?? OPENSSH_GEX_CLIENT_MIN_BITS,
      n: estimateGroupBits(this.keyMaterialNeeded() * 8),
      max: GEX_MAX_BITS,
    };
  }

  private receiveGroupExchangeRequest(payload: Uint8Array): void {
    if (this.config.role !== 'server' || this.phase !== 'kex') {
      this.unexpectedKexMessage(payload[0]);
      return;
    }
    let request: GroupExchangeRequest;
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      request = { min: reader.readUint32(), n: reader.readUint32(), max: reader.readUint32() };
    } catch {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'invalid KEX_DH_GEX_REQUEST', 'protocol');
      return;
    }
    const group = groupExchangeRequestValid(request)
      ? selectExchangeGroup(request, this.config.groupExchangeMinBits) : null;
    if (group === null) {
      this.abort(SSH_DISCONNECT_KEY_EXCHANGE_FAILED, 'DH_GEX_REQUEST, bad parameters', 'protocol');
      return;
    }
    this.exchangeGroup = { ...request, prime: group.prime, generator: group.generator };
    this.sendPacket(new SshWriter()
      .writeByte(SSH_MSG_KEX_DH_GEX_GROUP).writeMpint(group.prime).writeMpint(group.generator).toBytes());
  }

  private receiveGroupExchangeGroup(payload: Uint8Array): void {
    if (this.config.role !== 'client' || this.phase !== 'kex' || !this.method || !this.requestedGroup) {
      this.unexpectedKexMessage(payload[0]);
      return;
    }
    let prime: bigint;
    let generator: bigint;
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      prime = reader.readMpint();
      generator = reader.readMpint();
    } catch {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'invalid KEX_DH_GEX_GROUP', 'protocol');
      return;
    }
    const bits = prime.toString(2).length;
    if (bits < this.requestedGroup.min || bits > this.requestedGroup.max || generator < 2n || generator >= prime - 1n) {
      this.abort(SSH_DISCONNECT_KEY_EXCHANGE_FAILED, `DH parameter out of range: ${bits}`, 'protocol');
      return;
    }
    this.exchangeGroup = { ...this.requestedGroup, prime, generator };
    this.ephemeral = this.method.generate(this.random, this.keyMaterialNeeded(), { id: 0, bits, prime, generator });
    this.sendPacket(writeKexValue(new SshWriter().writeByte(SSH_MSG_KEX_DH_GEX_INIT),
      this.method.encoding, this.ephemeral.publicKey).toBytes());
  }

  private keyMaterialNeeded(): number {
    const negotiated = this.negotiated!;
    let need = 0;
    for (const [cipherName, macName] of [
      [negotiated.encryptionClientToServer, negotiated.macClientToServer],
      [negotiated.encryptionServerToClient, negotiated.macServerToClient],
    ] as const) {
      const cipher = cipherSpec(cipherName)!;
      need = Math.max(need, cipher.keyLength, cipher.blockSize, cipher.ivLength, macName ? macSpec(macName)!.keyLength : 0);
    }
    return need;
  }

  private receiveKexdhInit(payload: Uint8Array): void {
    if (this.config.role !== 'server' || this.phase !== 'kex' || !this.negotiated || !this.method
      || !this.peerKexInit || !this.peer) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'protocol error: unexpected KEXDH_INIT', 'protocol');
      return;
    }
    const method = this.method;
    let clientPublic: Uint8Array;
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      clientPublic = readKexValue(reader, method.encoding);
    } catch {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'invalid KEXDH_INIT', 'protocol');
      return;
    }
    const negotiated = this.negotiated;
    const hostKey = (this.config.hostKeys ?? []).find((k) => hostKeyAlgorithmsOf(k).includes(negotiated.hostKey));
    const group = this.exchangeGroup;
    if (method.groupExchange && group === null) {
      this.unexpectedKexMessage(payload[0]);
      return;
    }
    const ephemeral = method.generate(this.random, this.keyMaterialNeeded(),
      group === null ? undefined : { id: 0, bits: group.prime.toString(2).length, ...group });
    const shared = ephemeral.sharedSecret(clientPublic);
    if (!hostKey || shared === null) {
      this.abort(SSH_DISCONNECT_KEY_EXCHANGE_FAILED, 'invalid client public key', 'protocol');
      return;
    }
    const hash = exchangeHash({
      method,
      clientIdentification: this.peer.line,
      serverIdentification: this.config.identification,
      clientKexInit: this.peerKexInit,
      serverKexInit: this.myKexInit,
      hostKeyBlob: hostKey.publicKeyBlob,
      clientPublic,
      serverPublic: ephemeral.publicKey,
      sharedSecret: shared,
      ...(group === null ? {} : { groupExchange: group }),
    });
    this.sessionId ??= hash;
    this.hostKey = { algorithm: negotiated.hostKey, blob: hostKey.publicKeyBlob };
    const reply = new SshWriter()
      .writeByte(method.groupExchange ? SSH_MSG_KEX_DH_GEX_REPLY : SSH_MSG_KEXDH_REPLY)
      .writeBytes(hostKey.publicKeyBlob);
    writeKexValue(reply, method.encoding, ephemeral.publicKey);
    this.sendPacket(reply.writeBytes(signWithAlgorithm(hostKey.privateKey, negotiated.hostKey, hash)).toBytes());
    this.installKeys(shared, hash);
  }

  private receiveKexdhReply(payload: Uint8Array): void {
    if (this.config.role !== 'client' || this.phase !== 'kex' || !this.negotiated || !this.method
      || !this.peerKexInit || !this.ephemeral || !this.peer) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'protocol error: unexpected KEXDH_REPLY', 'protocol');
      return;
    }
    const method = this.method;
    let hostKeyBlob: Uint8Array;
    let serverPublic: Uint8Array;
    let signature: Uint8Array;
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      hostKeyBlob = reader.readBytes();
      serverPublic = readKexValue(reader, method.encoding);
      signature = reader.readBytes();
    } catch {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'invalid KEXDH_REPLY', 'protocol');
      return;
    }
    if (this.config.verifyHostKey && !this.config.verifyHostKey(this.negotiated.hostKey, hostKeyBlob)) {
      this.conclude({ ok: false, kind: 'hostkey', message: 'Host key verification failed.' });
      this.shutDown('host key verification failed');
      return;
    }
    const shared = this.ephemeral.sharedSecret(serverPublic);
    if (shared === null) {
      this.abort(SSH_DISCONNECT_KEY_EXCHANGE_FAILED, 'invalid server public key', 'protocol');
      return;
    }
    const hash = exchangeHash({
      method,
      clientIdentification: this.config.identification,
      serverIdentification: this.peer.line,
      clientKexInit: this.myKexInit,
      serverKexInit: this.peerKexInit,
      hostKeyBlob,
      clientPublic: this.ephemeral.publicKey,
      serverPublic,
      sharedSecret: shared,
      ...(this.exchangeGroup === null ? {} : { groupExchange: this.exchangeGroup }),
    });
    if (!verifyUserauthSignature(hostKeyBlob, this.negotiated.hostKey, signature, hash)) {
      this.abort(SSH_DISCONNECT_HOST_KEY_NOT_VERIFIABLE, 'incorrect signature', 'signature');
      return;
    }
    this.sessionId ??= hash;
    this.hostKey = { algorithm: this.negotiated.hostKey, blob: hostKeyBlob };
    this.installKeys(shared, hash);
  }

  private installKeys(shared: bigint, hash: Uint8Array): void {
    const negotiated = this.negotiated!;
    const method = this.method!;
    const sessionId = this.sessionId!;
    const derive = (letter: KeyLetter, length: number): Uint8Array =>
      deriveKey(method.hash, shared, hash, letter, sessionId, length);
    const protection = (
      cipherName: string, macName: string | null, ivLetter: KeyLetter, keyLetter: KeyLetter, macLetter: KeyLetter,
    ): PacketProtection => {
      const cipher = cipherSpec(cipherName)!;
      const mac = macName === null ? null : macSpec(macName)!;
      return {
        cipher: cipher.create(derive(keyLetter, cipher.keyLength), derive(ivLetter, cipher.ivLength)),
        mac: mac === null ? null : mac.create(derive(macLetter, mac.keyLength)),
      };
    };
    const clientToServer = protection(
      negotiated.encryptionClientToServer, negotiated.macClientToServer, 'A', 'C', 'E');
    const serverToClient = protection(
      negotiated.encryptionServerToClient, negotiated.macServerToClient, 'B', 'D', 'F');
    const client = this.config.role === 'client';
    this.sendPacket(new Uint8Array([SSH_MSG_NEWKEYS]));
    this.outgoing = client ? clientToServer : serverToClient;
    this.nextIncoming = client ? serverToClient : clientToServer;
    this.phase = 'newkeys';
    if (this.peerOffersExtInfo) this.sendExtInfo();
  }

  private sendExtInfo(): void {
    this.sendPacket(new SshWriter()
      .writeByte(SSH_MSG_EXT_INFO).writeUint32(2)
      .writeString(SERVER_SIG_ALGS).writeString(SERVER_SIGNATURE_ALGORITHMS.join(','))
      .writeString(PUBLICKEY_HOSTBOUND).writeString('0')
      .toBytes());
  }

  private receiveExtInfo(payload: Uint8Array): void {
    if (this.config.role !== 'client') {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'protocol error: unexpected EXT_INFO', 'protocol');
      return;
    }
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      const count = reader.readUint32();
      for (let i = 0; i < count; i++) {
        const name = reader.readString();
        const value = reader.readString();
        if (name === SERVER_SIG_ALGS) this.serverSignatureAlgorithms = value.split(',').filter((v) => v !== '');
      }
    } catch {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'invalid EXT_INFO', 'protocol');
    }
  }

  private receiveNewKeys(): void {
    if (this.phase !== 'newkeys' || this.nextIncoming === null) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'protocol error: unexpected NEWKEYS', 'protocol');
      return;
    }
    this.incoming = this.nextIncoming;
    this.nextIncoming = null;
    this.phase = 'service';
    if (this.config.role === 'client') {
      this.sendPacket(new SshWriter()
        .writeByte(SSH_MSG_SERVICE_REQUEST).writeString(SSH_USERAUTH_SERVICE).toBytes());
    }
  }

  private receiveServiceRequest(payload: Uint8Array): void {
    let service = '';
    try {
      const reader = new SshReader(payload);
      reader.readByte();
      service = reader.readString();
    } catch {
      service = '';
    }
    if (this.config.role !== 'server' || (this.phase !== 'service' && this.phase !== 'open')) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'protocol error: unexpected SERVICE_REQUEST', 'protocol');
      return;
    }
    if (service !== SSH_USERAUTH_SERVICE || this.userAuthenticated) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, `bad service request ${service}`, 'protocol');
      return;
    }
    this.sendPacket(new SshWriter().writeByte(SSH_MSG_SERVICE_ACCEPT).writeString(service).toBytes());
    if (this.phase === 'service') this.open();
  }

  private receiveServiceAccept(payload: Uint8Array): void {
    if (this.config.role !== 'client' || (this.phase !== 'service' && this.phase !== 'open')) {
      this.abort(SSH_DISCONNECT_PROTOCOL_ERROR, 'protocol error: unexpected SERVICE_ACCEPT', 'protocol');
      return;
    }
    if (this.phase === 'service') {
      this.open();
      return;
    }
    if (this.handlers.size === 0) this.undelivered.push(payload);
    for (const handler of [...this.handlers]) handler(payload);
  }

  private open(): void {
    this.phase = 'open';
    this.conclude({
      ok: true,
      sessionId: this.sessionId!,
      peerIdentification: this.peer!,
      hostKeyAlgorithm: this.hostKey!.algorithm,
      hostKeyBlob: this.hostKey!.blob,
      algorithms: this.negotiated!,
      serverSignatureAlgorithms: this.serverSignatureAlgorithms,
    });
  }

  private abort(reason: number, description: string, kind: SshTransportFailureKind): void {
    this.conclude({ ok: false, kind, message: description });
    this.disconnect(reason, description);
  }

  private lost(reason: string): void {
    this.peerClosed = reason;
    this.drain();
  }

  private finishLost(reason: string): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.conclude({ ok: false, kind: 'closed', message: 'Connection closed by remote host', identified: this.peer !== null });
    this.notifyClosed(reason);
  }

  private shutDown(reason: string): void {
    this.phase = 'closed';
    this.conn.close();
    this.notifyClosed(reason);
  }

  private notifyClosed(reason: string): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    for (const handler of [...this.closeHandlers]) handler(reason);
  }

  private conclude(outcome: SshTransportOutcome): void {
    if (this.outcome !== null) return;
    this.outcome = outcome;
    this.settle(outcome);
  }
}

const LEGACY_FRAGMENT = 32 * 1024;
const LEGACY_FINAL = 0;
const LEGACY_MORE = 1;

export function legacyFrameStream(transport: SshTransport, conn: TcpStream): TcpStream {
  const listeners = new Set<(data: string) => void>();
  const parts: Uint8Array[] = [];
  transport.onMessage((payload) => {
    if (payload[0] !== SSH_MSG_LOCAL_LEGACY_FRAME || payload.length < 2) return;
    parts.push(payload.slice(2));
    if (payload[1] !== LEGACY_FINAL) return;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const whole = new Uint8Array(total);
    let offset = 0;
    for (const p of parts.splice(0)) { whole.set(p, offset); offset += p.length; }
    const text = bytesToUtf8(whole);
    for (const listener of [...listeners]) listener(text);
  });
  const stream: TcpStream = {
    localIp: conn.localIp,
    localPort: conn.localPort,
    remoteIp: conn.remoteIp,
    remotePort: conn.remotePort,
    write: (data: string) => {
      const bytes = utf8ToBytes(data);
      let offset = 0;
      do {
        const chunk = bytes.subarray(offset, offset + LEGACY_FRAGMENT);
        offset += chunk.length;
        const frame = new Uint8Array(2 + chunk.length);
        frame[0] = SSH_MSG_LOCAL_LEGACY_FRAME;
        frame[1] = offset < bytes.length ? LEGACY_MORE : LEGACY_FINAL;
        frame.set(chunk, 2);
        transport.send(frame);
      } while (offset < bytes.length);
    },
    close: () => transport.disconnect(SSH_DISCONNECT_BY_APPLICATION, 'disconnected by user'),
    onData: (handler) => {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
    onClose: (handler) => transport.onClose(handler),
  };
  if (conn.setNoDelay) stream.setNoDelay = (enabled: boolean) => conn.setNoDelay!(enabled);
  return stream;
}
