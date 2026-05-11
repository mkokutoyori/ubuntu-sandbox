/**
 * DHCP — reactive event taxonomy.
 *
 * Co-located with the DHCP module. Covers both client (DORA, lease
 * lifecycle, conflict) and server (allocation / release) sides.
 */

export interface DhcpDeviceRef {
  /** Device id of the host running this DHCP engine. */
  deviceId: string;
  hostname?: string;
}

// ── Engine lifecycle ────────────────────────────────────────────────────

export interface DhcpEngineStartedPayload extends DhcpDeviceRef {
  role: 'client' | 'server';
}
export interface DhcpEngineStoppedPayload extends DhcpDeviceRef {
  role: 'client' | 'server';
}

// ── Client-side events ─────────────────────────────────────────────────

export interface DhcpClientStateChangedPayload extends DhcpDeviceRef {
  iface: string;
  oldState: string; // INIT, SELECTING, REQUESTING, BOUND, RENEWING, REBINDING, INIT-REBOOT, REBOOTING, RELEASED
  newState: string;
  cause: string;
}

export interface DhcpDiscoverSentPayload extends DhcpDeviceRef {
  iface: string;
  xid: number;
}

export interface DhcpOfferReceivedPayload extends DhcpDeviceRef {
  iface: string;
  serverIp: string;
  offeredIp: string;
  leaseTimeSec: number;
}

export interface DhcpRequestSentPayload extends DhcpDeviceRef {
  iface: string;
  serverIp: string;
  requestedIp: string;
  xid: number;
}

export interface DhcpAckReceivedPayload extends DhcpDeviceRef {
  iface: string;
  serverIp: string;
  assignedIp: string;
  mask: string;
  gateway: string | null;
  leaseTimeSec: number;
  t1Sec: number;
  t2Sec: number;
}

export interface DhcpNakReceivedPayload extends DhcpDeviceRef {
  iface: string;
  serverIp: string;
  reason?: string;
}

export interface DhcpLeaseGrantedPayload extends DhcpDeviceRef {
  iface: string;
  ip: string;
  mask: string;
  gateway: string | null;
  leaseTimeSec: number;
}

export interface DhcpLeaseRenewingPayload extends DhcpDeviceRef {
  iface: string;
  ip: string;
}

export interface DhcpLeaseRebindingPayload extends DhcpDeviceRef {
  iface: string;
  ip: string;
}

export interface DhcpLeaseExpiredPayload extends DhcpDeviceRef {
  iface: string;
  ip: string;
}

export interface DhcpLeaseReleasedPayload extends DhcpDeviceRef {
  iface: string;
  ip: string;
  serverIp: string;
}

export interface DhcpDeclineSentPayload extends DhcpDeviceRef {
  iface: string;
  serverIp: string;
  ip: string;
  reason: 'arp-conflict' | 'manual';
}

export interface DhcpAddressConflictPayload extends DhcpDeviceRef {
  iface: string;
  ip: string;
}

// ── Server-side events ────────────────────────────────────────────────

export interface DhcpPoolLeaseAllocatedPayload extends DhcpDeviceRef {
  pool: string;
  clientMac: string;
  ip: string;
  leaseTimeSec: number;
}

export interface DhcpPoolLeaseReleasedPayload extends DhcpDeviceRef {
  pool: string;
  ip: string;
  reason: 'client-release' | 'expired' | 'manual' | 'declined';
}

export interface DhcpReservationAddedPayload extends DhcpDeviceRef {
  pool: string;
  clientMac: string;
  ip: string;
}

// ── Discriminated union ───────────────────────────────────────────────

export type DhcpDomainEvent =
  | { topic: 'dhcp.engine.started'; payload: DhcpEngineStartedPayload }
  | { topic: 'dhcp.engine.stopped'; payload: DhcpEngineStoppedPayload }
  | { topic: 'dhcp.client.state-changed'; payload: DhcpClientStateChangedPayload }
  | { topic: 'dhcp.discover.sent'; payload: DhcpDiscoverSentPayload }
  | { topic: 'dhcp.offer.received'; payload: DhcpOfferReceivedPayload }
  | { topic: 'dhcp.request.sent'; payload: DhcpRequestSentPayload }
  | { topic: 'dhcp.ack.received'; payload: DhcpAckReceivedPayload }
  | { topic: 'dhcp.nak.received'; payload: DhcpNakReceivedPayload }
  | { topic: 'dhcp.lease.granted'; payload: DhcpLeaseGrantedPayload }
  | { topic: 'dhcp.lease.renewing'; payload: DhcpLeaseRenewingPayload }
  | { topic: 'dhcp.lease.rebinding'; payload: DhcpLeaseRebindingPayload }
  | { topic: 'dhcp.lease.expired'; payload: DhcpLeaseExpiredPayload }
  | { topic: 'dhcp.lease.released'; payload: DhcpLeaseReleasedPayload }
  | { topic: 'dhcp.decline.sent'; payload: DhcpDeclineSentPayload }
  | { topic: 'dhcp.address-conflict'; payload: DhcpAddressConflictPayload }
  | { topic: 'dhcp.pool.lease-allocated'; payload: DhcpPoolLeaseAllocatedPayload }
  | { topic: 'dhcp.pool.lease-released'; payload: DhcpPoolLeaseReleasedPayload }
  | { topic: 'dhcp.reservation.added'; payload: DhcpReservationAddedPayload };
