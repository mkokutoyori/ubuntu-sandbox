/**
 * RIP — reactive event taxonomy.
 *
 * Co-located with the RIP module so the protocol's event surface is
 * documented next to its implementation. The union is integrated into
 * the global `DomainEvent` (`src/events/types.ts`).
 */

import type { IPAddress, SubnetMask } from '../core/types';

export interface RipDeviceRef {
  deviceId: string;
  hostname?: string;
}

// ── Engine lifecycle ───────────────────────────────────────────────────

export interface RipEngineStartedPayload extends RipDeviceRef {
  updateIntervalMs: number;
}
export interface RipEngineStoppedPayload extends RipDeviceRef {}

// ── Route lifecycle ───────────────────────────────────────────────────

export interface RipRouteAddedPayload extends RipDeviceRef {
  network: string; // dotted-decimal
  mask: string;
  nextHop: string;
  iface: string;
  metric: number;
  learnedFrom: string;
}

export interface RipRouteUpdatedPayload extends RipDeviceRef {
  network: string;
  mask: string;
  oldMetric: number;
  newMetric: number;
  nextHop: string;
  iface: string;
}

export interface RipRouteTimedOutPayload extends RipDeviceRef {
  network: string;
  mask: string;
}

export interface RipRouteRemovedPayload extends RipDeviceRef {
  network: string;
  mask: string;
  reason: 'timeout' | 'gc' | 'better-metric' | 'manual';
}

// ── Update sent / received ────────────────────────────────────────────

export interface RipUpdateSentPayload extends RipDeviceRef {
  iface: string;
  routeCount: number;
  destIp: string;
  triggered: boolean;
}

export interface RipUpdateReceivedPayload extends RipDeviceRef {
  iface: string;
  fromIp: string;
  routeCount: number;
}

// ── Discriminated union ────────────────────────────────────────────────

export type RipDomainEvent =
  | { topic: 'rip.engine.started'; payload: RipEngineStartedPayload }
  | { topic: 'rip.engine.stopped'; payload: RipEngineStoppedPayload }
  | { topic: 'rip.route.added'; payload: RipRouteAddedPayload }
  | { topic: 'rip.route.updated'; payload: RipRouteUpdatedPayload }
  | { topic: 'rip.route.timed-out'; payload: RipRouteTimedOutPayload }
  | { topic: 'rip.route.removed'; payload: RipRouteRemovedPayload }
  | { topic: 'rip.update.sent'; payload: RipUpdateSentPayload }
  | { topic: 'rip.update.received'; payload: RipUpdateReceivedPayload };
