/**
 * PRD-QUIC.md §5 P12 — reactive event taxonomy (§2.1.11): dedicated
 * `quic.*` topics for connection lifecycle, per-packet send/receive/loss,
 * congestion window changes, and stream lifecycle — mirroring the shape
 * `PRD-TLS.md`'s `events.ts` already established (ephemeral,
 * connection-scoped state machines, no long-lived per-device engine),
 * every payload keyed by `connectionId` alone.
 */
import type { PacketNumberSpace } from './types';

export type QuicRole = 'client' | 'server';

export interface QuicConnectionRef {
  readonly connectionId: string;
  readonly role: QuicRole;
}

export type QuicConnectionEstablishedPayload = QuicConnectionRef;

export interface QuicConnectionClosingPayload extends QuicConnectionRef {
  readonly errorCode: number;
  readonly reason: string;
}

export type QuicConnectionClosedPayload = QuicConnectionRef;

export interface QuicPacketPayload extends QuicConnectionRef {
  readonly space: PacketNumberSpace;
  readonly packetNumber: number;
  readonly size: number;
}

export interface QuicPacketLostPayload extends QuicConnectionRef {
  readonly space: PacketNumberSpace;
  readonly packetNumber: number;
}

export type CongestionPhase = 'slow-start' | 'congestion-avoidance' | 'recovery';

export interface QuicCongestionWindowChangedPayload extends QuicConnectionRef {
  readonly congestionWindow: number;
  readonly phase: CongestionPhase;
}

export interface QuicStreamPayload extends QuicConnectionRef {
  readonly streamId: number;
}

export type QuicDomainEvent =
  | { topic: 'quic.connection.established'; payload: QuicConnectionEstablishedPayload }
  | { topic: 'quic.connection.closing'; payload: QuicConnectionClosingPayload }
  | { topic: 'quic.connection.closed'; payload: QuicConnectionClosedPayload }
  | { topic: 'quic.packet.sent'; payload: QuicPacketPayload }
  | { topic: 'quic.packet.received'; payload: QuicPacketPayload }
  | { topic: 'quic.packet.lost'; payload: QuicPacketLostPayload }
  | { topic: 'quic.congestion.window_changed'; payload: QuicCongestionWindowChangedPayload }
  | { topic: 'quic.stream.opened'; payload: QuicStreamPayload }
  | { topic: 'quic.stream.closed'; payload: QuicStreamPayload }
  | { topic: 'quic.stream.blocked'; payload: QuicStreamPayload };

let connectionNonceCounter = 0;

/** A stable per-connection correlator for `QuicDomainEvent` payloads, matching the shape of `TlsClientSession.sessionId`. */
export function randomConnectionId(): string {
  connectionNonceCounter += 1;
  return `quic-conn-${connectionNonceCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
