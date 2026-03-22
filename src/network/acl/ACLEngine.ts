/**
 * ACLEngine — Extracted Access Control List engine
 *
 * Fixes:
 * - 1.1: Extracted ~200 lines from Router.ts God Class
 * - 1.6: Standalone, reusable ACL engine
 * - 1.7: Protocol number mapping centralized
 *
 * Supports both numbered (1-99 standard, 100-199 extended) and
 * named ACLs with Cisco-style wildcard matching.
 */

import type { IPAddress, SubnetMask, IPv4Packet, UDPPacket } from '../core/types';
import { IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '../core/types';

// ─── Types ──────────────────────────────────────────────────────────

export interface ACLEntry {
  action: 'permit' | 'deny';
  /** Protocol filter: 'ip' matches all, 'icmp', 'tcp', 'udp' */
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
  /** Match counter */
  matchCount: number;
}

export interface AccessList {
  /** Numeric ID (1-99 standard, 100-199 extended) or undefined for named ACLs */
  id?: number;
  /** Name for named ACLs */
  name?: string;
  /** ACL type */
  type: 'standard' | 'extended';
  /** Ordered list of entries (first match wins) */
  entries: ACLEntry[];
}

/** Interface ACL binding: which ACL is applied in which direction */
export interface InterfaceACLBinding {
  /** ACL ID (number) or name (string) */
  inbound: number | string | null;
  outbound: number | string | null;
}

/** Options for adding an ACL entry */
export interface ACLEntryOptions {
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
}

// ─── Protocol Number → Name Mapping ─────────────────────────────────

const PROTOCOL_MAP: Record<number, string> = {
  [IP_PROTO_ICMP]: 'icmp',
  [IP_PROTO_TCP]: 'tcp',
  [IP_PROTO_UDP]: 'udp',
};

// ─── ACL Engine ─────────────────────────────────────────────────────

/**
 * Access Control List engine.
 *
 * Manages numbered and named ACLs with Cisco-style wildcard matching.
 * Supports per-interface binding (inbound/outbound) and match counting.
 *
 * @example
 * ```ts
 * const acl = new ACLEngine();
 *
 * // Add a standard ACL (source-only filtering)
 * acl.addEntry(10, 'permit', { srcIP: '10.0.0.0', srcWildcard: '0.0.0.255' });
 *
 * // Bind to an interface
 * acl.setInterfaceBinding('GigabitEthernet0/0', 'in', 10);
 *
 * // Evaluate a packet
 * const result = acl.evaluate(10, ipPacket); // 'permit' | 'deny' | null
 * ```
 */
export class ACLEngine {
  private lists: AccessList[] = [];
  private bindings: Map<string, InterfaceACLBinding> = new Map();

  // ─── ACL Management ───────────────────────────────────────────────

  /** Get all access lists (deep copy) */
  getAccessLists(): AccessList[] {
    return this.lists.map(acl => ({
      ...acl,
      entries: acl.entries.map(e => ({ ...e })),
    }));
  }

  /** Get the internal reference (for CLI shells that need direct access) */
  getAccessListsInternal(): AccessList[] {
    return this.lists;
  }

  /** Add an entry to a numbered ACL */
  addEntry(id: number, action: 'permit' | 'deny', opts: ACLEntryOptions): void {
    const type: 'standard' | 'extended' = id < 100 ? 'standard' : 'extended';
    let acl = this.lists.find(a => a.id === id);
    if (!acl) {
      acl = { id, type, entries: [] };
      this.lists.push(acl);
    }
    acl.entries.push({ action, ...opts, matchCount: 0 });
  }

  /** Add an entry to a named ACL */
  addNamedEntry(
    name: string,
    type: 'standard' | 'extended',
    action: 'permit' | 'deny',
    opts: ACLEntryOptions,
  ): void {
    let acl = this.lists.find(a => a.name === name);
    if (!acl) {
      acl = { name, type, entries: [] };
      this.lists.push(acl);
    }
    acl.entries.push({ action, ...opts, matchCount: 0 });
  }

  /** Remove a numbered ACL and all its interface bindings */
  removeById(id: number): void {
    this.lists = this.lists.filter(a => a.id !== id);
    for (const [, binding] of this.bindings) {
      if (binding.inbound === id) binding.inbound = null;
      if (binding.outbound === id) binding.outbound = null;
    }
  }

  /** Remove a named ACL and all its interface bindings */
  removeByName(name: string): void {
    this.lists = this.lists.filter(a => a.name !== name);
    for (const [, binding] of this.bindings) {
      if (binding.inbound === name) binding.inbound = null;
      if (binding.outbound === name) binding.outbound = null;
    }
  }

  // ─── Interface Bindings ───────────────────────────────────────────

  /** Bind an ACL to an interface in a given direction */
  setInterfaceBinding(ifName: string, direction: 'in' | 'out', aclRef: number | string): void {
    let binding = this.bindings.get(ifName);
    if (!binding) {
      binding = { inbound: null, outbound: null };
      this.bindings.set(ifName, binding);
    }
    if (direction === 'in') binding.inbound = aclRef;
    else binding.outbound = aclRef;
  }

  /** Remove an ACL binding from an interface */
  removeInterfaceBinding(ifName: string, direction: 'in' | 'out'): void {
    const binding = this.bindings.get(ifName);
    if (!binding) return;
    if (direction === 'in') binding.inbound = null;
    else binding.outbound = null;
  }

  /** Get the ACL bound to an interface in a given direction */
  getInterfaceBinding(ifName: string, direction: 'in' | 'out'): number | string | null {
    const binding = this.bindings.get(ifName);
    if (!binding) return null;
    return direction === 'in' ? binding.inbound : binding.outbound;
  }

  /** Get all interface bindings (for CLI shells) */
  getBindingsInternal(): Map<string, InterfaceACLBinding> {
    return this.bindings;
  }

  // ─── Evaluation ───────────────────────────────────────────────────

  /**
   * Evaluate a named/numbered ACL by reference string.
   * Used by IPSecEngine for crypto ACL matching.
   */
  evaluateByName(name: string, ipPkt: IPv4Packet): 'permit' | 'deny' | null {
    const ref: number | string = /^\d+$/.test(name) ? parseInt(name, 10) : name;
    return this.evaluate(ref, ipPkt);
  }

  /**
   * Evaluate an ACL against a packet.
   * First matching entry wins (Cisco-style).
   *
   * @returns 'permit', 'deny', or null (no ACL bound)
   */
  evaluate(aclRef: number | string | null, ipPkt: IPv4Packet): 'permit' | 'deny' | null {
    if (aclRef === null) return null;

    const acl = typeof aclRef === 'number'
      ? this.lists.find(a => a.id === aclRef)
      : this.lists.find(a => a.name === aclRef);

    if (!acl || acl.entries.length === 0) {
      return 'deny'; // Implicit deny
    }

    for (const entry of acl.entries) {
      if (this.entryMatches(acl.type, entry, ipPkt)) {
        entry.matchCount++;
        return entry.action;
      }
    }

    return 'deny'; // Implicit deny at end
  }

  // ─── Matching Logic ───────────────────────────────────────────────

  private entryMatches(aclType: 'standard' | 'extended', entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    // Source IP check (both standard and extended)
    if (!this.wildcardMatch(ipPkt.sourceIP, entry.srcIP, entry.srcWildcard)) {
      return false;
    }

    if (aclType === 'standard') {
      return true; // Standard ACLs only check source
    }

    // Extended ACL: destination IP
    if (entry.dstIP && entry.dstWildcard) {
      if (!this.wildcardMatch(ipPkt.destinationIP, entry.dstIP, entry.dstWildcard)) {
        return false;
      }
    }

    // Protocol matching
    if (entry.protocol && entry.protocol !== 'ip') {
      const pktProto = ACLEngine.getProtocolName(ipPkt.protocol);
      if (pktProto !== entry.protocol) return false;

      // Port matching for TCP/UDP
      if ((entry.protocol === 'tcp' || entry.protocol === 'udp') && ipPkt.payload) {
        const udp = ipPkt.payload as UDPPacket;
        if (entry.srcPort !== undefined && udp.sourcePort !== entry.srcPort) return false;
        if (entry.dstPort !== undefined && udp.destinationPort !== entry.dstPort) return false;
      }
    }

    return true;
  }

  /**
   * Cisco-style wildcard mask matching.
   * Wildcard bit 0 = must match, bit 1 = don't care.
   */
  private wildcardMatch(packetIP: IPAddress, aclIP: IPAddress, wildcard: SubnetMask): boolean {
    const pktOctets = packetIP.getOctets();
    const aclOctets = aclIP.getOctets();
    const wcOctets = wildcard.getOctets();
    for (let i = 0; i < 4; i++) {
      if ((pktOctets[i] & ~wcOctets[i]) !== (aclOctets[i] & ~wcOctets[i])) {
        return false;
      }
    }
    return true;
  }

  /** Map IP protocol number to name */
  static getProtocolName(proto: number): string {
    return PROTOCOL_MAP[proto] ?? 'ip';
  }
}
