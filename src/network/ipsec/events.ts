/**
 * IPSec — reactive event taxonomy.
 *
 * Co-located with the IPSec module so the protocol's event surface is
 * documented next to its implementation. The union is integrated into
 * the global `DomainEvent` (`src/events/types.ts`) so consumers
 * subscribe with full type safety.
 *
 * Topic naming follows the project-wide `domain.subdomain.action`
 * convention. Past tense for facts, present continuous for ongoing
 * intents.
 */

// ── Identity ────────────────────────────────────────────────────────────

export interface IpsecDeviceRef {
  /** Device id of the host router running this IPSec engine. */
  deviceId: string;
  /** Display name of the router for log readability. */
  routerName?: string;
}

// ── Engine lifecycle ────────────────────────────────────────────────────

export interface IpsecEngineStartedPayload extends IpsecDeviceRef {}
export interface IpsecEngineStoppedPayload extends IpsecDeviceRef {}

// ── IKE Security Associations ───────────────────────────────────────────

export interface IpsecIkeSaInstalledPayload extends IpsecDeviceRef {
  peerIp: string;
  localIp: string;
  /** 1 = IKEv1, 2 = IKEv2 */
  version: 1 | 2;
  /** ISAKMP cookie / IKEv2 SPI for the initiator side. */
  spiInitiator?: string;
  spiResponder?: string;
  lifetimeSec: number;
}

export interface IpsecIkeSaDeletedPayload extends IpsecDeviceRef {
  peerIp: string;
  reason: 'lifetime' | 'manual' | 'dpd' | 'replaced' | 'shutdown';
}

// ── IPSec (Phase 2) Security Associations ──────────────────────────────

export interface IpsecChildSaInstalledPayload extends IpsecDeviceRef {
  peerIp: string;
  spiInbound: number;
  spiOutbound: number;
  protocol: 'esp' | 'ah';
  mode: 'tunnel' | 'transport';
  encryption: string;
  integrity: string;
  lifetimeSec?: number;
  lifetimeKB?: number;
}

export interface IpsecChildSaDeletedPayload extends IpsecDeviceRef {
  peerIp: string;
  spiInbound: number;
  reason: 'lifetime' | 'manual' | 'replaced' | 'shutdown';
}

// ── DPD (Dead Peer Detection) ──────────────────────────────────────────

export interface IpsecDpdRequestSentPayload extends IpsecDeviceRef {
  peerIp: string;
  attempt: number;
}

export interface IpsecDpdPeerDownPayload extends IpsecDeviceRef {
  peerIp: string;
  retries: number;
}

// ── Fragment reassembly buffer ─────────────────────────────────────────

export interface IpsecFragmentTimeoutPayload extends IpsecDeviceRef {
  groupKey: string;
  fragmentsSeen: number;
}

// ── Inbound / outbound chain outcomes ──────────────────────────────────

export interface IpsecInboundOutcomePayload extends IpsecDeviceRef {
  spi: number;
  fromIp: string;
  outcome: 'accepted' | 'dropped' | 'rejected';
  reason?: string;
  code?: string;
  decidedBy?: string;
}

export interface IpsecOutboundOutcomePayload extends IpsecDeviceRef {
  toIp: string;
  outcome: 'accepted' | 'dropped' | 'rejected';
  reason?: string;
  code?: string;
  decidedBy?: string;
}

// ── Discriminated union ─────────────────────────────────────────────────

export type IpsecDomainEvent =
  | { topic: 'ipsec.engine.started'; payload: IpsecEngineStartedPayload }
  | { topic: 'ipsec.engine.stopped'; payload: IpsecEngineStoppedPayload }
  | { topic: 'ipsec.ike.sa-installed'; payload: IpsecIkeSaInstalledPayload }
  | { topic: 'ipsec.ike.sa-deleted'; payload: IpsecIkeSaDeletedPayload }
  | { topic: 'ipsec.sa.installed'; payload: IpsecChildSaInstalledPayload }
  | { topic: 'ipsec.sa.deleted'; payload: IpsecChildSaDeletedPayload }
  | { topic: 'ipsec.dpd.request-sent'; payload: IpsecDpdRequestSentPayload }
  | { topic: 'ipsec.dpd.peer-down'; payload: IpsecDpdPeerDownPayload }
  | { topic: 'ipsec.fragment.timeout'; payload: IpsecFragmentTimeoutPayload }
  | { topic: 'ipsec.inbound.outcome'; payload: IpsecInboundOutcomePayload }
  | { topic: 'ipsec.outbound.outcome'; payload: IpsecOutboundOutcomePayload };
