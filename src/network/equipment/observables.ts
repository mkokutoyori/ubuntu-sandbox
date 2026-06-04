/**
 * Equipment — observable read-models (Signals) + pure projections.
 *
 * Gives the base `Equipment` Actor the same reactive shape as the protocol
 * engines and `EndHost`: a private writable store plus a read-only
 * `DeviceObservables` exposed by `Equipment.deviceObservables`.
 *
 * The accessor is named `deviceObservables` (not `observables`) so it never
 * collides with `EndHost.observables` (host L3/L4 read-models) further down
 * the subclass hierarchy.
 *
 * The pure projection functions (`projectDeviceDetail`, `projectPorts`) are the
 * single source of truth for "equipment state → view-model". They are testable
 * without constructing an `Equipment`.
 */

import { WritableSignal, type Signal } from '@/events/Signal';

// ── View-models ─────────────────────────────────────────────────────────────

export interface DeviceDetailVM {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly type: string;
  readonly poweredOn: boolean;
  readonly uptimeMs: number;
  readonly portCount: number;
}

export interface PortVM {
  readonly name: string;
  readonly type: string;
  readonly isUp: boolean;
  readonly mac: string;
  readonly ipAddress: string | null;
  readonly mask: string | null;
  readonly connected: boolean;
}

// ── Signal store (engine-private) ─────────────────────────────────────────────

const EMPTY_DETAIL: DeviceDetailVM = {
  id: '',
  name: '',
  hostname: '',
  type: '',
  poweredOn: false,
  uptimeMs: 0,
  portCount: 0,
};

export class DeviceSignalStore {
  readonly detail = new WritableSignal<DeviceDetailVM>(EMPTY_DETAIL);
  readonly ports = new WritableSignal<ReadonlyArray<PortVM>>([]);
}

export interface DeviceObservables {
  readonly detail: Signal<DeviceDetailVM>;
  readonly ports: Signal<ReadonlyArray<PortVM>>;
}

export function makeReadonlyDeviceObservables(store: DeviceSignalStore): DeviceObservables {
  // Expose only the read-only Signal interface, never the writable handles.
  return { detail: store.detail, ports: store.ports };
}

// ── Pure projections ──────────────────────────────────────────────────────────

export interface DeviceDetailInput {
  id: string;
  name: string;
  hostname: string;
  type: string;
  poweredOn: boolean;
  uptimeMs: number;
  portCount: number;
}

export function projectDeviceDetail(input: DeviceDetailInput): DeviceDetailVM {
  return {
    id: input.id,
    name: input.name,
    hostname: input.hostname,
    type: input.type,
    poweredOn: input.poweredOn,
    uptimeMs: Math.max(0, input.uptimeMs),
    portCount: input.portCount,
  };
}

/** The slice of `Port` the projection needs — keeps it decoupled from the class. */
export interface PortLike {
  getName(): string;
  getType(): { toString(): string };
  getIsUp(): boolean;
  getMAC(): { toString(): string };
  getIPAddress(): { toString(): string } | null;
  getSubnetMask(): { toString(): string } | null;
  isConnected(): boolean;
}

export function projectPorts(ports: Iterable<PortLike>): PortVM[] {
  const out: PortVM[] = [];
  for (const p of ports) {
    const ip = p.getIPAddress();
    const mask = p.getSubnetMask();
    out.push({
      name: p.getName(),
      type: String(p.getType()),
      isUp: p.getIsUp(),
      mac: String(p.getMAC()),
      ipAddress: ip ? String(ip) : null,
      mask: mask ? String(mask) : null,
      connected: p.isConnected(),
    });
  }
  return out;
}
