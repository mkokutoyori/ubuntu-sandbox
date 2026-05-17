/**
 * DeviceStateView — vendor-neutral, read-only inspection facade.
 *
 * Layer 2 of the show/display architecture (see
 * docs/DESIGN-DEVICE-STATE-INSPECTION.md). It projects the device's
 * REAL internal state (Equipment / Port / Cable graph + protocol
 * engines) into immutable DTOs. It never fabricates data: an absent
 * subsystem yields an explicit "unconfigured" DTO, not invented
 * values.
 *
 * Renderers (CiscoShowRenderer / HuaweiDisplayRenderer) consume these
 * DTOs and never touch the model directly.
 */
import type { DeviceType } from '@/network/core/types';

/** Identity derived from the real device instance. */
export interface DeviceIdentityDTO {
  readonly hostname: string;
  readonly type: DeviceType;
  /** Human platform label derived from the real device type. */
  readonly platform: string;
  /** CDP/LLDP capability class (Router/Switch/Host). */
  readonly capability: 'Router' | 'Switch' | 'Host';
}

/** Real per-port state (read from Port). */
export interface InterfaceStateDTO {
  readonly name: string;
  readonly adminUp: boolean;
  readonly lineProtocolUp: boolean;
  readonly ip: string | null;
  readonly prefixLength: number | null;
  readonly mac: string;
  readonly speedKbps: number;
  readonly duplex: string;
  readonly connected: boolean;
  readonly description?: string;
}

/** A real cabled neighbour (basis for CDP & LLDP). */
export interface NeighborDTO {
  readonly localPort: string;
  readonly remoteHost: string;
  readonly remotePort: string;
  readonly remoteType: DeviceType;
  readonly remotePlatform: string;
  readonly remoteCapability: 'Router' | 'Switch' | 'Host';
}

/**
 * Read-only projection of one device's inspectable state. Methods are
 * added incrementally per migration lot; absence of a method means the
 * renderer emits the honest "not instrumented" line for that family.
 */
export interface DeviceStateView {
  identity(): DeviceIdentityDTO;
  interfaces(): InterfaceStateDTO[];
  neighbors(): NeighborDTO[];
}
