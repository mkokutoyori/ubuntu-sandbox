/**
 * EndHost - Base class for end-user devices (PCs, servers)
 *
 * Implements the full L2/L3 network stack shared by all end-hosts:
 * - ARP resolution (RFC 826)
 * - IPv4 packet handling with proper encapsulation (RFC 791)
 * - ICMP echo request/reply (RFC 792)
 * - Default gateway for inter-subnet communication
 * - Real RTT measurement using performance.now()
 *
 * Subclasses (LinuxPC, WindowsPC) only implement terminal commands
 * and OS-specific output formatting.
 *
 * Encapsulation:
 *   Ethernet Frame
 *     ├─ ARP Packet (etherType 0x0806) — direct L2
 *     └─ IPv4 Packet (etherType 0x0800)
 *          └─ ICMP Packet (protocol 1)
 */

import { Equipment } from '../equipment/Equipment';
import {
  classifyIpv4Destination, decrementForForwarding, ipv4HeaderProblem,
  connectedPrefixesOfPort, martianSource, type ConnectedIpv4Prefix,
} from '../layers/internet/InternetLayer';
import { linkDestinationFor } from '../layers/internet/Ipv4Egress';
import { Port } from '../hardware/Port';
import type { IPv4AddressOrigin } from '../hardware/Port';
import { SocketTable } from '../core/SocketTable';
import { TcpStack } from '../tcp/TcpStack';
import type { TcpSegment, TcpDialFailure, TcpWireOutcome } from '../tcp/types';
import type { UdpChecksumInput } from '@/network/layers/transport/UdpChecksum';
import { computeTcpChecksum, isDialFailure } from '../tcp/types';
import {
  computeUdpChecksum, verifyUdpChecksum, stampUdpChecksum,
} from '@/network/layers/transport/UdpChecksum';
import { dialTcp, parseDialAddress, type DialAddress } from '../tcp/dial';
import { PortNumber } from '../core/ports/PortNumber';
import { TimerSet } from '@/events/TimerSet';
import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { waitForEvent, WaitForEventTimeoutError } from '@/events/waitForEvent';
import {
  NeighborCache,
  NDP_RETRANS_TIMER_MS,
  NDP_MAX_MULTICAST_SOLICIT,
  type NeighborCacheEntry,
} from './host/NeighborCache';
import {
  HostSignalStore,
  makeReadonlyHostObservables,
  projectArpTable,
  projectNdpTable,
  projectHostRoutes,
  type HostObservables,
} from './host/observables';
import { HostSignalRefreshActor } from './host/actors';
import {
  EthernetFrame, IPv4Packet, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket, UDPPacket, TCPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6,
  IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_TCP, IP_PROTO_UDP,
  createIPv4Packet, verifyIPv4Checksum, computeIPv4Checksum,
  // IPv6 types
  IPv6Address, IPv6Packet, ICMPv6Packet, NDPNeighborSolicitation, NDPNeighborAdvertisement,
  NDPRouterAdvertisement, NDPOptionPrefixInfo,
  createIPv6Packet, createNeighborSolicitation, createNeighborAdvertisement,
  createICMPv6EchoRequest, createICMPv6EchoReply, createRouterSolicitation,
  IPV6_ALL_NODES_MULTICAST, IPV6_ALL_ROUTERS_MULTICAST,
} from '../core/types';
import {
  DEFAULT_IPV4_TTL, ipv4HeaderOptionsOf, requiresNamedInterface, sendOnNamedInterface,
  type Ipv4SendRequest,
} from '../layers/internet/Ipv4Egress';
import { selectIpv6SourceAddress } from '../layers/internet/Ipv6Egress';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';
import { Logger } from '../core/Logger';
import { PacketQueue } from '../core/PacketQueue';
import {
  buildICMPError,
  mayGenerateICMPError,
  mayGenerateICMPv6Error,
  ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED,
  ICMP_UNREACH_NET,
  ICMP_UNREACH_HOST,
  ICMP_UNREACH_PROTO,
  ICMP_UNREACH_PORT,
  ICMP_UNREACH_NET_PROHIBITED,
  ICMP_UNREACH_HOST_PROHIBITED,
  ICMP_UNREACH_ADMIN_PROHIBITED,
  ICMP_UNREACH_FRAG_NEEDED,
  ICMP_TTL_EXPIRED_IN_TRANSIT,
  unreachableCodeName,
  type ICMPErrorType,
} from '../core/IcmpErrors';
import { fragmentIPv4, IPv4Reassembler, IPV4_FLAG_DF } from '../core/Ipv4Fragmentation';
import { isMulticastIpv4, ipv4MulticastToMac } from '../core/ip';
import { DNS_PORT } from '../dns/transport/DnsUdpTransport';
import { encodeDnsMessage, decodeDnsMessage } from '../dns/wire/DnsMessageCodec';
import type { DnsMessage } from '../dns/wire/DnsMessage';
import {
  nextDnsTransactionId,
  buildLegacyQueryMessage,
} from '../dns/compat/DnsWireCompat';
import type { DnsQueryOptions } from '../dns/compat/DnsWireCompat';
import { queryDnsOverTcp } from '../dns/transport/DnsTcpTransport';
import { queryDnsOverTls, DOT_PORT } from '../dns/transport/DnsTlsTransport';
import { HardwareProfile } from './host/hardware';
import { HostLifecycle } from './host/lifecycle';
import { SystemIdentity } from './host/identity';
import { DHCPClient } from '../dhcp/DHCPClient';
import { DHCPPacket } from '../dhcp/DHCPPacket';
import { addressAnswersOnLink } from '../arp/AddressProbe';
import { WireDhcpChannel } from '../dhcp/DhcpServerChannel';
import type { DHCPClientIfaceState } from '../dhcp/types';
import { DHCPv6Packet } from '../dhcpv6/DHCPv6Packet';
import { IP_PROTO_GRE } from '../gre/types';
import { IP_PROTO_IGMP } from '../igmp/types';
import { IgmpHostAgent } from '../igmp/IgmpHostAgent';
import { LldpAgent } from '../lldp/LldpAgent';
import { ETHERTYPE_LLDP, LLDP_MULTICAST_MAC } from '../lldp/types';
import type { LldpNeighbor } from '../lldp/LldpAgent';
import { parseNatAddress, rewriteNatAddress } from '../nat/rewrite';
import { sendDynamicUpdate } from '../dns/update/DynamicUpdateClient';
import { DnsClass, RRType } from '../dns/wire/RRType';
import { makeARecord } from '../dns/wire/ResourceRecord';

export interface GreDecapsulator {
  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): IPv4Packet | null;
}

// ─── Internal Types ────────────────────────────────────────────────

import type { ARPEntry } from '../core/types';
import type { TaggedEthernetFrame } from './Switch';

const CLIENT_DDNS_TTL = 1200;

interface OwnForwardDnsName {
  readonly zone: string;
  readonly server: string;
  readonly fqdn: string;
  readonly address: string;
}
export type { ARPEntry } from '../core/types';

/** Linux reachable time default (RFC 4861 §10): 30 seconds */
const NEIGHBOR_QUEUE_TIMEOUT_MS = 2000;
export const ARP_REACHABLE_TIME_MS = 30_000;
export const ARP_GC_STALE_TIME_MS = 60_000;
export const ARP_AGING_INTERVAL_MS = 5_000;

/** Compute NUD (Neighbor Unreachability Detection) state from an ARP entry. */
export function getNUDState(entry: ARPEntry): string {
  if (entry.type === 'static') return 'PERMANENT';
  if (entry.type === 'failed') return 'FAILED';
  return Date.now() - entry.timestamp < ARP_REACHABLE_TIME_MS ? 'REACHABLE' : 'STALE';
}

export interface PingResult {
  success: boolean;
  rttMs: number;
  ttl: number;
  /** ICMP error message (e.g. "Time to live exceeded", "Destination unreachable") */
  error?: string;
  seq: number;
  bytes: number;
  fromIP: string;
}

export interface TracerouteProbeResult {
  responded: boolean;
  rttMs?: number;
  ip?: string;
  unreachable?: boolean;
  icmpCode?: number;
}

export interface TracerouteHopResult {
  hop: number;
  ip?: string;
  rttMs?: number;
  timeout: boolean;
  unreachable?: boolean;
  icmpCode?: number;
  probes: TracerouteProbeResult[];
}

// ─── UDP socket layer (RFC 768) ──────────────────────────────────────

/** A UDP datagram as delivered to a bound listener. */
export interface UdpDelivery {
  /** Interface the datagram arrived on ('lo' for local delivery). */
  inPort: string;
  sourceIP: IPAddress | IPv6Address;
  destinationIP: IPAddress | IPv6Address;
  udp: UDPPacket;
  /** Ethernet source MAC of the frame; undefined for loopback delivery. */
  sourceMAC?: string;
}

/** Callback invoked for every datagram delivered to a bound UDP port. */
export type UdpListener = (delivery: UdpDelivery) => void;

// ─── IPv6 Neighbor Cache (RFC 4861) ─────────────────────────────────

const ICMPV6_UNREACH_ADMIN_PROHIBITED = 1;
const ICMPV6_UNREACH_PORT = 4;

export type { NeighborState, NeighborCacheEntry } from './host/NeighborCache';

// ─── IPv6 Routing Table Entry ────────────────────────────────────────

export interface HostIPv6RouteEntry {
  /** Network prefix */
  prefix: IPv6Address;
  /** Prefix length (0-128) */
  prefixLength: number;
  /** Next-hop IPv6 address (null for on-link) */
  nextHop: IPv6Address | null;
  /** Outgoing interface */
  iface: string;
  /** Route type */
  type: 'connected' | 'static' | 'default' | 'ra';
  /** Metric */
  metric: number;
}

// ─── Routing Table Types ──────────────────────────────────────────

export interface HostRouteEntry {
  /** Network destination (e.g. 192.168.2.0) */
  network: IPAddress;
  /** Subnet mask (e.g. 255.255.255.0) */
  mask: SubnetMask;
  /** Next-hop IP (null for directly connected — use destination directly) */
  nextHop: IPAddress | null;
  /** Outgoing interface name (e.g. eth0) */
  iface: string;
  /** Route type */
  type: 'connected' | 'static' | 'default';
  /** Metric (lower = preferred when prefix lengths are equal) */
  metric: number;
  /** Routing table this route belongs to; omitted/254 = main. */
  table?: number;
  /**
   * The route's interface has no carrier. Linux keeps such a route in the
   * table and flags it rather than withdrawing it — withdrawal is what
   * taking the interface administratively down does. `ip route` renders
   * the flag as a trailing `linkdown`.
   */
  linkdown?: boolean;
}

/** A policy-routing rule (`ip rule`): selects which table a lookup uses. */
export interface HostPolicyRule {
  priority: number;
  fromNetwork?: IPAddress;
  fromMask?: SubnetMask;
  toNetwork?: IPAddress;
  toMask?: SubnetMask;
  fwmark?: number;
  table: number;
}

/**
 * Interfaces with no wire behind them. They never lose carrier, so the
 * link-derived route rules must not touch their routes.
 */
function isVirtualHostInterface(name: string): boolean {
  return /^(lo|dummy|tun|tap|gre|sit|br|bond|virbr|docker|veth)/i.test(name);
}

function pickBestRouteInTable(destInt: number, table: HostRouteEntry[]): HostRouteEntry | null {
  let bestRoute: HostRouteEntry | null = null;
  let bestPrefix = -1;
  for (const route of table) {
    const netInt = route.network.toUint32();
    const maskInt = route.mask.toUint32();
    const prefix = route.mask.toCIDR();
    if ((destInt & maskInt) === (netInt & maskInt)) {
      if (prefix > bestPrefix
        || (prefix === bestPrefix && bestRoute && route.metric < bestRoute.metric)) {
        bestPrefix = prefix;
        bestRoute = route;
      }
    }
  }
  return bestRoute;
}

/** `--to-destination`/`--to-source` as iptables/ip6tables accept them: a bare "ip" or "ip:port". */
// ─── EndHost ───────────────────────────────────────────────────────

export abstract class EndHost extends Equipment {
  // ─── Socket Table (L4) ──────────────────────────────────────────
  /** Per-device socket table — tracks listening and established sockets */
  protected readonly socketTable: SocketTable = new SocketTable();

  /**
   * Les entrées `LISTEN` que le sink de `TcpStack` a posées lui-même.
   * Il ne retire que celles-là : les `socketTable.bind()` manuels qui
   * subsistent gardent exactement leur cycle de vie, si bien que cette
   * passe ne peut faire disparaître aucune ligne de `ss`.
   */
  private readonly sinkOwnedListeners = new Set<string>();

  /** Bound UDP ports → datagram listeners (RFC 768 socket layer). */
  private readonly udpListeners: Map<number, UdpListener> = new Map();

  // ─── Hardware inventory ─────────────────────────────────────────
  /**
   * Faithful model of the host's physical hardware — CPU, memory, storage,
   * NICs, firmware. The single source of truth behind `lscpu`, `free`,
   * `/proc/*`, `dmidecode` and Windows `systeminfo`. Initialised from a
   * role-appropriate preset; replaceable via {@link setHardware}.
   */
  protected hardware: HardwareProfile;

  /**
   * Power & boot state machine — the source of truth for the host's boot
   * time and uptime, driving `uptime`, `w` and the `systeminfo` boot lines.
   */
  protected readonly lifecycle: HostLifecycle;

  /**
   * System identity & configuration — OS release, kernel, machine-id, time
   * zone and locale. The source of truth behind `uname`, `hostnamectl`,
   * `timedatectl`, `/etc/os-release`, `/etc/machine-id` and `/proc/version`.
   */
  protected readonly identity: SystemIdentity;

  // ─── IPv4 State ─────────────────────────────────────────────────
  /** ARP cache: IP string → { mac, iface, timestamp } */
  protected arpTable: Map<string, ARPEntry> = new Map();
  /** Packets held while the next hop's link-layer address is resolved. */
  protected readonly fwdQueue = new PacketQueue<IPv4Packet, string>();
  protected readonly ndpQueue = new PacketQueue<IPv6Packet, string>();
  private readonly inFlightNdpSolicitations: Set<string> = new Set();
  /** In-flight ARP solicitations for forwarding — dedup signal for
   *  fwdQueueAndResolve (replaces the pendingARPs map after Phase 5.5). */
  private inFlightFwdARPs: Set<string> = new Set();
  /** Reassembles fragments of datagrams addressed to this host (RFC 791 §3.2). */
  private readonly ipv4Reassembler = new IPv4Reassembler(
    (firstFragment, ingressPort) => {
      if (!firstFragment) return;
      this.sendICMPError(ingressPort ?? '', firstFragment, 'time-exceeded',
        ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED);
    });
  /** Monotonically increasing ICMP echo identifier */
  protected pingIdCounter: number = 0;
  /** Default gateway IP (set via `ip route add default via ...` or `route add`) */
  protected defaultGateway: IPAddress | null = null;
  /** Full routing table (connected + static + default) with LPM support */
  private _routingTable: HostRouteEntry[] = [];

  protected get routingTable(): HostRouteEntry[] { return this._routingTable; }

  protected set routingTable(table: HostRouteEntry[]) {
    this._routingTable = table;
    this.noteRoutesChanged();
  }

  protected addRouteEntry(entry: HostRouteEntry): void {
    this._routingTable.push(entry);
    this.noteRoutesChanged();
  }

  private noteRoutesChanged(): void {
    if (!this.hostSignalStore || !this.tcpv2 || !this.neighborCache) return;
    this._refreshRoutesSignal();
    this._refreshHostStatsSignal();
  }
  /** Non-main routing tables (`ip route add ... table <ID>`), keyed by table ID. */
  protected policyRoutingTables: Map<number, HostRouteEntry[]> = new Map();
  /** Policy-routing rules (`ip rule`), sorted ascending by priority. */
  protected policyRules: HostPolicyRule[] = [
    { priority: 0, table: 255 },
    { priority: 32766, table: 254 },
    { priority: 32767, table: 253 },
  ];

  // ─── IPv6 State (RFC 4861, RFC 8200) ─────────────────────────────
  protected readonly neighborCache = new NeighborCache(() => this.getScheduler(), {
    onLearned: (ip, entry) => this.emitNdpLearned({
      ip, mac: entry.mac.toString(), iface: entry.iface,
    }),
    sendUnicastSolicit: (ip, entry) => this.sendUnicastNeighborSolicit(ip, entry),
  });
  /** Monotonically increasing ICMPv6 echo identifier */
  protected ping6IdCounter: number = 0;
  /** Default IPv6 gateway (learned from RA or configured) */
  protected defaultGateway6: IPv6Address | null = null;
  /** IPv6 routing table */
  protected ipv6RoutingTable: HostIPv6RouteEntry[] = [];

  protected readonly tcpv2: TcpStack;

  // ─── DHCP Client (RFC 2131) ─────────────────────────────────────
  protected dhcpClient: DHCPClient;
  /** Track DHCP-configured interfaces for 'dynamic' display */
  protected dhcpInterfaces: Set<string> = new Set();

  // ─── IP Forwarding / NAT (for NAT-T topologies) ──────────────────
  /** Whether IPv4 forwarding is enabled (sysctl net.ipv4.ip_forward=1) */
  protected ipForwardEnabled: boolean = false;

  private broadcastEchoIgnored = true;

  ignoresBroadcastEcho(): boolean { return this.broadcastEchoIgnored; }
  setIgnoresBroadcastEcho(on: boolean): void { this.broadcastEchoIgnored = on; }

  /** Set by subclasses that own a real GreAgent, to decapsulate inbound GRE. */
  protected greAgent: GreDecapsulator | null = null;

  /**
   * Receiver-side IGMP (RFC 2236 §3). Lazily built so a host that never
   * joins a group carries no multicast state at all.
   */
  private _igmpHostAgent: IgmpHostAgent | null = null;
  private _lldpAgent: LldpAgent | null = null;

  /**
   * IPv4 host model (RFC 1122 §3.3.4.2).
   * - 'weak': accept packets destined to ANY local address, whatever the
   *   ingress interface — the Linux default behaviour.
   * - 'strong': only accept packets destined to the address of the ingress
   *   interface — the Windows (Vista+) default behaviour.
   */
  protected hostModel: 'weak' | 'strong' = 'weak';
  /** Interfaces on which MASQUERADE is applied (iptables POSTROUTING MASQUERADE) */
  protected masqueradeOnInterfaces: Set<string> = new Set();

  /** Default TTL for outgoing packets (Linux=64, Windows=128) */
  protected abstract readonly defaultTTL: number;
  protected abstract resolveHostForCommand(targetStr: string): Promise<IPAddress | null>;
  /**
   * IPv6 counterpart of `resolveHostForCommand` — default is a literal-only
   * parse (matches the historical `ping6`/`ping -6` behavior). Overridden
   * by `LinuxMachine` to also consult `/etc/hosts`/DNS via NSS, the same
   * way the IPv4 path already does.
   */
  protected async resolveHost6ForCommand(targetStr: string): Promise<IPv6Address | null> {
    try { return new IPv6Address(targetStr); } catch { return null; }
  }
  /** Default Hop Limit for IPv6 (typically same as TTL) */
  protected get defaultHopLimit(): number { return this.defaultTTL; }

  // ─── Reactive plumbing (Phase 5) ──────────────────────────────────
  /** Owns scheduler-driven timers (ARP aging, echo waits). */
  protected readonly hostTimers = new TimerSet(() => this.getScheduler());
  /** Engine-private writable signal store. */
  private readonly hostSignalStore = new HostSignalStore();
  /** Read-only observables (arp, ndp, routes, tcp, stats). */
  readonly observables: HostObservables = makeReadonlyHostObservables(this.hostSignalStore);
  /** Bundled signal-refresh actor. */
  private hostSignalRefreshActor: HostSignalRefreshActor | null = null;

  // Counters that feed the host stats signal.
  private icmpEchosSent = 0;
  private icmpEchosReceived = 0;
  private icmpTimeouts = 0;
  private arpRequestsSent = 0;

  /** Optional scheduler override (Phase 5 — falls back to default). */
  private hostScheduler: IScheduler | null = null;
  setScheduler(scheduler: IScheduler | null): void {
    this.hostScheduler = scheduler;
    this.fwdQueue.setScheduler(scheduler);
    this.ndpQueue.setScheduler(scheduler);
  }
  protected getScheduler(): IScheduler {
    return this.hostScheduler ?? getDefaultScheduler();
  }

  /** Common host identity stamped on every `host.*` event. */
  protected hostRef() {
    return { deviceId: this.id, hostname: this.hostname };
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    if (this.hostSignalRefreshActor) this.attachHostActors();
  }

  // ─── IGMP (receiver side, RFC 2236 §3) ───────────────────────────

  getIgmpHostAgent(): IgmpHostAgent {
    if (!this._igmpHostAgent) {
      this._igmpHostAgent = new IgmpHostAgent({
        id: this.id, name: this.name,
        getHostname: () => this.getHostname(),
        getPort: (n: string) => this.ports.get(n),
        sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
        sendIpv4Packet: (request) => this.sendIpv4Packet(request),
      }, () => this.getBus());
    }
    return this._igmpHostAgent;
  }

  // ─── LLDP (IEEE 802.1AB) ─────────────────────────────────────────

  /**
   * Un poste Linux parle LLDP comme n'importe quel équipement du LAN :
   * c'est ce qui lui permet de découvrir le commutateur auquel il est
   * câblé, et c'est ce que `networkctl lldp` affiche. Le moteur est le
   * même que celui des switches et des routeurs, seul l'hôte change
   * (`docs/PRD-networkctl.md` §7).
   */
  getLldpAgent(): LldpAgent {
    if (!this._lldpAgent) {
      this._lldpAgent = new LldpAgent({
        sendOnLink: (request: import('../layers/link/LinkLayer').LinkSendRequest) =>
          this.getLinkLayer().send(request),
        id: this.id, name: this.name,
        getHostname: () => this.getHostname(),
        getType: () => this.getType(),
        getPort: (n: string) => this.ports.get(n),
        getPorts: () => [...this.ports.values()],
        sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
        systemDescription: () => this.lldpSystemDescription(),
      } as never, () => this.getBus());
      // networkd écoute par défaut (`LLDP=yes`) mais n'émet pas
      // (`EmitLLDP=no`) : un poste voit le commutateur auquel il est
      // câblé sans rien configurer, et n'encombre pas le LAN pour autant.
      // C'est l'inverse du défaut Cisco, où `lldp run` ouvre les deux.
      // L'émission se coupe AVANT l'activation : `setEnabled(true)` annonce
      // immédiatement, et une annonce partie ne se rattrape pas.
      for (const port of this.ports.values()) {
        this._lldpAgent.setPortTransmit(port.getName(), false);
      }
      this._lldpAgent.setEnabled(true);
      this._lldpAgent.start();
    }
    return this._lldpAgent;
  }

  protected lldpSystemDescription(): string { return this.getType(); }

  /** `EmitLLDP=` de systemd.network(5) — l'hôte annonce sa présence. */
  setLldpEmission(on: boolean): void {
    const agent = this.getLldpAgent();
    for (const port of this.ports.values()) agent.setPortTransmit(port.getName(), on);
    if (on) agent.advertiseAll('config-change');
  }

  /** Voisins LLDP, tous ports confondus ou sur un seul. */
  getLldpNeighbors(iface?: string): LldpNeighbor[] {
    const agent = this.getLldpAgent();
    return iface ? agent.getNeighborsOnPort(iface) : agent.getNeighbors();
  }

  /**
   * Join an IPv4 multicast group on an interface — the real receiver-side
   * action, emitting a genuine Membership Report on the wire.
   */
  joinMulticastGroup(iface: string, group: string): boolean {
    return this.getIgmpHostAgent().join(iface, group);
  }

  leaveMulticastGroup(iface: string, group: string): boolean {
    return this.getIgmpHostAgent().leave(iface, group);
  }

  listMulticastGroups(iface?: string): Array<{ iface: string; group: string }> {
    const all = this.getIgmpHostAgent().listMemberships();
    return (iface ? all.filter(m => m.iface === iface) : all)
      .map(({ iface: i, group }) => ({ iface: i, group }));
  }

  /**
   * Les groupes IPv6 auxquels chaque interface est abonnée.
   *
   * IPv6 n'a pas d'IGMP : l'équivalent est MLD (RFC 2710/3810), qui
   * n'existe pas ici. L'appartenance est donc tenue localement — ce qui
   * suffit à la RÉCEPTION, seul rôle qu'elle joue tant qu'aucun
   * commutateur ne fait de MLD snooping. Un routeur qui parle OSPFv3
   * s'abonne ainsi à `ff02::5`, exactement comme un vrai.
   */
  private ipv6Groups = new Map<string, Set<string>>();

  joinIPv6Group(iface: string, group: string): boolean {
    let g: IPv6Address;
    try { g = new IPv6Address(group); } catch { return false; }
    if (!g.isMulticast()) return false;
    if (!this.ports.has(iface)) return false;
    const cle = g.toString();
    const set = this.ipv6Groups.get(iface) ?? new Set<string>();
    set.add(cle);
    this.ipv6Groups.set(iface, set);
    return true;
  }

  leaveIPv6Group(iface: string, group: string): boolean {
    let g: IPv6Address;
    try { g = new IPv6Address(group); } catch { return false; }
    return this.ipv6Groups.get(iface)?.delete(g.toString()) ?? false;
  }

  listIPv6Groups(iface?: string): Array<{ iface: string; group: string }> {
    const out: Array<{ iface: string; group: string }> = [];
    for (const [i, set] of this.ipv6Groups) {
      if (iface && i !== iface) continue;
      for (const group of set) out.push({ iface: i, group });
    }
    return out;
  }

  protected isJoinedIPv6Group(iface: string, group: IPv6Address): boolean {
    return this.ipv6Groups.get(iface)?.has(group.toString()) ?? false;
  }

  /**
   * Send to an IPv6 group — what this stack was missing.
   *
   * `sendUdpDatagram6` resolved the next hop by NDP, which can never
   * succeed for `ff02::5`: a group has no neighbour to solicit. The
   * Ethernet destination DERIVES from the address (RFC 2464 §7), as on
   * the IPv4 side.
   *
   * The send happens on EVERY operational link carrying an address — a
   * group has no route — and the hop limit is 1 for link scope.
   */
  public sendIPv6ToGroup(
    group: IPv6Address,
    protocol: number,
    payload: unknown,
    payloadLength: number,
    iface?: string,
  ): boolean {
    if (!group.isMulticast()) return false;
    const dstMAC = group.toMulticastMAC();
    // A GROUP's scope is its second nibble (RFC 4291 §2.7), not the
    // `fe80::/10` prefix: `isLinkLocal()` is false for `ff02::5`.
    const onLink = group.isLinkLocalScopeMulticast();
    const hopLimit = onLink ? 1 : this.defaultHopLimit;
    let sent = false;
    for (const [name, port] of this.ports) {
      if (name === 'lo') continue;
      if (iface && name !== iface) continue;
      if (!port.isOperationallyUp() || !port.isIPv6Enabled()) continue;
      // A packet to a link-scoped group sources from the interface's
      // link-local address: that is what the neighbour replies to.
      const srcIP = onLink
        ? (port.getLinkLocalIPv6() ?? port.getGlobalIPv6())
        : (port.getGlobalIPv6() ?? port.getLinkLocalIPv6());
      if (!srcIP) continue;
      const charge = protocol === IP_PROTO_UDP && (payload as UDPPacket | undefined)?.type === 'udp'
        ? stampUdpChecksum(payload as UDPPacket, srcIP.toString(), group.toString())
        : payload;
      const ipPkt = createIPv6Packet(srcIP, group, protocol, hopLimit, charge, payloadLength);
      if (this.firewallFilter6(name, ipPkt, 'out') !== 'accept') continue;
      this.sendFrame(name, {
        srcMAC: port.getMAC(), dstMAC, etherType: ETHERTYPE_IPV6, payload: ipPkt,
      });
      sent = true;
    }
    return sent;
  }

  /** Attach (or rebind) the host signal-refresh actor to the current bus. */
  protected attachHostActors(): void {
    this.hostSignalRefreshActor?.stop();
    this.hostSignalRefreshActor = new HostSignalRefreshActor(this.getBus(), {
      getId: () => this.id,
      _refreshArpSignal: () => this._refreshArpSignal(),
      _refreshNdpSignal: () => this._refreshNdpSignal(),
      _refreshRoutesSignal: () => this._refreshRoutesSignal(),
      _refreshTcpSignal: () => this._refreshTcpSignal(),
      _refreshHostStatsSignal: () => this._refreshHostStatsSignal(),
    });
    this.hostSignalRefreshActor.start();
    this.startArpAgingTimer();
  }

  private arpAgingTimer: symbol | null = null;

  private startArpAgingTimer(): void {
    if (this.arpAgingTimer !== null) return;
    this.arpAgingTimer = this.hostTimers.setInterval(
      () => this.ageArpEntries(),
      ARP_AGING_INTERVAL_MS,
    );
  }

  private stopArpAgingTimer(): void {
    if (this.arpAgingTimer === null) return;
    this.hostTimers.clear(this.arpAgingTimer);
    this.arpAgingTimer = null;
  }

  protected ageArpEntries(): void {
    const now = Date.now();
    let purged = false;
    for (const [ip, entry] of this.arpTable) {
      if (entry.type !== 'failed') continue;
      if (now - entry.timestamp > ARP_GC_STALE_TIME_MS) {
        this.arpTable.delete(ip);
        purged = true;
      }
    }
    if (purged) this._refreshArpSignal();
  }

  // ─── Actor-API: signal refresh helpers ─────────────────────────────

  /** [actor-API] Refresh the ARP signal from `this.arpTable`. */
  _refreshArpSignal(): void {
    this.hostSignalStore.arp.set(projectArpTable(this.arpTable));
  }

  /** [actor-API] Refresh the NDP signal from `this.neighborCache`. */
  _refreshNdpSignal(): void {
    this.hostSignalStore.ndp.set(projectNdpTable(this.neighborCache.snapshot()));
  }

  /** [actor-API] Refresh the routes signal from `this.routingTable`. */
  _refreshRoutesSignal(): void {
    this.hostSignalStore.routes.set(projectHostRoutes(this.routingTable));
  }

  /** [actor-API] Refresh the TCP listeners + connections signals. */
  _refreshTcpSignal(): void {
    const listeners = this.tcpv2.listListeners().map((l) => ({ ip: l.localIp, port: l.localPort }));
    this.hostSignalStore.tcpListeners.set(listeners);
    const sockets = this.tcpv2.listSockets().map((s) => ({
      localIp: s.localIp, localPort: s.localPort,
      remoteIp: s.remoteIp, remotePort: s.remotePort,
      side: s.passive ? 'server' as const : 'client' as const,
    }));
    this.hostSignalStore.tcpConnections.set(sockets);
  }

  /** [actor-API] Refresh the aggregate stats signal. */
  _refreshHostStatsSignal(): void {
    this.hostSignalStore.stats.set({
      arpCacheSize: this.arpTable.size,
      ndpCacheSize: this.neighborCache.size,
      routeCount: this.routingTable.length,
      tcpListeners: this.tcpv2.listListeners().length,
      tcpConnections: this.tcpv2.listSockets().length,
      icmpEchosSent: this.icmpEchosSent,
      icmpEchosReceived: this.icmpEchosReceived,
      icmpTimeouts: this.icmpTimeouts,
      arpRequestsSent: this.arpRequestsSent,
    });
  }

  /** Bus emission helper for ICMP echo sent counter. */
  protected emitIcmpEchoSent(payload: {
    fromIp: string; toIp: string; id: number; seq: number; ttl: number; size: number;
  }): void {
    this.icmpEchosSent++;
    this.getBus().publish({
      topic: 'host.icmp.echo-sent',
      payload: { ...this.hostRef(), ...payload },
    });
    // Mirror onto the Logger so the Network Logs panel surfaces every
    // ping packet — the bus payload is intentionally machine-friendly,
    // Logger carries the human-readable line.
    Logger.info(
      this.id, 'icmp:echo-sent',
      `${this.name}: ICMP echo #${payload.seq} → ${payload.toIp} (id=${payload.id}, ttl=${payload.ttl}, ${payload.size}B)`,
      payload,
    );
  }

  /** Bus emission helper for ICMP echo reply received. */
  protected emitIcmpEchoReply(payload: {
    fromIp: string; toIp: string; id: number; seq: number; ttl: number; rttMs: number;
  }): void {
    this.icmpEchosReceived++;
    this.getBus().publish({
      topic: 'host.icmp.echo-reply',
      payload: { ...this.hostRef(), ...payload },
    });
    Logger.info(
      this.id, 'icmp:echo-reply',
      `${this.name}: ICMP reply from ${payload.fromIp} id=${payload.id} seq=${payload.seq} ttl=${payload.ttl} rtt=${payload.rttMs}ms`,
      payload,
    );
  }

  /** Bus emission helper for ICMP echo timeout. */
  protected emitIcmpEchoTimeout(payload: { toIp: string; id: number; seq: number }): void {
    this.icmpTimeouts++;
    this.getBus().publish({
      topic: 'host.icmp.echo-timeout',
      payload: { ...this.hostRef(), ...payload },
    });
    Logger.warn(
      this.id, 'icmp:echo-timeout',
      `${this.name}: ICMP timeout for ${payload.toIp} id=${payload.id} seq=${payload.seq}`,
      payload,
    );
  }

  /** Bus emission helper for ICMP echo failed (TTL exceeded / unreachable). */
  protected emitIcmpEchoFailed(payload: {
    fromIp: string; toIp: string; id: number; seq: number; reason: string;
  }): void {
    this.getBus().publish({
      topic: 'host.icmp.echo-failed',
      payload: { ...this.hostRef(), ...payload },
    });
    Logger.warn(
      this.id, 'icmp:echo-failed',
      `${this.name}: ICMP echo to ${payload.toIp} failed (${payload.reason}) id=${payload.id} seq=${payload.seq}`,
      payload,
    );
  }

  private publishIcmpUnreachable(ipPkt: IPv4Packet, icmp: ICMPPacket): void {
    const original = icmp.originalPacket;
    const transport = original?.payload as
      { sourcePort?: number; destinationPort?: number } | undefined;
    this.getBus().publish({
      topic: 'host.icmp.unreachable',
      payload: {
        ...this.hostRef(),
        fromIp: ipPkt.sourceIP.toString(),
        toIp: ipPkt.destinationIP.toString(),
        code: icmp.icmpType === 'time-exceeded'
          ? 'ttl-exceeded' : unreachableCodeName(icmp.code),
        icmpCode: icmp.code,
        origProtocol: original?.protocol,
        origDestPort: transport?.destinationPort,
      },
    });
  }

  /** Bus emission helper for ARP entry learned. */
  protected emitArpLearned(payload: {
    ip: string; mac: string; iface: string; source: 'reply' | 'gratuitous' | 'request' | 'static';
  }): void {
    this.getBus().publish({
      topic: 'host.arp.entry-learned',
      payload: { ...this.hostRef(), ...payload },
    });
  }

  /** Bus emission helper for ARP request sent. */
  protected emitArpRequestSent(iface: string, targetIp: string): void {
    this.arpRequestsSent++;
    this.getBus().publish({
      topic: 'host.arp.request-sent',
      payload: { ...this.hostRef(), iface, targetIp },
    });
    Logger.info(
      this.id, 'arp:request',
      `${this.name}: who-has ${targetIp} (via ${iface})`,
      { iface, targetIp },
    );
  }

  /** Bus emission helper for NDP entry learned (IPv6 equivalent of ARP learn). */
  protected emitNdpLearned(payload: { ip: string; mac: string; iface: string }): void {
    this.getBus().publish({
      topic: 'host.ndp.entry-learned',
      payload: { ...this.hostRef(), ...payload },
    });
  }

  /** Bus emission helper for host.routing.route-added. */
  protected emitRouteAdded(payload: {
    destination: string; mask: string; gateway: string | null; iface: string;
    metric: number; type: string;
  }): void {
    this.getBus().publish({
      topic: 'host.routing.route-added',
      payload: { ...this.hostRef(), ...payload },
    });
  }

  /** Bus emission helper for host.routing.route-removed. */
  protected emitRouteRemoved(payload: { destination: string; mask: string; iface: string }): void {
    this.getBus().publish({
      topic: 'host.routing.route-removed',
      payload: { ...this.hostRef(), ...payload },
    });
  }

  constructor(type: any, name: string, x: number, y: number) {
    super(type, name, x, y);
    const hostBase = {
      sendOnLink: (request: import('../layers/link/LinkLayer').LinkSendRequest) =>
        this.getLinkLayer().send(request),
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      resolveRoute: (targetIp: string) => {
        const addr = IPAddress.tryParse(targetIp);
        if (!addr) return null;
        const r = this.resolveRoute(addr);
        if (!r) return null;
        return { iface: r.port.getName(), nextHopIp: r.nextHopIP.toString() };
      },
      resolveRoute6: (targetIp: string) => {
        const r = this.resolveIPv6Route(new IPv6Address(targetIp));
        if (!r) return null;
        return { iface: r.port.getName(), nextHopIp: r.nextHopIP.toString() };
      },
      localAddress6: (iface: string, remoteIp: string) => {
        const port = this.getPort(iface);
        if (!port) return null;
        const src = selectIpv6SourceAddress(port, new IPv6Address(remoteIp));
        return src ? src.toString() : null;
      },
      sendIpv4FrameArpAware: (outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress) =>
        this.sendIpv4FrameArpAware(outPortName, ipPkt, nextHopIP),
      sendIpv6FrameNdpAware: (outPortName: string, ipPkt: IPv6Packet, nextHopIP: IPv6Address) =>
        this.sendIpv6FrameNdpAware(outPortName, ipPkt, nextHopIP),
    };
    this.tcpv2 = new TcpStack(hostBase, () => this.getBus(), () => this.getScheduler());
    this.tcpv2.start();
    this.attachListenerProjection();
    this.hardware = HardwareProfile.defaultFor(
      String(type).includes('server') ? 'server' : 'workstation',
    );
    this.lifecycle = new HostLifecycle();
    this.lifecycle.attachBus(this.getBus(), this.id, name);
    this.identity = String(type).includes('windows')
      ? (String(type).includes('server') ? SystemIdentity.windowsServer() : SystemIdentity.windows())
      : SystemIdentity.ubuntu();
    this.identity.attachBus(this.getBus(), this.id);
    this.attachHostActors();
    this.dhcpClient = new DHCPClient(
      (iface: string) => {
        const port = this.ports.get(iface);
        return port ? port.getMAC().toString() : '00:00:00:00:00:00';
      },
      (iface: string, ip: string, mask: string, gateway: string | null, origin: IPv4AddressOrigin = 'dhcp') => {
        this.configureInterface(iface, new IPAddress(ip), new SubnetMask(mask), origin);
        // A configuration that carries no router option — APIPA, or a pool
        // without `default-router` — takes the DHCP-installed gateway away
        // with it. A gateway the operator set by hand is not the client's
        // to remove.
        if (gateway) this.setDefaultGateway(new IPAddress(gateway), 'dhcp');
        else if (this.defaultGatewayOrigin === 'dhcp') this.clearDefaultGateway();
        this.dhcpInterfaces.add(iface);
        this.onDhcpLeaseConfigured(iface);
        this.registerOwnForwardDnsName(iface);
      },
      (iface: string) => {
        this.withdrawOwnForwardDnsName(this.ownForwardDnsRegistration(iface));
        const port = this.ports.get(iface);
        if (port) port.clearIP();
        // Remove connected route for this interface
        this.routingTable = this.routingTable.filter(
          r => !(r.type === 'connected' && r.iface === iface)
        );
        this.defaultGateway = null;
        this.defaultGatewayOrigin = null;
        this.routingTable = this.routingTable.filter(r => r.type !== 'default');
        this.dhcpInterfaces.delete(iface);
        this.onDhcpLeaseReleased(iface);
      },
    );
    this.dhcpClient.setLinkLocalAutoconfiguration(() => this.linkLocalAutoconfigurationEnabled());
    this.dhcpClient.setEventBus(this.getBus());
    this.dhcpClient.setHostnameProvider(() => this.getHostname());
    this.dhcpClient.setForwardRegistrationPolicy(() => this.registersOwnForwardDns());
    this.dhcpClient.setWireChannelFactory((iface) => this.getDhcpWireChannel(iface));
    this.dhcpClient.setServerObservationRecorder((iface, serverIp, serverMac) => {
      if (!serverMac || serverIp === '0.0.0.0') return;
      try {
        this.arpTable.set(serverIp, {
          mac: new MACAddress(serverMac),
          iface,
          timestamp: Date.now(),
          type: 'dynamic',
        });
      } catch { /* malformed MAC */ }
    });
  }

  private dhcpWireChannels = new Map<string, WireDhcpChannel>();

  private getDhcpWireChannel(iface: string): WireDhcpChannel | null {
    const port = this.ports.get(iface);
    if (!port) return null;
    let channel = this.dhcpWireChannels.get(iface);
    if (!channel) {
      channel = new WireDhcpChannel(iface, (ifc, pkt) => this.sendWireDhcpFrame(ifc, pkt));
      this.dhcpWireChannels.set(iface, channel);
      this.ensureDhcpUdp68Listener();
    }
    return channel;
  }

  /**
   * Single UDP/68 listener feeding the per-interface wire channels.
   * All client-side RFC 2131 validation (xid, chaddr, expected message
   * type) lives in WireDhcpChannel.exchange().
   */
  private ensureDhcpUdp68Listener(): void {
    if (this.udpListeners.has(68)) return;
    this.udpListeners.set(68, (dgram) => {
      const pkt = dgram.udp.payload;
      if (pkt instanceof DHCPPacket) {
        this.dhcpWireChannels.get(dgram.inPort)?.deliver(pkt, dgram.sourceMAC);
      }
    });
  }

  protected onDhcpLeaseConfigured(_iface: string): void {}

  protected registersOwnForwardDns(): boolean { return false; }

  private ownForwardDnsRegistration(iface: string): OwnForwardDnsName | null {
    if (!this.registersOwnForwardDns()) return null;
    const lease = this.dhcpClient.getState(iface)?.lease;
    if (!lease) return null;
    const zone = (lease.domainName ?? '').trim();
    const server = lease.dnsServers[0];
    const label = this.getHostname().split('.')[0].trim();
    if (!zone || !server || !label) return null;
    return { zone, server, fqdn: `${label}.${zone}`, address: lease.ipAddress };
  }

  private registerOwnForwardDnsName(iface: string): void {
    const own = this.ownForwardDnsRegistration(iface);
    if (!own) return;
    void sendDynamicUpdate(this, new IPAddress(own.server), {
      zone: own.zone,
      zoneClass: DnsClass.IN,
      prerequisites: [],
      updates: [
        { kind: 'delete-rrset', name: own.fqdn, type: RRType.A },
        { kind: 'add', record: makeARecord(own.fqdn, CLIENT_DDNS_TTL, own.address) },
      ],
    });
  }

  private withdrawOwnForwardDnsName(own: OwnForwardDnsName | null): void {
    if (!own) return;
    void sendDynamicUpdate(this, new IPAddress(own.server), {
      zone: own.zone,
      zoneClass: DnsClass.IN,
      prerequisites: [],
      updates: [
        { kind: 'delete-record', record: makeARecord(own.fqdn, 0, own.address) },
      ],
    });
  }

  /**
   * The v6 counterpart of the hook above. The DHCPv6 client read only
   * the address from its REPLY, so the name servers and domain it
   * carried were dropped on arrival.
   */
  protected onDhcpv6LeaseConfigured(
    _iface: string, _dnsServers: readonly string[], _domainName: string | null,
  ): void {}

  private sendWireDhcpFrame(iface: string, pkt: DHCPPacket): void {
    const port = this.ports.get(iface);
    if (!port) return;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 68, destinationPort: 67,
      length: 8 + 300, checksum: 0, payload: pkt,
    };
    const ipPkt = createIPv4Packet(
      new IPAddress('0.0.0.0'), new IPAddress('255.255.255.255'),
      IP_PROTO_UDP, 64, udp, 8 + 300);
    this.sendFrame(iface, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
  }

  protected onDhcpLeaseReleased(_iface: string): void {}

  // ─── DHCPv6 client (RFC 8415) ─────────────────────────────────
  // A one-shot SOLICIT->ADVERTISE->REQUEST->REPLY exchange rather than a
  // full stateful FSM (no RENEW/REBIND background timers) — enough for a
  // client to obtain a real, wire-negotiated address from a DHCPv6Server.
  private dhcpv6Inbox: Map<string, DHCPv6Packet[]> = new Map();
  private dhcpv6XidCounter = 1;

  private ensureDhcpv6Udp546Listener(): void {
    if (this.udpListeners.has(546)) return;
    this.udpListeners.set(546, (dgram) => {
      const pkt = dgram.udp.payload;
      if (pkt instanceof DHCPv6Packet) {
        const box = this.dhcpv6Inbox.get(dgram.inPort) ?? [];
        box.push(pkt);
        this.dhcpv6Inbox.set(dgram.inPort, box);
      }
    });
  }

  private buildDhcpv6ClientDuid(iface: string): string {
    return `00:03:00:01:${this.ports.get(iface)!.getMAC().toString()}`;
  }

  private sendDhcpv6Frame(iface: string, pkt: DHCPv6Packet): void {
    const port = this.ports.get(iface);
    const srcIp = port?.getLinkLocalIPv6();
    if (!port || !srcIp) return;
    const dst = new IPv6Address('ff02::1:2');
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 546, destinationPort: 547, length: 8 + 300, checksum: 0, payload: pkt,
    };
    const ipPkt = createIPv6Packet(
      srcIp, dst, IP_PROTO_UDP, 1,
      stampUdpChecksum(udp, srcIp.toString(), dst.toString()), 8 + 300);
    this.sendFrame(iface, {
      srcMAC: port.getMAC(), dstMAC: dst.toMulticastMAC(), etherType: ETHERTYPE_IPV6, payload: ipPkt,
    });
  }

  /**
   * Fetch a DHCPv6 lease because an advertisement asked for one. Skipped
   * when the interface already holds one: an advertisement arrives on
   * every solicitation and every link-up.
   */
  private requestDhcpv6LeaseIfNeeded(iface: string): void {
    const port = this.ports.get(iface);
    if (!port) return;
    if (port.getIPv6Addresses().some((e) => e.origin === 'dhcpv6')) return;
    try { this.requestDhcpv6Lease(iface); } catch { /* pas de serveur : on reste sans bail */ }
  }

  /**
   * Fetch the other configuration once per interface, for the O flag.
   * An attempt that brought nothing back does not count: marking it
   * would leave a host that booted before its server silent for good,
   * whereas the M flag's guard — already holding a lease — self-corrects.
   */
  private requestDhcpv6InfoIfNeeded(iface: string): void {
    if (this.dhcpv6InfoRequested.has(iface)) return;
    try {
      if (this.fetchDhcpv6Information(iface) === null) return;
    } catch { return; }
    this.dhcpv6InfoRequested.add(iface);
  }

  private dhcpv6InfoRequested = new Set<string>();

  /**
   * Stateless DHCPv6: INFORMATION-REQUEST → REPLY (RFC 8415 §18.2.6).
   * No IA and no lease — the client asks for no address and the server
   * retains nothing.
   */
  requestDhcpv6Information(iface: string, verbose = false): string {
    const port = this.ports.get(iface);
    if (!port) return verbose ? `${iface}: no such interface` : '';

    const servers = this.fetchDhcpv6Information(iface);
    if (!verbose) return '';
    if (servers === null) {
      return ['DHCPv6 INFORMATION-REQUEST', 'No DHCPv6 REPLY received'].join('\n');
    }
    return ['DHCPv6 INFORMATION-REQUEST', servers.length > 0
      ? `DHCPv6 REPLY with nameserver ${servers.join(', ')}`
      : 'DHCPv6 REPLY with no configuration'].join('\n');
  }

  /** The exchange itself; `null` when no REPLY came back. */
  private fetchDhcpv6Information(iface: string): readonly string[] | null {
    const port = this.ports.get(iface);
    if (!port) return null;
    if (!port.isIPv6Enabled()) port.enableIPv6();
    this.ensureDhcpv6Udp546Listener();

    const clientDuid = this.buildDhcpv6ClientDuid(iface);
    const xid = (this.dhcpv6XidCounter = (this.dhcpv6XidCounter + 1) & 0xffffff);

    this.dhcpv6Inbox.set(iface, []);
    this.sendDhcpv6Frame(iface, DHCPv6Packet.createInformationRequest(clientDuid, xid));

    const reply = (this.dhcpv6Inbox.get(iface) ?? [])
      .find(p => p.msgType === 'REPLY' && p.transactionId === xid);
    if (!reply) return null;

    this.onDhcpv6LeaseConfigured(iface, reply.dnsServers ?? [], reply.domainList?.[0] ?? null);
    return reply.dnsServers ?? [];
  }

  /** Real DHCPv6 SOLICIT->ADVERTISE->REQUEST->REPLY. Returns a verbose transcript, or '' on failure/no verbose. */
  requestDhcpv6Lease(iface: string, verbose = false): string {
    const port = this.ports.get(iface);
    if (!port) return verbose ? `${iface}: no such interface` : '';
    if (!port.isIPv6Enabled()) port.enableIPv6();
    this.ensureDhcpv6Udp546Listener();

    const clientDuid = this.buildDhcpv6ClientDuid(iface);
    const iaid = 1;
    const xid = (this.dhcpv6XidCounter = (this.dhcpv6XidCounter + 1) & 0xffffff);
    const lines: string[] = [];

    this.dhcpv6Inbox.set(iface, []);
    this.sendDhcpv6Frame(iface, DHCPv6Packet.createSolicit(clientDuid, iaid, xid));
    if (verbose) lines.push('DHCPv6 SOLICIT');
    const advertise = (this.dhcpv6Inbox.get(iface) ?? [])
      .find(p => p.msgType === 'ADVERTISE' && p.transactionId === xid && p.ia?.addresses[0]);
    if (!advertise) return verbose ? [...lines, 'No DHCPv6 ADVERTISE received'].join('\n') : '';
    if (verbose) lines.push(`DHCPv6 ADVERTISE of ${advertise.ia!.addresses[0].address}`);

    this.dhcpv6Inbox.set(iface, []);
    this.sendDhcpv6Frame(iface, DHCPv6Packet.createRequest(
      clientDuid, advertise.serverDuid!, iaid, advertise.ia!.addresses[0].address, xid));
    if (verbose) lines.push('DHCPv6 REQUEST');
    const reply = (this.dhcpv6Inbox.get(iface) ?? [])
      .find(p => p.msgType === 'REPLY' && p.transactionId === xid && p.ia?.addresses[0]);
    if (!reply) return verbose ? [...lines, 'No DHCPv6 REPLY received'].join('\n') : '';

    const lease = reply.ia!.addresses[0];
    port.addDHCPv6Address(new IPv6Address(lease.address), 64);
    if (verbose) lines.push(`DHCPv6 REPLY of ${lease.address}`);
    this.onDhcpv6LeaseConfigured(
      iface, reply.dnsServers ?? [], reply.domainList?.[0] ?? null);
    return lines.join('\n');
  }

  // ─── Hardware inventory ─────────────────────────────────────────

  /** The host's hardware inventory (CPU, memory, storage, NICs, firmware). */
  getHardware(): HardwareProfile {
    return this.hardware;
  }

  /** Replace the hardware inventory — e.g. to model a differently-specced host. */
  setHardware(profile: HardwareProfile): void {
    this.hardware = profile;
  }

  // ─── Power & boot lifecycle ─────────────────────────────────────

  /** The host's power & boot state machine. */
  getLifecycle(): HostLifecycle {
    return this.lifecycle;
  }

  /** Power the host on — also advances the lifecycle `off → running`. */
  override powerOn(): void {
    const wasOn = this.getIsPoweredOn();
    super.powerOn();
    if (!wasOn) this.lifecycle.powerOn();
  }

  /** Power the host off — also drives the lifecycle to `off`. */
  override powerOff(): void {
    const wasOn = this.getIsPoweredOn();
    super.powerOff();
    if (wasOn) this.lifecycle.powerOff();
    this.stopArpAgingTimer();
    this.neighborCache.stop();
  }

  // ─── System identity ────────────────────────────────────────────

  /** The host's system identity & configuration (OS, kernel, locale, …). */
  getIdentity(): SystemIdentity {
    return this.identity;
  }

  // ─── Interface Configuration ───────────────────────────────────

  getInterface(name: string): Port | undefined { return this.getPort(name); }
  getInterfaces(): Port[] { return this.getPorts(); }

  /**
   * Configure an IP on an interface. Automatically adds a connected route.
   */
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask, origin: IPv4AddressOrigin = 'manual'): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.configureIP(ip, mask, origin);

    // Remove old connected route for this interface
    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName)
    );

    // Add connected route
    const networkOctets = ip.getOctets().map((o, i) => o & mask.getOctets()[i]);
    this.addRouteEntry({
      network: new IPAddress(networkOctets),
      mask,
      nextHop: null,
      iface: ifName,
      type: 'connected',
      metric: 0,
    });

    Logger.info(this.id, 'host:interface-config',
      `${this.name}: ${ifName} configured ${ip}/${mask.toCIDR()}`);

    this.getBus().publish({
      topic: 'host.address.changed',
      payload: { ...this.hostRef(), iface: ifName, ip: ip.toString(), cidr: mask.toCIDR(), added: true },
    });

    // Send gratuitous ARP (RFC 5227) to announce new IP and update neighbors' caches
    this.sendGratuitousArp(ifName, ip, 'request');

    return true;
  }

  /**
   * Broadcast an unsolicited ARP announcement for `ip` on `ifName` — RFC 5227
   * gratuitous ARP. `mode` picks the wire opcode: 'request' is the common
   * convention (used automatically by {@link configureInterface}); 'reply'
   * matches real `arping -A`, which announces via an unsolicited ARP REPLY
   * instead. Returns false if the interface has no cable attached.
   */
  sendGratuitousArp(ifName: string, ip: IPAddress, mode: 'request' | 'reply' = 'request'): boolean {
    const port = this.ports.get(ifName);
    if (!port || !port.isConnected()) return false;
    const gratuitousARP: ARPPacket = {
      type: 'arp',
      operation: mode,
      senderMAC: port.getMAC(),
      senderIP: ip,
      targetMAC: MACAddress.broadcast(),
      targetIP: ip,
    };
    this.sendFrame(ifName, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP,
      payload: gratuitousARP,
    });
    Logger.info(this.id, 'arp:gratuitous',
      `${this.name}: gratuitous ARP ${mode} for ${ip} on ${ifName}`);
    return true;
  }

  /**
   * Remove the IPv4 configuration from an interface: clears the address
   * AND drops the connected route {@link configureInterface} added, so the
   * routing table stops advertising a network the interface no longer owns.
   *
   * Mirror of {@link configureInterface}. Every "remove address" path —
   * `netsh interface ip delete address` (cmd) and `Remove-NetIPAddress`
   * (PowerShell) — must funnel through here so both shells observe the same
   * routing table (single source of truth). Previously these paths only
   * called `port.clearIP()`, leaving a stale `connected` route behind that
   * `route print` and `Get-NetRoute` both kept showing after the IP was gone.
   */
  unconfigureInterface(ifName: string): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    const oldIP = port.getIPAddress();
    const oldMask = port.getSubnetMask();
    port.clearIP();

    // Drop the connected route this interface contributed.
    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName)
    );

    if (oldIP) {
      Logger.info(this.id, 'host:interface-config',
        `${this.name}: ${ifName} address cleared`);
      this.getBus().publish({
        topic: 'host.address.changed',
        payload: { ...this.hostRef(), iface: ifName, ip: oldIP.toString(),
                   cidr: oldMask?.toCIDR() ?? 0, added: false },
      });
    }

    return true;
  }

  // ─── Default Gateway ──────────────────────────────────────────

  getDefaultGateway(): IPAddress | null { return this.defaultGateway; }

  /**
   * Who installed the current default gateway. The DHCP client owns the one
   * it installed and takes it back when the lease stops carrying a router
   * option; everything else is the operator's and survives.
   */
  protected defaultGatewayOrigin: 'static' | 'dhcp' | null = null;

  setDefaultGateway(gw: IPAddress, origin: 'static' | 'dhcp' = 'static', metric = 0): void {
    this.defaultGateway = gw;
    this.defaultGatewayOrigin = origin;

    const previousDefault = this.routingTable.find(r => r.type === 'default');
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');

    // Find the interface the gateway is reachable through
    let gwIface = '';
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(gw, mask)) {
        gwIface = port.getName();
        break;
      }
    }

    this.addRouteEntry({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop: gw,
      iface: gwIface,
      type: 'default',
      metric,
    });

    Logger.info(this.id, 'host:gateway', `${this.name}: default gateway set to ${gw}`);

    const unchanged = previousDefault !== undefined
      && previousDefault.nextHop?.equals(gw) === true
      && previousDefault.iface === gwIface
      && previousDefault.metric === metric;
    if (unchanged) return;
    if (previousDefault) {
      this.emitRouteRemoved({
        destination: '0.0.0.0', mask: '0.0.0.0', iface: previousDefault.iface,
      });
    }
    this.emitRouteAdded({
      destination: '0.0.0.0', mask: '0.0.0.0',
      gateway: gw.toString(), iface: gwIface, metric, type: 'default',
    });
  }

  clearDefaultGateway(): void {
    this.defaultGateway = null;
    this.defaultGatewayOrigin = null;
    const previousDefault = this.routingTable.find(r => r.type === 'default');
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
    if (previousDefault) {
      this.emitRouteRemoved({
        destination: '0.0.0.0', mask: '0.0.0.0', iface: previousDefault.iface,
      });
    }
  }

  // ─── DHCP Client API ──────────────────────────────────────────

  /** Expose the per-device socket table (used by netstat/ss commands). */
  getSocketTable(): SocketTable { return this.socketTable; }

  /** `TftpEndpoint` — the one member the port needs that reaching through `getSocketTable()` would have made a two-step. */
  allocateEphemeralPort(): number { return this.socketTable.allocateEphemeralPort(); }

  /**
   * docs/PRD-Sockets-Une-Seule-Verite.md §P1 — une écoute réelle
   * s'inscrit d'elle-même dans la table que lisent `ss`, `netstat`,
   * `lsof`, `/proc/net/tcp` et `nmap`.
   *
   * Deux tables, deux clés : `TcpStack` clave par `ip:port`,
   * `SocketTable` par `protocole:famille:port` — l'adresse n'entre pas
   * dans la sienne. Deux écoutes sur le même port et des adresses
   * différentes sont donc légales pour l'une et `EADDRINUSE` pour
   * l'autre ; on consulte avant de lier, et on se tait plutôt que de
   * lever.
   */
  private attachListenerProjection(): void {
    this.tcpv2.attachSocketSink({
      announce: (localIp, localPort, identity) => {
        const family = localIp.includes(':') ? 'v6' : 'v4';
        if (this.socketTable.isPortBound(localPort, 'tcp', family)) return;
        try {
          this.socketTable.bind(
            'tcp', localIp, localPort, identity.pid, identity.processName, identity.banner,
          );
          this.sinkOwnedListeners.add(`${localIp}:${localPort}`);
        } catch { /* déjà annoncé par ailleurs — l'entrée existante fait foi */ }
      },
      withdraw: (localIp, localPort) => {
        if (!this.sinkOwnedListeners.delete(`${localIp}:${localPort}`)) return;
        this.socketTable.unbind('tcp', localIp, localPort);
      },
    });
  }

  getDHCPClient(): DHCPClient { return this.dhcpClient; }

  getDHCPState(iface: string): { state: string; xid?: number } {
    const s = this.dhcpClient.getState(iface);
    return { state: s.state, xid: s.xid };
  }

  getDHCPLogs(iface: string): string {
    return this.dhcpClient.getLogs(iface);
  }

  getMACAddress(iface: string): MACAddress {
    const port = this.ports.get(iface);
    if (!port) throw new Error(`Interface ${iface} not found`);
    return port.getMAC();
  }

  setMACAddress(iface: string, mac: MACAddress): void {
    const port = this.ports.get(iface);
    if (!port) throw new Error(`Interface ${iface} not found`);
    port.setMAC(mac);
  }

  isDHCPConfigured(iface: string): boolean {
    return this.dhcpInterfaces.has(iface);
  }

  disableDhcpOnInterface(iface: string): void {
    this.dhcpInterfaces.delete(iface);
  }

  /**
   * Kept as the entry point `dhclient` / `ipconfig /renew` call before a
   * lease request, but it no longer discovers anything: a client finds
   * its server by the broadcast DISCOVER it puts on the wire, and a
   * server several L3 hops away by the relay agent that unicasts that
   * DISCOVER to its `ip helper-address`. Both are real frame paths.
   *
   * It used to walk the global equipment registry instead — resolving
   * the cabled neighbour, then every helper address, then (for an
   * uncabled host) every device in the simulation — and hand the client
   * a direct object handle to the server. That let a client hold a lease
   * from a server it had no physical path to.
   *
   * docs/PRD-Frame-Only-Refactor.md P5.
   */
  autoDiscoverDHCPServers(): void {
    this.dhcpClient.clearServers();
  }

  // ─── Routing Table Management ──────────────────────────────────

  getRoutingTable(): HostRouteEntry[] {
    return this.buildFullRoutingTable();
  }

  /**
   * Add a static route.
   * Returns true if the route was added successfully.
   */
  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number = 100): boolean {
    // Find the interface the next-hop is reachable through
    let gwIface = '';
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const pmask = port.getSubnetMask();
      if (ip && pmask && ip.isInSameSubnet(nextHop, pmask)) {
        gwIface = port.getName();
        break;
      }
    }
    if (!gwIface) {
      Logger.warn(this.id, 'host:route-add-fail',
        `${this.name}: next-hop ${nextHop} not reachable`);
      return false;
    }

    this.addRouteEntry({
      network, mask, nextHop,
      iface: gwIface,
      type: 'static',
      metric,
    });

    Logger.info(this.id, 'host:route-add',
      `${this.name}: static route ${network}/${mask.toCIDR()} via ${nextHop} metric ${metric}`);
    this.emitRouteAdded({
      destination: network.toString(), mask: mask.toString(),
      gateway: nextHop.toString(), iface: gwIface, metric, type: 'static',
    });
    return true;
  }

  /** Add an on-link (directly-connected) static route via an interface, no gateway. */
  addDeviceRoute(network: IPAddress, mask: SubnetMask, iface: string, metric: number = 0): boolean {
    if (!this.ports.has(iface)) return false;
    this.addRouteEntry({ network, mask, nextHop: null, iface, type: 'static', metric });
    Logger.info(this.id, 'host:route-add',
      `${this.name}: on-link route ${network}/${mask.toCIDR()} dev ${iface} metric ${metric}`);
    this.emitRouteAdded({
      destination: network.toString(), mask: mask.toString(),
      gateway: null, iface, metric, type: 'static',
    });
    return true;
  }

  /**
   * Remove a route by network/mask match.
   * Returns true if a route was removed.
   */
  removeRoute(
    network: IPAddress,
    mask: SubnetMask,
    filter: { nextHop?: IPAddress | null; metric?: number } = {},
  ): boolean {
    const matches = (r: HostRouteEntry): boolean => {
      if (!(r.network.equals(network) && r.mask.toCIDR() === mask.toCIDR() && r.type === 'static')) {
        return false;
      }
      if (filter.nextHop !== undefined) {
        if (filter.nextHop === null) {
          if (r.nextHop !== null) return false;
        } else {
          if (!r.nextHop || !r.nextHop.equals(filter.nextHop)) return false;
        }
      }
      if (filter.metric !== undefined && r.metric !== filter.metric) return false;
      return true;
    };
    const removed = this.routingTable.find(matches);
    this.routingTable = this.routingTable.filter(r => !matches(r));
    if (removed) {
      this.emitRouteRemoved({
        destination: network.toString(), mask: mask.toString(), iface: removed.iface,
      });
    }
    return removed !== undefined;
  }

  // ─── Policy routing (`ip rule` + `ip route ... table <ID>`) ──────

  /** All routes visible in a given table; 254 (or main's real ID) is the existing main table. */
  getRoutingTableFor(tableId: number): HostRouteEntry[] {
    if (tableId === 254) return this.getRoutingTable();
    return [...(this.policyRoutingTables.get(tableId) ?? [])];
  }

  private tableArray(tableId: number): HostRouteEntry[] {
    let arr = this.policyRoutingTables.get(tableId);
    if (!arr) { arr = []; this.policyRoutingTables.set(tableId, arr); }
    return arr;
  }

  addStaticRouteToTable(
    tableId: number, network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number = 100,
  ): boolean {
    if (tableId === 254) return this.addStaticRoute(network, mask, nextHop, metric);
    let gwIface = '';
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const pmask = port.getSubnetMask();
      if (ip && pmask && ip.isInSameSubnet(nextHop, pmask)) { gwIface = port.getName(); break; }
    }
    if (!gwIface) return false;
    this.tableArray(tableId).push({
      network, mask, nextHop, iface: gwIface, type: 'static', metric, table: tableId,
    });
    return true;
  }

  addDeviceRouteToTable(
    tableId: number, network: IPAddress, mask: SubnetMask, iface: string, metric: number = 0,
  ): boolean {
    if (tableId === 254) return this.addDeviceRoute(network, mask, iface, metric);
    if (!this.ports.has(iface)) return false;
    this.tableArray(tableId).push({
      network, mask, nextHop: null, iface, type: 'static', metric, table: tableId,
    });
    return true;
  }

  removeRouteFromTable(
    tableId: number, network: IPAddress, mask: SubnetMask,
    filter: { nextHop?: IPAddress | null; metric?: number } = {},
  ): boolean {
    if (tableId === 254) return this.removeRoute(network, mask, filter);
    const arr = this.policyRoutingTables.get(tableId);
    if (!arr) return false;
    const matches = (r: HostRouteEntry): boolean => {
      if (!(r.network.equals(network) && r.mask.toCIDR() === mask.toCIDR())) return false;
      if (filter.nextHop !== undefined) {
        if (filter.nextHop === null) { if (r.nextHop !== null) return false; }
        else if (!r.nextHop || !r.nextHop.equals(filter.nextHop)) return false;
      }
      if (filter.metric !== undefined && r.metric !== filter.metric) return false;
      return true;
    };
    const removed = arr.some(matches);
    this.policyRoutingTables.set(tableId, arr.filter(r => !matches(r)));
    return removed;
  }

  addPolicyRule(rule: HostPolicyRule): void {
    this.policyRules.push(rule);
    this.policyRules.sort((a, b) => a.priority - b.priority);
  }

  removePolicyRule(priority: number): boolean {
    const before = this.policyRules.length;
    this.policyRules = this.policyRules.filter(r => r.priority !== priority);
    return this.policyRules.length !== before;
  }

  getPolicyRules(): HostPolicyRule[] {
    return [...this.policyRules];
  }

  /** Resolve a route consulting `ip rule` policy: first matching rule's table wins. */
  resolveRouteFromTable(
    targetIP: IPAddress, fromIP: IPAddress | null,
  ): { port: Port; nextHopIP: IPAddress; table: number } | null {
    const destInt = targetIP.toUint32();
    for (const rule of this.policyRules) {
      if (rule.fromNetwork && rule.fromMask) {
        if (!fromIP || !fromIP.networkAddress(rule.fromMask).equals(rule.fromNetwork.networkAddress(rule.fromMask))) {
          continue;
        }
      }
      if (rule.toNetwork && rule.toMask) {
        if (!targetIP.networkAddress(rule.toMask).equals(rule.toNetwork.networkAddress(rule.toMask))) continue;
      }
      const best = pickBestRouteInTable(destInt, this.getRoutingTableFor(rule.table));
      if (!best) continue;
      const port = this.ports.get(best.iface);
      if (!port) continue;
      return { port, nextHopIP: best.nextHop || targetIP, table: rule.table };
    }
    return null;
  }

  installTunnelRoute(
    network: IPAddress,
    mask: SubnetMask,
    nextHop: IPAddress | null,
    iface: string,
    type: 'static' | 'default',
    metric: number = 100,
  ): void {
    if (type === 'default') {
      this.routingTable = this.routingTable.filter(r => r.type !== 'default');
      this.defaultGateway = nextHop;
      this.addRouteEntry({
        network: new IPAddress('0.0.0.0'),
        mask: new SubnetMask('0.0.0.0'),
        nextHop,
        iface,
        type: 'default',
        metric,
      });
    } else {
      this.addRouteEntry({ network, mask, nextHop, iface, type: 'static', metric });
    }
  }

  removeTunnelRoute(network: IPAddress, mask: SubnetMask, iface: string): boolean {
    const before = this.routingTable.length;
    const matches = (r: HostRouteEntry): boolean =>
      r.iface === iface
      && r.network.equals(network)
      && r.mask.toCIDR() === mask.toCIDR();
    const removed = this.routingTable.find(matches);
    this.routingTable = this.routingTable.filter(r => !matches(r));
    if (removed?.type === 'default') this.defaultGateway = null;
    return this.routingTable.length !== before;
  }

  // ─── ARP Table ─────────────────────────────────────────────────

  getARPTable(): Map<string, MACAddress> {
    const result = new Map<string, MACAddress>();
    for (const [ip, entry] of this.arpTable) {
      result.set(ip, entry.mac);
    }
    return result;
  }

  getARPTableWithInterface(): Map<string, ARPEntry> {
    return new Map(this.arpTable);
  }

  /** Return ARP table with full entry details (type, iface, mac, timestamp). */
  getARPTableFull(): Map<string, ARPEntry> {
    return new Map(this.arpTable);
  }

  /** Add a static ARP entry. Overwrites any existing entry for the same IP. */
  addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void {
    const key = ip.toString();
    this.arpTable.set(key, {
      mac,
      iface,
      timestamp: Date.now(),
      type: 'static',
    });
    this.emitArpLearned({ ip: key, mac: mac.toString(), iface, source: 'static' });
  }

  /** Delete a single ARP entry by IP. Returns true if an entry was removed. */
  deleteARP(ip: IPAddress): boolean {
    return this.arpTable.delete(ip.toString());
  }

  /** Clear all ARP entries (both static and dynamic). */
  clearARPTable(): void {
    this.arpTable.clear();
  }

  // ─── Frame Handling (L2 → L3 dispatch) ────────────────────────

  protected receiveSlowProtocol(_portName: string, _frame: EthernetFrame): void {
  }


  protected readonly vlanSubInterfaces = new Map<string, { parent: string; vid: number }>();

  protected registerVlanSubInterface(name: string, parent: string, vid: number): void {
    this.vlanSubInterfaces.set(name, { parent, vid });
  }

  protected unregisterVlanSubInterface(name: string): void {
    this.vlanSubInterfaces.delete(name);
  }

  getVlanSubInterface(name: string): { parent: string; vid: number } | undefined {
    return this.vlanSubInterfaces.get(name);
  }

  override sendFrame(portName: string, frame: EthernetFrame): boolean {
    const sub = this.vlanSubInterfaces.get(portName);
    if (!sub) return super.sendFrame(portName, frame);
    const tagged: TaggedEthernetFrame = {
      ...frame,
      dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: sub.vid },
    };
    const sent = super.sendFrame(sub.parent, tagged);
    this.getPort(portName)?.recordOutboundFrame(frame);
    return sent;
  }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const tagged = frame as TaggedEthernetFrame;
    if (tagged.dot1q && !this.vlanSubInterfaces.has(portName)) {
      const parent = this.aggregateIngressPort(portName) ?? portName;
      for (const [subName, sub] of this.vlanSubInterfaces) {
        if (sub.parent !== parent || sub.vid !== tagged.dot1q.vid) continue;
        const { dot1q: _tag, ...untagged } = tagged;
        const subPort = this.getPort(subName);
        if (subPort) { subPort.receiveFrame(untagged); return; }
        this.handleFrame(subName, untagged);
        return;
      }
      return;
    }
    const port = this.ports.get(portName);
    if (!port) return;

    const delivery = this.getLinkLayer().deliver(portName, frame);
    if (!delivery) return;

    if (delivery.wasLinkMulticast && frame.etherType === ETHERTYPE_IPV4) {
      const ipv4 = frame.payload as IPv4Packet;
      const group = ipv4.destinationIP.toString();
      if (isMulticastIpv4(group)
        && !this.getIgmpHostAgent().acceptsGroup(portName, group)) {
        return;
      }
    }

    if (delivery.wasLinkMulticast && frame.etherType === ETHERTYPE_IPV6) {
      const ipv6 = frame.payload as IPv6Packet;
      if (!this.shouldAcceptIPv6Multicast(port, ipv6.destinationIP)) {
        return;
      }
    }

    if (frame.etherType === ETHERTYPE_LLDP
      && frame.dstMAC.toString().toLowerCase() === LLDP_MULTICAST_MAC.toLowerCase()) {
      this.getLldpAgent().handleFrame(portName, frame);
      return;
    }

    if (frame.etherType === 0x8809) {
      this.receiveSlowProtocol(portName, frame);
      return;
    }

    const logical = this.aggregateIngressPort(portName);
    if (logical !== undefined && frame.srcMAC.equals(port.getMAC())) return;
    const iface = logical ?? portName;

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(iface, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIPv4(iface, frame.payload as IPv4Packet, frame.srcMAC.toString());
    } else if (frame.etherType === ETHERTYPE_IPV6) {
      this.handleIPv6(iface, frame.payload as IPv6Packet);
    }
  }

  /**
   * Check if we should accept an IPv6 multicast packet.
   * We accept: all-nodes (ff02::1), all-routers (ff02::2 for routers),
   * and solicited-node multicast for any of our unicast addresses.
   */
  private shouldAcceptIPv6Multicast(port: Port, destIP: IPv6Address): boolean {
    // All-nodes multicast (ff02::1)
    if (destIP.isAllNodesMulticast()) return true;

    // Un groupe auquel CETTE interface s'est abonnée. Sans cela, un
    // routeur qui rejoint `ff02::5` recevait bien la trame — le filtre
    // L2 la laisse monter, la MAC étant celle du groupe — et la jetait
    // ici faute d'être « pour lui ».
    if (this.isJoinedIPv6Group(port.getName(), destIP)) return true;

    // Solicited-node multicast — check if any of our addresses match
    if (destIP.isSolicitedNodeMulticast()) {
      const destHextets = destIP.getHextets();
      const low24 = ((destHextets[6] & 0xff) << 16) | destHextets[7];

      for (const entry of port.getIPv6Addresses()) {
        const addrHextets = entry.address.getHextets();
        const addrLow24 = ((addrHextets[6] & 0xff) << 16) | addrHextets[7];
        if (low24 === addrLow24) return true;
      }
    }

    return false;
  }

  // ─── ARP Handling (RFC 826) ──────────────────────────────────

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;

    const port = this.ports.get(portName);
    if (!port) return;

    const existing = this.arpTable.get(arp.senderIP.toString());
    const isGratuitous = arp.operation === 'request' && arp.senderIP.equals(arp.targetIP);
    if (!existing || existing.type !== 'static') {
      this.arpTable.set(arp.senderIP.toString(), {
        mac: arp.senderMAC,
        iface: portName,
        timestamp: Date.now(),
        type: 'dynamic',
      });
      this.emitArpLearned({
        ip: arp.senderIP.toString(),
        mac: arp.senderMAC.toString(),
        iface: portName,
        source: isGratuitous ? 'gratuitous' : (arp.operation === 'request' ? 'request' : 'reply'),
      });
    }

    const myIP = port.getIPAddress();
    if (!myIP) return;

    if (arp.senderIP.equals(myIP) && !arp.senderMAC.equals(port.getMAC())) {
      this.getBus().publish({
        topic: 'host.arp.ip-conflict',
        payload: {
          ...this.hostRef(),
          iface: portName,
          ip: myIP.toString(),
          foreignMac: arp.senderMAC.toString(),
          localMac: port.getMAC().toString(),
        },
      });
    }

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      // ARP request for our IP → reply with our MAC
      Logger.info(this.id, 'arp:reply', `${this.name}: ARP reply for ${myIP} via ${portName}`);

      const reply: ARPPacket = {
        type: 'arp',
        operation: 'reply',
        senderMAC: port.getMAC(),
        senderIP: myIP,
        targetMAC: arp.senderMAC,
        targetIP: arp.senderIP,
      };

      this.getLinkLayer().send({
        iface: portName,
        destination: arp.senderMAC,
        etherType: ETHERTYPE_ARP,
        payload: reply,
      });
    } else if (arp.operation === 'reply') {
      // ARP reply → resolveARP() now awaits host.arp.entry-learned via the
      // reactive bus (see Phase 5.5). The receive handler only needs to flush
      // queued forwarded packets that were waiting for this resolution.
      this.flushFwdQueue(arp.senderIP.toString(), arp.senderMAC);
    }
  }

  /** Send queued forwarded packets now that ARP has been resolved. */
  private flushFwdQueue(resolvedIP: string, resolvedMAC: MACAddress): void {
    this.inFlightFwdARPs.delete(resolvedIP);
    this.fwdQueue.flush(resolvedIP, (pkt, iface) => {
      const outPort = this.ports.get(iface);
      if (!outPort) return;
      this.sendFrame(iface, {
        srcMAC: outPort.getMAC(), dstMAC: resolvedMAC,
        etherType: ETHERTYPE_IPV4, payload: pkt,
      });
    });
  }

  // ─── Firewall Hook ─────────────────────────────────────────────

  /**
   * `--reject-with` of the rule that produced the most recent 'reject'
   * verdict, if the subclass's firewall engine tracks one (iptables does).
   * Set by the subclass override of `firewallFilter`/`firewallFilter6`
   * right before returning 'reject', consumed and cleared by
   * `sendICMPReject`. `null` means "use the default" (admin-prohibited).
   */
  protected lastRejectWith: string | null = null;

  /**
   * Firewall hook for incoming packets. Override in subclasses to implement
   * real packet filtering (e.g. Linux UFW, Windows Firewall).
   * Return 'accept' to allow, 'drop' to silently discard, 'reject' to drop + ICMP error.
   * Default: accept all.
   */
  protected firewallFilter(
    _portName: string, _ipPkt: IPv4Packet, _direction: 'in' | 'out' | 'forward',
    _outPortName?: string,
  ): 'accept' | 'drop' | 'reject' {
    return 'accept';
  }

  protected firewallFilter6(
    _portName: string, _ipv6Pkt: IPv6Packet, _direction: 'in' | 'out' | 'forward',
    _outPortName?: string,
  ): 'accept' | 'drop' | 'reject' {
    return 'accept';
  }

  /**
   * Evaluate NAT table for a forwarded packet.
   * Subclasses (LinuxPC, LinuxServer) override this to use iptables nat table.
   * Returns null (no NAT) by default.
   */
  protected evaluateNat(
    _ipPkt: IPv4Packet, _inPort: string, _outPort: string,
  ): { action: string; address?: string } | null {
    return null;
  }

  /**
   * Evaluate PREROUTING DNAT rules (before routing decision).
   * Subclasses override to implement iptables nat PREROUTING chain.
   * Returns null (no DNAT) by default.
   */
  protected evaluatePreRouting(
    _inPort: string, _ipPkt: IPv4Packet,
  ): { action: string; address?: string } | null {
    return null;
  }

  /**
   * Evaluate nat OUTPUT-chain DNAT/REDIRECT rules against this host's own
   * locally-generated traffic, before it picks an egress route — real on
   * Linux exactly like PREROUTING is for network-arriving traffic.
   * Subclasses override to implement iptables nat OUTPUT chain.
   * Returns null (no NAT) by default.
   */
  protected evaluateNatOutput(
    _srcIP: string, _dstIP: IPAddress, _dstPort: number, _srcPort: number,
    _protocol: number, _tentativeOutIface: string,
  ): { action: string; address?: string } | null {
    return null;
  }

  /**
   * Evaluate ip6tables PREROUTING DNAT rules for a packet destined to this
   * host itself, before local delivery. There is no IPv6 counterpart to
   * `evaluateNat`/POSTROUTING here: end hosts don't forward IPv6 packets
   * (see `handleIPv6`), so a SNAT/MASQUERADE hook would have no call site —
   * NAT66 in this simulator is scoped to locally-destined DNAT only.
   * Subclasses override to implement ip6tables nat PREROUTING chain.
   * Returns null (no DNAT) by default.
   */
  protected evaluatePreRouting6(
    _inPort: string, _ipv6Pkt: IPv6Packet,
  ): { action: string; address?: string } | null {
    return null;
  }

  /**
   * Extract port info from an IPv4 packet for firewall evaluation.
   */
  protected extractPorts(ipPkt: IPv4Packet): { srcPort: number; dstPort: number } {
    if ((ipPkt.protocol === IP_PROTO_TCP || ipPkt.protocol === IP_PROTO_UDP) && ipPkt.payload) {
      const transport = ipPkt.payload as UDPPacket;
      return { srcPort: transport.sourcePort ?? 0, dstPort: transport.destinationPort ?? 0 };
    }
    return { srcPort: 0, dstPort: 0 };
  }

  // ─── IPv4 Handling (RFC 791) ──────────────────────────────────

  /** Return the port that owns the given unicast IPv4 address, if any. */
  /**
   * Le port qui porte cette adresse — la primaire OU une secondaire.
   *
   * Seule la primaire était consultée, si bien qu'une machine ne se
   * reconnaissait pas dans ses propres adresses ajoutées par
   * `ip addr add` : un ping vers l'une d'elles partait résoudre une MAC
   * sur le lien et échouait, au lieu de boucler dans le noyau. `Port`
   * portait déjà le prédicat exact (`ownsIPv4`), consulté par le plan de
   * données ; c'est ici qu'il manquait.
   */
  protected getPortOwningIP(ip: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      if (port.ownsIPv4(ip)) return port;
    }
    return null;
  }

  protected getPortOwningIPv6(ip: IPv6Address): Port | null {
    for (const [, port] of this.ports) {
      if (port.isIPv6Enabled() && port.hasIPv6Address(ip)) return port;
    }
    return null;
  }

  /**
   * Decide whether a destination address is "ours" for local delivery,
   * honouring the configured host model (RFC 1122 §3.3.4.2): the weak model
   * (Linux) accepts packets for any local address on any interface, the
   * strong model (Windows) only for the ingress interface address.
   * Loopback destinations are always local.
   */
  protected isLocalDestination(inPort: string, destination: IPAddress): boolean {
    if (destination.isLoopback()) return true;
    const inIP = this.ports.get(inPort)?.getIPAddress();
    if (inIP && inIP.equals(destination)) return true;
    if (this.hostModel === 'weak') return this.getPortOwningIP(destination) !== null;
    return false;
  }

  private handleIPv4(portName: string, ipPkt: IPv4Packet, srcMac?: string): void {
    if (!ipPkt || ipPkt.type !== 'ipv4') return;

    const headerProblem = ipv4HeaderProblem(ipPkt);
    if (headerProblem) {
      Logger.warn(this.id, `ipv4:${headerProblem}-fail`,
        `${this.name}: IPv4 header ${headerProblem}, dropping packet`);
      return;
    }

    // IGMP is addressed to a multicast group, never to this host's own
    // address, so it has to be picked off before the local/forward split.
    if (ipPkt.protocol === IP_PROTO_IGMP) {
      this.getIgmpHostAgent().handleIp(portName, ipPkt);
      return;
    }

    // ── PREROUTING: evaluate DNAT rules before routing decision ──
    // This allows NAT devices to redirect packets addressed to themselves
    // to a different destination (e.g. port forwarding / DNAT).
    const preNat = this.evaluatePreRouting(portName, ipPkt);
    if (preNat && preNat.action === 'DNAT' && preNat.address) {
      try {
        const { ip, port } = parseNatAddress(preNat.address);
        ipPkt = rewriteNatAddress(ipPkt, 'dst', ip, port);
      } catch { /* keep original */ }
    } else if (preNat && preNat.action === 'REDIRECT') {
      // REDIRECT has no --to-destination to read: real Linux maps the
      // destination to this box's own address on the interface that
      // received the packet (`--to-ports` optionally changes the port).
      const localIP = this.ports.get(portName)?.getIPAddress();
      if (localIP) {
        const portNum = preNat.address ? parseInt(preNat.address, 10) : NaN;
        ipPkt = rewriteNatAddress(ipPkt, 'dst', localIP.toString(), Number.isNaN(portNum) ? undefined : portNum);
      }
    }

    // Check if packet is for us
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();

    const isForUs = this.isLocalDestination(portName, ipPkt.destinationIP);
    // Also accept if destination is the broadcast for our subnet, or the
    // limited broadcast 255.255.255.255 — RFC 1122 §3.3.6 requires accepting
    // it even on an unconfigured interface (DHCP clients depend on this).
    const mask = port.getSubnetMask();
    const destClass = classifyIpv4Destination(ipPkt.destinationIP);
    const isBroadcast = destClass === 'limited-broadcast'
      || (myIP && mask && ipPkt.destinationIP.isBroadcastFor(mask));
    // Un datagramme multicast n'est adressé à personne en particulier :
    // sans cette branche il tombait dans le « pas pour nous » et l'hôte
    // le jetait, alors que le filtre L2 l'avait justement laissé monter
    // parce que la carte est abonnée au groupe.
    const isMulticast = destClass === 'multicast' || destClass === 'link-local-multicast';

    if (isForUs || isBroadcast || isMulticast) {
      // RFC 791 §3.2: reassemble before filtering/dispatch — a non-first
      // fragment carries no L4 header for the firewall or upper layer to
      // inspect, so hold it here until the full datagram is back together.
      const reassembled = this.ipv4Reassembler.add(ipPkt, undefined, portName);
      if (!reassembled) return;
      ipPkt = reassembled;

      // ── Firewall: filter incoming packets ──
      const verdict = this.firewallFilter(portName, ipPkt, 'in');
      if (verdict === 'drop' || verdict === 'reject') {
        Logger.info(this.id, 'ipv4:firewall-blocked',
          `${this.name}: firewall ${verdict} ${ipPkt.sourceIP} → ${ipPkt.destinationIP} on ${portName}`);
        if (verdict === 'reject') {
          this.sendICMPReject(portName, ipPkt);
        }
        return;
      }

      // Deliver to upper layer
      if (ipPkt.protocol === IP_PROTO_ICMP) {
        this.handleICMP(portName, ipPkt);
      } else if (ipPkt.protocol === IP_PROTO_TCP) {
        this.tcpv2.handleIp(portName, ipPkt.sourceIP, ipPkt);
      } else if (ipPkt.protocol === IP_PROTO_UDP) {
        // Un multicast sans écouteur se jette en silence, comme un
        // broadcast : répondre « port injoignable » à un groupe
        // désignerait un coupable qui n'a rien demandé.
        this.deliverUDP(portName, ipPkt, !!isBroadcast || isMulticast, srcMac);
      } else if (ipPkt.protocol === IP_PROTO_GRE && this.greAgent) {
        const inner = this.greAgent.handleIp(portName, ipPkt.sourceIP, ipPkt);
        if (inner) this.handleIPv4(portName, inner, srcMac);
      }
      return;
    }

    // IP forwarding (NAT gateway mode)
    if (this.ipForwardEnabled) {
      this.forwardIPv4(portName, ipPkt);
    }
    // Otherwise: End hosts don't forward — drop packets not addressed to them
  }

  /** Forward an IPv4 packet when ipForwardEnabled is true (NAT gateway). */
  private forwardIPv4(inPort: string, ipPkt: IPv4Packet): void {
    const martien = martianSource(ipPkt.sourceIP);
    if (martien) {
      Logger.warn(this.id, 'ipv4:martian-source',
        `${this.name}: martian source ${ipPkt.sourceIP} (${martien}) to `
        + `${ipPkt.destinationIP} on ${inPort}, dropping`);
      return;
    }
    const decision = decrementForForwarding(ipPkt);
    if (decision.kind === 'expired') {
      // RFC 792: a forwarding node MUST send Time Exceeded (Type 11, Code 0)
      // back to the source — this is what makes this hop visible to traceroute.
      Logger.info(this.id, 'ipv4:ttl-expired',
        `${this.name}: TTL expired for ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'time-exceeded', ICMP_TTL_EXPIRED_IN_TRANSIT);
      return;
    }

    const route = this.resolveRoute(ipPkt.destinationIP);
    if (!route) {
      Logger.info(this.id, 'ipv4:no-route',
        `${this.name}: no route to ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'destination-unreachable', ICMP_UNREACH_NET);
      return;
    }

    const outPortName = route.port.getName();
    if (outPortName === inPort) return; // avoid looping back on same interface

    // ── Firewall: filter forwarded packets (FORWARD chain) ──
    const verdict = this.firewallFilter(inPort, ipPkt, 'forward', outPortName);
    if (verdict === 'drop' || verdict === 'reject') {
      Logger.info(this.id, 'ipv4:firewall-forward-blocked',
        `${this.name}: firewall ${verdict} FORWARD ${ipPkt.sourceIP} → ${ipPkt.destinationIP} on ${inPort}→${outPortName}`);
      if (verdict === 'reject') {
        this.sendICMPReject(inPort, ipPkt);
      }
      return;
    }

    // NAT: apply POSTROUTING rules (MASQUERADE/SNAT/DNAT)
    let fwdPkt: IPv4Packet = decision.packet;

    const natResult = this.evaluateNat(ipPkt, inPort, outPortName);
    if (natResult) {
      if (natResult.action === 'MASQUERADE') {
        const outPortIP = route.port.getIPAddress();
        if (outPortIP) fwdPkt = rewriteNatAddress(fwdPkt, 'src', outPortIP.toString());
      } else if (natResult.action === 'SNAT' && natResult.address) {
        try {
          const { ip, port } = parseNatAddress(natResult.address);
          fwdPkt = rewriteNatAddress(fwdPkt, 'src', ip, port);
        } catch { /* keep original */ }
      } else if (natResult.action === 'DNAT' && natResult.address) {
        try {
          const { ip, port } = parseNatAddress(natResult.address);
          fwdPkt = rewriteNatAddress(fwdPkt, 'dst', ip, port);
        } catch { /* keep original */ }
      }
    } else if (this.masqueradeOnInterfaces.has(outPortName)) {
      // Fallback: legacy masquerade support
      const outPortIP = route.port.getIPAddress();
      if (outPortIP) fwdPkt = rewriteNatAddress(fwdPkt, 'src', outPortIP.toString());
    }

    // RFC 791 §3.2 / RFC 1191: this NAT-gateway forward can cross an MTU
    // boundary just like a real router forward can. DF=1 gets an ICMP
    // frag-needed instead of going out oversized; DF=0 gets fragmented.
    const effectiveMtu = route.port.getMTU();
    let outgoingFragments: IPv4Packet[] = [fwdPkt];
    if (fwdPkt.totalLength > effectiveMtu) {
      const dfSet = (fwdPkt.flags & IPV4_FLAG_DF) !== 0;
      if (dfSet) {
        Logger.info(this.id, 'ipv4:mtu-exceeded',
          `${this.name}: packet ${fwdPkt.totalLength} > MTU ${effectiveMtu}, DF=1`);
        this.sendICMPError(inPort, ipPkt, 'destination-unreachable', ICMP_UNREACH_FRAG_NEEDED, effectiveMtu);
        return;
      }
      outgoingFragments = fragmentIPv4(fwdPkt, effectiveMtu);
    }

    const nextHopMAC = this.arpTable.get(route.nextHopIP.toString());
    if (nextHopMAC) {
      for (const frag of outgoingFragments) {
        this.sendFrame(outPortName, {
          srcMAC: route.port.getMAC(),
          dstMAC: nextHopMAC.mac,
          etherType: ETHERTYPE_IPV4,
          payload: frag,
        });
      }
    } else {
      // Queue packets and send ARP request (async resolution for forwarded packets)
      for (const frag of outgoingFragments) this.fwdQueueAndResolve(frag, outPortName, route.nextHopIP, route.port);
    }
  }

  /** Queue a forwarded packet and send an ARP request for the next hop. */
  private fwdQueueAndResolve(pkt: IPv4Packet, outPort: string, nextHopIP: IPAddress, port: Port): void {
    const key = nextHopIP.toString();
    this.fwdQueue.enqueue(pkt, outPort, key, NEIGHBOR_QUEUE_TIMEOUT_MS,
      (hop) => this.inFlightFwdARPs.delete(hop));

    // Send ARP request if not already in flight for this next hop.
    if (!this.inFlightFwdARPs.has(key)) {
      this.inFlightFwdARPs.add(key);
      const myIP = port.getIPAddress();
      if (!myIP) return;
      const arpReq: ARPPacket = {
        type: 'arp', operation: 'request',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: MACAddress.broadcast(), targetIP: nextHopIP,
      };
      this.emitArpRequestSent(outPort, key);
      this.getLinkLayer().send({
        iface: outPort,
        destination: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP, payload: arpReq,
      });
    }
  }

  /**
   * ARP-aware IPv4 frame send — the same "cached? send now : queue +
   * resolve" model `sendUdpDatagram`/router forwarding already use,
   * instead of blasting straight to the broadcast MAC on a cold ARP
   * cache (audit 03, MAJEUR: transversal ARP shortcut). `nextHopIP` is
   * the on-link address whose MAC actually needs resolving — the
   * destination itself for a directly-connected peer, or the gateway
   * for anything a caller has already resolved a route for.
   */
  public sourceAddressFor(destination: IPAddress): IPAddress | null {
    if (requiresNamedInterface(destination)) return null;
    return this.resolveRoute(destination)?.port.getIPAddress() ?? null;
  }

  public sendIpv4Packet(request: Ipv4SendRequest): boolean {
    const ttl = request.ttl ?? DEFAULT_IPV4_TTL;
    const options = ipv4HeaderOptionsOf(request);

    if (requiresNamedInterface(request.destination)) {
      return sendOnNamedInterface({
        getPort: (name) => this.getPort(name),
        sendFrame: (name, frame) => this.sendFrame(name, frame),
      }, request);
    }

    const route = this.resolveRoute(request.destination);
    if (!route || !route.port.isOperationallyUp()) return false;
    const source = request.source ?? route.port.getIPAddress();
    if (!source) return false;

    this.sendIpv4FrameArpAware(
      route.iface,
      createIPv4Packet(source, request.destination, request.protocol, ttl,
        request.payload, request.payloadBytes, options),
      route.nextHopIP);
    return true;
  }

  private connectedIpv4Prefixes(): ConnectedIpv4Prefix[] {
    const out: ConnectedIpv4Prefix[] = [];
    for (const [, port] of this.ports) out.push(...connectedPrefixesOfPort(port));
    return out;
  }

  public sendIpv4FrameArpAware(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void {
    const port = this.getPort(outPortName);
    if (!port) return;
    const surLien = linkDestinationFor(nextHopIP, this.connectedIpv4Prefixes());
    if (surLien) {
      this.sendFrame(outPortName, {
        srcMAC: port.getMAC(), dstMAC: surLien,
        etherType: ETHERTYPE_IPV4, payload: ipPkt,
      });
      return;
    }
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.sendFrame(outPortName, {
        srcMAC: port.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: ipPkt,
      });
    } else {
      this.fwdQueueAndResolve(ipPkt, outPortName, nextHopIP, port);
    }
  }

  /**
   * NDP-aware IPv6 frame send — same rationale as {@link sendIpv4FrameArpAware}.
   */
  public sendIpv6FrameNdpAware(outPortName: string, ipPkt: IPv6Packet, nextHopIP: IPv6Address): void {
    const port = this.getPort(outPortName);
    if (!port) return;
    const cached = this.neighborCache.get(nextHopIP.toString());
    if (cached) {
      this.sendFrame(outPortName, {
        srcMAC: port.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6, payload: ipPkt,
      });
      return;
    }
    this.ndpQueueAndResolve(ipPkt, outPortName, nextHopIP);
  }

  private ndpQueueAndResolve(pkt: IPv6Packet, outPort: string, nextHopIP: IPv6Address): void {
    const key = nextHopIP.toString();
    this.ndpQueue.enqueue(pkt, outPort, key, NEIGHBOR_QUEUE_TIMEOUT_MS,
      (hop) => this.inFlightNdpSolicitations.delete(hop));
    if (this.inFlightNdpSolicitations.has(key)) return;
    this.inFlightNdpSolicitations.add(key);
    this.sendNeighborSolicitation(outPort, nextHopIP);
  }

  /** Send queued packets now that NDP has resolved the neighbour. */
  private flushNdpQueue(resolvedIP: string, resolvedMAC: MACAddress): void {
    this.inFlightNdpSolicitations.delete(resolvedIP);
    this.ndpQueue.flush(resolvedIP, (pkt, iface) => {
      const outPort = this.ports.get(iface);
      if (!outPort) return;
      this.sendFrame(iface, {
        srcMAC: outPort.getMAC(), dstMAC: resolvedMAC,
        etherType: ETHERTYPE_IPV6, payload: pkt,
      });
    });
  }

  /**
   * Return the apparent source IP the peer at `toIP` would see after MASQUERADE.
   * Used by IPSecEngine.getApparentSourceIP().
   */
  getOutgoingMasqueradeIP(toIP: string): string | null {
    try {
      const route = this.resolveRoute(new IPAddress(toIP));
      if (!route) return null;
      const outPortName = route.port.getName();
      if (!this.masqueradeOnInterfaces.has(outPortName)) return null;
      return route.port.getIPAddress()?.toString() ?? null;
    } catch { return null; }
  }

  // ─── ICMP Handling (RFC 792) ──────────────────────────────────

  private handleICMP(portName: string, ipPkt: IPv4Packet): void {
    const icmp = ipPkt.payload as ICMPPacket;
    if (!icmp || icmp.type !== 'icmp') return;

    if (icmp.icmpType === 'echo-request') {
      if (this.broadcastEchoIgnored && !this.getPortOwningIP(ipPkt.destinationIP)) return;
      this.sendEchoReply(portName, ipPkt, icmp);
    } else if (icmp.icmpType === 'echo-reply') {
      // Phase 5.6: settle the awaiting `sendPing` promise via the bus.
      // The awaiter computes its own rtt; we pass 0 as a sentinel so capture
      // actors can still record the reply.
      this.emitIcmpEchoReply({
        fromIp: ipPkt.sourceIP.toString(),
        toIp: ipPkt.destinationIP.toString(),
        id: icmp.id,
        seq: icmp.sequence,
        ttl: ipPkt.ttl,
        rttMs: 0,
      });
    } else if (icmp.icmpType === 'time-exceeded' || icmp.icmpType === 'destination-unreachable') {
      const reason = icmp.icmpType === 'time-exceeded'
        ? `Time to live exceeded (from ${ipPkt.sourceIP})`
        : `Destination unreachable (from ${ipPkt.sourceIP}) code ${icmp.code}`
          + (icmp.mtu !== undefined ? ` mtu ${icmp.mtu}` : '');

      this.publishIcmpUnreachable(ipPkt, icmp);

      const isHardTcpError = icmp.icmpType === 'destination-unreachable'
        && (icmp.code === ICMP_UNREACH_PORT || icmp.code === ICMP_UNREACH_ADMIN_PROHIBITED);
      // PRD-TCP.md P7 (RFC 1191/1981) — Fragmentation Needed/Packet Too Big
      // is not a hard error like the codes above: the path works, our
      // segment was just too big for it, so this shrinks MSS and
      // retransmits instead of aborting the connection.
      const isFragNeeded = icmp.icmpType === 'destination-unreachable'
        && icmp.code === ICMP_UNREACH_FRAG_NEEDED;
      if (isHardTcpError && icmp.originalPacket) {
        const origSeg = icmp.originalPacket.payload as TCPPacket | undefined;
        if (origSeg && origSeg.type === 'tcp') {
          this.tcpv2.onIcmpUnreachable(
            origSeg.sourcePort, origSeg.destinationPort,
            icmp.originalPacket.destinationIP.toString(),
            icmp.code,
          );
        }
      } else if (isFragNeeded && icmp.originalPacket && icmp.mtu !== undefined) {
        // Real TCP traffic in this stack is a `TcpSegment` (`sequence`),
        // not the legacy `TCPPacket` PDU (`sequenceNumber`) used above —
        // PMTUD needs the real sequence number to identify the bounced
        // segment in `unackedQueue`.
        const origSeg = icmp.originalPacket.payload as TcpSegment | undefined;
        if (origSeg && origSeg.type === 'tcp') {
          this.tcpv2.onIcmpFragNeeded(
            origSeg.sourcePort, origSeg.destinationPort,
            icmp.originalPacket.destinationIP.toString(), origSeg.sequence, icmp.mtu,
          );
        }
      }

      // Phase 5.6: emit host.icmp.echo-failed so awaiting `sendPing` promises
      // can settle through `waitForEvent`. Carries the original id/seq so the
      // awaiter can filter precisely.
      if (icmp.originalPacket) {
        const origICMP = icmp.originalPacket.payload as ICMPPacket;
        if (origICMP && origICMP.type === 'icmp' && origICMP.icmpType === 'echo-request') {
          this.emitIcmpEchoFailed({
            fromIp: ipPkt.sourceIP.toString(),
            toIp: icmp.originalPacket.destinationIP.toString(),
            id: origICMP.id,
            seq: origICMP.sequence,
            reason,
          });
          return;
        }
      }

      // Fallback: no original packet — emit a wildcard echo-failed
      // (id=-1, seq=-1) so listeners can still observe a failure.
      this.emitIcmpEchoFailed({
        fromIp: ipPkt.sourceIP.toString(),
        toIp: '',
        id: -1,
        seq: -1,
        reason,
      });
    } else if (icmp.icmpType === 'redirect' && icmp.gateway && icmp.originalPacket) {
      // RFC 792: host updates its routing table to use the new gateway for this destination
      const dest = icmp.originalPacket.destinationIP;
      const gw = icmp.gateway;
      const hostMask = new SubnetMask('255.255.255.255');
      // Remove any existing host route for this specific destination
      this.routingTable = this.routingTable.filter(
        r => !(r.network.equals(dest) && r.mask.toCIDR() === 32),
      );
      // Find which interface the gateway is reachable on
      const gwRoute = this.resolveRoute(gw);
      const iface = gwRoute?.port.getName() ?? portName;
      this.addRouteEntry({
        network: dest,
        mask: hostMask,
        nextHop: gw,
        iface,
        type: 'static',
        metric: 1,
      });
      Logger.info(this.id, 'icmp:redirect',
        `${this.name}: ICMP Redirect from ${ipPkt.sourceIP} — use ${gw} for ${dest}`);
    }
  }

  private sendEchoReply(portName: string, requestIP: IPv4Packet, requestICMP: ICMPPacket): void {
    const port = this.ports.get(portName);
    if (!port) return;
    // RFC 1122 §3.2.2.6: the reply is sourced from the address the request
    // was sent to when it is one of ours (weak host model: possibly another
    // interface). For broadcast-directed echoes, fall back to the address
    // of the receiving interface.
    const myIP = this.getPortOwningIP(requestIP.destinationIP)
      ? requestIP.destinationIP
      : port.getIPAddress();
    if (!myIP) return;

    // Build ICMP echo reply
    const replyICMP: ICMPPacket = {
      type: 'icmp',
      icmpType: 'echo-reply',
      code: 0,
      id: requestICMP.id,
      sequence: requestICMP.sequence,
      dataSize: requestICMP.dataSize,
    };

    const icmpSize = 8 + requestICMP.dataSize; // ICMP header + data
    // Mirror the request's DF bit: an echo request that made it here
    // unfragmented (DF unset) took a path whose MTU allows that size, so the
    // reply — same size, reverse direction — should be free to do the same
    // rather than picking up this stack's DF-by-default and bouncing.
    const replyIP = createIPv4Packet(
      myIP,
      requestIP.sourceIP,
      IP_PROTO_ICMP,
      this.defaultTTL,
      replyICMP,
      icmpSize,
      { flags: requestIP.flags },
    );

    // Route the reply — source may be on a different subnet (via default gateway)
    const route = this.resolveRoute(requestIP.sourceIP);
    if (!route) return;

    const outPortName = route.port.getName();

    // Firewall: filter outgoing reply
    const verdict = this.firewallFilter(outPortName, replyIP, 'out');
    if (verdict === 'drop' || verdict === 'reject') return;

    const nextHopMAC = this.arpTable.get(route.nextHopIP.toString());
    if (nextHopMAC) {
      this.sendFrame(outPortName, {
        srcMAC: route.port.getMAC(),
        dstMAC: nextHopMAC.mac,
        etherType: ETHERTYPE_IPV4,
        payload: replyIP,
      });
    } else {
      // Next-hop MAC unknown — queue the reply and resolve via ARP
      this.fwdQueueAndResolve(replyIP, outPortName, route.nextHopIP, route.port);
    }
  }

  /**
   * Send the ICMP error (or TCP RST) that a firewall REJECT verdict implies.
   * Honors `--reject-with` when the firewall engine set `lastRejectWith`
   * (iptables does); falls back to the historical default
   * (destination-unreachable/admin-prohibited) when unset, exactly as
   * before this existed. `tcp-reset` only applies to TCP packets — a
   * mismatched combination (e.g. configured on a UDP rule) falls back to
   * the default ICMP error rather than silently doing nothing.
   */
  private sendICMPReject(portName: string, offendingPkt: IPv4Packet): void {
    const rejectWith = this.lastRejectWith;
    this.lastRejectWith = null;

    if (rejectWith === 'tcp-reset' && offendingPkt.protocol === IP_PROTO_TCP && offendingPkt.payload) {
      this.tcpv2.sendResetForSegment(
        offendingPkt.destinationIP.toString(), offendingPkt.sourceIP.toString(),
        offendingPkt.payload as TcpSegment,
      );
      return;
    }

    this.sendICMPError(portName, offendingPkt, 'destination-unreachable', this.resolveRejectCode(rejectWith));
  }

  /** Map `--reject-with` to the ICMP Destination Unreachable code it selects. */
  private resolveRejectCode(rejectWith: string | null): number {
    switch (rejectWith) {
      case 'icmp-net-unreachable': return ICMP_UNREACH_NET;
      case 'icmp-host-unreachable': return ICMP_UNREACH_HOST;
      case 'icmp-port-unreachable': return ICMP_UNREACH_PORT;
      case 'icmp-proto-unreachable': return ICMP_UNREACH_PROTO;
      case 'icmp-net-prohibited': return ICMP_UNREACH_NET_PROHIBITED;
      case 'icmp-host-prohibited': return ICMP_UNREACH_HOST_PROHIBITED;
      case 'icmp-admin-prohibited': return ICMP_UNREACH_ADMIN_PROHIBITED;
      // Real iptables: a bare `-j REJECT` with no `--reject-with` defaults
      // to icmp-port-unreachable, not admin-prohibited.
      default: return ICMP_UNREACH_PORT;
    }
  }

  /**
   * Send an ICMP error message (Time Exceeded / Destination Unreachable)
   * back to the source of the offending packet.
   *
   * RFC 1122 §3.2.2 guards apply (no error about an error, a broadcast, …).
   * RFC 1812 §4.3.2.7: the error is routed like any other packet — looked up
   * in the routing table rather than blindly reflected on the ingress port.
   * Sourced from the ingress interface IP when it has one (the address the
   * sender was actually talking to), otherwise from the egress interface.
   */
  protected sendICMPError(
    inPort: string,
    offendingPkt: IPv4Packet,
    icmpType: ICMPErrorType,
    code: number,
    nextHopMTU?: number,
  ): void {
    if (!mayGenerateICMPError(offendingPkt)) return;

    const route = this.resolveRoute(offendingPkt.sourceIP);
    if (!route) return; // no route back to source — silently drop

    const srcIP = this.ports.get(inPort)?.getIPAddress() ?? route.port.getIPAddress();
    if (!srcIP) return;

    const errorIP = buildICMPError(srcIP, offendingPkt, icmpType, code, this.defaultTTL, { nextHopMTU });

    const outPortName = route.port.getName();
    const verdict = this.firewallFilter(outPortName, errorIP, 'out');
    if (verdict === 'drop' || verdict === 'reject') return;

    const cached = this.arpTable.get(route.nextHopIP.toString());
    if (cached) {
      this.sendFrame(outPortName, {
        srcMAC: route.port.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4,
        payload: errorIP,
      });
    } else {
      // Next-hop MAC unknown — queue the error and resolve via ARP instead
      // of dropping it on a cold cache.
      this.fwdQueueAndResolve(errorIP, outPortName, route.nextHopIP, route.port);
    }
  }

  // ─── TCP Transport (RFC 793) ───────────────────────────────────

  /**
   * Register a TCP server listener on the given port.
   * The handler is called synchronously (within the SYN handler) with the
   * new server-side TcpConnection so it can set up onData() before data arrives.
   */
  public getTcpStack(): TcpStack { return this.tcpv2; }

  protected addPort(port: Port): void {
    super.addPort(port);
    port.onLinkChange((state) => {
      if (state === 'down') { this.abortSessionsBrokenByLinkLoss(); return; }
      this.solicitRouters(port);
    });
  }

  /**
   * RFC 4861 §6.3.7: an interface coming up solicits the link's routers
   * rather than waiting for the next unsolicited advertisement, which
   * may be hundreds of seconds away.
   */
  private solicitRouters(port: Port): void {
    if (!port.isIPv6Enabled() || !port.getLinkLocalIPv6()) return;
    this.sendRouterSolicitation(port.getName());
  }

  /** True when a peer address still has a usable egress interface. */
  private canReachPeer(remoteIp: string): boolean {
    if (remoteIp === '' || remoteIp.includes(':')) return true;
    let addr: IPAddress;
    try {
      addr = new IPAddress(remoteIp);
    } catch {
      return true;
    }
    if (addr.isLoopback() || this.getPortOwningIP(addr)) return true;
    const route = this.resolveRoute(addr);
    return route !== null && this.isInterfaceOperationallyUp(route.iface, route.port);
  }

  /**
   * A link went down: every established connection that can no longer
   * reach its peer is torn down, the way a real stack drops sessions
   * whose path disappeared. Listeners keep their bound ports
   * (docs/PRD-Link-State.md §2.1 P5).
   */
  protected abortSessionsBrokenByLinkLoss(): number {
    return this.tcpv2.abortUnreachableSockets((ip) => this.canReachPeer(ip));
  }

  /**
   * PRD-TCP.md P2 — genuinely waits for the handshake to resolve instead
   * of judging it in the same synchronous tick. A SYN lost on a lossy
   * link now gets a real chance to succeed via P1's RTO retransmission
   * (the caller's `await` simply takes longer); the promise only settles
   * once the socket actually opens or actually closes (RST/timeout).
   * Already-resolved cases (instant established/refused, the common
   * loss-free path every existing caller exercises) still resolve on the
   * same tick — this is additive latency for the failure path only.
   */
  public async tcpConnect(dstIp: string, dstPort: number): Promise<import('../tcp/TcpStack').TcpSocket | null> {
    const destination = parseDialAddress(dstIp);
    const port = PortNumber.isValid(dstPort) ? PortNumber.of(dstPort) : null;
    if (!destination || !port) return null;
    const outcome = await this.tcpDial(destination, port);
    return isDialFailure(outcome) ? null : outcome;
  }

  /**
   * Le meme appel que `tcpConnect`, qui NOMME l'echec au lieu de rendre un
   * `null` muet. Un RST et un paquet jete ne se diagnostiquent pas de la
   * meme facon — la distinction est celle que `connectOutcome` tire deja,
   * et `refused`/`timeout` sont lus au meme endroit pour que les deux ne
   * puissent pas se contredire.
   */
  public tcpDial(
    destination: DialAddress, port: PortNumber,
  ): Promise<import('../tcp/TcpStack').TcpSocket | TcpDialFailure> {
    return dialTcp(this.tcpv2, destination, port);
  }

  // ─── UDP Transport (RFC 768) ───────────────────────────────────

  /**
   * Bind a UDP port and register a datagram listener (socket-style API).
   * The binding is recorded in the socket table so `netstat`/`ss` show it.
   * Throws EADDRINUSE when the port is already bound (Fail Fast).
   */
  public addressAnswersOnLink(iface: string, target: IPAddress): boolean {
    const port = this.ports.get(iface);
    if (!port) return false;
    return addressAnswersOnLink({
      sendOnLink: (request) => this.getLinkLayer().send(request),
      hasNeighbour: (ip) => this.arpTable.has(ip),
      neighbourMac: (ip) => this.arpTable.get(ip)?.mac,
      answersEcho: (from, send) => {
        let vu = false;
        const stop = this.getBus().subscribe('host.icmp.echo-reply', (e) => {
          if ((e.payload as { fromIp?: string }).fromIp === from) vu = true;
        });
        try { send(); } finally { stop(); }
        return vu;
      },
    }, iface, port, target);
  }

  public udpBind(port: number, listener: UdpListener, processName?: string): boolean {
    try {
      this.socketTable.bind('udp', '0.0.0.0', port, undefined, processName);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('EADDRINUSE')) return false;
      throw error;
    }
    this.udpListeners.set(port, listener);
    return true;
  }

  private readonly udpAddressListeners = new Map<string, UdpListener>();

  /**
   * Lie un service à UNE adresse plutôt qu'à tout le port. Le port reste
   * disponible pour un service lié à `0.0.0.0`, ce qui est la cohabitation
   * réelle entre systemd-resolved (127.0.0.53:53) et un serveur DNS local.
   */
  public udpBindAddress(
    address: string, port: number, listener: UdpListener, processName?: string,
  ): void {
    this.socketTable.bind('udp', address, port, undefined, processName);
    this.udpAddressListeners.set(`${address}:${port}`, listener);
  }

  public udpCloseAddress(address: string, port: number): void {
    this.udpAddressListeners.delete(`${address}:${port}`);
    this.socketTable.unbind('udp', address, port);
  }

  /** Close a UDP port: remove the listener and the socket-table entry. */
  public udpClose(port: number): void {
    this.udpListeners.delete(port);
    this.socketTable.unbind('udp', '0.0.0.0', port);
  }

  /**
   * Send a UDP datagram, routed through the host routing table like any
   * locally-originated traffic (firewall OUTPUT chain included). Datagrams
   * for loopback or an address we own are delivered locally without
   * touching the wire. Returns false when there is no route or no source
   * address (caller maps that to ENETUNREACH-style errors).
   */
  public sendUdpDatagram(request: UdpSendRequest): boolean;
  public sendUdpDatagram(
    destinationIP: IPAddress,
    destinationPort: number,
    sourcePort: number,
    payload: unknown,
    payloadBytes?: number,
    options?: { df?: boolean; iface?: string },
  ): boolean;
  public sendUdpDatagram(
    first: IPAddress | UdpSendRequest,
    port?: number,
    source?: number,
    body?: unknown,
    bytes: number = 0,
    opts: { df?: boolean; iface?: string } = {},
  ): boolean {
    if (!(first instanceof IPAddress)) {
      return this.emitUdpDatagram(
        first.destination, first.destinationPort, first.sourcePort,
        first.payload, first.payloadBytes,
        first.iface === undefined ? {} : { iface: first.iface });
    }
    return this.emitUdpDatagram(first, port as number, source as number, body, bytes, opts);
  }

  private emitUdpDatagram(
    destinationIP: IPAddress,
    destinationPort: number,
    sourcePort: number,
    payload: unknown,
    payloadBytes: number = 0,
    options: { df?: boolean; iface?: string } = {},
  ): boolean {
    // OUTPUT: nat OUTPUT-chain DNAT/REDIRECT applies to this host's own
    // outbound traffic before the loopback/local-delivery decision below,
    // mirroring real Linux's early routing decision + LOCAL_OUT hook
    // ordering. Skipped for multicast/broadcast/loopback — none is a
    // realistic DNAT/REDIRECT target and no rule ever matches them.
    if (!destinationIP.isLoopback()
      && !isMulticastIpv4(destinationIP.toString())
      && destinationIP.toString() !== '255.255.255.255') {
      const tentativeRoute = this.resolveRoute(destinationIP);
      const outputNat = this.evaluateNatOutput(
        tentativeRoute?.port.getIPAddress()?.toString() ?? '0.0.0.0',
        destinationIP, destinationPort, sourcePort, IP_PROTO_UDP, tentativeRoute?.port.getName() ?? '',
      );
      if (outputNat?.action === 'REDIRECT') {
        // No --to-destination to read: real Linux maps a locally-generated
        // packet's destination to loopback (there is no "incoming
        // interface" for traffic this host originates itself).
        const portNum = outputNat.address ? parseInt(outputNat.address, 10) : NaN;
        destinationIP = new IPAddress('127.0.0.1');
        if (!Number.isNaN(portNum)) destinationPort = portNum;
      } else if (outputNat?.action === 'DNAT' && outputNat.address) {
        const { ip, port } = parseNatAddress(outputNat.address);
        destinationIP = new IPAddress(ip);
        if (port !== undefined) destinationPort = port;
      }
    }

    const udpBase = { type: 'udp' as const, sourcePort, destinationPort, length: 8 + payloadBytes, payload };
    // Preserve the existing DF=1 default (every prior caller relied on
    // it); pass { df: false } to originate fragmentable UDP traffic that
    // a smaller-MTU hop can split instead of bouncing (RFC 791 §3.2).
    const flags = options.df === false ? 0 : IPV4_FLAG_DF;

    // Local delivery (loopback or own address) — like a real kernel, this
    // never reaches the wire.
    if (destinationIP.isLoopback() || this.getPortOwningIP(destinationIP)) {
      const srcStr = destinationIP.toString();
      const udp: UDPPacket = { ...udpBase, checksum: computeUdpChecksum(udpBase, srcStr, srcStr) };
      const localPkt = createIPv4Packet(
        destinationIP, destinationIP, IP_PROTO_UDP, this.defaultTTL, udp, udp.length, { flags },
      );
      this.deliverUDP('lo', localPkt, false);
      return true;
    }

    // Multicast et broadcast limité n'ont ni route ni voisin à résoudre :
    // la MAC se déduit du groupe (RFC 1112 §6.4), et la trame part sur le
    // lien. Sans cette branche, `resolveRoute` échouait et l'hôte ne
    // pouvait rien émettre vers un groupe — pas même un groupe rejoint.
    if (isMulticastIpv4(destinationIP.toString())
      || destinationIP.toString() === '255.255.255.255') {
      return this.sendUdpToGroup(destinationIP, udpBase, flags, options.iface);
    }

    const route = this.resolveRoute(destinationIP);
    if (!route) return false;
    const srcIP = route.port.getIPAddress();
    if (!srcIP) return false;

    const udp: UDPPacket = {
      ...udpBase,
      checksum: computeUdpChecksum(udpBase, srcIP.toString(), destinationIP.toString()),
    };
    const ipPkt = createIPv4Packet(
      srcIP, destinationIP, IP_PROTO_UDP, this.defaultTTL, udp, udp.length, { flags },
    );

    const outPortName = route.port.getName();
    const verdict = this.firewallFilter(outPortName, ipPkt, 'out');
    if (verdict === 'drop' || verdict === 'reject') return false;

    const cached = this.arpTable.get(route.nextHopIP.toString());
    if (cached) {
      this.sendFrame(outPortName, {
        srcMAC: route.port.getMAC(),
        dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4,
        payload: ipPkt,
      });
    } else {
      // Cold ARP cache: queue the datagram and resolve asynchronously.
      this.fwdQueueAndResolve(ipPkt, outPortName, route.nextHopIP, route.port);
    }
    return true;
  }

  /**
   * Émission vers un groupe (ou le broadcast limité). Sans interface
   * nommée, la trame part sur chaque lien monté qui porte une adresse —
   * c'est le comportement d'un démon qui a rejoint le groupe sur tous ses
   * liens, et c'est ce dont LLMNR et mDNS ont besoin.
   */
  private sendUdpToGroup(
    group: IPAddress,
    udpBase: Omit<UDPPacket, 'checksum'>,
    flags: number,
    iface?: string,
  ): boolean {
    const isLimitedBroadcast = group.toString() === '255.255.255.255';
    const dstMAC = isLimitedBroadcast
      ? MACAddress.broadcast()
      : new MACAddress(ipv4MulticastToMac(group.toString()));

    let sent = false;
    for (const [name, port] of this.ports) {
      if (name === 'lo') continue;
      if (iface && name !== iface) continue;
      if (!port.isOperationallyUp()) continue;
      const srcIP = port.getIPAddress();
      if (!srcIP) continue;

      const udp: UDPPacket = {
        ...udpBase,
        checksum: computeUdpChecksum(udpBase, srcIP.toString(), group.toString()),
      };
      // TTL 1 : un groupe en 224.0.0.0/24 ne franchit jamais le lien
      // (RFC 1112 §6.1), et c'est exactement ce que LLMNR et mDNS
      // attendent.
      const ttl = isLimitedBroadcast || group.toString().startsWith('224.0.0.')
        ? 1 : this.defaultTTL;
      const ipPkt = createIPv4Packet(
        srcIP, group, IP_PROTO_UDP, ttl, udp, udp.length, { flags },
      );
      if (this.firewallFilter(name, ipPkt, 'out') !== 'accept') continue;
      this.sendFrame(name, {
        srcMAC: port.getMAC(), dstMAC, etherType: ETHERTYPE_IPV4, payload: ipPkt,
      });
      sent = true;
    }
    return sent;
  }

  public sendUdpDatagramTo(
    destinationIP: IPAddress | IPv6Address,
    destinationPort: number,
    sourcePort: number,
    payload: unknown,
    payloadBytes: number = 0,
  ): boolean {
    return destinationIP instanceof IPv6Address
      ? this.sendUdpDatagram6(destinationIP, destinationPort, sourcePort, payload, payloadBytes)
      : this.sendUdpDatagram(destinationIP, destinationPort, sourcePort, payload, payloadBytes);
  }

  public sendUdpDatagram6(
    destinationIP: IPv6Address,
    destinationPort: number,
    sourcePort: number,
    payload: unknown,
    payloadBytes: number = 0,
  ): boolean {
    const udp: UDPPacket = {
      type: 'udp', sourcePort, destinationPort,
      length: 8 + payloadBytes, checksum: 0, payload,
    };

    if (destinationIP.isLoopback() || this.getPortOwningIPv6(destinationIP)) {
      const localPkt = createIPv6Packet(
        destinationIP, destinationIP, IP_PROTO_UDP, this.defaultHopLimit,
        stampUdpChecksum(udp, destinationIP.toString(), destinationIP.toString()),
        udp.length,
      );
      this.deliverUDP6('lo', localPkt);
      return true;
    }

    // A group has neither route nor neighbour, so resolving it by NDP
    // could never succeed and every multicast send failed silently.
    if (destinationIP.isMulticast()) {
      return this.sendIPv6ToGroup(destinationIP, IP_PROTO_UDP, udp, udp.length);
    }

    const route = this.resolveIPv6Route(destinationIP);
    if (!route) return false;
    const srcIP = selectIpv6SourceAddress(route.port, destinationIP);
    if (!srcIP) return false;

    const ipPkt = createIPv6Packet(
      srcIP, destinationIP, IP_PROTO_UDP, this.defaultHopLimit,
      stampUdpChecksum(udp, srcIP.toString(), destinationIP.toString()), udp.length,
    );

    const outPortName = route.port.getName();
    if (this.firewallFilter6(outPortName, ipPkt, 'out') !== 'accept') return false;

    const cached = this.neighborCache.get(route.nextHopIP.toString());
    if (cached) {
      this.sendFrame(outPortName, {
        srcMAC: route.port.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6, payload: ipPkt,
      });
    } else {
      void this.resolveNDP(outPortName, route.nextHopIP).then((mac) => {
        this.sendFrame(outPortName, {
          srcMAC: route.port.getMAC(), dstMAC: mac,
          etherType: ETHERTYPE_IPV6, payload: ipPkt,
        });
      }).catch(() => {});
    }
    return true;
  }

  /**
   * Deliver a locally-addressed UDP datagram to its bound listener.
   * RFC 1122 §4.1.3.1: a datagram for a port with no listener elicits
   * ICMP Destination Unreachable Code 3 (port unreachable) — never for
   * broadcast-directed datagrams.
   */
  private dispatchUdpToListener(
    portName: string, udp: UDPPacket,
    sourceIP: IPAddress | IPv6Address, destinationIP: IPAddress | IPv6Address,
    sourceMAC?: string,
  ): boolean {
    // Un service lié à UNE adresse est consulté avant le port générique :
    // c'est ce qui permet à systemd-resolved de tenir 127.0.0.53:53 sans
    // interdire à dnsmasq ou bind9 de prendre 0.0.0.0:53, exactement comme
    // sur un Ubuntu réel.
    const bound = this.udpAddressListeners.get(`${destinationIP.toString()}:${udp.destinationPort}`);
    if (bound) {
      bound({ inPort: portName, sourceIP, destinationIP, udp, sourceMAC });
      return true;
    }
    const listener = this.udpListeners.get(udp.destinationPort);
    if (!listener) return false;
    listener({ inPort: portName, sourceIP, destinationIP, udp, sourceMAC });
    return true;
  }

  private deliverUDP(portName: string, ipPkt: IPv4Packet, wasBroadcast: boolean, srcMac?: string): void {
    const udp = ipPkt.payload as UDPPacket;
    if (!udp || udp.type !== 'udp') return;

    // RFC 768: a non-zero checksum that doesn't match is corruption — a
    // real kernel silently discards it (UdpInErrors), no ICMP reply.
    if (!verifyUdpChecksum(udp, ipPkt.sourceIP.toString(), ipPkt.destinationIP.toString())) {
      Logger.warn(this.id, 'udp:checksum-fail',
        `${this.name}: invalid UDP checksum from ${ipPkt.sourceIP}:${udp.sourcePort}, dropping`);
      return;
    }

    if (this.dispatchUdpToListener(portName, udp, ipPkt.sourceIP, ipPkt.destinationIP, srcMac)) return;

    // NTP (`docs/PRD-NTP-Tutoriel.md` §4). Un hote qui interroge un
    // serveur doit pouvoir entendre sa REPONSE : sans ce point de
    // remise, chronyd emettait ses paquets et rien ne revenait jamais,
    // donc aucune machine Linux ne pouvait se synchroniser.
    if (udp.destinationPort === 123) {
      const ntp = (this as unknown as { getNtpAgent?: () => import('../ntp/NtpAgent').NtpAgent })
        .getNtpAgent?.();
      if (ntp) { ntp.handleUdp(portName, ipPkt.sourceIP, udp); return; }
    }

    if (!wasBroadcast) {
      Logger.info(this.id, 'udp:port-unreachable',
        `${this.name}: no listener on UDP ${udp.destinationPort}, ` +
        `replying port unreachable to ${ipPkt.sourceIP}`);
      this.sendICMPError(portName, ipPkt, 'destination-unreachable', ICMP_UNREACH_PORT);
    }
  }

  private deliverUDP6(portName: string, ipv6: IPv6Packet): void {
    const udp = ipv6.payload as UDPPacket;
    if (!udp || udp.type !== 'udp') return;

    if (!verifyUdpChecksum(
      udp, ipv6.sourceIP.toString(), ipv6.destinationIP.toString())) {
      Logger.warn(this.id, 'udp6:checksum-fail',
        `${this.name}: invalid UDP checksum over IPv6, dropping`);
      return;
    }

    if (this.dispatchUdpToListener(portName, udp, ipv6.sourceIP, ipv6.destinationIP)) return;

    this.sendICMPv6Unreachable(portName, ipv6);
  }

  private sendICMPv6Unreachable(portName: string, offendingPkt: IPv6Packet, code: number = ICMPV6_UNREACH_PORT): void {
    if (!mayGenerateICMPv6Error(offendingPkt, 'destination-unreachable')) return;
    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return;
    const srcIP = offendingPkt.destinationIP;
    if (!srcIP) return;

    const icmpError: ICMPv6Packet = {
      type: 'icmpv6', icmpType: 'destination-unreachable', code,
    };
    const errorPkt = createIPv6Packet(
      srcIP, offendingPkt.sourceIP, IP_PROTO_ICMPV6, this.defaultHopLimit, icmpError, 48,
    );

    const route = this.resolveIPv6Route(offendingPkt.sourceIP);
    if (!route) return;
    if (this.firewallFilter6(route.port.getName(), errorPkt, 'out') !== 'accept') return;

    const cached = this.neighborCache.get(route.nextHopIP.toString());
    if (cached) {
      this.sendFrame(route.port.getName(), {
        srcMAC: route.port.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV6, payload: errorPkt,
      });
      return;
    }
    void this.resolveNDP(route.port.getName(), route.nextHopIP).then((mac) => {
      this.sendFrame(route.port.getName(), {
        srcMAC: route.port.getMAC(), dstMAC: mac,
        etherType: ETHERTYPE_IPV6, payload: errorPkt,
      });
    }).catch(() => {});
  }

  public async queryDnsServer(
    serverIP: IPAddress | IPv6Address,
    name: string,
    qtype: string,
    timeoutMs: number = 2000,
    options: DnsQueryOptions = {},
  ): Promise<DnsMessage | null> {
    const port = options.port ?? DNS_PORT;
    if (options.tls) {
      // RFC 7858 : port propre, poignée de main TLS 1.3 réelle. Le port 53
      // par défaut ne vaut pas ici — c'est 853 tant que l'appelant n'en
      // impose pas un autre.
      const query = buildLegacyQueryMessage(nextDnsTransactionId(), name, qtype, options);
      if (!query) return null;
      if (!(serverIP instanceof IPAddress)) return null;
      return queryDnsOverTls(this, serverIP, query, {
        port: options.port ?? DOT_PORT, timeoutMs,
      });
    }
    if (options.tcp) {
      const query = buildLegacyQueryMessage(nextDnsTransactionId(), name, qtype, options);
      if (!query) return null;
      return queryDnsOverTcp(this, serverIP, query, port, timeoutMs);
    }
    const wire = this.encodeDnsQuery(name, qtype, options);
    if (!wire) return null;
    let sourcePort: number;
    try {
      sourcePort = this.socketTable.allocateEphemeralPort();
    } catch {
      return null;
    }

    return new Promise<DnsMessage | null>((resolve) => {
      let timer: symbol | null = null;
      let settled = false;
      const finish = (result: DnsMessage | null) => {
        if (settled) return;
        settled = true;
        this.hostTimers.clear(timer);
        this.udpClose(sourcePort);
        resolve(result);
      };

      try {
        this.udpBind(sourcePort, ({ udp }) => {
          const response = this.decodeDnsReply(udp.payload, wire.id);
          if (response) finish(response);
        }, 'resolver');
      } catch {
        resolve(null);
        return;
      }

      const sent = this.sendUdpDatagramTo(
        serverIP, port, sourcePort, wire.bytes, wire.bytes.length,
      );
      if (!sent) {
        finish(null);
        return;
      }
      timer = this.hostTimers.setTimeout(() => finish(null), timeoutMs);
    });
  }

  public queryDnsServerSync(
    serverIP: IPAddress | IPv6Address,
    name: string,
    qtype: string,
  ): DnsMessage | null {
    const wire = this.encodeDnsQuery(name, qtype);
    if (!wire) return null;
    let sourcePort: number;
    try {
      sourcePort = this.socketTable.allocateEphemeralPort();
    } catch {
      return null;
    }
    let reply: DnsMessage | null = null;
    try {
      this.udpBind(sourcePort, ({ udp }) => {
        const response = this.decodeDnsReply(udp.payload, wire.id);
        if (response) reply = response;
      }, 'resolver');
    } catch {
      return null;
    }
    this.sendUdpDatagramTo(
      serverIP, DNS_PORT, sourcePort, wire.bytes, wire.bytes.length,
    );
    this.udpClose(sourcePort);
    return reply;
  }

  private encodeDnsQuery(
    name: string,
    qtype: string,
    options: DnsQueryOptions = {},
  ): { id: number; bytes: Uint8Array } | null {
    const id = nextDnsTransactionId();
    const query = buildLegacyQueryMessage(id, name, qtype, options);
    if (!query) return null;
    try {
      return { id, bytes: encodeDnsMessage(query) };
    } catch {
      return null;
    }
  }

  private decodeDnsReply(payload: unknown, id: number): DnsMessage | null {
    if (!(payload instanceof Uint8Array)) return null;
    try {
      const message = decodeDnsMessage(payload);
      return message.id === id && message.flags.qr ? message : null;
    } catch {
      return null;
    }
  }

  // ─── ARP Resolution ────────────────────────────────────────────

  /**
   * Resolve an IP address to a MAC address via ARP.
   * Returns cached result if available, otherwise sends ARP request and waits.
   */
  protected async resolveARP(portName: string, targetIP: IPAddress, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.arpTable.get(targetIP.toString());
    if (cached && cached.type !== 'failed') return cached.mac;

    const port = this.ports.get(portName);
    if (!port) throw new Error('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) throw new Error('No IP configured');

    const targetIpStr = targetIP.toString();

    // Reactive wait: resolve when the bus reports a learn for this IP on this device.
    const waitPromise = waitForEvent(
      this.getBus(),
      'host.arp.entry-learned',
      (p) => p.deviceId === this.id && p.ip === targetIpStr,
      { timeoutMs, scheduler: this.getScheduler() },
    );

    // Send ARP broadcast.
    const arpReq: ARPPacket = {
      type: 'arp',
      operation: 'request',
      senderMAC: port.getMAC(),
      senderIP: myIP,
      targetMAC: MACAddress.broadcast(),
      targetIP,
    };
    this.emitArpRequestSent(portName, targetIpStr);
    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP,
      payload: arpReq,
    });

    try {
      const learned = await waitPromise;
      return new MACAddress(learned.mac);
    } catch (err) {
      if (err instanceof WaitForEventTimeoutError) {
        const prev = this.arpTable.get(targetIpStr);
        if (!prev || prev.type !== 'static') {
          this.arpTable.set(targetIpStr, {
            mac: MACAddress.broadcast(),
            iface: portName,
            timestamp: Date.now(),
            type: 'failed',
          });
        }
        throw new Error('ARP timeout');
      }
      throw err;
    }
  }

  // ─── Send Ping (ICMP Echo Request via IPv4) ───────────────────

  /**
   * Send a single ICMP echo request encapsulated in IPv4 and wait for reply.
   * Returns PingResult with real measured RTT.
   */
  protected async sendPing(
    portName: string,
    targetIP: IPAddress,
    targetMAC: MACAddress,
    seq: number = 1,
    timeoutMs: number = 2000,
    ttl?: number,
    opts?: { dataSize?: number; df?: boolean },
  ): Promise<PingResult> {
    const port = this.ports.get(portName);
    if (!port) throw new Error('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) throw new Error('No IP configured');

    // No carrier means the kernel fails the send outright with EHOSTUNREACH
    // rather than waiting for a reply that can never come — real ping then
    // prints "From <src> icmp_seq=N Destination Host Unreachable" for every
    // probe, which is the visible failure a plain timeout never produces
    // (docs/PRD-Link-State.md §2.1 P3).
    if (!this.isInterfaceOperationallyUp(portName, port)) {
      throw new Error(`Destination unreachable from ${myIP}`);
    }

    this.pingIdCounter++;
    const id = this.pingIdCounter;

    const targetIpStr = targetIP.toString();
    const sentAt = performance.now();
    const useTtl = ttl ?? this.defaultTTL;

    // Phase 5.6: settle through the bus instead of a pendingPings Map.
    const toBroadcast = linkDestinationFor(targetIP, this.connectedIpv4Prefixes()) !== null;
    const replyPromise = waitForEvent(
      this.getBus(),
      'host.icmp.echo-reply',
      (p) => p.deviceId === this.id && p.id === id && p.seq === seq
        && (toBroadcast || p.fromIp === targetIpStr),
      { timeoutMs, scheduler: this.getScheduler() },
    );
    const failedPromise = waitForEvent(
      this.getBus(),
      'host.icmp.echo-failed',
      (p) => p.deviceId === this.id
        && (p.id === -1 || (p.id === id && p.seq === seq))
        && (p.toIp === targetIpStr || p.toIp === ''),
      { timeoutMs, scheduler: this.getScheduler() },
    );
    // The ping can abort before both waiters settle (firewall verdict below,
    // race loser timing out later); observe rejections so abandoned waiters
    // never surface as unhandled errors.
    replyPromise.catch(() => {});
    failedPromise.catch(() => {});

    const dataSize = opts?.dataSize ?? 56;
    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-request', code: 0,
      id, sequence: seq, dataSize,
    };
    const icmpSize = 8 + dataSize;
    const ipPkt = createIPv4Packet(
      myIP, targetIP, IP_PROTO_ICMP, useTtl, icmp, icmpSize,
      opts?.df === undefined ? {} : { flags: opts.df ? 0b010 : 0b000 },
    );

    this.emitIcmpEchoSent({
      fromIp: myIP.toString(), toIp: targetIpStr,
      id, seq, ttl: useTtl, size: icmpSize,
    });

    const verdict = this.firewallFilter(portName, ipPkt, 'out');
    if (verdict === 'drop' || verdict === 'reject') {
      throw new Error('blocked by firewall');
    }

    this.sendFrame(portName, {
      srcMAC: port.getMAC(), dstMAC: targetMAC,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });

    const replyOutcome = replyPromise.then((r) => ({ kind: 'reply' as const, r }));
    const failedOutcome = failedPromise.then((r) => ({ kind: 'failed' as const, r }));
    // The race loser keeps waiting until its own timeout fires; observe its
    // rejection so it never surfaces as an unhandled error.
    replyOutcome.catch(() => {});
    failedOutcome.catch(() => {});

    try {
      const winner = await Promise.race([replyOutcome, failedOutcome]);
      if (winner.kind === 'failed') throw new Error(winner.r.reason);
      // `tc qdisc ... netem delay` (Cable.artificialDelayMs) is metadata
      // added to the reported RTT, not a real injected delay on the
      // (synchronous, hot) frame-delivery path — same treatment as
      // getPropagationDelay()'s own physical-distance figure.
      const artificialDelayMs = port.getCable()?.getArtificialDelayMs() ?? 0;
      const rtt = performance.now() - sentAt + artificialDelayMs;
      return {
        success: true,
        rttMs: rtt,
        ttl: winner.r.ttl,
        seq,
        bytes: icmpSize,
        fromIP: targetIpStr,
      };
    } catch (err) {
      if (err instanceof WaitForEventTimeoutError) {
        this.emitIcmpEchoTimeout({ toIp: targetIpStr, id, seq });
        throw new Error('timeout');
      }
      throw err;
    }
  }

  // ─── Route Resolution (LPM — Longest Prefix Match) ──────────────

  /**
   * Build the full routing table including dynamic connected routes
   * from ports that were configured directly (backward compatibility).
   */
  private buildFullRoutingTable(): HostRouteEntry[] {
    // Connected routes are stored when the address is configured, so the
    // stored copy predates any later link change: the two link-derived
    // effects are applied here, on the way out, rather than left to a
    // snapshot taken before the cable moved. Loopback and virtual
    // interfaces are exempt — they have no wire to lose.
    const table: HostRouteEntry[] = [];
    for (const route of this.routingTable) {
      const port = this.ports.get(route.iface);
      if (!port || isVirtualHostInterface(route.iface)) { table.push(route); continue; }
      if (route.type === 'connected' && (!port.getIsUp() || port.isAdminDown())) continue;
      table.push(port.hasCarrier() ? route : { ...route, linkdown: true });
    }

    // Auto-detect connected routes from ports not already in the table.
    // An interface taken administratively down loses its connected route
    // outright, the way `ip link set dev eth0 down` flushes it; losing
    // carrier only flags the route (see HostRouteEntry.linkdown).
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      if (!port.getIsUp() || port.isAdminDown()) continue;
      // Une interface de bouclage ne produit AUCUNE route dans la table
      // principale : sur un vrai Linux, `ip route` ne montre pas
      // 127.0.0.0/8 — cette route vit dans la table `local`, que
      // `ip route show table local` affiche seule. La joignabilité des
      // adresses portées par la boucle ne passe pas par une route mais
      // par `getPortOwningIP()`, qui court-circuite avant toute
      // résolution, exactement comme le noyau.
      if (port.isLoopback()) continue;

      const portName = port.getName();
      const alreadyExists = table.some(
        r => r.type === 'connected' && r.iface === portName
      );
      if (!alreadyExists) {
        const networkOctets = ip.getOctets().map((o, i) => o & mask.getOctets()[i]);
        table.push({
          network: new IPAddress(networkOctets),
          mask,
          nextHop: null,
          iface: portName,
          type: 'connected',
          metric: 0,
          linkdown: !port.hasCarrier(),
        });
      }

      // Seule l'adresse PRIMAIRE d'un port donnait une route, alors que
      // le noyau en pose une par adresse : `ip addr add 10.0.0.1/32 dev
      // lo` était accepté, l'adresse s'affichait, et un ping vers elle
      // répondait « Network is unreachable » — l'adresse existait sans
      // être joignable. Ce n'est pas propre à la boucle : toute adresse
      // secondaire, sur n'importe quelle interface, était dans ce cas.
      for (const sec of port.getSecondaryIPs()) {
        const secNet = new IPAddress(
          sec.ip.getOctets().map((o, i) => o & sec.mask.getOctets()[i]));
        const deja = table.some((r) => r.type === 'connected'
          && r.iface === portName
          && r.network.equals(secNet)
          && r.mask.toCIDR() === sec.mask.toCIDR());
        if (deja) continue;
        table.push({
          network: secNet,
          mask: sec.mask,
          nextHop: null,
          iface: portName,
          type: 'connected',
          metric: 0,
          linkdown: !port.hasCarrier(),
        });
      }
    }

    // Auto-detect default gateway not already in the table
    if (this.defaultGateway && !table.some(r => r.type === 'default')) {
      let gwIface = '';
      for (const [, port] of this.ports) {
        const ip = port.getIPAddress();
        const pmask = port.getSubnetMask();
        if (ip && pmask && ip.isInSameSubnet(this.defaultGateway, pmask)) {
          gwIface = port.getName();
          break;
        }
      }
      const gwPort = gwIface ? this.ports.get(gwIface) : undefined;
      table.push({
        network: new IPAddress('0.0.0.0'),
        mask: new SubnetMask('0.0.0.0'),
        nextHop: this.defaultGateway,
        iface: gwIface,
        type: 'default',
        metric: 0,
        linkdown: gwPort ? !gwPort.hasCarrier() : undefined,
      });
    }

    return table;
  }

  /**
   * Find the outgoing interface and next-hop for a given destination IP
   * using Longest Prefix Match (LPM).
   *
   * Algorithm:
   *   1. Compare destination against every route entry using (dest & mask) == (network & mask)
   *   2. Select the route with the longest prefix (most specific mask)
   *   3. If prefix lengths are equal, select the one with the lowest metric
   *
   * Returns: { port, nextHopIP } or null if unreachable.
   */
  protected resolveRoute(targetIP: IPAddress): { port: Port; iface: string; nextHopIP: IPAddress } | null {
    const table = this.buildFullRoutingTable();
    const destInt = targetIP.toUint32();

    let bestRoute: HostRouteEntry | null = null;
    let bestPrefix = -1;

    for (const route of table) {
      const netInt = route.network.toUint32();
      const maskInt = route.mask.toUint32();
      const prefix = route.mask.toCIDR();

      if ((destInt & maskInt) === (netInt & maskInt)) {
        if (prefix > bestPrefix ||
            (prefix === bestPrefix && bestRoute && route.metric < bestRoute.metric)) {
          bestPrefix = prefix;
          bestRoute = route;
        }
      }
    }

    if (!bestRoute) return null;

    const port = this.ports.get(bestRoute.iface);
    if (!port) return null;

    // For connected routes (nextHop is null), the next-hop is the destination itself
    const nextHopIP = bestRoute.nextHop || targetIP;

    return { port, iface: bestRoute.iface, nextHopIP };
  }

  /**
   * True when `portName` can actually carry traffic. Delegates to
   * `Port.isOperationallyUp()` by default; overridden by `LinuxMachine`
   * so a VLAN sub-interface (which is a real Linux construct but has no
   * `Cable` of its own — see `addVlanSubInterface`) correctly reflects
   * its parent interface's carrier instead of always reporting down.
   */
  protected isInterfaceOperationallyUp(portName: string, port: Port): boolean {
    const sub = this.vlanSubInterfaces.get(portName);
    if (!sub) return port.isOperationallyUp();
    const parent = this.ports.get(sub.parent);
    return port.getIsUp() && !port.isAdminDown() && !!parent?.isOperationallyUp();
  }

  protected linkLocalAutoconfigurationEnabled(): boolean {
    return false;
  }

  // ─── High-level Ping (used by terminal commands) ──────────────

  /**
   * Execute a full ping sequence: route lookup → ARP → ICMP echo × count.
   * Returns an array of PingResult (one per ping attempt).
   */
  /** Fabricate successful echo results for traffic that never leaves the host. */
  private localEchoResults(targetIP: IPAddress, count: number): PingResult[] {
    const results: PingResult[] = [];
    const ip = targetIP.toString();
    for (let seq = 1; seq <= count; seq++) {
      this.pingIdCounter++;
      const id = this.pingIdCounter;
      this.emitIcmpEchoSent({ fromIp: ip, toIp: ip, id, seq, ttl: this.defaultTTL, size: 64 });
      this.emitIcmpEchoReply({ fromIp: ip, toIp: ip, id, seq, ttl: this.defaultTTL, rttMs: 0.01 });
      results.push({
        success: true,
        rttMs: 0.01,
        ttl: this.defaultTTL,
        seq,
        bytes: 64,
        fromIP: ip,
      });
    }
    return results;
  }

  private unreachableResults(localIP: IPAddress | null, count: number): PingResult[] {
    const from = localIP ? localIP.toString() : '';
    const results: PingResult[] = [];
    for (let seq = 1; seq <= count; seq++) {
      results.push({
        success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: from,
        error: `Destination unreachable from ${from} code 1`,
      });
    }
    return results;
  }

  protected async executePingSequence(
    targetIP: IPAddress,
    count: number = 4,
    timeoutMs: number = 2000,
    ttl?: number,
    opts?: { dataSize?: number; df?: boolean },
  ): Promise<PingResult[]> {
    // Local delivery without touching the wire: loopback (127/8) and any
    // address owned by one of our interfaces (self-ping), like a real kernel.
    if (targetIP.isLoopback() || this.getPortOwningIP(targetIP)) {
      return this.localEchoResults(targetIP, count);
    }

    // Route resolution
    const route = this.resolveRoute(targetIP);
    if (!route) {
      return []; // Empty = unreachable, caller formats the error
    }

    const portName = route.port.getName();

    // ARP resolution (for next-hop, not necessarily the final destination)
    let nextHopMAC: MACAddress;
    const surLien = linkDestinationFor(route.nextHopIP, this.connectedIpv4Prefixes());
    if (surLien) {
      nextHopMAC = surLien;
    } else {
      try {
        nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
      } catch {
        return this.unreachableResults(route.port.getIPAddress(), count);
      }
    }

    // Send pings
    const results: PingResult[] = [];
    for (let seq = 1; seq <= count; seq++) {
      try {
        const result = await this.sendPing(portName, targetIP, nextHopMAC, seq, timeoutMs, ttl, opts);
        results.push(result);
      } catch (err: any) {
        const errorMsg = typeof err === 'string'
          ? err
          : (err instanceof Error ? err.message : String(err));
        results.push({
          success: false,
          rttMs: 0,
          ttl: 0,
          seq,
          bytes: 0,
          fromIP: '',
          error: errorMsg,
        });
      }
    }
    return results;
  }

  async pingStreamInSession(
    targetStr: string,
    opts: {
      count: number;
      timeoutMs?: number;
      ttl?: number;
      intervalMs?: number;
      onResolved?: (ip: IPAddress, hostname?: string) => void;
      onResult: (result: PingResult) => void;
      shouldStop: () => boolean;
      sleep: (ms: number) => Promise<void>;
    },
  ): Promise<{ resolved: boolean; reason?: 'name' | 'unreachable' }> {
    const ip = await this.resolveHostForCommand(targetStr);
    if (!ip) return { resolved: false, reason: 'name' };
    opts.onResolved?.(ip, targetStr !== ip.toString() ? targetStr : undefined);
    const outcome = await this.executePingStream(ip, opts);
    return outcome.resolved ? { resolved: true } : { resolved: false, reason: 'unreachable' };
  }

  getEgressIPFor(targetIP: IPAddress): IPAddress | null {
    return this.getEgressFor(targetIP)?.sourceIp ?? null;
  }

  /** True if `targetIP` is locally delivered (loopback/self) or a route exists to reach it. */
  hasRouteOrLocal(targetIP: IPAddress): boolean {
    if (targetIP.isLoopback() || this.getPortOwningIP(targetIP)) return true;
    return this.resolveRoute(targetIP) !== null;
  }

  getEgressFor(targetIP: IPAddress): { sourceIp: IPAddress; interfaceName: string; nextHopIP: IPAddress } | null {
    const route = this.resolveRoute(targetIP);
    if (!route) return null;
    const sourceIp = route.port.getIPAddress();
    if (!sourceIp) return null;
    return { sourceIp, interfaceName: route.port.getName(), nextHopIP: route.nextHopIP };
  }

  sendPingProbeSync(targetIP: IPAddress, opts?: { ttl?: number }): { success: boolean; rttMs: number; ttl: number } {
    if (targetIP.isLoopback() || this.getPortOwningIP(targetIP)) {
      return { success: true, rttMs: 0.02, ttl: this.defaultTTL };
    }
    const route = this.resolveRoute(targetIP);
    if (!route) return { success: false, rttMs: 0, ttl: 0 };
    const port = route.port;
    const portName = port.getName();
    const myIP = port.getIPAddress();
    if (!myIP) return { success: false, rttMs: 0, ttl: 0 };

    const nextHopIpStr = route.nextHopIP.toString();
    const surLien = linkDestinationFor(route.nextHopIP, this.connectedIpv4Prefixes());
    if (!surLien) this.resolveArpSync(targetIP);
    const destinationMac = surLien ?? this.arpTable.get(nextHopIpStr)?.mac;
    if (!destinationMac) return { success: false, rttMs: 0, ttl: 0 };

    this.pingIdCounter++;
    const id = this.pingIdCounter;
    const targetIpStr = targetIP.toString();
    const seq = 1;
    const useTtl = opts?.ttl ?? this.defaultTTL;

    let reply: { rttMs: number; ttl: number } | null = null;
    let failed = false;
    const unsubReply = this.getBus().subscribe('host.icmp.echo-reply', (e) => {
      const p = e.payload;
      if (p.deviceId === this.id && p.fromIp === targetIpStr && p.id === id && p.seq === seq) {
        reply = { rttMs: performance.now() - sentAt, ttl: p.ttl };
      }
    });
    const unsubFailed = this.getBus().subscribe('host.icmp.echo-failed', (e) => {
      const p = e.payload;
      if (p.deviceId === this.id && (p.id === -1 || (p.id === id && p.seq === seq))
          && (p.toIp === targetIpStr || p.toIp === '')) {
        failed = true;
      }
    });

    const icmp: ICMPPacket = { type: 'icmp', icmpType: 'echo-request', code: 0, id, sequence: seq, dataSize: 56 };
    const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, useTtl, icmp, 64);
    const sentAt = performance.now();

    this.emitIcmpEchoSent({
      fromIp: myIP.toString(), toIp: targetIpStr,
      id, seq, ttl: useTtl, size: 64,
    });

    const verdict = this.firewallFilter(portName, ipPkt, 'out');
    if (verdict === 'drop' || verdict === 'reject') {
      unsubReply(); unsubFailed();
      return { success: false, rttMs: 0, ttl: 0 };
    }

    this.sendFrame(portName, {
      srcMAC: port.getMAC(), dstMAC: destinationMac,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });

    unsubReply(); unsubFailed();
    if (reply) return { success: true, rttMs: (reply as { rttMs: number }).rttMs, ttl: (reply as { ttl: number }).ttl };
    if (failed) return { success: false, rttMs: 0, ttl: 0 };
    return { success: false, rttMs: 0, ttl: 0 };
  }

  private resolveArpSync(targetIP: IPAddress): void {
    const route = this.resolveRoute(targetIP);
    if (!route) return;
    const nextHopIpStr = route.nextHopIP.toString();
    if (this.arpTable.get(nextHopIpStr)) return;
    const myIP = route.port.getIPAddress();
    if (!myIP) return;
    const arpReq: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: route.port.getMAC(), senderIP: myIP,
      targetMAC: MACAddress.broadcast(), targetIP: route.nextHopIP,
    };
    this.emitArpRequestSent(route.port.getName(), nextHopIpStr);
    this.sendFrame(route.port.getName(), {
      srcMAC: route.port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: arpReq,
    });
  }

  /**
   * IPv6/NDP equivalent of `resolveArpSync()` — needed for the same reason:
   * `tcpConnectOutcome6()`/`tcpProbeSyncIPv6()` check `socket.state`
   * synchronously right after `connect()` returns, with no `await` anywhere
   * in between. `resolveNDP()` is `async` (its `.then()` continuation can
   * only run on a later microtask), so on a cold neighbor cache the SYN
   * itself wouldn't even be on the wire yet at the point those callers
   * inspect the socket — this sends the NS (and, since frame delivery in
   * this simulator is synchronous end-to-end, absorbs the NA reply) before
   * that check ever happens, exactly like the ARP warm-up already does.
   */
  private resolveNdpSync(targetIP: IPv6Address): void {
    const route = this.resolveIPv6Route(targetIP);
    if (!route) return;
    const nextHopIpStr = route.nextHopIP.toString();
    if (this.neighborCache.get(nextHopIpStr)) return;
    const port = route.port;
    const srcIP = route.nextHopIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());
    if (!srcIP) return;
    const ns = createNeighborSolicitation(route.nextHopIP, port.getMAC());
    const nsPkt = createIPv6Packet(
      srcIP, route.nextHopIP.toSolicitedNodeMulticast(), IP_PROTO_ICMPV6, 255, ns, 24,
    );
    this.sendFrame(port.getName(), {
      srcMAC: port.getMAC(), dstMAC: route.nextHopIP.toSolicitedNodeMulticast().toMulticastMAC(),
      etherType: ETHERTYPE_IPV6, payload: nsPkt,
    });
  }

  tcpProbeSync(targetIP: IPAddress, port: number): boolean {
    const socket = this.tcpv2.connect(targetIP.toString(), port);
    if (!socket) return false;
    const established = socket.everEstablished;
    socket.close();
    return established;
  }

  /**
   * Connect probe whose verdict is read from the wire: 'open',
   * 'refused' (RST or ICMP unreachable), 'timeout' (silent drop) or
   * 'unreachable' (no route resolves, so nothing was ever sent). Lets
   * clients (nc, telnet, ssh) distinguish a filtered port from a closed
   * one without inspecting the peer's firewall state.
   */
  tcpConnectOutcome(targetIP: IPAddress, port: number): TcpWireOutcome {
    this.resolveArpSync(targetIP);
    return this.tcpv2.connectOutcome(targetIP.toString(), port);
  }

  tcpConnectOutcome6(targetIP: IPv6Address, port: number): TcpWireOutcome {
    this.resolveNdpSync(targetIP);
    return this.tcpv2.connectOutcome(targetIP.toString(), port);
  }

  tcpProbeSyncIPv6(targetAddr: string, port: number): boolean {
    const bareTarget = targetAddr.split('%')[0];
    this.resolveNdpSync(new IPv6Address(bareTarget));
    return this.tcpv2.connectOutcome(bareTarget, port) === 'open';
  }

  async tracerouteStreamInSession(
    targetStr: string,
    opts: {
      maxHops?: number;
      probesPerHop?: number;
      firstTtl?: number;
      timeoutMs?: number;
      onResolved?: (ip: IPAddress, hostname?: string) => void;
      onHop: (hop: TracerouteHopResult) => void;
      shouldStop: () => boolean;
    },
  ): Promise<{ resolved: boolean }> {
    const ip = await this.resolveHostForCommand(targetStr);
    if (!ip) return { resolved: false };
    opts.onResolved?.(ip, targetStr !== ip.toString() ? targetStr : undefined);

    // Loopback / one of the host's own addresses never goes through
    // `resolveRoute()` — there's no next hop to ARP for, exactly like
    // `executePingStream()` already special-cases this below. Without this,
    // `executeTraceroute()` finds no route and returns zero hops, which the
    // terminal layer reports as a bogus "Unable to resolve target system
    // name" instead of the single, instant self-hop real tracert/traceroute
    // print for 127.0.0.1/localhost.
    if (ip.isLoopback() || this.getPortOwningIP(ip)) {
      opts.onHop({
        hop: opts.firstTtl ?? 1,
        ip: ip.toString(),
        timeout: false,
        probes: [
          { responded: true, rttMs: 0.02, ip: ip.toString() },
          { responded: true, rttMs: 0.02, ip: ip.toString() },
          { responded: true, rttMs: 0.02, ip: ip.toString() },
        ],
      });
      return { resolved: true };
    }

    await this.executeTraceroute(
      ip, opts.maxHops, opts.timeoutMs ?? 2000, opts.probesPerHop, opts.firstTtl,
      { onHop: opts.onHop, shouldStop: opts.shouldStop },
    );
    return { resolved: true };
  }

  protected async executePingStream(
    targetIP: IPAddress,
    opts: {
      count: number;
      timeoutMs?: number;
      ttl?: number;
      intervalMs?: number;
      onResult: (result: PingResult) => void;
      shouldStop: () => boolean;
      sleep: (ms: number) => Promise<void>;
    },
  ): Promise<{ resolved: boolean }> {
    const { count, timeoutMs = 2000, ttl, intervalMs = 1000, onResult, shouldStop, sleep } = opts;
    const infinite = count <= 0;
    const isLast = (seq: number) => !infinite && seq >= count;

    if (targetIP.isLoopback() || this.getPortOwningIP(targetIP)) {
      for (let seq = 1; (infinite || seq <= count) && !shouldStop(); seq++) {
        onResult({ success: true, rttMs: 0.02, ttl: this.defaultTTL, seq, bytes: 64, fromIP: targetIP.toString() });
        if (isLast(seq)) break;
        await sleep(intervalMs);
      }
      return { resolved: true };
    }

    const route = this.resolveRoute(targetIP);
    if (!route) return { resolved: false };

    const portName = route.port.getName();
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return { resolved: false };
    }

    for (let seq = 1; (infinite || seq <= count) && !shouldStop(); seq++) {
      let result: PingResult;
      try {
        result = await this.sendPing(portName, targetIP, nextHopMAC, seq, timeoutMs, ttl);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result = { success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '', error: errorMsg };
      }
      onResult(result);
      if (isLast(seq) || shouldStop()) break;
      await sleep(intervalMs);
    }
    return { resolved: true };
  }

  // ─── Traceroute (uses TTL-limited packets) ────────────────────

  /**
   * Execute a traceroute: send ICMP echo with incrementing TTL.
   * Each router along the path returns ICMP Time Exceeded.
   * probesPerHop controls how many probes are sent per TTL value (default 3, like real Linux traceroute).
   */
  protected async executeTraceroute(
    targetIP: IPAddress,
    maxHops: number = 30,
    timeoutMs: number = 2000,
    probesPerHop: number = 3,
    firstTtl: number = 1,
    hooks?: { onHop?: (hop: TracerouteHopResult) => void; shouldStop?: () => boolean },
  ): Promise<TracerouteHopResult[]> {
    const route = this.resolveRoute(targetIP);
    if (!route) return [];

    const portName = route.port.getName();
    const myIP = route.port.getIPAddress()!;

    // ARP resolve next hop
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
    } catch {
      const unresolved: TracerouteHopResult = { hop: firstTtl, timeout: true, probes: [{ responded: false }] };
      hooks?.onHop?.(unresolved);
      return [unresolved];
    }

    const hops: TracerouteHopResult[] = [];

    for (let ttl = firstTtl; ttl <= maxHops; ttl++) {
      if (hooks?.shouldStop?.()) break;
      const probes: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean; icmpCode?: number }> = [];
      let destinationReached = false;

      for (let p = 0; p < probesPerHop; p++) {
        this.pingIdCounter++;
        const id = this.pingIdCounter;
        const seq = p + 1;
        const targetIpStr = targetIP.toString();
        const sentAt = performance.now();

        // Phase 5.6: traceroute also settles via the bus.
        const replyP = waitForEvent(
          this.getBus(),
          'host.icmp.echo-reply',
          (pl) => pl.deviceId === this.id && pl.fromIp === targetIpStr && pl.id === id && pl.seq === seq,
          { timeoutMs, scheduler: this.getScheduler() },
        );
        const failP = waitForEvent(
          this.getBus(),
          'host.icmp.echo-failed',
          (pl) => pl.deviceId === this.id && pl.id === id && pl.seq === seq,
          { timeoutMs, scheduler: this.getScheduler() },
        );

        const icmp: ICMPPacket = {
          type: 'icmp', icmpType: 'echo-request', code: 0,
          id, sequence: seq, dataSize: 56,
        };
        const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, ttl, icmp, 64);

        this.sendFrame(portName, {
          srcMAC: route.port.getMAC(),
          dstMAC: nextHopMAC,
          etherType: ETHERTYPE_IPV4,
          payload: ipPkt,
        });

        const replyOutcome = replyP.then((pl) => ({
          ip: pl.fromIp,
          rttMs: performance.now() - sentAt,
          timeout: false, reached: true,
          unreachable: undefined as boolean | undefined,
          icmpCode: undefined as number | undefined,
        }));
        const failOutcome = failP.then((pl) => {
          const codeMatch = pl.reason.match(/code (\d+)/);
          const isUnreachable = pl.reason.includes('Destination unreachable');
          return {
            ip: pl.fromIp,
            rttMs: performance.now() - sentAt,
            timeout: false, reached: false,
            unreachable: isUnreachable,
            icmpCode: codeMatch ? parseInt(codeMatch[1], 10) : undefined,
          };
        });
        // Observe the race loser's eventual timeout rejection.
        replyOutcome.catch(() => {});
        failOutcome.catch(() => {});

        const probe = await Promise.race([replyOutcome, failOutcome]).catch((err) => {
          if (err instanceof WaitForEventTimeoutError) {
            return { timeout: true, reached: false } as {
              ip?: string; rttMs?: number; timeout: boolean; reached: boolean;
              unreachable?: boolean; icmpCode?: number;
            };
          }
          throw err;
        });

        probes.push({
          responded: !probe.timeout,
          rttMs: probe.rttMs,
          ip: probe.ip,
          unreachable: probe.unreachable,
          icmpCode: probe.icmpCode,
        });
        if (probe.reached) destinationReached = true;
      }

      // Aggregate probe results into hop summary
      const firstResponded = probes.find(p => p.responded);
      const firstUnreachable = probes.find(p => p.unreachable);
      const allTimeout = probes.every(p => !p.responded);

      const hop: TracerouteHopResult = {
        hop: ttl,
        ip: firstResponded?.ip,
        rttMs: firstResponded?.rttMs,
        timeout: allTimeout,
        unreachable: !!firstUnreachable,
        icmpCode: firstUnreachable?.icmpCode ?? firstResponded?.icmpCode,
        probes,
      };

      hops.push(hop);
      hooks?.onHop?.(hop);

      if (destinationReached) break;
      if (firstUnreachable) break;
    }

    return hops;
  }

  // ═══════════════════════════════════════════════════════════════════
  // IPv6 Stack (RFC 8200, RFC 4861, RFC 4443)
  // ═══════════════════════════════════════════════════════════════════

  // ─── IPv6 Configuration ─────────────────────────────────────────

  /**
   * Enable IPv6 on an interface. Generates link-local address via EUI-64.
   */
  enableIPv6(ifName: string): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;
    port.enableIPv6();
    this.ensureLinkLocalRoute(ifName);
    return true;
  }

  /**
   * The interface's `fe80::/10` connected route.
   *
   * It was installed only by `enableIPv6()`, never by
   * `configureIPv6Interface()` — the path `ip -6 addr add` takes — so a
   * normally configured host could reach NO link-local address at all.
   * It was also pushed without a check, leaving duplicates.
   */
  private ensureLinkLocalRoute(ifName: string): void {
    const port = this.ports.get(ifName);
    if (!port?.getLinkLocalIPv6()) return;
    const prefix = new IPv6Address('fe80::');
    const deja = this.ipv6RoutingTable.some(
      (r) => r.type === 'connected' && r.iface === ifName
        && r.prefixLength === 10 && r.prefix.equals(prefix),
    );
    if (deja) return;
    this.ipv6RoutingTable.push({
      prefix, prefixLength: 10, nextHop: null,
      iface: ifName, type: 'connected', metric: 0,
    });
  }

  /**
   * Configure a static IPv6 address on an interface.
   */
  configureIPv6Interface(ifName: string, address: IPv6Address, prefixLength: number): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.configureIPv6(address, prefixLength);
    this.ensureLinkLocalRoute(ifName);

    // Add connected route for this prefix
    const networkPrefix = address.getNetworkPrefix(prefixLength);
    const existingRoute = this.ipv6RoutingTable.find(r =>
      r.type === 'connected' && r.iface === ifName && r.prefix.equals(networkPrefix)
    );

    if (!existingRoute) {
      this.ipv6RoutingTable.push({
        prefix: networkPrefix,
        prefixLength,
        nextHop: null,
        iface: ifName,
        type: 'connected',
        metric: 0,
      });
    }

    Logger.info(this.id, 'host:ipv6-config',
      `${this.name}: ${ifName} configured ${address}/${prefixLength}`);
    return true;
  }

  // ─── IPv6 Routing Table ─────────────────────────────────────────

  getIPv6RoutingTable(): HostIPv6RouteEntry[] {
    return [...this.ipv6RoutingTable];
  }

  addIPv6StaticRoute(
    prefix: IPv6Address, prefixLength: number,
    nextHop: IPv6Address | null, iface: string, metric = 0,
  ): void {
    this.ipv6RoutingTable.push({
      prefix: prefix.getNetworkPrefix(prefixLength),
      prefixLength, nextHop, iface, type: 'static', metric,
    });
  }

  removeIPv6StaticRoute(
    prefix: IPv6Address, prefixLength: number, nextHop?: IPv6Address | null,
  ): boolean {
    const wanted = prefix.getNetworkPrefix(prefixLength);
    const before = this.ipv6RoutingTable.length;
    this.ipv6RoutingTable = this.ipv6RoutingTable.filter((route) => {
      if (route.type === 'connected') return true;
      if (route.prefixLength !== prefixLength || !route.prefix.equals(wanted)) return true;
      if (nextHop && !(route.nextHop?.equals(nextHop) ?? false)) return true;
      return false;
    });
    if (prefixLength === 0 && this.ipv6RoutingTable.every(r => r.type !== 'default')) {
      this.defaultGateway6 = null;
    }
    return this.ipv6RoutingTable.length !== before;
  }

  getDefaultGateway6(): IPv6Address | null {
    return this.defaultGateway6;
  }

  setDefaultGateway6(gw: IPv6Address): void {
    this.defaultGateway6 = gw;

    // Remove old default and add new
    this.ipv6RoutingTable = this.ipv6RoutingTable.filter(r => r.type !== 'default');

    // Find the interface the gateway is reachable through
    let gwIface = '';
    for (const [, port] of this.ports) {
      if (!port.isIPv6Enabled()) continue;
      // Check if gateway is link-local (must be on same link) or matches a prefix
      if (gw.isLinkLocal()) {
        // Link-local gateway — assume same interface if we have IPv6 enabled
        gwIface = port.getName();
        break;
      }
      for (const entry of port.getIPv6Addresses()) {
        if (entry.address.isInSameSubnet(gw, entry.prefixLength)) {
          gwIface = port.getName();
          break;
        }
      }
      if (gwIface) break;
    }

    this.ipv6RoutingTable.push({
      prefix: new IPv6Address('::'),
      prefixLength: 0,
      nextHop: gw,
      iface: gwIface,
      type: 'default',
      metric: 0,
    });

    Logger.info(this.id, 'host:ipv6-gateway', `${this.name}: default IPv6 gateway set to ${gw}`);
  }

  // ─── Neighbor Cache (NDP) ──────────────────────────────────────

  getNeighborCache(): Map<string, NeighborCacheEntry> {
    return this.neighborCache.snapshot();
  }

  // ─── IPv6 Packet Handling ──────────────────────────────────────

  private handleIPv6(portName: string, ipv6: IPv6Packet): void {
    if (!ipv6 || ipv6.type !== 'ipv6') return;

    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return;

    // ── PREROUTING: evaluate ip6tables DNAT rules before the local-
    // destination check, symmetrically to handleIPv4's evaluatePreRouting.
    const preNat6 = this.evaluatePreRouting6(portName, ipv6);
    if (preNat6 && preNat6.action === 'DNAT' && preNat6.address) {
      try {
        const newDst = new IPv6Address(preNat6.address.split(']:')[0].replace(/^\[/, ''));
        ipv6 = { ...ipv6, destinationIP: newDst };
      } catch { /* keep original */ }
    }

    // Check if packet is for us
    const isForUs = port.hasIPv6Address(ipv6.destinationIP);
    const isMulticast = ipv6.destinationIP.isMulticast();
    const isLoopback = ipv6.destinationIP.isLoopback();

    if (isForUs || isMulticast || isLoopback) {
      if (ipv6.nextHeader === IP_PROTO_ICMPV6) {
        // Neighbor Discovery (RFC 4861) must never be filtered — blocking it
        // would break address resolution itself, taking the whole interface
        // down rather than just the traffic an administrator meant to
        // block. Everything else (ping, destination-unreachable relayed
        // from elsewhere, etc.) goes through ip6tables INPUT like TCP/UDP.
        const icmpv6 = ipv6.payload as ICMPv6Packet | undefined;
        const isNeighborDiscovery = !!icmpv6 && (
          icmpv6.icmpType === 'neighbor-solicitation' || icmpv6.icmpType === 'neighbor-advertisement'
          || icmpv6.icmpType === 'router-solicitation' || icmpv6.icmpType === 'router-advertisement'
        );
        if (!isNeighborDiscovery) {
          const icmpVerdict = this.firewallFilter6(portName, ipv6, 'in');
          if (icmpVerdict === 'drop') return;
          if (icmpVerdict === 'reject') {
            this.sendICMPv6Unreachable(portName, ipv6, ICMPV6_UNREACH_ADMIN_PROHIBITED);
            return;
          }
        }
        this.handleICMPv6(portName, ipv6);
        return;
      }
      if (ipv6.nextHeader !== IP_PROTO_UDP && ipv6.nextHeader !== IP_PROTO_TCP) return;

      const verdict = this.firewallFilter6(portName, ipv6, 'in');
      if (verdict === 'drop') return;
      if (verdict === 'reject') {
        if (ipv6.nextHeader === IP_PROTO_TCP) {
          this.tcpv2.sendResetForSegment(
            ipv6.destinationIP.toString(), ipv6.sourceIP.toString(), ipv6.payload as TcpSegment,
          );
        } else {
          this.sendICMPv6Unreachable(portName, ipv6);
        }
        return;
      }

      if (ipv6.nextHeader === IP_PROTO_UDP) {
        this.deliverUDP6(portName, ipv6);
      } else {
        this.tcpv2.handleIp6(portName, ipv6.sourceIP, ipv6);
      }
    }
  }

  // ─── ICMPv6 Handling (RFC 4443, RFC 4861) ──────────────────────

  private handleICMPv6(portName: string, ipv6: IPv6Packet): void {
    const icmpv6 = ipv6.payload as ICMPv6Packet;
    if (!icmpv6 || icmpv6.type !== 'icmpv6') return;

    switch (icmpv6.icmpType) {
      case 'echo-request':
        this.handleICMPv6EchoRequest(portName, ipv6, icmpv6);
        break;
      case 'echo-reply':
        this.handleICMPv6EchoReply(ipv6, icmpv6);
        break;
      case 'neighbor-solicitation':
        this.handleNeighborSolicitation(portName, ipv6, icmpv6);
        break;
      case 'neighbor-advertisement':
        this.handleNeighborAdvertisement(portName, ipv6, icmpv6);
        break;
      case 'router-advertisement':
        this.handleRouterAdvertisement(portName, ipv6, icmpv6);
        break;
      case 'time-exceeded':
      case 'destination-unreachable':
        this.handleICMPv6Error(ipv6, icmpv6);
        break;
    }
  }

  private handleICMPv6EchoRequest(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // RFC 4443 §4.2: the source of an Echo Reply to a unicast request MUST
    // be the destination the request was addressed to.
    let srcIP: IPv6Address | null =
      port.hasIPv6Address(ipv6.destinationIP) ? ipv6.destinationIP : null;
    if (!srcIP) {
      srcIP = ipv6.destinationIP.isLinkLocal()
        ? port.getLinkLocalIPv6()
        : (port.getGlobalIPv6() || port.getLinkLocalIPv6());
    }
    if (!srcIP) return;

    // Build echo reply
    const reply = createICMPv6EchoReply(icmpv6.id || 0, icmpv6.sequence || 0, icmpv6.dataSize || 56);
    const replyPkt = createIPv6Packet(
      srcIP,
      ipv6.sourceIP,
      IP_PROTO_ICMPV6,
      this.defaultHopLimit,
      reply,
      8 + (icmpv6.dataSize || 56), // ICMPv6 header + data
    );

    // Route the reply
    const route = this.resolveIPv6Route(ipv6.sourceIP);
    if (!route) return;

    const send = (mac: MACAddress): void => {
      this.sendFrame(route.port.getName(), {
        srcMAC: route.port.getMAC(),
        dstMAC: mac,
        etherType: ETHERTYPE_IPV6,
        payload: replyPkt,
      });
    };

    const cached = this.neighborCache.markUsed(route.nextHopIP.toString());
    if (cached) {
      send(cached.mac);
    } else {
      // No neighbor entry — resolve it instead of silently dropping the
      // reply (RFC 4861 §7.2.2: queue the packet pending resolution).
      this.resolveNDP(route.port.getName(), route.nextHopIP)
        .then(send)
        .catch(() => { /* resolution failed: drop, as a real stack would */ });
    }
  }

  private handleICMPv6EchoReply(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    this.neighborCache.confirmReachability(ipv6.sourceIP.toString());
    // Phase 5.7: settle the awaiting `sendPing6` via the bus. The awaiter
    // computes its own rtt; rttMs=0 is a sentinel here so capture actors
    // can still record the reply.
    this.emitIcmpEchoReply({
      fromIp: ipv6.sourceIP.toString(),
      toIp: ipv6.destinationIP.toString(),
      id: icmpv6.id ?? 0,
      seq: icmpv6.sequence ?? 0,
      ttl: ipv6.hopLimit,
      rttMs: 0,
    });
  }

  private handleICMPv6Error(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const reason = icmpv6.icmpType === 'time-exceeded'
      ? `Hop limit exceeded (from ${ipv6.sourceIP})`
      : `Destination unreachable (from ${ipv6.sourceIP})`;

    // Phase 5.7: wildcard emission so any awaiting `sendPing6` settles.
    this.emitIcmpEchoFailed({
      fromIp: ipv6.sourceIP.toString(),
      toIp: '',
      id: -1,
      seq: -1,
      reason,
    });
  }

  // ─── NDP: Neighbor Solicitation (RFC 4861 §7.2.3) ───────────────

  private handleNeighborSolicitation(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const ns = icmpv6.ndp as NDPNeighborSolicitation;
    if (!ns || ns.ndpType !== 'neighbor-solicitation') return;

    const port = this.ports.get(portName);
    if (!port) return;

    // Check if the target address is ours
    if (!port.hasIPv6Address(ns.targetAddress)) return;

    // Learn the source's link-layer address if provided
    const srcLLOpt = ns.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer' && !ipv6.sourceIP.isUnspecified()) {
      this.neighborCache.learnFromSource(
        ipv6.sourceIP.toString(), srcLLOpt.address, portName, false);
    }

    // Send Neighbor Advertisement
    const na = createNeighborAdvertisement(ns.targetAddress, port.getMAC(), {
      router: false, // EndHosts are not routers
      solicited: true,
      override: true,
    });

    // Determine response destination and source
    let dstIP: IPv6Address;
    let dstMAC: MACAddress;

    if (ipv6.sourceIP.isUnspecified()) {
      // DAD probe — respond to all-nodes multicast
      dstIP = IPV6_ALL_NODES_MULTICAST;
      dstMAC = dstIP.toMulticastMAC();
    } else {
      // Normal NS — respond to source
      dstIP = ipv6.sourceIP;
      const cached = this.neighborCache.get(ipv6.sourceIP.toString());
      dstMAC = cached?.mac || (srcLLOpt as { address: MACAddress })?.address;
      if (!dstMAC) return; // Can't respond without knowing MAC
    }

    const naPkt = createIPv6Packet(
      ns.targetAddress,
      dstIP,
      IP_PROTO_ICMPV6,
      255, // NDP hop limit must be 255
      na,
      24, // NA size: 8 ICMPv6 + 16 target + option
    );

    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: naPkt,
    });

    Logger.debug(this.id, 'ndp:na-sent',
      `${this.name}: NA for ${ns.targetAddress} sent to ${dstIP}`);
  }

  // ─── NDP: Neighbor Advertisement (RFC 4861 §7.2.5) ──────────────

  private handleNeighborAdvertisement(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const na = icmpv6.ndp as NDPNeighborAdvertisement;
    if (!na || na.ndpType !== 'neighbor-advertisement') return;

    // Extract target link-layer address from options
    const tgtLLOpt = na.options.find(o => o.optionType === 'target-link-layer');
    if (!tgtLLOpt || tgtLLOpt.optionType !== 'target-link-layer') return;

    const mac = tgtLLOpt.address;
    const key = na.targetAddress.toString();

    this.neighborCache.learnFromAdvertisement(key, mac, portName, {
      solicited: na.solicitedFlag,
      isRouter: na.routerFlag,
      override: na.overrideFlag,
    });

    Logger.debug(this.id, 'ndp:na-received',
      `${this.name}: learned ${na.targetAddress} -> ${mac}`);

    this.flushNdpQueue(key, mac);
  }

  // ─── NDP: Router Advertisement (RFC 4861 §6.3.4) ────────────────

  private handleRouterAdvertisement(portName: string, ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
    const ra = icmpv6.ndp as NDPRouterAdvertisement;
    if (!ra || ra.ndpType !== 'router-advertisement') return;

    const port = this.ports.get(portName);
    if (!port) return;

    // Learn router's link-layer address
    const srcLLOpt = ra.options.find(o => o.optionType === 'source-link-layer');
    if (srcLLOpt && srcLLOpt.optionType === 'source-link-layer') {
      this.neighborCache.learnFromSource(
        ipv6.sourceIP.toString(), srcLLOpt.address, portName, true);
    }

    // If router lifetime > 0, consider as default router
    if (ra.routerLifetime > 0 && !this.defaultGateway6) {
      // The zone index never travels: it is not part of the 128 bits
      // and means nothing to a peer. A real receiver records the
      // interface it heard the advertisement on.
      this.setDefaultGateway6(
        new IPv6Address(ipv6.sourceIP.getHextets(), portName));
    }

    // Process prefix information for SLAAC
    for (const opt of ra.options) {
      if (opt.optionType === 'prefix-info') {
        const prefixOpt = opt as NDPOptionPrefixInfo;

        // Only process if Autonomous flag is set
        if (prefixOpt.autonomous && prefixOpt.prefixLength === 64) {
          // Generate address via SLAAC
          const slackAddr = port.addSLAACAddress(prefixOpt.prefix, prefixOpt.prefixLength);

          // Add route for this prefix
          const existingRoute = this.ipv6RoutingTable.find(r =>
            r.prefix.equals(prefixOpt.prefix.getNetworkPrefix(prefixOpt.prefixLength)) &&
            r.prefixLength === prefixOpt.prefixLength
          );

          if (!existingRoute && prefixOpt.onLink) {
            this.ipv6RoutingTable.push({
              prefix: prefixOpt.prefix.getNetworkPrefix(prefixOpt.prefixLength),
              prefixLength: prefixOpt.prefixLength,
              nextHop: null,
              iface: portName,
              type: 'ra',
              metric: 0,
            });
          }

          Logger.info(this.id, 'slaac',
            `${this.name}: SLAAC configured ${slackAddr}/${prefixOpt.prefixLength}`);
        }
      }
    }

    // RFC 4861 §4.2 / RFC 8415 §5: the M flag tells the host to fetch an
    // address by DHCPv6. The prefix's A flag stays independent
    // (RFC 4862 §5.5.3), so both addresses may legitimately coexist.
    if (ra.managedFlag) this.requestDhcpv6LeaseIfNeeded(portName);
    // The O flag alone (RFC 4861 §4.2): no address wanted, only the
    // other configuration. Under M the full lease already carries it.
    else if (ra.otherConfigFlag) this.requestDhcpv6InfoIfNeeded(portName);
  }

  // ─── NDP Resolution (IPv6 equivalent of ARP) ────────────────────

  /**
   * Resolve an IPv6 address to a MAC address via NDP.
   * Returns cached result if available, otherwise sends NS and waits.
   */
  /**
   * Une sollicitation de voisin, emise et rien de plus. `resolveNDP` la
   * repete en attendant la reponse ; `sendIpv6FrameNdpAware` l'emet une
   * fois et met son paquet en file, comme le fait le chemin ARP.
   */
  protected sendNeighborSolicitation(portName: string, targetIP: IPv6Address): boolean {
    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return false;
    const srcIP = targetIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());
    if (!srcIP) return false;

    const ns = createNeighborSolicitation(targetIP, port.getMAC());
    const nsPkt = createIPv6Packet(
      srcIP, targetIP.toSolicitedNodeMulticast(), IP_PROTO_ICMPV6, 255, ns, 24);
    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC: targetIP.toSolicitedNodeMulticast().toMulticastMAC(),
      etherType: ETHERTYPE_IPV6, payload: nsPkt,
    });
    return true;
  }

  protected async resolveNDP(portName: string, targetIP: IPv6Address, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.neighborCache.markUsed(targetIP.toString());
    if (cached && cached.state !== 'incomplete') return cached.mac;

    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) throw new Error('IPv6 not enabled');

    // RFC 4861 §7.2.2: the NS source SHOULD be the address the pending
    // traffic uses, so the target's cache maps THAT address to our MAC
    // (a link-local-only NS would leave the peer unable to reply to our
    // global address without a resolution round of its own).
    const srcIP = targetIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());
    if (!srcIP) throw new Error('No IPv6 source address');

    const targetIpStr = targetIP.toString();
    const attempts = Math.min(
      NDP_MAX_MULTICAST_SOLICIT,
      Math.max(1, Math.round(timeoutMs / NDP_RETRANS_TIMER_MS)),
    );
    const perAttemptMs = Math.max(1, Math.floor(timeoutMs / attempts));

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const waitPromise = waitForEvent(
        this.getBus(),
        'host.ndp.entry-learned',
        (p) => p.deviceId === this.id && p.ip === targetIpStr,
        { timeoutMs: perAttemptMs, scheduler: this.getScheduler() },
      );

      this.sendNeighborSolicitation(portName, targetIP);

      Logger.debug(this.id, 'ndp:ns-sent',
        `${this.name}: NS for ${targetIP} sent (attempt ${attempt}/${attempts})`);

      try {
        const learned = await waitPromise;
        return new MACAddress(learned.mac);
      } catch (err) {
        if (!(err instanceof WaitForEventTimeoutError)) throw err;
      }
    }
    throw new Error('NDP timeout');
  }

  private sendUnicastNeighborSolicit(ip: string, entry: NeighborCacheEntry): void {
    const port = this.ports.get(entry.iface);
    if (!port || !port.isIPv6Enabled()) return;
    const targetIP = new IPv6Address(ip);
    const srcIP = targetIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());
    if (!srcIP) return;

    const ns = createNeighborSolicitation(targetIP, port.getMAC());
    const nsPkt = createIPv6Packet(srcIP, targetIP, IP_PROTO_ICMPV6, 255, ns, 24);
    this.sendFrame(entry.iface, {
      srcMAC: port.getMAC(), dstMAC: entry.mac,
      etherType: ETHERTYPE_IPV6, payload: nsPkt,
    });
  }

  // ─── IPv6 Route Resolution (LPM) ────────────────────────────────

  protected resolveIPv6Route(targetIP: IPv6Address): { port: Port; nextHopIP: IPv6Address } | null {
    let bestRoute: HostIPv6RouteEntry | null = null;
    let bestPrefix = -1;

    for (const route of this.ipv6RoutingTable) {
      if (targetIP.isInSameSubnet(route.prefix, route.prefixLength)) {
        if (route.prefixLength > bestPrefix ||
            (route.prefixLength === bestPrefix && bestRoute && route.metric < bestRoute.metric)) {
          bestPrefix = route.prefixLength;
          bestRoute = route;
        }
      }
    }

    if (!bestRoute) return null;

    const port = this.ports.get(bestRoute.iface);
    if (!port) return null;

    // For connected routes (nextHop is null), use destination directly if on-link,
    // or use link-local address for NDP resolution
    const nextHopIP = bestRoute.nextHop || targetIP;

    return { port, nextHopIP };
  }

  // ─── Send IPv6 Ping ────────────────────────────────────────────

  protected async sendPing6(
    portName: string,
    targetIP: IPv6Address,
    targetMAC: MACAddress,
    seq: number = 1,
    timeoutMs: number = 2000,
  ): Promise<PingResult> {
    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) throw new Error('IPv6 not enabled');

    const srcIP = targetIP.isLinkLocal()
      ? port.getLinkLocalIPv6()
      : (port.getGlobalIPv6() || port.getLinkLocalIPv6());

    if (!srcIP) throw new Error('No IPv6 address');

    if (!this.isInterfaceOperationallyUp(portName, port)) {
      throw new Error(`Destination unreachable from ${srcIP}`);
    }

    this.ping6IdCounter++;
    const id = this.ping6IdCounter;

    const targetIpStr = targetIP.toString();
    const sentAt = performance.now();

    const replyPromise = waitForEvent(
      this.getBus(),
      'host.icmp.echo-reply',
      (p) => p.deviceId === this.id && p.fromIp === targetIpStr && p.id === id && p.seq === seq,
      { timeoutMs, scheduler: this.getScheduler() },
    );
    const failedPromise = waitForEvent(
      this.getBus(),
      'host.icmp.echo-failed',
      (p) => p.deviceId === this.id
        && (p.id === -1 || (p.id === id && p.seq === seq))
        && (p.toIp === targetIpStr || p.toIp === ''),
      { timeoutMs, scheduler: this.getScheduler() },
    );

    const icmpv6 = createICMPv6EchoRequest(id, seq, 56);
    const ipPkt = createIPv6Packet(
      srcIP, targetIP, IP_PROTO_ICMPV6, this.defaultHopLimit, icmpv6, 64,
    );

    this.sendFrame(portName, {
      srcMAC: port.getMAC(), dstMAC: targetMAC,
      etherType: ETHERTYPE_IPV6, payload: ipPkt,
    });

    const replyOutcome = replyPromise.then((r) => ({ kind: 'reply' as const, r }));
    const failedOutcome = failedPromise.then((r) => ({ kind: 'failed' as const, r }));
    // The race loser keeps waiting until its own timeout fires; observe its
    // rejection so it never surfaces as an unhandled error.
    replyOutcome.catch(() => {});
    failedOutcome.catch(() => {});

    try {
      const winner = await Promise.race([replyOutcome, failedOutcome]);
      if (winner.kind === 'failed') throw new Error(winner.r.reason);
      // `tc qdisc ... netem delay` (Cable.artificialDelayMs) is metadata
      // added to the reported RTT, not a real injected delay on the
      // (synchronous, hot) frame-delivery path — same treatment as
      // getPropagationDelay()'s own physical-distance figure.
      const artificialDelayMs = port.getCable()?.getArtificialDelayMs() ?? 0;
      const rtt = performance.now() - sentAt + artificialDelayMs;
      return {
        success: true,
        rttMs: rtt,
        ttl: winner.r.ttl,
        seq,
        bytes: 64,
        fromIP: targetIpStr,
      };
    } catch (err) {
      if (err instanceof WaitForEventTimeoutError) throw new Error('timeout');
      throw err;
    }
  }

  // ─── High-level Ping6 (used by terminal commands) ───────────────

  protected async executePing6Sequence(
    targetIP: IPv6Address,
    count: number = 4,
    timeoutMs: number = 2000,
  ): Promise<PingResult[]> {
    // Self-ping (loopback)
    if (targetIP.isLoopback()) {
      const results: PingResult[] = [];
      for (let seq = 1; seq <= count; seq++) {
        results.push({
          success: true,
          rttMs: 0.01,
          ttl: this.defaultHopLimit,
          seq,
          bytes: 64,
          fromIP: '::1',
        });
      }
      return results;
    }

    // Check if target is one of our addresses
    for (const [, port] of this.ports) {
      for (const entry of port.getIPv6Addresses()) {
        if (entry.address.equals(targetIP)) {
          const results: PingResult[] = [];
          for (let seq = 1; seq <= count; seq++) {
            results.push({
              success: true,
              rttMs: 0.01,
              ttl: this.defaultHopLimit,
              seq,
              bytes: 64,
              fromIP: targetIP.toString(),
            });
          }
          return results;
        }
      }
    }

    // Route resolution
    const route = this.resolveIPv6Route(targetIP);
    if (!route) {
      return []; // Unreachable
    }

    const portName = route.port.getName();

    // NDP resolution (for next-hop)
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveNDP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return []; // NDP failed
    }

    // Send pings
    const results: PingResult[] = [];
    for (let seq = 1; seq <= count; seq++) {
      try {
        const result = await this.sendPing6(portName, targetIP, nextHopMAC, seq, timeoutMs);
        results.push(result);
      } catch (err: unknown) {
        const errorMsg = typeof err === 'string'
          ? err
          : (err instanceof Error ? err.message : String(err));
        results.push({
          success: false,
          rttMs: 0,
          ttl: 0,
          seq,
          bytes: 0,
          fromIP: '',
          error: errorMsg,
        });
      }
    }
    return results;
  }

  /**
   * Real-time streaming IPv6 ping — the `ping6`/`ping -6` counterpart of
   * `executePingStream()`, with the same `count<=0` = unbounded convention
   * so the interactive terminal can offer genuine "continuous until
   * Ctrl+C" behavior for IPv6 too, not just IPv4.
   */
  protected async executePing6Stream(
    targetIP: IPv6Address,
    opts: {
      count: number;
      timeoutMs?: number;
      intervalMs?: number;
      onResult: (result: PingResult) => void;
      shouldStop: () => boolean;
      sleep: (ms: number) => Promise<void>;
    },
  ): Promise<{ resolved: boolean }> {
    const { count, timeoutMs = 2000, intervalMs = 1000, onResult, shouldStop, sleep } = opts;
    const infinite = count <= 0;
    const isLast = (seq: number) => !infinite && seq >= count;

    if (targetIP.isLoopback()) {
      for (let seq = 1; (infinite || seq <= count) && !shouldStop(); seq++) {
        onResult({ success: true, rttMs: 0.01, ttl: this.defaultHopLimit, seq, bytes: 64, fromIP: '::1' });
        if (isLast(seq)) break;
        await sleep(intervalMs);
      }
      return { resolved: true };
    }

    for (const [, port] of this.ports) {
      if (port.getIPv6Addresses().some((e) => e.address.equals(targetIP))) {
        for (let seq = 1; (infinite || seq <= count) && !shouldStop(); seq++) {
          onResult({ success: true, rttMs: 0.01, ttl: this.defaultHopLimit, seq, bytes: 64, fromIP: targetIP.toString() });
          if (isLast(seq)) break;
          await sleep(intervalMs);
        }
        return { resolved: true };
      }
    }

    const route = this.resolveIPv6Route(targetIP);
    if (!route) return { resolved: false };

    const portName = route.port.getName();
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveNDP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return { resolved: false };
    }

    for (let seq = 1; (infinite || seq <= count) && !shouldStop(); seq++) {
      let result: PingResult;
      try {
        result = await this.sendPing6(portName, targetIP, nextHopMAC, seq, timeoutMs);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result = { success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '', error: errorMsg };
      }
      onResult(result);
      if (isLast(seq) || shouldStop()) break;
      await sleep(intervalMs);
    }
    return { resolved: true };
  }

  async ping6StreamInSession(
    targetStr: string,
    opts: {
      count: number;
      timeoutMs?: number;
      intervalMs?: number;
      onResolved?: (ip: IPv6Address) => void;
      onResult: (result: PingResult) => void;
      shouldStop: () => boolean;
      sleep: (ms: number) => Promise<void>;
    },
  ): Promise<{ resolved: boolean; reason?: 'name' | 'unreachable' }> {
    const ip = await this.resolveHost6ForCommand(targetStr);
    if (!ip) return { resolved: false, reason: 'name' };
    opts.onResolved?.(ip);
    const outcome = await this.executePing6Stream(ip, opts);
    return outcome.resolved ? { resolved: true } : { resolved: false, reason: 'unreachable' };
  }

  // ─── Router Solicitation ────────────────────────────────────────

  /**
   * Send Router Solicitation to discover routers and obtain prefix info.
   * Public: used directly by `ipconfig /renew6` (Windows) and the
   * Linux equivalent — a SLAAC-only network has no DHCPv6 lease to
   * renew, so a real renew there re-solicits the on-link router(s).
   */
  sendRouterSolicitation(portName: string): void {
    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return;

    const srcIP = port.getLinkLocalIPv6();
    if (!srcIP) return;

    const rs = createRouterSolicitation(port.getMAC());
    const rsPkt = createIPv6Packet(
      srcIP,
      IPV6_ALL_ROUTERS_MULTICAST,
      IP_PROTO_ICMPV6,
      255,
      rs,
      16,
    );

    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC: IPV6_ALL_ROUTERS_MULTICAST.toMulticastMAC(),
      etherType: ETHERTYPE_IPV6,
      payload: rsPkt,
    });

    Logger.debug(this.id, 'ndp:rs-sent',
      `${this.name}: Router Solicitation sent on ${portName}`);
  }
}
