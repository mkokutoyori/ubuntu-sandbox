/**
 * ACLEngine - Access Control List evaluation engine
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Manages numbered/named ACLs and interface bindings.
 */

import type { IPAddress, SubnetMask, IPv4Packet, UDPPacket } from '../../core/types';
import { IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '../../core/types';

// ─── ACL Types ──────────────────────────────────────────────────

export type PortOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'range';

export interface PortSpec {
  op: PortOperator;
  port: number;
  endPort?: number;
}

export interface ACLEntry {
  sequence?: number;
  action: 'permit' | 'deny';
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
  srcPortSpec?: PortSpec;
  dstPortSpec?: PortSpec;
  icmpType?: string;
  icmpCode?: number;
  tcpEstablished?: boolean;
  tcpFlags?: string[];
  dscp?: string;
  precedence?: string;
  tos?: string;
  log?: boolean;
  logInput?: boolean;
  timeRange?: string;
  reflect?: string;
  reflectTimeout?: number;
  evaluate?: string;
  fragments?: boolean;
  optionName?: string;
  remark?: string;
  matchCount: number;
}

export interface ACLEntryOptions {
  sequence?: number;
  protocol?: string;
  srcIP: IPAddress;
  srcWildcard: SubnetMask;
  dstIP?: IPAddress;
  dstWildcard?: SubnetMask;
  srcPort?: number;
  dstPort?: number;
  srcPortSpec?: PortSpec;
  dstPortSpec?: PortSpec;
  icmpType?: string;
  icmpCode?: number;
  tcpEstablished?: boolean;
  tcpFlags?: string[];
  dscp?: string;
  precedence?: string;
  tos?: string;
  log?: boolean;
  logInput?: boolean;
  timeRange?: string;
  reflect?: string;
  reflectTimeout?: number;
  evaluate?: string;
  fragments?: boolean;
  optionName?: string;
  remark?: string;
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

// ─── ACL Engine ─────────────────────────────────────────────────

export class ACLEngine {
  private accessLists: AccessList[] = [];
  private interfaceACLBindings: Map<string, InterfaceACLBinding> = new Map();

  getAccessLists(): AccessList[] {
    return this.accessLists.map(acl => ({
      ...acl,
      entries: acl.entries.map(e => ({ ...e })),
    }));
  }

  addAccessListEntry(
    id: number,
    action: 'permit' | 'deny',
    opts: ACLEntryOptions,
  ): void {
    const type: 'standard' | 'extended' = (id < 100 || (id >= 2000 && id <= 2999)) ? 'standard' : 'extended';
    let acl = this.accessLists.find(a => a.id === id);
    if (!acl) {
      acl = { id, type, entries: [] };
      this.accessLists.push(acl);
    }
    const seq = opts.sequence ?? ACLEngine.nextSequence(acl);
    acl.entries.push({ action, ...opts, sequence: seq, matchCount: 0 });
    ACLEngine.sortBySequence(acl);
  }

  addNamedAccessListEntry(
    name: string,
    type: 'standard' | 'extended',
    action: 'permit' | 'deny',
    opts: ACLEntryOptions,
  ): void {
    let acl = this.accessLists.find(a => a.name === name);
    if (!acl) {
      acl = { name, type, entries: [] };
      this.accessLists.push(acl);
    }
    const seq = opts.sequence ?? ACLEngine.nextSequence(acl);
    acl.entries.push({ action, ...opts, sequence: seq, matchCount: 0 });
    ACLEngine.sortBySequence(acl);
  }

  removeNamedACLEntryBySequence(name: string, seq: number): boolean {
    const acl = this.accessLists.find(a => a.name === name);
    if (!acl) return false;
    const before = acl.entries.length;
    acl.entries = acl.entries.filter(e => e.sequence !== seq);
    return acl.entries.length !== before;
  }

  resequenceNamedACL(name: string, start: number, step: number): boolean {
    const acl = this.accessLists.find(a => a.name === name);
    if (!acl) return false;
    ACLEngine.sortBySequence(acl);
    let n = start;
    for (const e of acl.entries) {
      e.sequence = n;
      n += step;
    }
    return true;
  }

  findByName(name: string): AccessList | undefined {
    return this.accessLists.find(a => a.name === name);
  }

  findById(id: number): AccessList | undefined {
    return this.accessLists.find(a => a.id === id);
  }

  private static nextSequence(acl: AccessList): number {
    if (acl.entries.length === 0) return 10;
    const maxSeq = acl.entries.reduce((m, e) => Math.max(m, e.sequence ?? 0), 0);
    return Math.floor(maxSeq / 10) * 10 + 10;
  }

  private static sortBySequence(acl: AccessList): void {
    acl.entries.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }

  removeAccessList(id: number): void {
    this.accessLists = this.accessLists.filter(a => a.id !== id);
    for (const [, binding] of this.interfaceACLBindings) {
      if (binding.inbound === id) binding.inbound = null;
      if (binding.outbound === id) binding.outbound = null;
    }
  }

  removeNamedAccessList(name: string): void {
    this.accessLists = this.accessLists.filter(a => a.name !== name);
    for (const [, binding] of this.interfaceACLBindings) {
      if (binding.inbound === name) binding.inbound = null;
      if (binding.outbound === name) binding.outbound = null;
    }
  }

  setInterfaceACL(ifName: string, direction: 'in' | 'out', aclRef: number | string): void {
    let binding = this.interfaceACLBindings.get(ifName);
    if (!binding) {
      binding = { inbound: null, outbound: null };
      this.interfaceACLBindings.set(ifName, binding);
    }
    if (direction === 'in') binding.inbound = aclRef;
    else binding.outbound = aclRef;
  }

  removeInterfaceACL(ifName: string, direction: 'in' | 'out'): void {
    const binding = this.interfaceACLBindings.get(ifName);
    if (!binding) return;
    if (direction === 'in') binding.inbound = null;
    else binding.outbound = null;
  }

  getInterfaceACL(ifName: string, direction: 'in' | 'out'): number | string | null {
    const binding = this.interfaceACLBindings.get(ifName);
    if (!binding) return null;
    return direction === 'in' ? binding.inbound : binding.outbound;
  }

  /** Evaluate a named/numbered ACL by name — used by IPSecEngine for crypto ACL matching. */
  evaluateACLByName(name: string, ipPkt: IPv4Packet): 'permit' | 'deny' | null {
    const ref: number | string = /^\d+$/.test(name) ? parseInt(name, 10) : name;
    return this.evaluateACL(ref, ipPkt);
  }

  /** Evaluate an ACL against a packet. Returns 'permit', 'deny', or null (no ACL). */
  evaluateACL(aclRef: number | string | null, ipPkt: IPv4Packet): 'permit' | 'deny' | null {
    if (aclRef === null) return null;

    const acl = typeof aclRef === 'number'
      ? this.accessLists.find(a => a.id === aclRef)
      : this.accessLists.find(a => a.name === aclRef);

    if (!acl || acl.entries.length === 0) {
      return 'deny';
    }

    for (const entry of acl.entries) {
      if (this.aclEntryMatches(acl.type, entry, ipPkt)) {
        entry.matchCount++;
        return entry.action;
      }
    }

    return 'deny';
  }

  /** Check if an ACL entry matches a packet */
  private aclEntryMatches(aclType: 'standard' | 'extended', entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    if (!this.wildcardMatch(ipPkt.sourceIP, entry.srcIP, entry.srcWildcard)) {
      return false;
    }

    if (aclType === 'standard') {
      return true;
    }

    if (entry.dstIP && entry.dstWildcard) {
      if (!this.wildcardMatch(ipPkt.destinationIP, entry.dstIP, entry.dstWildcard)) {
        return false;
      }
    }

    if (entry.protocol && entry.protocol !== 'ip') {
      const pktProto = this.getProtocolName(ipPkt.protocol);
      if (pktProto !== entry.protocol) return false;

      if ((entry.protocol === 'tcp' || entry.protocol === 'udp') && ipPkt.payload) {
        const udp = ipPkt.payload as UDPPacket;
        if (!this.portMatches(udp.sourcePort, entry.srcPort, entry.srcPortSpec)) return false;
        if (!this.portMatches(udp.destinationPort, entry.dstPort, entry.dstPortSpec)) return false;
      }
    }

    return true;
  }

  private portMatches(pktPort: number, exact: number | undefined, spec: PortSpec | undefined): boolean {
    if (spec) {
      switch (spec.op) {
        case 'eq': return pktPort === spec.port;
        case 'neq': return pktPort !== spec.port;
        case 'gt': return pktPort > spec.port;
        case 'lt': return pktPort < spec.port;
        case 'range': return pktPort >= spec.port && pktPort <= (spec.endPort ?? spec.port);
      }
    }
    if (exact !== undefined) return pktPort === exact;
    return true;
  }

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

  private getProtocolName(proto: number): string {
    switch (proto) {
      case IP_PROTO_ICMP: return 'icmp';
      case IP_PROTO_TCP: return 'tcp';
      case IP_PROTO_UDP: return 'udp';
      default: return 'ip';
    }
  }

  /** @internal Direct access to ACL list for CLI shells */
  getAccessListsInternal(): AccessList[] { return this.accessLists; }

  /** @internal Direct access to bindings for CLI shells */
  getInterfaceACLBindingsInternal(): Map<string, InterfaceACLBinding> { return this.interfaceACLBindings; }
}
