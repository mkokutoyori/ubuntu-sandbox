/**
 * CDP — Cisco Discovery Protocol data structures.
 *
 * CDP (Cisco's proprietary IEEE 802.3 / SNAP-encapsulated discovery
 * protocol) carries TLVs describing the sender; each receiver tracks
 * neighbours per-interface and evicts them when their hold-time
 * elapses. We model the protocol faithfully enough that the existing
 * `show cdp neighbors [detail]` commands now read REAL learned state —
 * not the raw cable graph.
 *
 * Frame transport:
 *   - destination MAC: 01:00:0c:cc:cc:cc (CDP/VTP/UDLD/etc multicast)
 *   - ethertype (logical, Cisco SNAP):  0x2000
 *
 * IOS defaults — codified in `createDefaultCdpConfig()`:
 *   - enabled: true
 *   - timer:    60 s
 *   - holdtime: 180 s (3 × timer)
 *   - per-port enable: true on every interface that exists
 */
import type { MACAddress, IPAddress, DeviceType } from '../core/types';

/** Cisco's SNAP-encapsulated CDP "ethertype" — used to discriminate in the sim. */
export const ETHERTYPE_CDP = 0x2000;
/** Reserved multicast MAC for CDP advertisements (RFC-style notation). */
export const CDP_MULTICAST_MAC = '01:00:0c:cc:cc:cc';
/** Capability strings advertised in TLV #4 (subset we actually use). */
export type CdpCapability = 'Router' | 'Switch' | 'Host' | 'IGMP' | 'Repeater';

/**
 * CDP advertisement payload — a discriminated subset of the real TLV
 * set (real CDPv2 has ~25 TLVs; we model the ones every `show cdp
 * neighbors detail` line actually displays).
 */
export interface CdpFrame {
  type: 'cdp';
  version: 2;
  /** Time the receiver should keep this entry alive (sec). */
  holdtimeSec: number;
  /** TLV 0x0001 — Device ID. */
  deviceId: string;
  /** TLV 0x0003 — Port ID (sender's egress port). */
  portId: string;
  /** TLV 0x0004 — Capabilities. */
  capabilities: CdpCapability[];
  /** TLV 0x0005 — Version (IOS image string). */
  softwareVersion: string;
  /** TLV 0x0006 — Platform (chassis model). */
  platform: string;
  /** TLV 0x0002 — Addresses. */
  addresses: string[];
  /** TLV 0x000a — Native VLAN (switches only). */
  nativeVlan?: number;
  /** TLV 0x000b — Duplex. */
  duplex: 'half' | 'full' | 'auto';
  /** TLV 0x0009 — VTP management domain (left blank — VTP not modelled). */
  vtpDomain?: string;
}

/**
 * Live neighbour entry — one row per (localPort, remoteDeviceId).
 *
 * The structure intentionally mirrors `NeighborDTO` from the inspection
 * facade so `show cdp neighbors` can keep returning the same shape.
 */
export interface CdpNeighborEntry {
  localPort: string;
  remoteHost: string;       // deviceId TLV
  remotePort: string;
  remoteType: DeviceType;
  remotePlatform: string;
  remoteCapability: CdpCapability;
  remoteAddresses: string[];
  remoteSoftwareVersion: string;
  /** When this entry was learned (or last refreshed) — used for `show cdp`. */
  learnedAtMs: number;
  /** Total hold-time the advertisement asked us to honour (sec). */
  holdtimeSec: number;
  /** Computed expiry timestamp (ms). */
  expiresAtMs: number;
  /** Native VLAN if the peer is a switch. */
  nativeVlan?: number;
  duplex: 'half' | 'full' | 'auto';
}

export interface CdpConfig {
  enabled: boolean;
  /** Advertisement period in seconds (default 60). */
  timerSec: number;
  /** TTL the agent advertises to peers (default 180). */
  holdtimeSec: number;
  /** Ports for which CDP is administratively disabled. */
  disabledPorts: Set<string>;
}

export function createDefaultCdpConfig(): CdpConfig {
  return {
    enabled: true,
    timerSec: 60,
    holdtimeSec: 180,
    disabledPorts: new Set(),
  };
}

/** Look-up key for the neighbour table: one entry per (localPort, deviceId). */
export function neighborKey(localPort: string, remoteDeviceId: string): string {
  return `${localPort}|${remoteDeviceId}`;
}

/** Helper — IPAddress / string union → string list (TLV friendly). */
export function addressesToStrings(addrs: ReadonlyArray<IPAddress | string>): string[] {
  return addrs.map(a => typeof a === 'string' ? a : a.toString());
}

/** Re-export so callers don't need to also import core/types. */
export type { MACAddress };
