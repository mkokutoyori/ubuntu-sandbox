/**
 * Domain event types (Phase 1 — initial subset).
 *
 * The full taxonomy of topics is documented in
 * `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.2 and §12.4.
 *
 * Each phase of the refactor extends this union with the topics it requires.
 * Phase 1 ships only the cross-cutting topics (`log`, `bus.handler-error`)
 * plus device lifecycle topics consumed by Phase 2.
 */

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
// Discriminated union
// ──────────────────────────────────────────────────────────────────────────

export type DomainEvent =
  | { topic: 'log'; payload: LogEventPayload }
  | { topic: 'bus.handler-error'; payload: BusHandlerErrorPayload }
  | { topic: 'device.registered'; payload: DeviceRegisteredPayload }
  | { topic: 'device.deregistered'; payload: DeviceDeregisteredPayload }
  | { topic: 'device.power-on'; payload: DevicePowerOnPayload }
  | { topic: 'device.power-off'; payload: DevicePowerOffPayload }
  | { topic: 'device.position-changed'; payload: DevicePositionChangedPayload }
  | { topic: 'device.renamed'; payload: DeviceRenamedPayload }
  | { topic: 'registry.cleared'; payload: RegistryClearedPayload };

export type DomainEventTopic = DomainEvent['topic'];

export type EventOf<T extends DomainEventTopic> = Extract<DomainEvent, { topic: T }>;

export type PayloadOf<T extends DomainEventTopic> = EventOf<T>['payload'];
