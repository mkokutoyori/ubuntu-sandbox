/**
 * ARP inspection (DAI / Dynamic ARP Inspection) — data structures.
 *
 * Models the configuration & runtime state of a Layer-2 switch's
 * ARP-snooping engine, faithful to Cisco IOS / Huawei VRP semantics:
 *
 *   - Per-VLAN enable list      → `ip arp inspection vlan 10,20-30`
 *   - Trusted ports             → `ip arp inspection trust`
 *   - Per-port pps rate-limit   → `ip arp inspection limit rate N`
 *   - Additional validations    → `ip arp inspection validate src-mac|dst-mac|ip`
 *   - ARP ACL filters per VLAN  → `ip arp inspection filter <acl> vlan <list>`
 *   - Err-disable auto-recovery → `errdisable recovery cause arp-inspection`
 *
 * The engine consumes DHCP snooping bindings to authorise ARP packets
 * coming from untrusted ports (the canonical DAI ↔ snooping integration).
 */
import type { IPAddress, MACAddress } from '../core/types';

// ─── Per-port / per-VLAN counters ───────────────────────────────────

export interface ArpStats {
  /** Frames the engine has examined (any verdict). */
  received: number;
  /** Frames permitted (trusted port, DHCP-binding match, ACL permit). */
  forwarded: number;
  /** Total drops (sum of the per-reason breakdown). */
  dropped: number;

  /** Per-reason drop counters. */
  droppedBindingMismatch: number;
  droppedAclDeny: number;
  droppedSrcMacMismatch: number;
  droppedDstMacMismatch: number;
  droppedInvalidIp: number;
  droppedRateLimit: number;
  droppedDisabled: number;
}

export function createDefaultArpStats(): ArpStats {
  return {
    received: 0, forwarded: 0, dropped: 0,
    droppedBindingMismatch: 0, droppedAclDeny: 0,
    droppedSrcMacMismatch: 0, droppedDstMacMismatch: 0,
    droppedInvalidIp: 0, droppedRateLimit: 0, droppedDisabled: 0,
  };
}

// ─── ARP ACL (named) ────────────────────────────────────────────────

export type ArpAclAction = 'permit' | 'deny';

/**
 * One ACL line: `permit ip host 10.0.0.1 mac host aaaa.bbbb.cccc`.
 *
 * `null` on either side means *any*. Both must match for the entry to
 * fire (IOS uses an AND between the IP and MAC clauses).
 */
export interface ArpAclEntry {
  action: ArpAclAction;
  /** Match the sender IP. `null` = any. */
  senderIp: string | null;
  /** Match the sender MAC (lower-case `aa:bb:cc:dd:ee:ff`). `null` = any. */
  senderMac: string | null;
  /** Original line as typed, for round-tripping into running-config. */
  raw: string;
}

export interface ArpAccessList {
  name: string;
  entries: ArpAclEntry[];
}

// ─── Global / per-VLAN configuration ───────────────────────────────

export interface ArpInspectionValidate {
  /** Compare ARP's `sender-mac` field against Ethernet `src-mac`. */
  srcMac: boolean;
  /** Compare ARP's `target-mac` against Ethernet `dst-mac` (replies only). */
  dstMac: boolean;
  /** Reject 0.0.0.0, multicast, broadcast or 255.255.255.255 in IP fields. */
  ip: boolean;
}

export interface ArpInspectionConfig {
  /** Per-VLAN enable set. ARP inspection is *off* on a VLAN not in this set. */
  vlans: Set<number>;
  /** Ports flagged as trusted (frames are forwarded without inspection). */
  trustedPorts: Set<string>;
  /** Per-port rate limit in pps. 0 / absent = unlimited (Cisco default 15 on untrusted). */
  rateLimits: Map<string, number>;
  /** Burst interval in seconds the rate limit is measured over (default 1 = pps). */
  rateBurstSec: number;
  /** Additional validations the operator turned on. */
  validate: ArpInspectionValidate;
  /** VLAN → ACL name filter (`ip arp inspection filter <acl> vlan <list>`). */
  vlanAclFilters: Map<number, { aclName: string; staticMode: boolean }>;
  /** Append per-violation messages to the switch's snooping log. */
  loggingEnabled: boolean;
  /** Auto-recover err-disabled ports after this many seconds (0 = never). */
  errDisableRecoverySec: number;
}

export function createDefaultArpInspectionConfig(): ArpInspectionConfig {
  return {
    vlans: new Set(),
    trustedPorts: new Set(),
    rateLimits: new Map(),
    rateBurstSec: 1,
    validate: { srcMac: false, dstMac: false, ip: false },
    vlanAclFilters: new Map(),
    loggingEnabled: true,
    errDisableRecoverySec: 0,
  };
}

// ─── Engine verdict ─────────────────────────────────────────────────

export type ArpDropReason =
  | 'binding-mismatch'
  | 'acl-deny'
  | 'src-mac-mismatch'
  | 'dst-mac-mismatch'
  | 'invalid-ip'
  | 'rate-limit'
  | 'port-err-disabled';

export type ArpInspectionVerdict =
  | { kind: 'pass'; reason: 'trusted' | 'binding-match' | 'acl-permit' | 'no-inspection' | 'no-binding-fallback' }
  | { kind: 'drop'; reason: ArpDropReason; detail: string };

export interface ArpInspectionContext {
  ingressPort: string;
  vlan: number;
  /** sender from the ARP packet (already extracted by the caller). */
  senderIp: IPAddress;
  senderMac: MACAddress;
  /** target IP (used for `validate ip` and logging). */
  targetIp: IPAddress;
  targetMac: MACAddress;
  /** Ethernet src/dst MACs of the carrying frame (used for `validate src-mac`/`dst-mac`). */
  ethSrcMac: MACAddress;
  ethDstMac: MACAddress;
  /** ARP operation (request validation skips dst-mac check, like real IOS). */
  operation: 'request' | 'reply';
}
