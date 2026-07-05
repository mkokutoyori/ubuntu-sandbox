import type { EndHost, UdpDelivery } from '@/network/devices/EndHost';
import type { IEventBus } from '@/events/EventBus';
import type { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsServerSession } from '@/network/tls/TlsServerSession';
import type { TlsRecord } from '@/network/tls/recordLayer';
import { IPAddress } from '@/network/core/types';
import { QUIC_VERSION_1, type PacketProtectionKeys, type PacketNumberSpace } from './types';
import { encodeLongHeader, decodeLongHeader, encodeShortHeader, decodeShortHeader } from './packetFormat';
import { encodeFrame, decodeFrames, type QuicFrame } from './frames';
import {
  protectBody, unprotectBody, deriveInitialSecrets, deriveQuicKeys,
  encodeTlsRecordsForCrypto, decodeTlsRecordsFromCrypto,
} from './packetProtection';
import { QuicStreamManager, type StreamDirection } from './QuicStream';
import { LossDetectionState, onPacketSent as onLossPacketSent, onAckReceived } from './lossRecovery';
import { createCongestionState, isInSlowStart, onPacketSent as onCongestionPacketSent, onPacketAcked, onPacketsLost, type CongestionState } from './congestionControl';
import { randomConnectionId, type QuicDomainEvent, type CongestionPhase } from './events';

export type QuicRole = 'client' | 'server';
export type QuicConnectionState = 'idle' | 'handshaking' | 'established' | 'closing' | 'draining' | 'closed';

export interface QuicTestKeys {
  initial: PacketProtectionKeys;
  application: PacketProtectionKeys;
}

/**
 * RFC 9001 — real TLS 1.3 integration (PRD-QUIC.md §5 P8). `tls` is the
 * peer-role-appropriate session (`TlsClientSession` for a client
 * connection, `TlsServerSession` for a server one) the caller has already
 * configured (certificates, verifier, ALPN, ...); `clientDestConnectionId`
 * is the client's chosen destination connection ID for its first Initial
 * packet (RFC 9001 §5.2) — both peers must be given the same value so
 * they derive the same Initial secrets. `QuicConnection` drives the
 * handshake (CRYPTO frames, Initial → Handshake → 1-RTT key transitions)
 * but never touches `src/network/tls/` itself beyond holding this
 * reference — all secret-to-QUIC-key derivation lives in
 * `packetProtection.ts`.
 */
export interface QuicTlsConfig {
  readonly tls: TlsClientSession | TlsServerSession;
  readonly clientDestConnectionId: string;
}

export type QuicKeyConfig =
  | { readonly mode: 'test-keys'; readonly keys: QuicTestKeys }
  | ({ readonly mode: 'tls' } & QuicTlsConfig);

export interface QuicMessage {
  streamId: number;
  data: Uint8Array;
  fin: boolean;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function binaryStringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function concatFrameBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

interface DirectionalKeys {
  readonly send: PacketProtectionKeys;
  readonly receive: PacketProtectionKeys;
}

const ACK_ELICITING_TYPES = new Set<QuicFrame['type']>(['PING', 'CRYPTO', 'STREAM', 'HANDSHAKE_DONE']);
const DEFAULT_DRAIN_MS = 3000;

/**
 * A QUIC connection state machine (RFC 9000 §5/§9/§10) over the project's
 * real UDP transport (`EndHost.sendUdpDatagram`/`udpBind`) — no new
 * transport abstraction. Two key-supply modes: `test-keys` (P3–P7's
 * minimal PING/HANDSHAKE_DONE stand-in, unchanged, for low-level tests
 * that don't need a real handshake) and `tls` (P8: a real
 * `TlsClientSession`/`TlsServerSession` drives the actual Initial →
 * Handshake → 1-RTT flight exchange over CRYPTO frames, RFC 9001).
 * Streams (P6), loss recovery (P4) and congestion control (P5) are wired
 * together for real in both modes: every ack-eliciting packet gets an
 * immediate ACK reply, which feeds both subsystems.
 */
export class QuicConnection {
  state: QuicConnectionState = 'idle';
  /** Stable per-connection correlator for `events.ts` payloads (§2.1.11). */
  readonly connectionId = randomConnectionId();
  private nextPacketNumber = 0;
  private peer: { ip: string; port: number } | null = null;
  private readonly streams: QuicStreamManager;
  private readonly lossState = new LossDetectionState();
  private readonly congestionState: CongestionState = createCongestionState();
  private readonly packetSizes = new Map<number, number>();
  private readonly closedStreamIds = new Set<number>();
  private readonly messageHandlers: Array<(msg: QuicMessage) => void> = [];
  private readonly closeHandlers: Array<(errorCode: number, reason: string) => void> = [];
  private closingSince: number | null = null;

  private initialKeys: DirectionalKeys | null = null;
  private handshakeKeys: DirectionalKeys | null = null;
  private applicationKeys: DirectionalKeys | null = null;
  private readonly cryptoSendOffset: Record<PacketNumberSpace, number> = { initial: 0, handshake: 0, application: 0 };

  constructor(
    private readonly host: EndHost,
    private readonly role: QuicRole,
    private readonly localPort: number,
    private readonly config: QuicKeyConfig,
    private readonly eventBus?: IEventBus,
  ) {
    this.streams = new QuicStreamManager(role);
    host.udpBind(localPort, (delivery) => this.handleDatagram(delivery));

    if (this.config.mode === 'test-keys') {
      this.initialKeys = { send: this.config.keys.initial, receive: this.config.keys.initial };
      this.applicationKeys = { send: this.config.keys.application, receive: this.config.keys.application };
    } else {
      const secrets = deriveInitialSecrets(this.config.clientDestConnectionId);
      this.initialKeys = this.directionalKeys('initial', secrets.client, secrets.server);
    }
  }

  private directionalKeys(space: PacketNumberSpace, clientSecret: string, serverSecret: string): DirectionalKeys {
    return this.role === 'client'
      ? { send: deriveQuicKeys(space, clientSecret), receive: deriveQuicKeys(space, serverSecret) }
      : { send: deriveQuicKeys(space, serverSecret), receive: deriveQuicKeys(space, clientSecret) };
  }

  /** Once the TLS session has computed its Handshake/Application secrets (available together, this simulator's key schedule derives them at the same checkpoint), derive the corresponding QUIC keys. */
  private refreshTlsDerivedKeys(): void {
    if (this.config.mode !== 'tls') return;
    const tls = this.config.tls;
    if (!this.handshakeKeys && tls.clientHandshakeTrafficSecret && tls.serverHandshakeTrafficSecret) {
      this.handshakeKeys = this.directionalKeys('handshake', tls.clientHandshakeTrafficSecret, tls.serverHandshakeTrafficSecret);
    }
    if (!this.applicationKeys && tls.clientApplicationTrafficSecret && tls.serverApplicationTrafficSecret) {
      this.applicationKeys = this.directionalKeys('application', tls.clientApplicationTrafficSecret, tls.serverApplicationTrafficSecret);
    }
  }

  private keysFor(space: PacketNumberSpace): DirectionalKeys {
    const keys = space === 'initial' ? this.initialKeys : space === 'handshake' ? this.handshakeKeys : this.applicationKeys;
    if (!keys) throw new Error(`QuicConnection: no ${space} keys available yet`);
    return keys;
  }

  private emit(event: QuicDomainEvent): void {
    this.eventBus?.publish(event);
  }

  private congestionPhase(): CongestionPhase {
    if (this.congestionState.congestionRecoveryStartTime !== null) return 'recovery';
    return isInSlowStart(this.congestionState) ? 'slow-start' : 'congestion-avoidance';
  }

  private emitWindowChanged(previousWindow: number): void {
    if (this.congestionState.congestionWindow === previousWindow) return;
    this.emit({
      topic: 'quic.congestion.window_changed',
      payload: { connectionId: this.connectionId, role: this.role, congestionWindow: this.congestionState.congestionWindow, phase: this.congestionPhase() },
    });
  }

  private markStreamClosedIfDone(streamId: number): void {
    if (this.closedStreamIds.has(streamId)) return;
    const stream = this.streams.get(streamId);
    if (!stream || !stream.finSent || !stream.finReceived) return;
    this.closedStreamIds.add(streamId);
    this.emit({ topic: 'quic.stream.closed', payload: { connectionId: this.connectionId, role: this.role, streamId } });
  }

  /** Client only — establishes the peer and, in `tls` mode, sends the initial ClientHello; in `test-keys` mode, sends the minimal PING stand-in. */
  connect(remoteIp: string, remotePort: number): void {
    this.peer = { ip: remoteIp, port: remotePort };
    this.state = 'handshaking';
    if (this.config.mode === 'test-keys') {
      this.sendPacket('initial', [{ type: 'PING' }], true);
      return;
    }
    const flight = (this.config.tls as TlsClientSession).start();
    this.sendCryptoRecords('initial', flight);
  }

  private sendCryptoRecords(space: PacketNumberSpace, records: readonly TlsRecord[]): void {
    if (records.length === 0) return;
    const data = encodeTlsRecordsForCrypto(records);
    const offset = this.cryptoSendOffset[space];
    this.cryptoSendOffset[space] += data.length;
    this.sendPacket(space, [{ type: 'CRYPTO', offset, length: data.length, data }], true);
  }

  openStream(direction: StreamDirection): number {
    const stream = this.streams.openStream(direction);
    this.emit({ topic: 'quic.stream.opened', payload: { connectionId: this.connectionId, role: this.role, streamId: stream.id } });
    return stream.id;
  }

  sendData(streamId: number, data: string | Uint8Array, fin = false): void {
    if (this.state !== 'established') return;
    const stream = this.streams.get(streamId) ?? this.streams.getOrCreatePeerStream(streamId);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const result = this.streams.trySend(stream, bytes, fin);
    if (result.frame) {
      this.sendPacket('application', [result.frame], true);
      this.markStreamClosedIfDone(streamId);
    } else if (result.blockedFrame) {
      this.sendPacket('application', [result.blockedFrame], true);
      this.emit({ topic: 'quic.stream.blocked', payload: { connectionId: this.connectionId, role: this.role, streamId } });
    }
  }

  onMessage(handler: (msg: QuicMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const i = this.messageHandlers.indexOf(handler);
      if (i !== -1) this.messageHandlers.splice(i, 1);
    };
  }

  onClose(handler: (errorCode: number, reason: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i !== -1) this.closeHandlers.splice(i, 1);
    };
  }

  close(errorCode = 0, reason = ''): void {
    if (this.state === 'closing' || this.state === 'draining' || this.state === 'closed') return;
    this.state = 'closing';
    this.closingSince = Date.now();
    this.emit({ topic: 'quic.connection.closing', payload: { connectionId: this.connectionId, role: this.role, errorCode, reason } });
    this.sendPacket('application', [{ type: 'CONNECTION_CLOSE', errorCode, reasonPhrase: reason, layer: 'application' }], false);
  }

  /** Advances closing -> draining -> closed once the drain period has elapsed; returns true once fully closed. */
  advanceClosing(now: number, drainMs = DEFAULT_DRAIN_MS): boolean {
    if (this.state === 'closed') return true;
    if (this.state !== 'closing' && this.state !== 'draining') return false;
    if (this.closingSince !== null && now - this.closingSince >= drainMs) {
      this.state = 'closed';
      this.emit({ topic: 'quic.connection.closed', payload: { connectionId: this.connectionId, role: this.role } });
      return true;
    }
    return false;
  }

  private sendPacket(space: PacketNumberSpace, frames: QuicFrame[], ackEliciting: boolean): void {
    if (!this.peer) return;
    const pn = this.nextPacketNumber++;
    const plaintext = concatFrameBytes(frames.map((f) => encodeFrame(f)));
    const ciphertext = protectBody(this.keysFor(space).send, pn, plaintext);

    const bytes = space === 'application'
      ? encodeShortHeader({ form: 'short', destConnectionId: '', packetNumber: pn, payload: ciphertext })
      : encodeLongHeader({
          form: 'long', type: space === 'handshake' ? 'handshake' : 'initial',
          version: QUIC_VERSION_1, destConnectionId: '', srcConnectionId: '', packetNumber: pn, payload: ciphertext,
        });

    onLossPacketSent(this.lossState, space, pn, bytes.length, ackEliciting, frames, Date.now());
    onCongestionPacketSent(this.congestionState, bytes.length);
    this.packetSizes.set(pn, bytes.length);

    this.host.sendUdpDatagram(new IPAddress(this.peer.ip), this.peer.port, this.localPort, bytesToBinaryString(bytes), bytes.length);
    this.emit({ topic: 'quic.packet.sent', payload: { connectionId: this.connectionId, role: this.role, space, packetNumber: pn, size: bytes.length } });
  }

  private sendAck(space: PacketNumberSpace, packetNumber: number): void {
    this.sendPacket(space, [{ type: 'ACK', largestAcknowledged: packetNumber, ackDelay: 0, ackRanges: [{ gap: 0, ackRangeLength: 0 }] }], false);
  }

  private handleDatagram(delivery: UdpDelivery): void {
    const bytes = binaryStringToBytes(String(delivery.udp.payload));
    const isLong = (bytes[0] & 0x80) !== 0;
    const decoded = isLong ? decodeLongHeader(bytes) : decodeShortHeader(bytes, 0);
    if (!decoded) return;

    if (!this.peer) this.peer = { ip: delivery.sourceIP.toString(), port: delivery.udp.sourcePort };

    const space: PacketNumberSpace =
      decoded.packet.form !== 'long' ? 'application' : decoded.packet.type === 'handshake' ? 'handshake' : 'initial';
    const packetNumber = decoded.packet.packetNumber ?? 0;
    const plaintext = unprotectBody(this.keysFor(space).receive, packetNumber, decoded.packet.payload);
    const { frames } = decodeFrames(plaintext);
    this.emit({ topic: 'quic.packet.received', payload: { connectionId: this.connectionId, role: this.role, space, packetNumber, size: bytes.length } });

    let sawAckEliciting = false;
    for (const frame of frames) {
      if (ACK_ELICITING_TYPES.has(frame.type)) sawAckEliciting = true;
      this.handleFrame(frame, space);
    }
    if (sawAckEliciting && this.state !== 'closed') this.sendAck(space, packetNumber);
  }

  private establish(): void {
    this.state = 'established';
    this.emit({ topic: 'quic.connection.established', payload: { connectionId: this.connectionId, role: this.role } });
  }

  /**
   * `tls` mode — processes CRYPTO frame data.
   *
   * This simulator's `TlsClientSession`/`TlsServerSession` derive the
   * Handshake-space traffic secrets as part of processing a *whole*
   * incoming flight in one `handle()` call, rather than exposing them the
   * moment ServerHello alone is seen (as a real implementation can, since
   * the Handshake secret only depends on ClientHello+ServerHello). That
   * means the client cannot derive its Handshake receive key before it
   * has *already* decrypted the server's protected bundle — a circular
   * dependency if that bundle is itself QUIC-protected with a Handshake
   * key. Simplification adopted here: the server's ServerHello + protected
   * bundle (its one reply to ClientHello) travels entirely over the
   * Initial space, whose keys both sides always have upfront. Once the
   * client has processed that flight, both sides share the Handshake
   * secrets, so the client's own reply (Finished) — and everything the
   * server sends afterward until 1-RTT — legitimately uses real
   * Handshake-space keys.
   */
  private handleCryptoFrame(frame: Extract<QuicFrame, { type: 'CRYPTO' }>, space: PacketNumberSpace): void {
    if (this.config.mode !== 'tls') return;
    const records = decodeTlsRecordsFromCrypto(frame.data);

    if (this.role === 'server') {
      if (space === 'initial') {
        const reply = (this.config.tls as TlsServerSession).handle(records);
        this.refreshTlsDerivedKeys();
        if (reply) this.sendCryptoRecords('initial', reply);
        return;
      }
      // The client's Finished, over the Handshake space.
      const reply = (this.config.tls as TlsServerSession).handle(records);
      if (reply) this.sendCryptoRecords('handshake', reply);
      if ((this.config.tls as TlsServerSession).result === 'accept') {
        this.establish();
        this.sendPacket('application', [{ type: 'HANDSHAKE_DONE' }], true);
      }
      return;
    }

    // Client: the server's whole reply to ClientHello arrives as one Initial-space flight.
    const reply = (this.config.tls as TlsClientSession).handle(records);
    this.refreshTlsDerivedKeys();
    if (reply) this.sendCryptoRecords('handshake', reply);
    // Established only once HANDSHAKE_DONE is received (RFC 9000 §4.1.2) — handled below.
  }

  private handleFrame(frame: QuicFrame, space: PacketNumberSpace): void {
    switch (frame.type) {
      case 'PING':
        if (this.config.mode === 'test-keys' && this.role === 'server' && this.state !== 'established') {
          this.sendPacket('initial', [{ type: 'HANDSHAKE_DONE' }], true);
          this.establish();
        }
        return;

      case 'CRYPTO':
        this.handleCryptoFrame(frame, space);
        return;

      case 'HANDSHAKE_DONE':
        if (this.role === 'client') this.establish();
        return;

      case 'STREAM': {
        const isNewPeerStream = this.streams.get(frame.streamId) === undefined;
        const stream = this.streams.receiveStreamFrame(frame);
        if (isNewPeerStream) this.emit({ topic: 'quic.stream.opened', payload: { connectionId: this.connectionId, role: this.role, streamId: stream.id } });
        for (const h of this.messageHandlers) h({ streamId: stream.id, data: frame.data, fin: frame.fin });
        this.markStreamClosedIfDone(stream.id);
        return;
      }

      case 'STREAM_DATA_BLOCKED':
        this.streams.grantStreamCredit(this.streams.getOrCreatePeerStream(frame.streamId), 65536);
        return;

      case 'DATA_BLOCKED':
        this.streams.grantConnectionCredit(65536);
        return;

      case 'ACK': {
        const acked = expandSingleRangeAck(frame);
        const { newlyAcked, lostPackets } = onAckReceived(this.lossState, space, acked, frame.ackDelay, Date.now());
        const windowBeforeAck = this.congestionState.congestionWindow;
        for (const pn of newlyAcked) {
          const size = this.packetSizes.get(pn);
          this.packetSizes.delete(pn);
          if (size !== undefined) onPacketAcked(this.congestionState, 0, size);
        }
        this.emitWindowChanged(windowBeforeAck);
        if (lostPackets.length > 0) {
          const windowBeforeLoss = this.congestionState.congestionWindow;
          const accounting = lostPackets
            .map((p) => ({ sentTime: 0, size: this.packetSizes.get(p.packetNumber) ?? 0 }));
          for (const p of lostPackets) {
            this.packetSizes.delete(p.packetNumber);
            this.emit({ topic: 'quic.packet.lost', payload: { connectionId: this.connectionId, role: this.role, space, packetNumber: p.packetNumber } });
          }
          onPacketsLost(this.congestionState, accounting, Date.now());
          this.emitWindowChanged(windowBeforeLoss);
        }
        return;
      }

      case 'CONNECTION_CLOSE':
        this.state = 'draining';
        this.closingSince = Date.now();
        this.emit({
          topic: 'quic.connection.closing',
          payload: { connectionId: this.connectionId, role: this.role, errorCode: frame.errorCode, reason: frame.reasonPhrase },
        });
        for (const h of this.closeHandlers) h(frame.errorCode, frame.reasonPhrase);
        return;

      default:
        return;
    }
  }
}

/** Expands a single-range ACK frame (as produced by `sendAck` above) into the list of acknowledged packet numbers. */
function expandSingleRangeAck(frame: Extract<QuicFrame, { type: 'ACK' }>): number[] {
  const acked: number[] = [];
  const first = frame.ackRanges[0];
  if (!first) return [frame.largestAcknowledged];
  for (let pn = frame.largestAcknowledged - first.ackRangeLength; pn <= frame.largestAcknowledged; pn++) acked.push(pn);
  return acked;
}
