import type { EndHost, UdpDelivery } from '@/network/devices/EndHost';
import type { IEventBus } from '@/events/EventBus';
import { IPAddress } from '@/network/core/types';
import { QUIC_VERSION_1, type PacketProtectionKeys, type PacketNumberSpace } from './types';
import { encodeLongHeader, decodeLongHeader, encodeShortHeader, decodeShortHeader } from './packetFormat';
import { encodeFrame, decodeFrames, type QuicFrame } from './frames';
import { protectBody, unprotectBody } from './packetProtection';
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

const ACK_ELICITING_TYPES = new Set<QuicFrame['type']>(['PING', 'STREAM', 'HANDSHAKE_DONE']);
const DEFAULT_DRAIN_MS = 3000;

/**
 * A QUIC connection state machine (RFC 9000 §5/§9/§10) over the project's
 * real UDP transport (`EndHost.sendUdpDatagram`/`udpBind`) — no new
 * transport abstraction. Handshake uses test-injected keys, not real TLS
 * (that integration is P8, once PRD-TLS.md is implemented): the "Initial"
 * exchange here is a minimal stand-in that exercises the real state
 * transitions, framing, and packet protection without modeling CRYPTO
 * frames/TLS flights. Once established, streams (P6), loss recovery (P4)
 * and congestion control (P5) are wired together for real: every
 * ack-eliciting packet gets an immediate ACK reply, which feeds both
 * subsystems.
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

  constructor(
    private readonly host: EndHost,
    private readonly role: QuicRole,
    private readonly localPort: number,
    private readonly keys: QuicTestKeys,
    private readonly eventBus?: IEventBus,
  ) {
    this.streams = new QuicStreamManager(role);
    host.udpBind(localPort, (delivery) => this.handleDatagram(delivery));
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

  connect(remoteIp: string, remotePort: number): void {
    this.peer = { ip: remoteIp, port: remotePort };
    this.state = 'handshaking';
    this.sendPacket('initial', [{ type: 'PING' }], true);
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
    const keys = space === 'application' ? this.keys.application : this.keys.initial;
    const ciphertext = protectBody(keys, pn, plaintext);

    const bytes = space === 'application'
      ? encodeShortHeader({ form: 'short', destConnectionId: '', packetNumber: pn, payload: ciphertext })
      : encodeLongHeader({ form: 'long', type: 'initial', version: QUIC_VERSION_1, destConnectionId: '', srcConnectionId: '', packetNumber: pn, payload: ciphertext });

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

    const space: PacketNumberSpace = decoded.packet.form === 'long' ? 'initial' : 'application';
    const keys = space === 'application' ? this.keys.application : this.keys.initial;
    const packetNumber = decoded.packet.packetNumber ?? 0;
    const plaintext = unprotectBody(keys, packetNumber, decoded.packet.payload);
    const { frames } = decodeFrames(plaintext);
    this.emit({ topic: 'quic.packet.received', payload: { connectionId: this.connectionId, role: this.role, space, packetNumber, size: bytes.length } });

    let sawAckEliciting = false;
    for (const frame of frames) {
      if (ACK_ELICITING_TYPES.has(frame.type)) sawAckEliciting = true;
      this.handleFrame(frame, space);
    }
    if (sawAckEliciting && this.state !== 'closed') this.sendAck(space, packetNumber);
  }

  private handleFrame(frame: QuicFrame, space: PacketNumberSpace): void {
    switch (frame.type) {
      case 'PING':
        if (this.role === 'server' && this.state !== 'established') {
          this.state = 'established';
          this.sendPacket('initial', [{ type: 'HANDSHAKE_DONE' }], true);
          this.emit({ topic: 'quic.connection.established', payload: { connectionId: this.connectionId, role: this.role } });
        }
        return;

      case 'HANDSHAKE_DONE':
        if (this.role === 'client') {
          this.state = 'established';
          this.emit({ topic: 'quic.connection.established', payload: { connectionId: this.connectionId, role: this.role } });
        }
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
