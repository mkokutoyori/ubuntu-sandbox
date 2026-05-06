/**
 * Domain event types.
 *
 * The full taxonomy of topics is documented in
 * `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.2 and §12.4.
 *
 * Each phase of the refactor extends this union with the topics it requires.
 *
 * Type-only imports are used for domain types (`EthernetFrame`, `MACAddress`,
 * etc.) to keep the events module zero-runtime-cost and to avoid any
 * circular runtime dependency between `src/events/` and `src/network/`.
 */

import type {
  EthernetFrame,
  MACAddress,
  IPAddress,
  IPv6Address,
  SubnetMask,
  PortDuplex,
  PortSpeed,
  PortViolationMode,
} from '@/network/core/types';

// ──────────────────────────────────────────────────────────────────────────
// Cross-cutting
// ──────────────────────────────────────────────────────────────────────────

export interface LogEventPayload {
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  event: string;
  message: string;
  data?: unknown;
}

export interface BusHandlerErrorPayload {
  topic: string;
  error: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// Device lifecycle (consumed by Phase 2)
// ──────────────────────────────────────────────────────────────────────────

export interface DeviceRegisteredPayload {
  id: string;
  type: string;
  name: string;
}

export interface DeviceDeregisteredPayload {
  id: string;
}

export interface DevicePowerOnPayload {
  id: string;
}

export interface DevicePowerOffPayload {
  id: string;
}

export interface DevicePositionChangedPayload {
  id: string;
  x: number;
  y: number;
}

export interface DeviceRenamedPayload {
  id: string;
  oldName: string;
  newName: string;
}

export interface RegistryClearedPayload {
  reason?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Hardware: Port (Phase 3)
// ──────────────────────────────────────────────────────────────────────────

export interface PortRef {
  deviceId: string;
  portName: string;
}

export interface PortFrameTxRequestedPayload extends PortRef {
  frame: EthernetFrame;
}

export interface PortFrameTxBlockedPayload extends PortRef {
  reason: 'link-down' | 'no-cable' | 'powered-off';
}

export interface PortFrameReceivedPayload extends PortRef {
  frame: EthernetFrame;
}

export interface PortFrameDroppedPayload extends PortRef {
  reason: 'link-down' | 'security-violation';
  /** Source MAC of the dropped frame, when available. */
  srcMac?: MACAddress;
}

export interface PortLinkUpPayload extends PortRef {}
export interface PortLinkDownPayload extends PortRef {}

export interface PortIpChangedPayload extends PortRef {
  ip: IPAddress | null;
  mask: SubnetMask | null;
}

export interface PortIpv6AddedPayload extends PortRef {
  address: IPv6Address;
  prefixLength: number;
  origin: 'link-local' | 'static' | 'slaac' | 'dhcpv6';
}

export interface PortIpv6RemovedPayload extends PortRef {
  address: IPv6Address;
}

export interface PortMtuChangedPayload extends PortRef {
  mtu: number;
}

export interface PortSpeedChangedPayload extends PortRef {
  speed: PortSpeed;
}

export interface PortDuplexChangedPayload extends PortRef {
  duplex: PortDuplex;
}

export interface PortSecurityViolationPayload extends PortRef {
  mac: MACAddress;
  mode: PortViolationMode;
  action: 'discarded' | 'shutdown' | 'restricted';
}

// ──────────────────────────────────────────────────────────────────────────
// Hardware: Cable (Phase 3)
// ──────────────────────────────────────────────────────────────────────────

export interface CableRef {
  cableId: string;
}

export interface CableConnectedPayload extends CableRef {
  portA: PortRef;
  portB: PortRef;
  cableType: string;
}

export interface CableDisconnectedPayload extends CableRef {}

export interface CableNegotiatedPayload extends CableRef {
  speed: PortSpeed;
  duplex: PortDuplex;
}

export interface CableDuplexMismatchPayload extends CableRef {
  portA: PortRef;
  portB: PortRef;
}

export interface CableFrameDispatchedPayload extends CableRef {
  from: PortRef;
  to: PortRef;
  frame: EthernetFrame;
  propagationMs: number;
}

export interface CableFrameDeliveredPayload extends CableRef {
  from: PortRef;
  to: PortRef;
  frame: EthernetFrame;
}

export interface CableFrameLostPayload extends CableRef {
  reason: 'simulated-loss' | 'cable-down' | 'no-peer';
}

// ──────────────────────────────────────────────────────────────────────────
// Discriminated union
// ──────────────────────────────────────────────────────────────────────────

export type DomainEvent =
  // Cross-cutting
  | { topic: 'log'; payload: LogEventPayload }
  | { topic: 'bus.handler-error'; payload: BusHandlerErrorPayload }
  // Device lifecycle
  | { topic: 'device.registered'; payload: DeviceRegisteredPayload }
  | { topic: 'device.deregistered'; payload: DeviceDeregisteredPayload }
  | { topic: 'device.power-on'; payload: DevicePowerOnPayload }
  | { topic: 'device.power-off'; payload: DevicePowerOffPayload }
  | { topic: 'device.position-changed'; payload: DevicePositionChangedPayload }
  | { topic: 'device.renamed'; payload: DeviceRenamedPayload }
  | { topic: 'registry.cleared'; payload: RegistryClearedPayload }
  // Port
  | { topic: 'port.frame.tx-requested'; payload: PortFrameTxRequestedPayload }
  | { topic: 'port.frame.tx-blocked'; payload: PortFrameTxBlockedPayload }
  | { topic: 'port.frame.received'; payload: PortFrameReceivedPayload }
  | { topic: 'port.frame.dropped'; payload: PortFrameDroppedPayload }
  | { topic: 'port.link.up'; payload: PortLinkUpPayload }
  | { topic: 'port.link.down'; payload: PortLinkDownPayload }
  | { topic: 'port.config.ip-changed'; payload: PortIpChangedPayload }
  | { topic: 'port.config.ipv6-added'; payload: PortIpv6AddedPayload }
  | { topic: 'port.config.ipv6-removed'; payload: PortIpv6RemovedPayload }
  | { topic: 'port.config.mtu-changed'; payload: PortMtuChangedPayload }
  | { topic: 'port.config.speed-changed'; payload: PortSpeedChangedPayload }
  | { topic: 'port.config.duplex-changed'; payload: PortDuplexChangedPayload }
  | { topic: 'port.security.violation'; payload: PortSecurityViolationPayload }
  // Cable
  | { topic: 'cable.connected'; payload: CableConnectedPayload }
  | { topic: 'cable.disconnected'; payload: CableDisconnectedPayload }
  | { topic: 'cable.negotiated'; payload: CableNegotiatedPayload }
  | { topic: 'cable.duplex-mismatch'; payload: CableDuplexMismatchPayload }
  | { topic: 'cable.frame.dispatched'; payload: CableFrameDispatchedPayload }
  | { topic: 'cable.frame.delivered'; payload: CableFrameDeliveredPayload }
  | { topic: 'cable.frame.lost'; payload: CableFrameLostPayload };

export type DomainEventTopic = DomainEvent['topic'];

export type EventOf<T extends DomainEventTopic> = Extract<DomainEvent, { topic: T }>;

export type PayloadOf<T extends DomainEventTopic> = EventOf<T>['payload'];
