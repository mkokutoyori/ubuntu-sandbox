/**
 * OSPF — reactive event taxonomy.
 *
 * Co-located with the OSPF module so that the protocol's surface is
 * documented next to its implementation. Each payload type is
 * referenced by the global `DomainEvent` discriminated union exposed in
 * `src/events/types.ts`, so consumers can subscribe with full type
 * safety.
 *
 * Topic naming follows the project-wide convention:
 *   `domain.subdomain[.action]` in kebab-case, transitions in past tense.
 */

import type {
  OSPFNeighborState, OSPFInterfaceState, OSPFNeighborEvent,
  LSAHeader, OSPFRouteEntry, OSPFPacket,
} from './types';

// ── Identity helpers ────────────────────────────────────────────────────

export interface OspfRouterRef {
  /** Router ID (dotted-decimal) of the router running the engine. */
  routerId: string;
  /** Process ID of the OSPF instance (allows multiple instances per router). */
  processId: number;
  /** Optional device id when the engine is bound to an Equipment. */
  deviceId?: string;
}

// ── Neighbor FSM ────────────────────────────────────────────────────────

export interface OspfNeighborStateChangedPayload extends OspfRouterRef {
  iface: string;
  neighborId: string;
  oldState: OSPFNeighborState;
  newState: OSPFNeighborState;
  event: OSPFNeighborEvent;
}

// ── Interface state ─────────────────────────────────────────────────────

export interface OspfInterfaceStateChangedPayload extends OspfRouterRef {
  iface: string;
  oldState: OSPFInterfaceState;
  newState: OSPFInterfaceState;
}

export interface OspfDrElectionPayload extends OspfRouterRef {
  iface: string;
  dr: string;
  bdr: string;
}

// ── LSA / LSDB ──────────────────────────────────────────────────────────

export interface OspfLsaInstalledPayload extends OspfRouterRef {
  areaId: string;
  lsa: LSAHeader;
}

export interface OspfLsaFlushedPayload extends OspfRouterRef {
  areaId: string;
  lsa: LSAHeader;
  reason: 'maxage' | 'topology-change';
}

export interface OspfLsaReceivedPayload extends OspfRouterRef {
  iface: string;
  fromRouterId: string;
  lsa: LSAHeader;
}

export interface OspfLsaRefreshedPayload extends OspfRouterRef {
  areaId: string;
  lsa: LSAHeader;
}

/**
 * Emitted by the LSA aging tick when a self-originated LSA reaches
 * `LS_REFRESH_TIME`. Consumed by `LsaRefreshActor` which performs the
 * actual refresh (bumps the seq, resets age, refloods). Splitting the
 * "what happened" (LSA is refresh-due) from the "what we do about it"
 * (refresh + reflood) keeps the policy pluggable.
 */
export interface OspfLsaRefreshDuePayload extends OspfRouterRef {
  areaId: string;
  lsa: LSAHeader;
}

// ── SPF ─────────────────────────────────────────────────────────────────

export interface OspfSpfRunPayload extends OspfRouterRef {
  kind: 'full' | 'partial';
  runtimeMs: number;
  routesCount: number;
  runIndex: number;
}

export interface OspfRoutesRecomputedPayload extends OspfRouterRef {
  routes: OSPFRouteEntry[];
}

// ── Area lifecycle ──────────────────────────────────────────────────────

export interface OspfAreaActivatedPayload extends OspfRouterRef {
  areaId: string;
}

// ── Packet egress (for Router data-plane integration) ──────────────────

export interface OspfPacketOutgoingPayload extends OspfRouterRef {
  iface: string;
  destIp: string;
  packet: OSPFPacket;
}

/**
 * Mirror of `ospf.packet.outgoing` for ingress: emitted at the top of
 * each `process*` entry point so that capture / replay / IDS-like
 * subscribers see exactly what arrived on the wire, before any
 * stateful processing.
 */
export interface OspfPacketReceivedPayload extends OspfRouterRef {
  iface: string;
  srcIp: string;
  packet: OSPFPacket;
}

// ── Lifecycle events (Phase 4b2-OSPF.lifecycle) ────────────────────────

/**
 * Emitted by the per-interface Hello timer at every interval tick.
 * Consumed by `HelloActor` which builds and dispatches the actual
 * Hello packet. Splitting the tick from the send keeps the policy
 * (e.g. authenticated Hello, padded Hello, suspended Hello for tests)
 * pluggable without touching the engine.
 */
export interface OspfHelloSendRequestedPayload extends OspfRouterRef {
  iface: string;
}

/**
 * Emitted by the per-neighbor DD retransmit timer when the
 * RxmtInterval elapses without a response. Consumed by
 * `RetransmitActor` which calls `engine.triggerDDRetransmit(...)`.
 */
export interface OspfDdRetransmitDuePayload extends OspfRouterRef {
  iface: string;
  neighborId: string;
}

/**
 * Emitted by the per-neighbor LSR retransmit timer when the
 * RxmtInterval elapses without a corresponding LSU. Consumed by
 * `RetransmitActor` which calls `engine.triggerLSRRetransmit(...)`.
 */
export interface OspfLsrRetransmitDuePayload extends OspfRouterRef {
  iface: string;
  neighborId: string;
}

// ── Topic union (added to DomainEvent in src/events/types.ts) ──────────

export type OspfDomainEvent =
  | { topic: 'ospf.neighbor.state-changed'; payload: OspfNeighborStateChangedPayload }
  | { topic: 'ospf.interface.state-changed'; payload: OspfInterfaceStateChangedPayload }
  | { topic: 'ospf.dr-election'; payload: OspfDrElectionPayload }
  | { topic: 'ospf.lsa.installed'; payload: OspfLsaInstalledPayload }
  | { topic: 'ospf.lsa.flushed'; payload: OspfLsaFlushedPayload }
  | { topic: 'ospf.lsa.received'; payload: OspfLsaReceivedPayload }
  | { topic: 'ospf.lsa.refreshed'; payload: OspfLsaRefreshedPayload }
  | { topic: 'ospf.lsa.refresh-due'; payload: OspfLsaRefreshDuePayload }
  | { topic: 'ospf.spf.run'; payload: OspfSpfRunPayload }
  | { topic: 'ospf.routes-recomputed'; payload: OspfRoutesRecomputedPayload }
  | { topic: 'ospf.area.activated'; payload: OspfAreaActivatedPayload }
  | { topic: 'ospf.packet.outgoing'; payload: OspfPacketOutgoingPayload }
  | { topic: 'ospf.packet.received'; payload: OspfPacketReceivedPayload }
  | { topic: 'ospf.hello.send-requested'; payload: OspfHelloSendRequestedPayload }
  | { topic: 'ospf.dd.retransmit-due'; payload: OspfDdRetransmitDuePayload }
  | { topic: 'ospf.lsr.retransmit-due'; payload: OspfLsrRetransmitDuePayload };
