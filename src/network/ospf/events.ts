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
  | { topic: 'ospf.packet.outgoing'; payload: OspfPacketOutgoingPayload };
