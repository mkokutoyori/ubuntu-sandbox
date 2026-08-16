/**
 * ACLEngine - Access Control List evaluation engine
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Manages numbered/named ACLs and interface bindings.
 */

import type { IPAddress, SubnetMask, IPv4Packet, UDPPacket, ICMPPacket, TCPPacket } from '../../core/types';
import {
  IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ESP, IP_PROTO_AH,
  IP_PROTO_EIGRP, IP_PROTO_OSPF,
} from '../../core/types';
import { IP_PROTO_GRE } from '../../gre/types';
import { IP_PROTO_PIM } from '../../pim/types';

const DSCP_KEYWORD_TO_VALUE: Record<string, number> = {
  default: 0, cs0: 0, cs1: 8, cs2: 16, cs3: 24, cs4: 32, cs5: 40, cs6: 48, cs7: 56,
  af11: 10, af12: 12, af13: 14, af21: 18, af22: 20, af23: 22,
  af31: 26, af32: 28, af33: 30, af41: 34, af42: 36, af43: 38, ef: 46,
};

const PRECEDENCE_KEYWORD_TO_VALUE: Record<string, number> = {
  routine: 0, priority: 1, immediate: 2, flash: 3,
  'flash-override': 4, critical: 5, internet: 6, network: 7,
};

/**
 * Les mots-clés ICMP que ce simulateur sait ÉVALUER.
 *
 * `ICMPType` ne modélise que cinq types (echo-request, echo-reply,
 * destination-unreachable, redirect, time-exceeded). Les autres mots-clés
 * qu'IOS accepte — `source-quench`, `packet-too-big`, `parameter-problem`,
 * `traceroute`, `router-advertisement/solicitation`, `mask-*`,
 * `timestamp-*`, `information-*`, `administratively-prohibited` — décrivent
 * des paquets qu'aucun équipement d'ici ne produit.
 *
 * Un mot-clé absent de cette table fait donc échouer la correspondance
 * (voir `aclEntryMatches`) : c'est le seul choix sûr. Le faire réussir
 * revenait à ce qu'une ACE portant un critère inconnu corresponde à TOUT
 * le trafic ICMP, donc à ouvrir la liste au lieu de la restreindre.
 *
 * Limite connue : les quatre variantes d'`unreachable` retombent sur le
 * même type faute de discrimination par code ICMP.
 */
const ACL_ICMP_KEYWORD_TO_TYPE: Record<string, string> = {
  'echo': 'echo-request',
  'echo-request': 'echo-request',
  'echo-reply': 'echo-reply',
  'unreachable': 'destination-unreachable',
  'host-unreachable': 'destination-unreachable',
  'net-unreachable': 'destination-unreachable',
  'port-unreachable': 'destination-unreachable',
  'protocol-unreachable': 'destination-unreachable',
  'time-exceeded': 'time-exceeded',
  'ttl-exceeded': 'time-exceeded',
  'redirect': 'redirect',
};

// ─── Drapeaux TCP ───────────────────────────────────────────────

const TCP_FLAG_NAMES = ['ack', 'fin', 'psh', 'rst', 'syn', 'urg'] as const;
type TcpFlagName = typeof TCP_FLAG_NAMES[number];

/**
 * Un jeton de `match-any` / `match-all` : `+syn` exige le drapeau posé,
 * `-syn` l'exige absent, `syn` nu vaut `+syn`. Rend `null` sur un nom
 * inconnu — l'appelant fait alors échouer la correspondance.
 */
function parseTcpFlagToken(token: string): { flag: TcpFlagName; mustBeSet: boolean } | null {
  const tok = token.toLowerCase();
  const signed = tok.startsWith('+') || tok.startsWith('-');
  const name = signed ? tok.slice(1) : tok;
  if (!(TCP_FLAG_NAMES as readonly string[]).includes(name)) return null;
  return { flag: name as TcpFlagName, mustBeSet: !tok.startsWith('-') };
}

// ─── Numérotation des listes, par vendeur ───────────────────────

/** Quel type de liste porte ce numéro ? La réponse dépend du vendeur. */
export type AclNumbering = (id: number) => 'standard' | 'extended';

/** IOS : 1-99 et 1300-1999 standard ; 100-199 et 2000-2699 étendues. */
export const IOS_ACL_NUMBERING: AclNumbering = (id) =>
  ((id >= 1 && id <= 99) || (id >= 1300 && id <= 1999)) ? 'standard' : 'extended';

/** VRP : 2000-2999 « basic » (source seule) ; 3000-3999 « advanced ». */
export const VRP_ACL_NUMBERING: AclNumbering = (id) =>
  (id >= 2000 && id <= 2999) ? 'standard' : 'extended';

// ─── ACL Types ──────────────────────────────────────────────────

export type PortOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'range';

export interface PortSpec {
  op: PortOperator;
  port: number;
  endPort?: number;
}

export interface ACLEntry {
  sequence?: number;
  /** L'opérateur a-t-il ÉCRIT ce numéro ? IOS ne le rend en configuration que dans ce cas. */
  sequenceConfigured?: boolean;
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
  /** `match-all` exige tous les drapeaux, `match-any` un seul. Défaut : `any`. */
  tcpFlagsMatch?: 'any' | 'all';
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
  /** L'opérateur a-t-il ÉCRIT ce numéro ? IOS ne le rend en configuration que dans ce cas. */
  sequenceConfigured?: boolean;
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
  /** `match-all` exige tous les drapeaux, `match-any` un seul. Défaut : `any`. */
  tcpFlagsMatch?: 'any' | 'all';
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

  /**
   * Le moteur sert plusieurs vendeurs, et leurs plages de numéros se
   * contredisent : 2000-2699 est ÉTENDU sur IOS et « basic » sur VRP.
   * Le vendeur pose donc sa règle ; le moteur n'en devine aucune.
   * Défaut IOS, ce module étant la surface Cisco.
   */
  private numbering: AclNumbering = IOS_ACL_NUMBERING;
  setNumberingPolicy(fn: AclNumbering): void { this.numbering = fn; }

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
    const type: 'standard' | 'extended' = this.numbering(id);
    let acl = this.accessLists.find(a => a.id === id);
    if (!acl) {
      acl = { id, type, entries: [] };
      this.accessLists.push(acl);
    }
    const seq = opts.sequence ?? ACLEngine.nextSequence(acl);
    acl.entries.push({
      action, ...opts, sequence: seq, sequenceConfigured: opts.sequence !== undefined,
      matchCount: 0,
    });
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
    acl.entries.push({
      action, ...opts, sequence: seq, sequenceConfigured: opts.sequence !== undefined,
      matchCount: 0,
    });
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

  /** Zero every entry's match counter for one ACL (`reset acl counter <N>`). */
  resetCounters(aclRef: number | string): boolean {
    const acl = typeof aclRef === 'number'
      ? this.accessLists.find(a => a.id === aclRef)
      : this.accessLists.find(a => a.name === aclRef);
    if (!acl) return false;
    for (const entry of acl.entries) entry.matchCount = 0;
    return true;
  }

  /** Zero every entry's match counter across all ACLs (`reset acl counter all`). */
  resetAllCounters(): void {
    for (const acl of this.accessLists) {
      for (const entry of acl.entries) entry.matchCount = 0;
    }
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

  /**
   * Optional resolver for time-range references on individual ACEs. When
   * set, an entry tagged `time-range NAME` only matches if the resolver
   * returns true for `(name, now)`. When unset (default), time-range
   * entries are treated as always-active — the historical behaviour.
   */
  private timeRangeResolver: ((name: string, now: Date) => boolean) | null = null;
  setTimeRangeResolver(fn: ((name: string, now: Date) => boolean) | null): void {
    this.timeRangeResolver = fn;
  }

  /** Evaluate a named/numbered ACL by name — used by IPSecEngine for crypto ACL matching. */
  evaluateACLByName(name: string, ipPkt: IPv4Packet, now: Date = new Date()): 'permit' | 'deny' | null {
    const ref: number | string = /^\d+$/.test(name) ? parseInt(name, 10) : name;
    return this.evaluateACL(ref, ipPkt, now);
  }

  /** Evaluate an ACL against a packet. Returns 'permit', 'deny', or null (no ACL). */
  evaluateACL(aclRef: number | string | null, ipPkt: IPv4Packet, now: Date = new Date()): 'permit' | 'deny' | null {
    if (aclRef === null) return null;

    const acl = typeof aclRef === 'number'
      ? this.accessLists.find(a => a.id === aclRef)
      : this.accessLists.find(a => a.name === aclRef);

    // Undefined or empty ACL = no ACL applied (real IOS), not deny-all.
    if (!acl || acl.entries.length === 0) {
      return null;
    }

    for (const entry of acl.entries) {
      if (entry.timeRange && this.timeRangeResolver
          && !this.timeRangeResolver(entry.timeRange, now)) {
        continue; // inactive time-range → skip ACE (next-rule semantics)
      }
      if (this.aclEntryMatches(acl.type, entry, ipPkt)) {
        entry.matchCount++;
        return entry.action;
      }
    }

    return 'deny';
  }

  /**
   * Cette entrée correspond-elle à ce paquet ?
   *
   * RÈGLE D'ÉCHEC, valable pour tout ce qui suit : **un critère que le
   * moteur ne sait pas trancher fait échouer la correspondance.** Jamais
   * réussir, jamais « sauter le critère ». Une ACE dont un critère est
   * abandonné devient plus permissive que ce que l'opérateur a écrit,
   * c'est-à-dire un trou silencieux dans la liste. C'est la règle que
   * `Ipv6AclEngine` applique déjà, et qui vaut ici aussi.
   */
  private aclEntryMatches(aclType: 'standard' | 'extended', entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    // Un commentaire n'est pas une règle. Sans ce test il correspondait à
    // tout — étant stocké comme un `permit` de source `any` — et toute
    // liste commentée devenait une liste ouverte.
    if (entry.remark !== undefined) return false;

    // `evaluate` désigne une liste réflexive, et il n'existe aucune table
    // de sessions derrière. La clause n'est donc pas étayée : elle échoue.
    if (entry.evaluate !== undefined) return false;

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

      if (entry.protocol === 'tcp' || entry.protocol === 'udp') {
        if (!this.portCriteriaMatch(entry, ipPkt)) return false;
      }

      if (entry.protocol === 'tcp' && entry.tcpEstablished) {
        const tcp = ipPkt.payload as TCPPacket | undefined;
        const flags = tcp && tcp.type === 'tcp' ? tcp.flags : undefined;
        if (!flags || (!flags.ack && !flags.rst)) return false;
      }

      if (entry.protocol === 'tcp' && entry.tcpFlags && entry.tcpFlags.length > 0) {
        if (!ACLEngine.tcpFlagsMatch(entry, ipPkt)) return false;
      }

      if (entry.protocol === 'icmp' && entry.icmpType) {
        const expected = ACL_ICMP_KEYWORD_TO_TYPE[entry.icmpType];
        // Mot-clé qu'on ne sait pas traduire : critère non tranchable.
        if (expected === undefined) return false;
        const icmp = ipPkt.payload as ICMPPacket | undefined;
        const pktType = icmp && icmp.type === 'icmp' ? icmp.icmpType : undefined;
        if (pktType === undefined || expected !== pktType) return false;
      }
    }

    if (entry.dscp !== undefined) {
      const want = /^\d+$/.test(entry.dscp)
        ? parseInt(entry.dscp, 10)
        : DSCP_KEYWORD_TO_VALUE[entry.dscp.toLowerCase()];
      if (!ACLEngine.tosFieldMatches(ipPkt, want, 2, 0x3f)) return false;
    }

    if (entry.precedence !== undefined) {
      const want = /^\d+$/.test(entry.precedence)
        ? parseInt(entry.precedence, 10)
        : PRECEDENCE_KEYWORD_TO_VALUE[entry.precedence.toLowerCase()];
      if (!ACLEngine.tosFieldMatches(ipPkt, want, 5, 0x7)) return false;
    }

    if (entry.tos !== undefined) {
      const want = /^\d+$/.test(entry.tos) ? parseInt(entry.tos, 10) : undefined;
      if (!ACLEngine.tosFieldMatches(ipPkt, want, 0, 0xff)) return false;
    }

    if (entry.fragments) {
      const isFragment = (ipPkt.fragmentOffset > 0) || ((ipPkt.flags & 0x1) !== 0);
      if (!isFragment) return false;
    }

    return true;
  }

  /**
   * Les critères de port de cette ACE sont-ils satisfaits ?
   *
   * Une ACE SANS critère de port correspond quelle que soit la charge
   * utile — `permit tcp any any` ne regarde pas les ports. Mais dès qu'un
   * critère est posé et que la couche 4 manque, il n'est pas vérifiable :
   * on échoue. L'ancienne version sautait tout le bloc quand la charge
   * utile était absente, de sorte qu'un paquet sans couche 4 satisfaisait
   * `permit tcp any any eq 22`.
   */
  private portCriteriaMatch(entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    const wantsSrc = entry.srcPort !== undefined || entry.srcPortSpec !== undefined;
    const wantsDst = entry.dstPort !== undefined || entry.dstPortSpec !== undefined;
    if (!wantsSrc && !wantsDst) return true;

    const l4 = ipPkt.payload as Partial<UDPPacket> | undefined;
    if (wantsSrc) {
      if (typeof l4?.sourcePort !== 'number') return false;
      if (!this.portMatches(l4.sourcePort, entry.srcPort, entry.srcPortSpec)) return false;
    }
    if (wantsDst) {
      if (typeof l4?.destinationPort !== 'number') return false;
      if (!this.portMatches(l4.destinationPort, entry.dstPort, entry.dstPortSpec)) return false;
    }
    return true;
  }

  /**
   * `match-any` / `match-all` sur les drapeaux TCP. Les jetons étaient
   * analysés, stockés et réaffichés sans jamais être évalués : le critère
   * disparaissait, et `deny tcp any any match-any rst` refusait un SYN.
   */
  private static tcpFlagsMatch(entry: ACLEntry, ipPkt: IPv4Packet): boolean {
    const tcp = ipPkt.payload as TCPPacket | undefined;
    const flags = tcp && tcp.type === 'tcp' ? tcp.flags : undefined;
    if (!flags) return false;

    const conditions = entry.tcpFlags!.map(parseTcpFlagToken);
    // Un nom de drapeau inconnu rend le critère intranchable.
    if (conditions.some(c => c === null)) return false;

    const holds = (c: { flag: TcpFlagName; mustBeSet: boolean }) => flags[c.flag] === c.mustBeSet;
    return entry.tcpFlagsMatch === 'all'
      ? conditions.every(c => holds(c!))
      : conditions.some(c => holds(c!));
  }

  /** Un champ du ToS, décalé et masqué. `want` indéfini ⇒ critère intranchable. */
  private static tosFieldMatches(ipPkt: IPv4Packet, want: number | undefined, shift: number, mask: number): boolean {
    if (want === undefined || Number.isNaN(want)) return false;
    if (typeof ipPkt.tos !== 'number') return false;
    return ((ipPkt.tos >> shift) & mask) === want;
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
      case IP_PROTO_ESP: return 'esp';
      case IP_PROTO_AH: return 'ahp';
      case IP_PROTO_GRE: return 'gre';
      case IP_PROTO_EIGRP: return 'eigrp';
      case IP_PROTO_OSPF: return 'ospf';
      case IP_PROTO_PIM: return 'pim';
      default: return 'ip';
    }
  }

  /** @internal Direct access to ACL list for CLI shells */
  getAccessListsInternal(): AccessList[] { return this.accessLists; }

  /** @internal Direct access to bindings for CLI shells */
  getInterfaceACLBindingsInternal(): Map<string, InterfaceACLBinding> { return this.interfaceACLBindings; }
}

function formatPortSpecTokens(spec: PortSpec): string[] {
  if (spec.op === 'range') return ['range', String(spec.port), String(spec.endPort ?? spec.port)];
  return [spec.op, String(spec.port)];
}

/**
 * Render a VRP `display acl` rule line — action, protocol, source/destination
 * (with wildcard), ports, and a trailing `(N matches)` once traffic has hit
 * the entry. Shared by the router and switch shells so both surfaces show
 * the same fields the engine actually evaluates on.
 */
export function formatHuaweiAclEntry(entry: ACLEntry, opts: { showCounts?: boolean } = {}): string {
  const parts: string[] = [entry.action];
  if (entry.protocol && entry.protocol !== 'ip') parts.push(entry.protocol);
  if (entry.srcIP.toString() !== '0.0.0.0') {
    parts.push('source', entry.srcIP.toString(), entry.srcWildcard.toString());
  }
  if (entry.dstIP && entry.dstWildcard && entry.dstIP.toString() !== '0.0.0.0') {
    parts.push('destination', entry.dstIP.toString(), entry.dstWildcard.toString());
  }
  if (entry.srcPortSpec) parts.push('source-port', ...formatPortSpecTokens(entry.srcPortSpec));
  if (entry.dstPortSpec) parts.push('destination-port', ...formatPortSpecTokens(entry.dstPortSpec));
  let line = parts.join(' ');
  if (opts.showCounts !== false && entry.matchCount > 0) {
    line += ` (${entry.matchCount} matche${entry.matchCount === 1 ? '' : 's'})`;
  }
  return line;
}
