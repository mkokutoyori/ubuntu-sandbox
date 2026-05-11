/**
 * NAT — reactive event taxonomy.
 *
 * Co-located with the NATEngine module. Topics are deviceId-scoped so
 * a multi-router topology stays clean on a shared bus.
 */

export interface NatDeviceRef {
  deviceId: string;
  routerName?: string;
}

// ── Engine lifecycle ───────────────────────────────────────────────────

export interface NatEngineConfiguredPayload extends NatDeviceRef {
  insideIfaces: string[];
  outsideIfaces: string[];
  staticEntryCount: number;
  poolCount: number;
  dynamicRuleCount: number;
}

// ── Translation lifecycle ──────────────────────────────────────────────

export interface NatSessionCreatedPayload extends NatDeviceRef {
  protocol: number;
  localIp: string;
  localPort: number;
  globalIp: string;
  globalPort: number;
  outsideIp: string;
  outsidePort: number;
  kind: 'static' | 'overload' | 'pool';
}

export interface NatSessionRemovedPayload extends NatDeviceRef {
  protocol: number;
  localIp: string;
  localPort: number;
  globalIp: string;
  globalPort: number;
  reason: 'expired' | 'manual' | 'flush';
}

export interface NatTranslationAppliedPayload extends NatDeviceRef {
  direction: 'inbound' | 'outbound';
  protocol: number;
  beforeSrcIp: string;
  beforeSrcPort: number;
  beforeDstIp: string;
  beforeDstPort: number;
  afterSrcIp: string;
  afterSrcPort: number;
  afterDstIp: string;
  afterDstPort: number;
  cacheHit: boolean;
}

export interface NatTcpStateChangedPayload extends NatDeviceRef {
  localIp: string;
  localPort: number;
  globalIp: string;
  globalPort: number;
  oldState: string;
  newState: string;
}

// ── Statistics ───────────────────────────────────────────────────────

export interface NatStaleSweepedPayload extends NatDeviceRef {
  sweepedCount: number;
  remainingSessions: number;
}

// ── Discriminated union ────────────────────────────────────────────────

export type NatDomainEvent =
  | { topic: 'nat.engine.configured'; payload: NatEngineConfiguredPayload }
  | { topic: 'nat.session.created'; payload: NatSessionCreatedPayload }
  | { topic: 'nat.session.removed'; payload: NatSessionRemovedPayload }
  | { topic: 'nat.translation.applied'; payload: NatTranslationAppliedPayload }
  | { topic: 'nat.tcp.state-changed'; payload: NatTcpStateChangedPayload }
  | { topic: 'nat.stale.sweeped'; payload: NatStaleSweepedPayload };
