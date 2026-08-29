/**
 * Router - Layer 3 Forwarding Engine (RFC 791, RFC 1812, RFC 2453)
 *
 * Architecture: Control Plane / Data Plane / Management Plane
 *
 * Data Plane (Forwarding Engine — "Packet Walk"):
 *   Phase A: Ingress & L2 Validation
 *     - L2 Filter: Accept only frames for our MAC or broadcast
 *     - EtherType Check: Dispatch ARP (0x0806) or IPv4 (0x0800)
 *   Phase B: L3 Header Sanity Check (RFC 1812 §5.2.2)
 *     - Checksum verification (one's complement)
 *     - Version == 4
 *     - IHL >= 5
 *     - TotalLength consistency
 *   Phase C: Forwarding Decision (LPM)
 *     - If for us → Control Plane (ICMP echo-reply, UDP/RIP)
 *     - Else → FIB lookup (Longest Prefix Match)
 *   Phase D: Header Mutation & Exception Handling
 *     - TTL decrement → ICMP Time Exceeded if TTL=0
 *     - Checksum recalculation
 *   Phase E: Egress & L2 Rewrite
 *     - MTU check → ICMP Fragmentation Needed if DF=1
 *     - ARP resolution for next-hop MAC
 *     - Re-encapsulate: SrcMAC=egress interface, DstMAC=next-hop
 *
 * Control Plane:
 *   - RIB (Routing Information Base) with connected/static/default/rip routes
 *   - ARP cache with interface tracking
 *   - ICMP error generation (Time Exceeded, Dest Unreachable, Frag Needed)
 *   - RIPv2 engine (RFC 2453): periodic updates, split horizon, route aging
 *
 * Management Plane:
 *   - Vendor-abstracted CLI (Cisco IOS / Huawei VRP)
 *   - Running-config state
 *   - SNMP-ready performance counters
 */

import { Equipment } from '../equipment/Equipment';
import type { TaggedEthernetFrame } from './Switch';
import type { CredentialAuthenticator } from '../equipment/HostCapabilities';
import { deviceClockSource, SEVERITY_NAMES } from './inspection/config/LoggingConfig';
import type { IEventBus } from '@/events/EventBus';
import { VtyLineConfigStore } from './router/vty/VtyLineConfigStore';
import type { VtyLineConfig } from './router/vty/VtyLineConfig';
import { VtyIncomingPolicy, type VtyAdmissionVerdict, type VtyTransportKind } from './router/vty/VtyIncomingPolicy';
import { AaaAuthenticator } from './router/aaa/AaaAuthenticator';
import { isInteractionPlanner } from '@/shell/interaction/CommandInteraction';
import {
  hasHeadlessAnswers, runInteractionPlanHeadless, type HeadlessAnswers,
} from '@/shell/interaction/HeadlessInteraction';
import { RouterHostsTable } from './router/dns/RouterHostsTable';
import { RouterSshKnownHosts } from './router/ssh/RouterSshKnownHosts';
import { CommandAliasTable } from './router/cli/CommandAliasTable';
import { IpPrefixListStore } from './router/policy/IpPrefixList';
import { RoutePolicyStore } from './router/policy/RoutePolicy';
import { TrafficPolicyStore } from './router/policy/TrafficPolicy';
import { NqaService } from '../nqa/NqaService';
import { ControlPlaneUdpEndpoint } from './udp/ControlPlaneUdpEndpoint';
import { addressAnswersOnLink } from '../arp/AddressProbe';
import { CiscoDnsConfig } from './router/dns/CiscoDnsConfig';
import { RouterDnsService, DNS_PORT, type DnsTransport } from './router/dns/RouterDnsService';
import { encodeDnsMessage, decodeDnsMessage } from '../dns/wire/DnsMessageCodec';
import { RRType } from '../dns/wire/RRType';
import type { DnsMessage } from '../dns/wire/DnsMessage';
import { Port, LOOPBACK_MTU, LOOPBACK_BW_KBPS, LOOPBACK_DELAY_US } from '../hardware/Port';
import { CliShellSession } from './shells/vty/CliShellSession';
import { TimerSet } from '@/events/TimerSet';
import { TcpStack, type TcpSocket } from '../tcp/TcpStack';
import type { TcpStream, TcpDialFailure } from '../tcp/types';
import { isDialFailure } from '../tcp/types';
import { verifyUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import { dialTcp, parseDialAddress, type DialAddress } from '../tcp/dial';
import { SystemClock } from '../core/SystemClock';
import { PortNumber } from '../core/ports/PortNumber';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { RouterSshServerContext } from '../protocols/ssh/server/RouterSshServerContext';
import type { RouterSftpSource } from '../protocols/ssh/sftp/RouterSftpFileSystem';
import { TelnetServerHandler } from '../protocols/telnet/TelnetServerHandler';
import { RouterTelnetServerContext } from '../protocols/telnet/RouterTelnetServerContext';
import { SshHostKey } from '../protocols/ssh/SshHostKey';
import { FtpServer } from '../ftp/FtpServer';
import { RouterSftpFileSystem } from '../protocols/ssh/sftp/RouterSftpFileSystem';
import type { SshExecTarget } from '../protocols/ssh/server/SshExecTarget';
import {
  getDefaultScheduler, __setDefaultScheduler, VirtualTimeScheduler,
  type IScheduler,
} from '@/events/Scheduler';
import { waitForEvent, WaitForEventTimeoutError } from '@/events/waitForEvent';
import type { CiscoPingRow } from './shells/cisco/ciscoPing';
import { CiscoFileSystem } from './shells/cisco/CiscoFileSystem';
import { evaluateIpv6Acl } from './router/Ipv6AclEngine';

/** One probe of one hop, as both traceroute implementations report it. */
export interface TracerouteProbe {
  responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean;
}
export interface TracerouteHop {
  hop: number; ip?: string; rttMs?: number; timeout: boolean;
  unreachable?: boolean; probes: TracerouteProbe[];
}
import {
  EthernetFrame, IPv4Packet, ESPPacket, AHPacket, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket, UDPPacket, RIPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6,
  IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ESP, IP_PROTO_AH, IP_PROTO_OSPF,
  IP_PROTO_EIGRP,
  UDP_PORT_RIP, UDP_PORT_IKE, UDP_PORT_IKE_NAT_T,
  TCPPacket,
  createIPv4Packet, verifyIPv4Checksum, computeIPv4Checksum,
  DeviceType,
  IPv6Address, IPv6Packet,
} from '../core/types';
import type { ARPEntry } from '../core/types';
import type { IIPv4Route } from '../core/interfaces';
import { ipv4MulticastToMac, tryIpToUint32 } from '../core/ip';
import { Logger } from '../core/Logger';
import { CarPolicer } from '../qos/CarPolicer';
import { buildICMPError, mayGenerateICMPError, ICMP_UNREACH_PORT, type ICMPErrorType } from '../core/IcmpErrors';
import { IpSlaEngine } from '../ipsla/IpSlaEngine';
import { TrackService } from '../ipsla/TrackService';
import type { IpSlaEgress } from '../ipsla/types';
import { dialHttp } from '../http/HttpClient';
import { md5Hex } from '@/crypto/hash/md5';
import type { KeyChainRepository } from './inspection/config/KeyChainRepository';
import { fragmentIPv4, IPv4Reassembler } from '../core/Ipv4Fragmentation';
import type { FhrpDataPlane } from '../fhrp/types';
import { DHCPServer, type DhcpUtilizationCrossing } from '../dhcp/DHCPServer';
import {
  classifyIpv4Destination, decrementForForwarding, isDirectedBroadcast,
  ipv4HeaderProblem,
} from '../layers/internet/InternetLayer';
import {
  DHCP_FREE_ADDRESS_HIGH, DHCP_FREE_ADDRESS_LOW, DHCP_SHARED_NET_ENTRY,
  snmpAdminStringIndex,
} from '../snmp/mibs/DhcpServerMib';
import { DHCPPacket } from '../dhcp/DHCPPacket';
import { buildDhcpServerReply } from '../dhcp/DhcpServerExchange';
import type { DHCPDiscoverParams, DHCPOfferResult } from '../dhcp/types';
import { DHCPv6Server } from '../dhcpv6/DHCPv6Server';
import { DHCPv6Packet } from '../dhcpv6/DHCPv6Packet';
import { IPSecEngine } from '../ipsec/IPSecEngine';
import type { NetFlowAgent, NetFlowRecordInput } from '../netflow/NetFlowAgent';
import { ACLEngine, formatAclLogMessage, sourceProbePacket, type AclNumbering, type AclSequencing } from './router/ACLEngine';
import { isTimeRangeActive, type CiscoSecurityConfig } from './router/security/CiscoSecurityConfig';
export type { ACLEntry, AccessList, InterfaceACLBinding } from './router/ACLEngine';
import { RouterRIPEngine } from './router/RouterRIPEngine';
export type { RIPConfig } from './router/RouterRIPEngine';
import { IPv6DataPlane } from './router/IPv6DataPlane';
export type { IPv6RouteEntry, NeighborState, NeighborCacheEntry, RAConfig } from './router/IPv6DataPlane';
import { RouterDhcpClient } from './router/RouterDhcpClient';
import { RouterOSPFIntegration } from './router/RouterOSPFIntegration';
import { RouterDynamicRouting } from './router/RouterDynamicRouting';
import { NetworkOsCredentialStore } from './router/aaa/NetworkOsCredentialStore';
import { SecurityAuditLog } from './router/aaa/SecurityAuditLog';
import {
  NetworkOsAccount, applyCiscoUsernamePatch,
  type CiscoUsernamePatch, type PasswordHashAlgorithm,
} from './router/aaa/NetworkOsAccount';
import { LoginBlocker } from './router/aaa/LoginBlocker';
import { SshSessionRegistry } from './router/aaa/SshSessionRegistry';
import { algorithmesRetenus } from './shells/cisco/CiscoCommonShow';
import { CrossVendorSshHost, type CrossVendorSshVendor } from '../protocols/ssh/server/CrossVendorSshHost';
export type { OSPFExtraConfig, OSPFRouterContext } from './router/RouterOSPFIntegration';
export { RouterOSPFIntegration } from './router/RouterOSPFIntegration';
import { NATEngine } from './router/NATEngine';
import { inspectAndRewriteFtpAlg } from './router/nat/FtpAlg';
import { RouterDebugService } from './router/diag/RouterDebugService';
import { NhrpService } from './router/nhrp/NhrpService';
import { DmvpnService } from './router/nhrp/DmvpnService';
import { NhrpEngine } from '../nhrp/NhrpEngine';
import { IP_PROTO_NHRP, type NhrpPacket } from '../nhrp/types';
import { RouterManagementService } from './router/management/RouterManagementService';
import { CiscoHttpService } from './router/management/CiscoHttpService';
import { CiscoHttpUi } from './router/management/CiscoHttpUi';
import { Http1ServerSession } from '../http/http1/Http1ServerSession';
import { HttpsServerSession } from '../http/https/HttpsServerSession';
import type { HttpMessage } from '../http/semantics/types';
import { generateSelfSignedCertificate } from '../pki/SelfSignedCertificate';
import type { X509Certificate } from '../pki/X509Certificate';
import type { PkiPrivateKey } from '../pki/PkiKeyPair';
import { synthTcpPacket } from './router/vty/VtyIncomingPolicy';
import { SnmpService } from './router/management/SnmpService';
import { EemService } from './router/eem/EemService';
import { EemEngine, type EemHost } from './router/eem/EemEngine';
import type { SnmpAgent } from '../snmp/SnmpAgent';
import { NetflowService } from './router/netflow/NetflowService';
import { ArchiveService } from './router/archive/ArchiveService';
import { KeypairService } from './router/security/KeypairService';
import { HuaweiRoutingExtras } from './router/routing/HuaweiRoutingExtras';
import { HuaweiBfdService } from './router/bfd/HuaweiBfdService';
import { HuaweiAaaService } from './router/aaa/HuaweiAaaService';
export type { NatStaticEntry, NatPool, NatDynamicRule, NatSession, NatTranslationEntry } from './router/NATEngine';

// ─── Routing Table (RIB) ───────────────────────────────────────────

/**
 * A router's IPv4 routing-table entry — the canonical IIPv4Route
 * (network/mask/nextHop/iface/type/ad/metric) plus router-only annotations.
 */
function routeDebugSource(type: string): string {
  switch (type) {
    case 'connected': return 'connected';
    case 'local': return 'connected';
    case 'rip': return 'rip';
    case 'ospf': return 'ospf';
    case 'eigrp': return 'eigrp';
    case 'bgp': return 'bgp';
    default: return 'static';
  }
}

export interface RouteEntry extends IIPv4Route {
  preference?: number;
  tag?: number;
  description?: string;
  track?: string;
  vpnInstance?: string;
  permanent?: boolean;
  installedAt?: number;
  /**
   * L'opérateur a-t-il NOMMÉ l'interface de sortie, ou a-t-elle été
   * déduite du prochain saut ?
   *
   * `iface` seul ne permet pas de répondre : `addStaticRoute` le
   * remplit dans les deux cas, par `findInterfaceForIP` pour la forme
   * `ip route <net> <mask> <prochain-saut>`. Sans cette distinction, le
   * rendu de configuration ne peut que deviner — et il devinait mal,
   * réécrivant `ip route … GigabitEthernet0/0` en
   * `ip route … 0.0.0.0`, une route différente, rechargée telle quelle
   * à l'import d'une topologie.
   */
  ifaceConfigured?: boolean;
}

const RECURSION_MAX = 4;

// ─── Performance Counters (SNMP-ready) ──────────────────────────────

export interface RouterCounters {
  /** Total octets received on all interfaces */
  ifInOctets: number;
  /** Total octets sent on all interfaces */
  ifOutOctets: number;
  /** Packets dropped due to invalid header (version, IHL, checksum, length) */
  ipInHdrErrors: number;
  /** Packets with IP addresses that were invalid for the entity (not for us, no route) */
  ipInAddrErrors: number;
  /** Packets successfully forwarded to next hop */
  ipForwDatagrams: number;
  /** Total ICMP messages sent */
  icmpOutMsgs: number;
  /** ICMP Destination Unreachable messages sent */
  icmpOutDestUnreachs: number;
  /** ICMP Time Exceeded messages sent */
  icmpOutTimeExcds: number;
  /** ICMP echo-reply messages sent */
  icmpOutEchoReps: number;
}

// ─── ARP State ─────────────────────────────────────────────────────

/** Packets waiting for ARP resolution */
interface QueuedPacket {
  frame: IPv4Packet;
  outIface: string;
  nextHopIP: IPAddress;
  timer: symbol;
}

// ─── CLI Shell (imported from shells/) ──────────────────────────────

import type { IRouterShell } from './shells/IRouterShell';
import { iosInterfaceUsable, interfacesBootShutdown, routerPortCountOverride } from './inspection/InterfaceStatusView';
import { ciscoPasswordMatches } from './shells/cisco/ciscoPasswordVerify';
import { DHCP_SERVER_PORT, DHCP_CLIENT_PORT } from '../core/WellKnownPorts';
import { buildUdpOverIpv4, type UdpSendRequest } from '../layers/transport/UdpEgress';

// ─── Router (Abstract Base) ──────────────────────────────────────────

export interface IPv6ACLEntry {
  action: 'permit' | 'deny';
  protocol?: string;
  srcPrefix?: string;
  srcPrefixLength?: number;
  dstPrefix?: string;
  dstPrefixLength?: number;
  dstPort?: string;
  log?: boolean;
  sequence?: number;
  remark?: string;
  evaluate?: string;
  prefix?: string;
  prefixLength?: number;
}

export interface IPv6ACL {
  name: string;
  entries: IPv6ACLEntry[];
}

interface ControlPlaneUdpClaim {
  readonly owner: string;
  readonly receive: (inPort: string, ipPkt: IPv4Packet, udp: UDPPacket) => void;
}

export abstract class Router extends Equipment implements CredentialAuthenticator {
  // ── Control Plane ─────────────────────────────────────────────
  private routingTable: RouteEntry[] = [];
  /** Round-robin cursor across genuinely tied (same prefix/AD/metric) ECMP candidates in lookupRoute(). */
  private ecmpCursor = 0;

  /**
   * Combien de chemins de coût égal un protocole a le droit d'installer.
   *
   * `maximum-paths <n>` (IOS) et `maximum load-balancing <n>` (VRP) sont
   * la MÊME décision, et elle était rangée dans **sept** magasins
   * différents — un par protocole et par constructeur — que **personne
   * ne lisait** : `Router.lookupRoute` répartissait sur tous les chemins
   * à égalité sans plafond, donc `maximum-paths 1`, qui est la façon
   * normale de COUPER la répartition et le premier geste de tout
   * diagnostic de trafic asymétrique, n'avait aucun effet.
   *
   * Les défauts sont ceux du matériel, vérifiés et non supposés, et la
   * différence entre eux est la seule chose qu'il ne fallait pas rater :
   * **BGP vaut 1** — « by default, BGP installs only the best path »,
   * et Huawei l'écrit aussi (« la répartition de charge entre routes BGP
   * n'est pas activée par défaut ») — tandis que les IGP valent **4**.
   * Les aligner tous sur 4 apprendrait qu'un iBGP répartit tout seul, ce
   * qui est faux et coûteux.
   *
   * Ce qui n'a PAS de plafond, et c'est voulu : `connected` et `static`.
   * Aucune commande ne les borne — `maximum-paths` vit sous un processus
   * de routage — donc deux routes statiques à égalité se répartissent
   * toujours, comme sur une vraie machine.
   */
  private maxPathsByProto = new Map<string, number>();

  private static readonly MAX_PATHS_DEFAUT: Readonly<Record<string, number>> = {
    bgp: 1, ospf: 4, rip: 4, eigrp: 4, isis: 4,
  };

  setMaximumPaths(proto: string, n: number): void {
    this.maxPathsByProto.set(proto, n);
  }

  /** Le plafond effectif ; `Infinity` pour ce qu'aucune commande ne borne. */
  maximumPathsFor(proto: string): number {
    const pose = this.maxPathsByProto.get(proto);
    if (pose !== undefined) return pose;
    return Router.MAX_PATHS_DEFAUT[proto] ?? Infinity;
  }
  private arpTable: Map<string, ARPEntry> = new Map();
  protected ipv6AccessLists: IPv6ACL[] = [];

  getIpv6AccessLists(): IPv6ACL[] { return this.ipv6AccessLists; }

  _clearArpEntry(ip: string): number {
    return this.arpTable.delete(ip) ? 1 : 0;
  }
  _clearDynamicRoutes(): void {
    this.routingTable = this.routingTable.filter(r =>
      r.type === 'connected' || r.type === 'static' || r.type === 'default');
  }
  private packetQueue: QueuedPacket[] = [];
  private readonly defaultTTL = 255; // Cisco/Huawei default
  private readonly interfaceMTU = 1500; // Standard Ethernet MTU

  // ── RIP Engine (RFC 2453) — delegated to RouterRIPEngine ──────
  private ripEngine!: RouterRIPEngine;

  // ── Performance Counters ──────────────────────────────────────
  private counters: RouterCounters = {
    ifInOctets: 0, ifOutOctets: 0,
    ipInHdrErrors: 0, ipInAddrErrors: 0, ipForwDatagrams: 0,
    icmpOutMsgs: 0, icmpOutDestUnreachs: 0, icmpOutTimeExcds: 0,
    icmpOutEchoReps: 0,
  };

  // ── IPv6 Data Plane — delegated to IPv6DataPlane ──────────────
  private ipv6Engine!: IPv6DataPlane;

  // ── ACL (Access Control Lists) — delegated to ACLEngine ────
  private aclEngine = (() => {
    const e = new ACLEngine();
    // Wire the Cisco time-range resolver — ACL entries tagged
    // `time-range NAME` consult getSecurityConfig().timeRanges to know
    // whether they are currently active. Done lazily so the security
    // config is created on demand by the security-CLI handlers.
    // `log` / `log-input` : le moteur signale la correspondance, l'equipement
    // la met en forme comme IOS et la pousse dans le journal.
    e.setLogSink((ev) => {
      Logger.info(this.id, 'router:acl-log', formatAclLogMessage(ev));
    });
    e.setClockSource(() => this.getSystemClockMs());
    e.setTimeRangeResolver((name, now) => {
      const sec = (this as unknown as Record<symbol, CiscoSecurityConfig | undefined>)[
        Symbol.for('CiscoSecurityConfig')
      ];
      const tr = sec?.timeRanges.get(name);
      if (!tr) return false;
      return isTimeRangeActive(tr, now);
    });
    return e;
  })();

  protected isIcmpUnreachablesEnabled(ifName: string): boolean {
    const sec = (this as unknown as Record<symbol, CiscoSecurityConfig | undefined>)[
      Symbol.for('CiscoSecurityConfig')
    ];
    if (!sec) return true;
    return !sec.ifaceFlags(ifName).noUnreachables;
  }

  // ── Interface Descriptions ──────────────────────────────────
  private interfaceDescriptions: Map<string, string> = new Map();

  private pingIdCounter = 1;

  // ── DHCP Server (RFC 2131) ──────────────────────────────────
  private dhcpServer: DHCPServer = new DHCPServer();

  // ── DHCPv6 Server (RFC 8415) ─────────────────────────────────
  private dhcpv6Server: DHCPv6Server = new DHCPv6Server();
  _getDHCPv6ServerInternal(): DHCPv6Server { return this.dhcpv6Server; }
  /** Interface → pool name (`ipv6 dhcp server <pool>` / Huawei `dhcpv6 server <pool>`). */
  private dhcpv6InterfacePools: Map<string, string> = new Map();
  setDhcpv6ServerPool(iface: string, poolName: string): void { this.dhcpv6InterfacePools.set(iface, poolName); }
  getDhcpv6ServerPool(iface: string): string | undefined { return this.dhcpv6InterfacePools.get(iface); }
  /** Interface → relay destination addresses (`ipv6 dhcp relay destination`). */
  private dhcpv6RelayDestinations: Map<string, string[]> = new Map();
  addDhcpv6RelayDestination(iface: string, addr: string): void {
    const list = this.dhcpv6RelayDestinations.get(iface) ?? [];
    if (!list.includes(addr)) list.push(addr);
    this.dhcpv6RelayDestinations.set(iface, list);
  }
  getDhcpv6RelayDestinations(iface: string): string[] { return this.dhcpv6RelayDestinations.get(iface) ?? []; }

  // ── OSPF Integration (RFC 2328 / RFC 5340) — delegated to RouterOSPFIntegration ──
  // `protected` et non `private` : `CiscoRouter` comme `HuaweiRouter`
  // l'appellent depuis leur abonnement `bfd.session.changed`, ce que le
  // typage refusait des deux côtés.
  protected ospfIntegration!: RouterOSPFIntegration;
  private dynamicRouting!: RouterDynamicRouting;

  // ── IPSec Engine ─────────────────────────────────────────────
  private ipsecEngine: IPSecEngine | null = null;

  // ── NAT Engine ───────────────────────────────────────────────
  private natEngine = new NATEngine();

  private ipPrefixListStore = new IpPrefixListStore();
  private routePolicyStore = new RoutePolicyStore();
  private trafficPolicyStore = new TrafficPolicyStore();


  getIpPrefixListStore(): IpPrefixListStore { return this.ipPrefixListStore; }
  getRoutePolicyStore(): RoutePolicyStore { return this.routePolicyStore; }
  getTrafficPolicyStore(): TrafficPolicyStore { return this.trafficPolicyStore; }


  // ── Reactive (Phase 5.8) — scheduler + TimerSet + event helpers ──
  private routerScheduler: IScheduler | null = null;
  protected readonly routerTimers = new TimerSet(() => this.getRouterScheduler());
  /** In-flight ARP solicitations for forwarding — dedup signal that replaces
   *  pendingARPs use as a "request-already-sent" check (Phase 5.8). */
  private inFlightFwdARPs: Set<string> = new Set();
  /** Reassembles fragments of datagrams addressed to this router itself (RFC 791 §3.2). */
  private readonly ipv4Reassembler = new IPv4Reassembler();

  // ── Management Plane (vendor CLI shell) ───────────────────────
  private shell: IRouterShell;

  constructor(type: DeviceType, name: string = 'Router', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.ripEngine = new RouterRIPEngine({
      id: this.id,
      name: this.name,
      getPorts: () => this.ports,
      getRoutingTable: () => this.routingTable,
      setRoutingTable: (table) => { this.routingTable = table; },
      pushRoute: (route) => { this.routingTable.push({ ...route, installedAt: Date.now() }); },
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getRipVersion: () => this._ripVersion,
      isInterfaceUsable: (iface) => !(this.getPort(iface)?.isAdminDown() ?? false),
      sendIpv4ArpAware: (iface, packet, nextHop) =>
        this.sendIpv4FrameArpAware(iface, packet, nextHop),
      getInterfaceRipAuth: (iface) => this.ripAuthOn(iface),
      getBus: () => this.getBus(),
      getScheduler: () => this.getRouterScheduler(),
      evaluateRoutePolicy: (name, network, mask) => {
        const rp = this.routePolicyStore.get(name);
        if (!rp) return null;
        return rp.evaluate(
          { network: network.toString(), prefixLength: mask.toCIDR() },
          this.ipPrefixListStore,
        ).action;
      },
    });
    this.ipv6Engine = new IPv6DataPlane({
      id: this.id,
      name: this.name,
      getPorts: () => this.ports,
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getCounters: () => this.counters,
      getBus: () => this.getBus(),
      getScheduler: () => this.getRouterScheduler(),
      getDhcpv6Server: () => this.dhcpv6Server,
      getDhcpv6ServerPool: (iface) => this.dhcpv6InterfacePools.get(iface),
      getDhcpv6RelayDestinations: (iface) => this.dhcpv6RelayDestinations.get(iface) ?? [],
      deliverOspfv3: (inPort, srcIP, packet, ipsecProtected) =>
        this.ospfIntegration?.receivePacketV3(inPort, srcIP, packet, ipsecProtected),
      ipv6FilterPermits: (iface, direction, pkt) => this.ipv6FilterPermits(iface, direction, pkt),
      onIcmpv6EchoReply: (p) => this.emitIcmpEchoReply({ ...p, ttl: p.hopLimit, rttMs: 0 }),
      onIcmpv6EchoFailed: (p) => this.emitIcmpEchoFailed({
        fromIp: p.fromIp, toIp: '', id: -1, seq: -1, reason: p.reason,
      }),
    });
    this.ospfIntegration = new RouterOSPFIntegration({
      id: this.id,
      name: this.name,
      getPorts: () => this.ports,
      getRoutingTable: () => this.routingTable,
      setRoutingTable: (table) => { this.routingTable = table; },
      pushRoute: (route) => { this.routingTable.push({ ...route, installedAt: Date.now() }); },
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getArpEntry: (ip) => this.arpTable.get(ip),
      getACLEngine: () => this.aclEngine,
      getIPv6Engine: () => this.ipv6Engine,
      getIPv6AccessLists: () => this.ipv6AccessLists,
      getBfdAgent: () => this.getBfdAgent(),
      getIpPrefixListStore: () => this.ipPrefixListStore,
      getBus: () => this.getBus(),
    });
    this.dynamicRouting = new RouterDynamicRouting({
      id: this.id,
      getPorts: () => this.ports,
      getRoutingTable: () => this.routingTable,
      setRoutingTable: (table) => { this.routingTable = table; },
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getArpEntry: (ip) => this.arpTable.get(ip),
      getRipEngine: () => this.ripEngine,
      getOspfIntegration: () => this.ospfIntegration,
      getTcpStack: () => this.tcpv2,
      getBus: () => this.getBus(),
    });
    this.shell = this.createShell();
    this.dynamicRouting.eigrp.setKeyResolver((chaine) => {
      const cles = this.ipSlaKeyChains()?.getChain(chaine)?.keys;
      if (!cles || cles.size === 0) return null;
      const id = [...cles.keys()].sort((a, b) => a - b)[0];
      const secret = cles.get(id)?.keyString;
      return secret === undefined ? null : { id, secret };
    });
    // Wire the logging buffer to this device's own bus up front — without
    // this, `show logging` stays empty for every domain event (OSPF, HSRP,
    // NAT debug, …) until something happens to call the internal
    // `getLoggingConfig()` accessor first, which no real CLI command does.
    this.attachLoggingBus(this.getBus());
    this.natEngine.setDeviceId(this.id, this.name);
    // An engine left on the process-wide default bus meets every other
    // router's events there, and its actors then have to filter by device
    // id to ignore them. The bus boundary is the guarantee that filtering
    // only approximates (docs/PRD-Frame-Only-Refactor.md P2).
    this.natEngine.setEventBus(this.getBus());
    this.dhcpServer.setEventBus(this.getBus());
    this.dhcpServer.setDeviceId(this.id, this.name);
    this.dhcpServer.setUtilizationSink((crossing) => this.emitDhcpUtilizationTrap(crossing));
    this.natEngine.setACLMatchFn((aclId, srcIP, realPkt) => {
      const pkt = realPkt ?? sourceProbePacket(new IPAddress(srcIP));
      // Undefined ACL = no interesting traffic, so require an explicit permit.
      return this.aclEngine.evaluateACLByName(String(aclId), pkt) === 'permit';
    });
    this.natEngine.setInterfaceIPFn((iface) => {
      const port = this.ports.get(iface);
      return port?.getIPAddress()?.toString() ?? null;
    });
    this.createPorts();
    this.dhcpClientAgent = new RouterDhcpClient({
      macOf: (iface) => this.ports.get(iface)?.getMAC().toString() ?? '00:00:00:00:00:00',
      linkUsable: (iface) => {
        const port = this.ports.get(iface);
        return !!port && port.getIsUp() && port.isConnected();
      },
      applyLease: (iface, ip, mask, gateway) => {
        this.ports.get(iface)?.configureIP(new IPAddress(ip), new SubnetMask(mask), 'dhcp');
        this.configureInterface(iface, new IPAddress(ip), new SubnetMask(mask));
        if (gateway) this.setDefaultRoute(new IPAddress(gateway), 0, { iface });
      },
      clearLease: (iface) => {
        this.ports.get(iface)?.clearIP();
        this.routingTable = this.routingTable.filter(r =>
          !((r.type === 'connected' || r.type === 'default') && r.iface === iface));
      },
      sendDhcpFrame: (iface, pkt) => this.sendDhcpClientFrame(iface, pkt),
      markClient: (iface, on) => this.ports.get(iface)?.setDhcpClient(on),
      bus: () => this.getBus(),
      identity: () => ({ deviceId: this.id, hostname: this.getHostname() }),
    });
    this._setupPortMonitoring();
    const tcpHost = {
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      resolveMac: (nextHopIp: string) => this.arpTable.get(nextHopIp)?.mac ?? null,
      sendIpv4FrameArpAware: (p: string, ipPkt: IPv4Packet, nextHopIP: IPAddress) =>
        this.sendIpv4FrameArpAware(p, ipPkt, nextHopIP),
    };
    this.tcpv2 = new TcpStack(tcpHost, () => this.getBus(),
      () => this.getRouterScheduler());
    this.tcpv2.start();
    this.getEemEngine();
    this.getCredentialStore();
    this.mountSshDaemon();
    this.startArpAgingTimer();
    this.ipSlaEngine.start();
    this.trackService.start();
    this.subscribeNqaResults();
  }

  /**
   * IP SLA et suivi d'objets vivent sur l'ÉQUIPEMENT, pas sur le shell.
   *
   * Ils y vivaient : `CiscoIOSShell` construisait son propre
   * `TrackRepository`/`IpSlaRepository`. Or `createVtyShell()` fabrique un
   * shell NEUF par session — un `track` posé en SSH était donc invisible
   * depuis la console de la même machine, et réciproquement. La
   * running-config, qui est rendue par le shell mais décrit l'équipement,
   * ne pouvait pas non plus les voir.
   */
  private readonly ipSlaEngine: IpSlaEngine = new IpSlaEngine(
    {
      id: this.id,
      getHostname: () => this.getHostname(),
      getPort: (name) => this.ports.get(name),
      resolveEgress: (destination, sourceInterface, sourceIp) =>
        this.resolveIpSlaEgress(destination, sourceInterface, sourceIp),
      sendIcmpv6Echo: (r) => this.sendIpSlaIcmpv6Echo(r),
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      sendUdp: (destination, sourcePort, destinationPort, payload) =>
        this.sendIpSlaUdp(destination, sourcePort, destinationPort, payload),
      connectTcp: (ip, port, timeoutMs) => this.probeTcpConnect(ip, port, timeoutMs),
      tracePath: async (destination, maxHops, timeoutMs) => {
        const hops = await this.executeTraceroute(destination, maxHops, timeoutMs, 1);
        return hops.map((hop) => ({
          address: hop.ip ?? null,
          rttMs: hop.rttMs ?? null,
        }));
      },
      computeKeyDigest: (chain, keyId, material) => this.ipSlaKeyDigest(chain, keyId, material),
      activeKeyId: (chain) => this.ipSlaActiveKeyId(chain),
      fetchHttp: (ip, port, path, method) => this.probeHttp(ip, port, path, method),
      resolveHostname: (name) => this.hostsTable.resolve(name),
      isClockSynchronized: () => this.isNtpSynchronized(),
      epochMs: () => this.getSystemClockMs(),
      log: (severity, mnemonic, text) => {
        this.getLoggingConfig()?.append(severity, 'ipsla', text, true, mnemonic);
      },
      sendTrap: (oid, varBindings) => { this.sendIpSlaTrap(oid, varBindings); },
    },
    () => this.getBus(),
    () => this.getRouterScheduler(),
  );

  private readonly trackService: TrackService = new TrackService(
    {
      id: this.id,
      getHostname: () => this.getHostname(),
      isInterfaceLineUp: (name) => {
        const port = this.ports.get(name);
        return !!port && port.getIsUp() && port.isConnected();
      },
      isInterfaceRoutingUp: (name) => {
        const port = this.ports.get(name);
        return !!port && port.getIsUp() && !!port.getIPAddress();
      },
      hasRoute: (prefix, mask) => this.trackedRouteEntry(prefix, mask) !== null,
      routeMetric: (prefix, mask) => this.trackedRouteEntry(prefix, mask)?.metric ?? null,
      epochMs: () => this.getSystemClockMs(),
      log: (severity, mnemonic, text) => {
        this.getLoggingConfig()?.append(severity, 'tracking', text, true, mnemonic);
      },
    },
    () => this.ipSlaEngine,
    () => this.getBus(),
    () => this.getRouterScheduler(),
  );

  private readonly nqaService: NqaService = new NqaService(this.ipSlaEngine);

  getIpSlaEngine(): IpSlaEngine { return this.ipSlaEngine; }
  getTrackService(): TrackService { return this.trackService; }
  getNqaService(): NqaService { return this.nqaService; }

  /**
   * Un lot NQA terminé doit remonter au test qui l'a demandé. Le moteur
   * ne connaît que des numéros d'opération ; c'est ici que le numéro
   * redevient un couple (administrateur, test).
   */
  private subscribeNqaResults(): () => void {
    return this.getBus().subscribeWhere(
      'ipsla.probe.completed',
      (payload) => payload.deviceId === this.id,
      (event) => {
        for (const test of this.nqaService.list()) {
          if (test.operationId !== event.payload.operationId) continue;
          const runtime = this.nqaService.runtimeOf(test);
          if (runtime) this.nqaService.recordBatch(test, runtime, this.getSystemClockMs());
        }
      },
    );
  }

  private trackedRouteEntry(prefix: string, mask: string | null): RouteEntry | null {
    for (const route of this.routingTable) {
      if (String(route.network) !== prefix) continue;
      if (mask && String(route.mask) !== mask) continue;
      if (!this.isRouteUsable(route)) continue;
      return route;
    }
    return null;
  }

  private resolveIpSlaEgress(
    destination: IPAddress,
    sourceInterface: string | null,
    sourceIp: string | null,
  ): IpSlaEgress | null {
    if (sourceInterface) {
      const pinned = this.ports.get(sourceInterface);
      if (!pinned || !pinned.isOperationallyUp() || !pinned.getIPAddress()) return null;
    }
    const route = this.lookupRoute(destination);
    if (!route) return null;
    const egressPort = this.ports.get(route.iface);
    if (!egressPort || !egressPort.isOperationallyUp()) return null;

    let source = egressPort.getIPAddress();
    if (sourceInterface) {
      source = this.ports.get(sourceInterface)?.getIPAddress() ?? source;
    } else if (sourceIp) {
      source = IPAddress.tryParse(sourceIp) ?? source;
    }
    if (!source) return null;

    const nextHop = route.nextHop ?? destination;
    const arpHit = this.arpTable.get(nextHop.toString())
      ?? this.arpTable.get(destination.toString());
    return {
      iface: route.iface,
      sourceIp: source,
      sourceMac: egressPort.getMAC(),
      destinationMac: arpHit ? arpHit.mac : MACAddress.broadcast(),
    };
  }

  private async probeTcpConnect(
    ip: string, port: number, timeoutMs: number,
  ): Promise<{ connected: boolean; refused: boolean }> {
    const socket = this.tcpv2.connect(ip, port);
    if (!socket) return { connected: false, refused: false };
    if (socket.state === 'established') {
      socket.close();
      return { connected: true, refused: false };
    }
    return new Promise((resolve) => {
      let settled = false;
      let offOpen: () => void = () => {};
      let offClose: () => void = () => {};
      const finish = (result: { connected: boolean; refused: boolean }) => {
        if (settled) return;
        settled = true;
        offOpen();
        offClose();
        this.getRouterScheduler().clear(timer);
        resolve(result);
      };
      const timer = this.getRouterScheduler().setTimeout(
        () => { socket.close(); finish({ connected: false, refused: false }); },
        timeoutMs,
      );
      offOpen = socket.onOpen(() => { socket.close(); finish({ connected: true, refused: false }); });
      offClose = socket.onClose(() => finish({ connected: false, refused: true }));
    });
  }

  private probeHttp(
    ip: string, port: number, path: string, method: string,
  ): { ok: boolean; status: number; error?: string } {
    const result = dialHttp({ tcpStack: this.tcpv2, targetIp: ip, port, method, path });
    if (!result.ok || !result.response) {
      return { ok: false, status: 0, error: result.error ?? 'no response' };
    }
    return { ok: true, status: result.response.statusCode };
  }

  /**
   * Un datagramme UDP émis par le plan de contrôle IP SLA, à travers la
   * FIB, comme `_sendIkeUdp` le fait déjà pour IKE — la charge utile est
   * l'objet typé du protocole, pas des octets, comme partout ailleurs
   * dans ce simulateur.
   */
  private sendIpSlaUdp(
    destination: IPAddress,
    sourcePort: number,
    destinationPort: number,
    payload: unknown,
  ): boolean {
    const route = this.lookupRoute(destination);
    if (!route) return false;
    const egress = this.ports.get(route.iface);
    const sourceIp = egress?.getIPAddress();
    if (!egress || !sourceIp || !egress.isOperationallyUp()) return false;
    const udp: UDPPacket = {
      type: 'udp', sourcePort, destinationPort,
      length: 8 + 64, checksum: 0, payload,
    };
    const packet = createIPv4Packet(sourceIp, destination, IP_PROTO_UDP, 64, udp, 8 + 64);
    const arpHit = this.arpTable.get((route.nextHop ?? destination).toString())
      ?? this.arpTable.get(destination.toString());
    this.sendFrame(route.iface, {
      srcMAC: egress.getMAC(),
      dstMAC: arpHit ? arpHit.mac : MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: packet,
    });
    return true;
  }

  private ipSlaKeyChains(): KeyChainRepository | undefined {
    return (this.shell as unknown as { getKeyChains?: () => KeyChainRepository })
      .getKeyChains?.();
  }

  private ipSlaActiveKeyId(chain: string): number | null {
    const keys = this.ipSlaKeyChains()?.getChain(chain)?.keys;
    if (!keys || keys.size === 0) return null;
    return [...keys.keys()].sort((a, b) => a - b)[0];
  }

  private ipSlaKeyDigest(chain: string, keyId: number, material: string): string | null {
    const key = this.ipSlaKeyChains()?.getChain(chain)?.keys.get(keyId);
    if (!key || key.keyString === undefined) return null;
    return md5Hex(`${key.keyString}|${material}`);
  }

  protected isNtpSynchronized(): boolean { return false; }

  /** Last link state a notification was sent for. */
  private readonly lastNotifiedLinkState = new Map<string, boolean>();

  /**
   * linkDown / linkUp (IF-MIB, RFC 2863 — OIDs 1.3.6.1.6.3.1.1.5.3/.4).
   *
   * The varbinds are the RFC's: interface index, admin status, oper
   * status. A trap that did not say WHICH interface it is about would
   * teach the collector nothing.
   */
  private emitLinkTrap(ifName: string, port: Port, monte: boolean): void {
    // An unchanged state is not notified: on an uncabled interface,
    // `shutdown` then `no shutdown` both leave the link down, and a
    // second linkDown went out for an interface already down.
    if (this.lastNotifiedLinkState.get(ifName) === monte) return;
    this.lastNotifiedLinkState.set(ifName, monte);

    const snmp = this.getSnmpService();
    if (!snmp.isEnabled()) return;
    if (!snmp.isTrapEnabled('snmp', monte ? 'linkup' : 'linkdown')) return;

    const index = [...this.ports.keys()].indexOf(ifName) + 1;
    const adminUp = port.getIsUp();
    this.sendIpSlaTrap(
      monte ? '1.3.6.1.6.3.1.1.5.4' : '1.3.6.1.6.3.1.1.5.3',
      [
        { oid: `1.3.6.1.2.1.2.2.1.1.${index}`, kind: 'integer', value: index },
        { oid: `1.3.6.1.2.1.2.2.1.7.${index}`, kind: 'integer', value: adminUp ? 1 : 2 },
        { oid: `1.3.6.1.2.1.2.2.1.8.${index}`, kind: 'integer', value: monte ? 1 : 2 },
      ],
    );
  }

  private emitDhcpUtilizationTrap(crossing: DhcpUtilizationCrossing): void {
    const snmp = this.getSnmpService();
    if (!snmp.isEnabled()) return;
    if (!snmp.isTrapEnabled('dhcp', 'pool')) return;

    const index = snmpAdminStringIndex(crossing.pool);
    const thresholdOid = crossing.crossing === 'high'
      ? `${DHCP_SHARED_NET_ENTRY}.2.${index}`
      : `${DHCP_SHARED_NET_ENTRY}.3.${index}`;
    const usedAtThreshold = crossing.crossing === 'high'
      ? Math.ceil((crossing.threshold * crossing.total) / 100)
      : Math.floor((crossing.threshold * crossing.total) / 100);
    const freeThreshold = Math.max(0, crossing.total - usedAtThreshold);
    this.sendIpSlaTrap(
      crossing.crossing === 'high' ? DHCP_FREE_ADDRESS_LOW : DHCP_FREE_ADDRESS_HIGH,
      [
        { oid: thresholdOid, kind: 'gauge32', value: freeThreshold },
        { oid: `${DHCP_SHARED_NET_ENTRY}.4.${index}`, kind: 'gauge32', value: crossing.free },
      ],
    );
  }

  protected sendIpSlaTrap(
    oid: string,
    varBindings: Array<{ oid: string; kind: string; value: number | string }>,
  ): void {
    void oid;
    void varBindings;
  }

  private arpAgingTimer: symbol | null = null;

  private startArpAgingTimer(): void {
    if (this.arpAgingTimer !== null) return;
    this.arpAgingTimer = this.routerTimers.setInterval(() => this.ageArpEntries(), 5_000);
  }

  protected ageArpEntries(): void {
    const now = Date.now();
    for (const [ip, entry] of this.arpTable) {
      if (entry.type === 'static') continue;
      if (now - entry.timestamp > 60_000) this.arpTable.delete(ip);
    }
  }

  override setEventBus(bus: IEventBus | null): void {
    super.setEventBus(bus);
    if (bus) this.attachLoggingBus(bus);
    if (bus) this.getSnmpService().attachToBus(bus, this.id);
    this._debugService?.attachToBus(this.getBus(), this.id, this);
    this.ipsecEngine?.setEventBus(this.getBus());
    this.natEngine?.setEventBus(this.getBus());
    if (this._eemEngine) { this._eemEngine.stop(); this._eemEngine.start(); }
  }

  // ── SSH daemon over real TCP ───────────────────────────────────────

  private _sshHandlerMounted = false;

  private mountSshDaemon(): void {
    if (this._sshHandlerMounted) return;
    this._sshHandlerMounted = true;
    // Same gate as `syncSshListener`: a box with no host keys has no SSH
    // server to mount, at boot as much as after a `zeroize`. Binding here
    // unconditionally and gating everywhere else would leave a fresh
    // router listening while `show crypto key mypubkey rsa` says there is
    // no key — the two must not be able to disagree.
    if (this.sshServerEnabled && this.hasSshHostKeys()) this.bindSshListener();
    this.bindTelnetListener();
  }

  private bindSshListener(): void {
    this.tcpv2.listen(22, {
      onAccept: (socket) => {
        const handler = this.buildRouterSshServerHandler();
        handler.register(socket as unknown as TcpStream, socket.remoteIp);
      },
    });
  }

  private bindTelnetListener(): void {
    this.tcpv2.listen(23, {
      onAccept: (socket) => {
        const handler = this.buildRouterTelnetServerHandler();
        handler.register(socket as unknown as TcpStream, socket.remoteIp);
      },
    });
  }

  /**
   * The VTY line's authentication mode, vendor-neutral. Cisco writes it
   * as `login` / `login local` / `login authentication`, Huawei as
   * `authentication-mode password|aaa|none`; the store keeps both, and
   * the telnet dialog needs one answer.
   */
  /**
   * Le bloc `line vty` qui gouverne la session en cours d'ouverture.
   * Toutes ces directives — `login`, `password`, `exec-timeout`,
   * `privilege level` — sont des directives de LIGNE, et six lecteurs
   * prenaient le PREMIER bloc declare : sur une machine ou `line vty 0 4`
   * et `line vty 5 15` different, ils repondaient tous pour la premiere
   * plage quelle que soit la ligne prise. Le repli sur le premier bloc
   * subsiste pour une ligne qu'aucun bloc ne couvre.
   */
  private blocVtyCourant(): VtyLineConfig | undefined {
    const idx = this.getSshSessionRegistry().prochaineLigne();
    const parLigne = idx == null ? undefined : this.vtyLineConfig.blocPourLigne(idx);
    return parLigne ?? this.vtyLineConfig.all()[0];
  }

  private resolveVtyLoginMode(): 'none' | 'local' | 'aaa' | 'password' {
    const block = this.blocVtyCourant();
    if (!block) return 'none';
    if (block.login) return block.login;
    if (block.authenticationMode === 'aaa') return 'aaa';
    if (block.authenticationMode === 'password') return 'password';
    return 'none';
  }

  /** Header printed above the telnet credential prompts — IOS wording by default. */
  protected getVtyAuthHeader(): string { return 'User Access Verification'; }

  private buildRouterTelnetServerHandler(): TelnetServerHandler {
    const ctx = new RouterTelnetServerContext({
      hostname: () => this.hostname,
      loginMode: () => this.resolveVtyLoginMode(),
      linePassword: () => {
        const l = this.blocVtyCourant();
        return l?.linePassword ? { value: l.linePassword, algo: l.linePasswordAlgo } : null;
      },
      authHeader: () => this.getVtyAuthHeader(),
      loginBanner: () => this.getBanner('login') || null,
      motd: () => this.getBanner('motd') || null,
      admit: (ip) => this.vtyAdmissionVerdict('telnet', ip),
      authenticateLocal: (user, password) => this.getCredentialStore().authenticate(user, password),
      authenticateAaa: (user, password) => this.authenticateViaAaa(user, password),
      createVtyShell: (user) => this.createVtyShell(user),
      openSession: (user, fromIp, peerPort) => {
        const record = this.getSshSessionRegistry().open({
          user, privilege: this.resolveVtyExecLevel(user || undefined),
          fromIp, authMethod: 'password', localPort: 23, peerPort,
        });
        return record ? { id: record.id, line: record.line } : null;
      },
      noteTerminalType: (id, terminalType) => {
        this.getSshSessionRegistry().setTerminalType(id, terminalType);
      },
      closeSession: (id, reason) => { this.getSshSessionRegistry().close(id, reason); },
      touchSession: (id, bytesIn, bytesOut) => {
        this.getSshSessionRegistry().touch(id, Date.now(), bytesIn, bytesOut);
      },
      idleTimeoutMs: () => this.resolveVtyIdleTimeoutMs(),
      recordAuthFailure: (user, ip) => this.recordSshLogin(user, ip, '', false),
      recordLogin: (user, ip) => this.recordSshLogin(user, ip, '', true, undefined, 23),
    });
    return new TelnetServerHandler(ctx);
  }

  /**
   * `transport input` est une directive de LIGNE, donc l'ecoute suit la
   * reunion des lignes : le serveur reste ouvert tant qu'une vty admet
   * le protocole. Le reglage d'equipement ne sert que de defaut pour les
   * lignes qui n'en declarent pas — sans quoi `line vty 5 15 / transport
   * input none`, la configuration de durcissement la plus courante,
   * fermait le protocole aux vty 0 a 4 qui l'autorisent.
   */
  transportAdmisSurUneVty(kind: 'ssh' | 'telnet'): boolean {
    return this.vtyLineConfig.admetQuelquePart(kind, this.vtyTransportInput);
  }

  private telnetAllowedByTransport(): boolean {
    return this.transportAdmisSurUneVty('telnet');
  }

  private syncSshListener(): void {
    const sshBound = this.tcpv2.listListeners().some(l => l.localPort === 22);
    // Keys are part of "is the server up", not a separate switch: IOS
    // refuses to listen without them.
    const shouldListen = this.sshServerEnabled && this.hasSshHostKeys()
      && this.transportAdmisSurUneVty('ssh');
    if (shouldListen && !sshBound) this.bindSshListener();
    if (!shouldListen && sshBound) this.tcpv2.closeListener(22);
    const telnetWanted = this.telnetAllowedByTransport();
    const telnetBound = this.tcpv2.listListeners().some(l => l.localPort === 23);
    if (telnetWanted && !telnetBound) this.bindTelnetListener();
    if (!telnetWanted && telnetBound) this.tcpv2.closeListener(23);
  }

  /**
   * The synthetic file surface this router serves over a real SFTP
   * channel. A vendor that exposes none (or whose SCP server is off)
   * returns null, and the SSH server context refuses the transfer —
   * the same source `resolveRemoteSftpFsFromDevice` reads, so the two
   * cannot disagree about what a client can pull.
   */
  protected sshSftpFileSource(): RouterSftpSource | null {
    const src = (this as unknown as {
      getSftpFileSource?: () => RouterSftpSource | null;
    }).getSftpFileSource?.();
    return src ?? null;
  }

  private _sshHostKeyCache: SshHostKey | null = null;
  private buildRouterSshServerHandler(): SshServerHandler {
    const credentials = this.getCredentialStore();
    if (!this._sshHostKeyCache) this._sshHostKeyCache = SshHostKey.generate(this.hostname);
    const ctx = new RouterSshServerContext({
      hostname: () => this.hostname,
      hostKey: () => this._sshHostKeyCache!,
      credentials: () => ({
        authenticate: (n, p) => credentials.authenticate(n, p),
        has: (n) => credentials.get(n) !== undefined,
        get: (n) => {
          const a = credentials.get(n);
          return a ? { name: a.name, privilege: a.privilege, secret: a.secret } : undefined;
        },
      }),
      execTarget: () => this as unknown as SshExecTarget,
      sftpSource: () => this.sshSftpFileSource(),
      execIdleTimeoutMs: () => this.resolveVtyIdleTimeoutMs(),
      banner: () => this.sshBannerText || null,
      aaaAuthenticate: (n, p) => this.authenticateViaAaa(n, p),
      // Reuse the exact admission/failure-tracking the cross-vendor bypass
      // used to gate on its own (login block-for / quiet-mode ACL /
      // LoginBlocker) so real-wire SSH enforces the same security policy a
      // Cisco/Huawei device configures via CLI, instead of losing it when
      // the client stops calling checkPassword() directly.
      isClientBlocked: (ip, user) => !this.vtyAdmissionVerdict('ssh', ip).accept
        || (user !== undefined && this.perUserAdmissionRefusal(user, ip) !== null),
      recordAuthFailure: (user, ip) => this.recordSshLogin(user, ip, '', false),
      recordLogin: (user, ip) => this.recordSshLogin(user, ip, '', true),
    });
    return new SshServerHandler(ctx);
  }

  protected readonly tcpv2: TcpStack;
  public getTcpStack(): TcpStack { return this.tcpv2; }

  /**
   * Open an outbound TCP connection, resolving once the handshake really
   * settles — same contract as `EndHost.tcpConnect`, which a router
   * lacked, so an outbound client running on the CLI (telnet toward
   * another device's VTY) had no way to reach the wire.
   */
  public async tcpConnect(dstIp: string, dstPort: number): Promise<TcpSocket | null> {
    const destination = parseDialAddress(dstIp);
    const port = PortNumber.isValid(dstPort) ? PortNumber.of(dstPort) : null;
    if (!destination || !port) return null;
    const outcome = await this.tcpDial(destination, port);
    return isDialFailure(outcome) ? null : outcome;
  }

  public tcpDial(
    destination: DialAddress, port: PortNumber,
  ): Promise<TcpSocket | TcpDialFailure> {
    return dialTcp(this.tcpv2, destination, port);
  }

  private createPorts(): void {
    const portCount = routerPortCountOverride() ?? this.physicalPortCount();
    const adminDown = this.bootsInterfacesShutdown() && interfacesBootShutdown();
    for (let i = 0; i < portCount; i++) {
      const portName = this.getVendorPortName(i);
      this.addPort(new Port(portName, 'ethernet', undefined, { adminDown }));
    }
  }

  protected bootsInterfacesShutdown(): boolean {
    return false;
  }

  protected physicalPortCount(): number {
    return 4;
  }

  /** Register link-change handlers on all ports to trigger OSPF convergence and DPD */
  /**
   * True when a routing-table entry's egress interface can actually carry
   * traffic. Virtual interfaces (Tunnel, Loopback) need no cable; a
   * physical one needs full operational state (line, admin, and carrier
   * all up — `Port.isOperationallyUp()`), so a route over a severed link
   * OR an administratively shut interface is neither used for forwarding
   * nor shown by `show ip route`, exactly as IOS drops it when the line
   * protocol goes down (docs/PRD-Link-State.md §2.1 P7, §3.1).
   */
  isRouteInterfaceUsable(iface: string): boolean {
    if (iface === '') return false;
    const port = this.ports.get(iface)
      ?? this.ports.get(iface.includes('.') ? iface.slice(0, iface.indexOf('.')) : iface);
    if (!port) return true;
    return iosInterfaceUsable(port, iface, this.ports);
  }

  /**
   * `ip route ... track <N>` resolver — injected by the CLI shell layer,
   * which owns the real `TrackRepository`/`IpSlaRepository` state (same
   * pattern as `ACLEngine.setTimeRangeResolver` above: Router doesn't own
   * this config, just consults it). Wired fresh on every command
   * (`CiscoIOSShell.execute`), since the shell instance — not a fixed
   * router reference — is what's stable across a device's lifetime.
   */
  private routeTrackResolver: ((trackId: string) => boolean) | null = null;
  setRouteTrackResolver(fn: ((trackId: string) => boolean) | null): void { this.routeTrackResolver = fn; }
  /** Whether a `track <id>`-conditioned route is currently usable — true when the route has no track condition, or no resolver is wired yet (no track/IP-SLA config exists). */
  isRouteTrackUp(trackId: string | undefined): boolean {
    if (!trackId) return true;
    if (!this.routeTrackResolver) return true;
    return this.routeTrackResolver(trackId);
  }

  /**
   * Une route est-elle installable dans la table ?
   *
   * C'est LA question que posent le plan de données (`lookupRoute`) et
   * chaque vue de table des deux constructeurs. Elle vivait en trois
   * morceaux recopiés (`isRouteInterfaceUsable(r.iface) &&
   * isRouteTrackUp(r.track)`), et les vues VRP n'en appelaient aucun —
   * si bien qu'une route statique survivait à un `shutdown` sur Huawei
   * alors qu'elle disparaissait sur Cisco, pour la même topologie.
   *
   * `permanent` (IOS `ip route ... permanent`, VRP `ip route-static ...
   * permanent`) est exactement l'exception que ce mot-clé existe pour
   * créer : la route RESTE quand son interface de sortie tombe. Elle
   * était mémorisée sur `RouteEntry` et lue par personne.
   *
   * Ce que `permanent` ne fait PAS, et c'est volontaire : il ne rend pas
   * le trafic acheminable. La route reste dans la table, les paquets
   * partent vers une interface éteinte et se perdent — c'est le trou
   * noir que ce mot-clé provoque sur un vrai routeur, et la raison pour
   * laquelle on s'en méfie. Il ne court-circuite pas non plus `track` :
   * un objet suivi qui tombe est une condition explicite posée par
   * l'opérateur, pas une panne d'interface.
   */
  isRouteUsable(route: {
    iface: string; track?: string; permanent?: boolean; nextHop?: IPAddress | null;
  }): boolean {
    if (!this.isRouteTrackUp(route.track)) return false;
    if (route.permanent) return true;
    if (route.iface !== '') return this.isRouteInterfaceUsable(route.iface);
    return this.resolveRecursiveNextHop(route.nextHop ?? null) !== null;
  }

  resolveRecursiveNextHop(
    nextHop: IPAddress | null, depth = 0,
  ): { iface: string; nextHop: IPAddress } | null {
    if (!nextHop || depth > RECURSION_MAX) return null;

    const direct = this.findInterfaceForIP(nextHop);
    if (direct) {
      const name = direct.getName();
      return this.isRouteInterfaceUsable(name) ? { iface: name, nextHop } : null;
    }

    const covering = this.routeCovering(nextHop);
    if (!covering) return null;
    if (covering.iface !== '' && covering.nextHop) {
      return this.isRouteInterfaceUsable(covering.iface)
        ? { iface: covering.iface, nextHop: covering.nextHop }
        : null;
    }
    return this.resolveRecursiveNextHop(covering.nextHop ?? null, depth + 1);
  }

  private routeCovering(address: IPAddress): RouteEntry | null {
    let best: RouteEntry | null = null;
    for (const route of this.routingTable) {
      if (!route.nextHop && route.iface === '') continue;
      if (route.mask.toCIDR() === 0) continue;
      if (!route.network.isInSameSubnet(address, route.mask)) continue;
      if (!best || route.mask.toCIDR() > best.mask.toCIDR()) best = route;
    }
    return best;
  }

  installedRoutes(): RouteEntry[] {
    const best = new Map<string, RouteEntry[]>();
    for (const route of this.routingTable) {
      if (!this.isRouteUsable(route)) continue;
      const key = `${route.network}/${route.mask.toCIDR()}`;
      const tied = best.get(key);
      if (!tied) { best.set(key, [route]); continue; }
      const ad = route.ad ?? 1;
      const bestAd = tied[0].ad ?? 1;
      if (ad < bestAd) best.set(key, [route]);
      else if (ad === bestAd) tied.push(route);
    }
    return [...best.values()].flat();
  }

  private readonly dhcpClientAgent: RouterDhcpClient;

  getDhcpClientAgent(): RouterDhcpClient { return this.dhcpClientAgent; }

  private sendDhcpClientFrame(iface: string, pkt: DHCPPacket): void {
    const port = this.ports.get(iface);
    if (!port) return;
    const ipPkt = buildUdpOverIpv4(new IPAddress('0.0.0.0'), {
      destination: new IPAddress('255.255.255.255'),
      destinationPort: DHCP_SERVER_PORT, sourcePort: DHCP_CLIENT_PORT,
      payload: pkt, payloadBytes: 300,
    });
    this.sendFrame(iface, {
      srcMAC: port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
  }

  private _setupPortMonitoring(): void {
    for (const [name, port] of this.ports) {
      port.onLinkChange((state) => {
        this.syncRouteDebug();
        this.emitLinkTrap(name, port, state === 'up');
        if (state === 'up') this.dhcpClientAgent.onLinkUp(name);
        else this.dhcpClientAgent.onLinkDown(name);
        if (state === 'up') {
          this.ospfIntegration.onPortUp(name);
          this._ospfAutoConverge();
          // The cable often arrives AFTER the address is configured, so
          // the advertisement from `configureInterface` went nowhere.
          this.ipv6Engine.advertiseOnInterface(name);
        } else {
          this.ipsecEngine?.onPortDown(name);
          this.ospfIntegration.onPortDown(name);
          this._ospfAutoConverge();
          // EIGRP declares the neighbours on a dead interface down at
          // once, without waiting out their hold time — IOS logs it as
          // '%DUAL-5-NBRCHANGE … is down: interface down'.
          this.dynamicRouting?.onInterfaceDown(name);
          this.ripOnInterfaceDown(name);
        }
        if (this.dynamicRouting?.hasActive()) this.convergeDynamicRouting();
      });
    }
  }

  // ─── Reactive (Phase 5.8) ─────────────────────────────────────

  /** Inject (or replace) the scheduler used by routerTimers and waitForEvent. */
  setScheduler(scheduler: IScheduler | null): void {
    this.routerScheduler = scheduler;
  }

  /** Return the active scheduler — injected one, or the singleton default. */
  protected getRouterScheduler(): IScheduler {
    return this.routerScheduler ?? getDefaultScheduler();
  }

  /** Identity payload for host.* events emitted by this router. */
  protected routerRef(): { deviceId: string; hostname?: string } {
    return { deviceId: this.id, hostname: this.name };
  }

  protected emitArpLearned(payload: {
    ip: string; mac: string; iface: string; source: 'reply' | 'gratuitous' | 'request' | 'static';
  }): void {
    this.getBus().publish({
      topic: 'host.arp.entry-learned',
      payload: { ...this.routerRef(), ...payload },
    });
  }

  protected emitArpRequestSent(iface: string, targetIp: string): void {
    this.getBus().publish({
      topic: 'host.arp.request-sent',
      payload: { ...this.routerRef(), iface, targetIp },
    });
  }

  protected emitIcmpEchoSent(payload: {
    fromIp: string; toIp: string; id: number; seq: number; ttl: number; size: number;
  }): void {
    this.getBus().publish({
      topic: 'host.icmp.echo-sent',
      payload: { ...this.routerRef(), ...payload },
    });
  }

  protected emitIcmpEchoReply(payload: {
    fromIp: string; toIp: string; id: number; seq: number; ttl: number; rttMs: number;
  }): void {
    this.getBus().publish({
      topic: 'host.icmp.echo-reply',
      payload: { ...this.routerRef(), ...payload },
    });
  }

  protected emitIcmpEchoTimeout(payload: { toIp: string; id: number; seq: number }): void {
    this.getBus().publish({
      topic: 'host.icmp.echo-timeout',
      payload: { ...this.routerRef(), ...payload },
    });
  }

  protected emitIcmpEchoFailed(payload: {
    fromIp: string; toIp: string; id: number; seq: number; reason: string;
  }): void {
    this.getBus().publish({
      topic: 'host.icmp.echo-failed',
      payload: { ...this.routerRef(), ...payload },
    });
  }

  /**
   * Create a virtual port (loopback, tunnel, subinterface, etc.).
   * Returns true if created successfully.
   * @internal Used by CLI shells
   */
  private findSubinterfaceForVlan(parentName: string, vid: number): string | null {
    const prefix = `${parentName}.`;
    for (const [name, port] of this.ports) {
      if (!name.startsWith(prefix)) continue;
      const vlan = (port as unknown as { encapsulation?: { vlan?: number } }).encapsulation?.vlan;
      if (vlan === vid) return name;
    }
    return null;
  }

  override sendFrame(portName: string, frame: EthernetFrame): boolean {
    const dotIdx = portName.indexOf('.');
    if (dotIdx > 0) {
      const parent = portName.slice(0, dotIdx);
      const subif = this.ports.get(portName);
      const vlan = (subif as unknown as { encapsulation?: { vlan?: number } } | undefined)?.encapsulation?.vlan;
      if (vlan !== undefined && this.ports.has(parent)) {
        const tagged: TaggedEthernetFrame = { ...frame, dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: vlan } };
        return super.sendFrame(parent, tagged);
      }
    }
    return super.sendFrame(portName, frame);
  }

  _createVirtualInterface(name: string): boolean {
    if (this.ports.has(name)) return true; // already exists
    const port = new Port(name, 'ethernet');
    port.setUp(true); // virtual interfaces are always up
    // Une loopback n'a pas de lien dont déduire sa bande passante : IOS
    // lui donne les siennes, et ce sont celles-là que `show interfaces`
    // affiche. Les poser sur le port plutôt que dans le rendu laisse
    // `bandwidth`/`delay`/`mtu` continuer de les surcharger par la voie
    // normale — un défaut n'est pas une constante d'affichage.
    if (/^Loopback/i.test(name)) {
      port.setMTU(LOOPBACK_MTU);
      port.setBandwidthKbps(LOOPBACK_BW_KBPS);
      port.setDelayUs(LOOPBACK_DELAY_US);
    }
    const dot = name.indexOf('.');
    if (dot > 0) {
      const parent = this.ports.get(name.slice(0, dot));
      if (parent) port.setMAC(parent.getMAC());
    }
    this.addPort(port);
    // Register OSPF monitor
    port.onLinkChange((state) => {
      if (state === 'up') this._ospfAutoConverge();
    });
    return true;
  }

  /**
   * `no interface Tunnel0`. Only virtual interfaces can be removed — a
   * physical port is soldered on, and IOS refuses just as flatly.
   *
   * Removing the port is not enough: anything still pointing at it would
   * be left holding a name that resolves to nothing. Static routes via
   * the interface go, and so does a `debug` scoped to it — an operator
   * who deletes the interface they were watching should not be left with
   * a flag aimed at a ghost.
   */
  _removeVirtualInterface(name: string): boolean {
    const port = this.ports.get(name);
    if (!port) return false;
    if (!/^(Loopback|Tunnel|Vlan|Port-channel|Nve|Virtual-Template|Serial)/i.test(name)) return false;

    const cable = port.getCable?.();
    if (cable) cable.disconnect();
    this.ports.delete(name);
    this.routingTable = this.routingTable.filter((r) => r.iface !== name);

    const debug = this._debugService;
    if (debug) {
      for (const flag of debug.list()) {
        if (flag.scope && flag.scope.toLowerCase() === name.toLowerCase()) debug.disable(flag.category);
      }
    }
    return true;
  }

  /** Vendor-specific interface naming convention */
  protected abstract getVendorPortName(index: number): string;

  /** Create the vendor-specific CLI shell */
  protected abstract createShell(): IRouterShell;

  getShell(): IRouterShell { return this.shell; }
  getOspfIntegration(): RouterOSPFIntegration { return this.ospfIntegration; }

  /**
   * `exec-timeout` of the VTY line, in milliseconds. Real IOS hangs an
   * idle EXEC session up on the line's own timer; `exec-timeout 0 0`
   * (both fields zero) disables it, as does an unconfigured line here.
   */
  private resolveVtyIdleTimeoutMs(): number | null {
    const block = this.blocVtyCourant();
    if (!block) return null;
    const { execTimeoutMinutes: min, execTimeoutSeconds: sec } = block;
    if (min == null && sec == null) return null;
    const ms = ((min ?? 0) * 60 + (sec ?? 0)) * 1000;
    return ms > 0 ? ms : null;
  }

  /**
   * The EXEC level an incoming VTY session opens at. Real IOS: a
   * `privilege level N` on the line OVERRIDES the authenticated account's
   * own level; with none configured the account's level applies. Without
   * a login name there is nothing to look up, so the line starts at 1.
   */
  /**
   * Le niveau auquel une session s'ouvre sur la CONSOLE.
   *
   * Meme regle que `resolveVtyExecLevel`, et c'est le point : le niveau
   * de la LIGNE remplace celui du compte — vers le haut comme vers le
   * bas — et `loginAs` ne lisait que le compte. La regle vivait donc
   * dans le terminal graphique et nulle part ailleurs, si bien qu'une
   * session SSH, telnet ou scriptee ouvrait au mauvais niveau.
   */
  resolveConsoleExecLevel(user?: string): number {
    const lineLevel = this.getConsoleLinePrivilege();
    if (lineLevel != null) return lineLevel;
    if (user === undefined) return 1;
    return this.getCredentialStore().lookup(user)?.privilege ?? 1;
  }

  resolveVtyExecLevel(user?: string): number {
    const lineLevel = this.blocVtyCourant()?.privilege;
    if (lineLevel != null) return lineLevel;
    if (user === undefined) return 1;
    return this.getCredentialStore().lookup(user)?.privilege ?? 1;
  }

  /**
   * A CLI shell dedicated to one remote session. Real VTY semantics: its
   * own mode context, so `configure terminal` over SSH never drags the
   * console into config mode, while the configuration it edits lives on
   * the device and is therefore shared (docs/PRD-SSH-Unification.md §3.2).
   */
  createVtyShell(user?: string): {
    execute(rawInput: string): string | Promise<string>;
    getPrompt(): string;
    getCompletions(line: string): string[];
    lastEndedSession(): boolean;
    subscribeAsyncOutput(sink: (line: string) => void): () => void;
    dispose(): void;
  } {
    const shell = this.createShell();
    shell.beginExecSession?.(this.resolveVtyExecLevel(user), user);
    // A vendor CLI's exit word unwinds one mode at a time and, at the
    // top level, logs the VTY line out. The shell owns that state, so
    // the logout is detected here — an exit verb that leaves the prompt
    // unchanged means there was no mode left to pop
    // (docs/PRD-SSH-Unification.md §4bis B4).
    const EXIT_VERBS = /^(exit|quit|logout)$/i;
    let ended = false;
    return {
      execute: (rawInput: string) => {
        const before = shell.getPrompt(this);
        const result = shell.execute(this, rawInput);
        const settle = (out: string): string => {
          ended = EXIT_VERBS.test(rawInput.trim()) && shell.getPrompt(this) === before;
          return out;
        };
        return result instanceof Promise ? result.then(settle) : settle(result);
      },
      getPrompt: () => shell.getPrompt(this),
      // The shell's own candidates, so they follow its CLI mode.
      getCompletions: (line: string) => shell.tabCandidates(line, this),
      lastEndedSession: () => ended,
      // The two streams are the device's — one debug registry, one syslog
      // buffer, shared by every line. What is per-session is who agreed to
      // receive them, and that answer is read at delivery time so a
      // `terminal monitor` typed mid-session takes effect at once.
      subscribeAsyncOutput: (sink: (line: string) => void) => {
        const offs: Array<() => void> = [];
        const debugSource = this.getVtyDebugSource();
        if (debugSource) {
          offs.push(debugSource.subscribe((line) => {
            if (shell.receivesAsyncOutput?.().debug) sink(line);
          }));
        }
        const syslogSource = this.getLoggingConfig();
        if (syslogSource) {
          offs.push(syslogSource.subscribeMonitor((line) => {
            if (shell.receivesAsyncOutput?.().syslog) sink(line);
          }));
        }
        shell.setAsyncOutputLive?.(true);
        return () => {
          shell.setAsyncOutputLive?.(false);
          for (const off of offs) off();
        };
      },
      // The line is gone; the shell it was minted for must not keep a
      // hand on the device's debug registry.
      dispose: () => shell.releaseDebugSource?.(),
    };
  }

  /**
   * The debug registry a VTY session reads from. Cisco's is the one
   * `Router` owns; Huawei keeps a VRP-flavoured registry of its own and
   * overrides this.
   */
  protected getVtyDebugSource(): { subscribe(listener: (line: string) => void): () => void } | null {
    return this.getDebugService();
  }

  /** Get the vendor-specific boot sequence */
  abstract getBootSequence(): string;

  // ─── Interface IP Configuration ──────────────────────────────

  /**
   * Configure an IP on an interface. Automatically adds a connected route.
   */
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask, secondary = false): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    if (secondary) {
      port.addSecondaryIP(ip, mask);
    } else {
      port.configureIP(ip, mask);
      // Remove old primary connected route for this interface, keeping
      // routes belonging to secondary subnets still configured.
      const secondaryNets = port.getSecondaryIPs().map((e) =>
        e.ip.getOctets().map((o, i) => o & e.mask.getOctets()[i]).join('.'));
      this.routingTable = this.routingTable.filter(
        r => !(r.type === 'connected' && r.iface === ifName
          && !secondaryNets.includes(String(r.network)))
      );
    }

    // Add connected route
    const networkOctets = ip.getOctets().map((o, i) => o & mask.getOctets()[i]);
    this.routingTable.push({
      network: new IPAddress(networkOctets),
      mask,
      nextHop: null,
      iface: ifName,
      type: 'connected',
      ad: 0,
      metric: 0,
      installedAt: Date.now(),
    });

    Logger.info(this.id, 'router:interface-config',
      `${this.name}: ${ifName} configured ${ip}/${mask.toCIDR()}`);

    // Gratuitous ARP (RFC 5227): announce the address so neighbours
    // refresh stale cache entries — real IOS does this on `ip address`.
    // A dot1q subinterface is never cabled itself: its reachability is the
    // parent's (the frame is tagged and sent through the parent by sendFrame).
    const dotIdx = ifName.indexOf('.');
    const wirePort = dotIdx > 0 ? this.ports.get(ifName.slice(0, dotIdx)) ?? port : port;
    if (wirePort.isConnected() && wirePort.getIsUp() && this.subinterfaceAllowsArpBroadcast(ifName)) {
      this.sendFrame(ifName, {
        srcMAC: port.getMAC(),
        dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP,
        payload: {
          type: 'arp', operation: 'request',
          senderMAC: port.getMAC(), senderIP: ip,
          targetMAC: MACAddress.broadcast(), targetIP: ip,
        },
      });
    }

    // Trigger OSPF convergence if OSPF is enabled (needed for Loopback, etc.)
    if (this.ospfIntegration.isOSPFEnabled()) {
      this._ospfAutoConverge();
    }
    return true;
  }

  unconfigureInterface(ifName: string): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.clearIP();

    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName)
    );

    Logger.info(this.id, 'router:interface-config',
      `${this.name}: ${ifName} IP address removed`);

    if (this.ospfIntegration.isOSPFEnabled()) {
      this._ospfAutoConverge();
    }
    return true;
  }

  removeSecondaryAddress(ifName: string, ip: IPAddress, mask: SubnetMask): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;
    port.removeSecondaryIP(ip);
    const net = ip.getOctets().map((o, i) => o & mask.getOctets()[i]).join('.');
    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName && String(r.network) === net)
    );
    if (this.ospfIntegration.isOSPFEnabled()) this._ospfAutoConverge();
    return true;
  }

  // ─── IPv6 Interface Configuration — delegated to IPv6DataPlane ──

  enableIPv6Routing(): void {
    this.ipv6Engine.enableRouting();
    Logger.info(this.id, 'router:ipv6-enabled', `${this.name}: IPv6 unicast routing enabled`);
  }

  disableIPv6Routing(): void {
    this.ipv6Engine.disableRouting();
    Logger.info(this.id, 'router:ipv6-disabled', `${this.name}: IPv6 unicast routing disabled`);
  }

  isIPv6RoutingEnabled(): boolean { return this.ipv6Engine.isRoutingEnabled(); }

  configureIPv6Interface(ifName: string, address: IPv6Address, prefixLength: number): boolean {
    return this.ipv6Engine.configureInterface(ifName, address, prefixLength);
  }

  // ─── Routing Table Management (Control Plane — RIB) ──────────

  getRoutingTable(): RouteEntry[] {
    return [...this.routingTable];
  }

  addStaticRoute(
    network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number = 0,
    opts?: Partial<Pick<RouteEntry, 'preference' | 'tag' | 'description' | 'track' | 'vpnInstance' | 'permanent' | 'iface'>>,
  ): boolean {
    if (this._routingTableLimit && this.routingTable.length >= this._routingTableLimit.max) {
      Logger.warn(this.id, 'router:routing-table-limit',
        `${this.name}: routing-table limit ${this._routingTableLimit.max} reached, refusing static route to ${network}`);
      return false;
    }
    const iface = this.findInterfaceForIP(nextHop);
    const ifaceName = opts?.iface ?? (iface ? iface.getName() : '');

    const entry: RouteEntry = {
      network, mask, nextHop,
      iface: ifaceName,
      type: 'static',
      ad: opts?.preference ?? 1,
      metric,
      installedAt: Date.now(),
      preference: opts?.preference,
      tag: opts?.tag,
      description: opts?.description,
      track: opts?.track,
      vpnInstance: opts?.vpnInstance,
      permanent: opts?.permanent,
      ifaceConfigured: opts?.iface !== undefined ? true : undefined,
    };

    const same = this.routingTable.findIndex((r) => r.type === 'static'
      && r.network.toString() === network.toString()
      && r.mask.toString() === mask.toString()
      && r.nextHop?.toString() === nextHop.toString()
      && r.iface === ifaceName);
    if (same >= 0) this.routingTable[same] = entry;
    else this.routingTable.push(entry);

    Logger.info(this.id, 'router:route-add',
      `${this.name}: static route ${network}/${mask.toCIDR()} via ${nextHop} metric ${metric}`);
    return true;
  }

  addSummaryDiscardRoute(network: IPAddress, mask: SubnetMask): boolean {
    const deja = this.routingTable.some((r) => r.iface === 'Null0'
      && r.network.toString() === network.toString()
      && r.mask.toString() === mask.toString());
    if (deja) return false;
    this.routingTable.push({
      network, mask, nextHop: null, iface: 'Null0',
      type: 'static', ad: 5, metric: 0, installedAt: Date.now(),
    });
    return true;
  }

  removeSummaryDiscardRoute(network: IPAddress, mask: SubnetMask): boolean {
    const avant = this.routingTable.length;
    this.routingTable = this.routingTable.filter((r) => !(r.iface === 'Null0'
      && r.ad === 5
      && r.network.toString() === network.toString()
      && r.mask.toString() === mask.toString()));
    return this.routingTable.length < avant;
  }

  removeStaticRoute(network: IPAddress, mask: SubnetMask, nextHop?: IPAddress): boolean {
    const networkStr = network.toString();
    const maskStr = mask.toString();
    const nextHopStr = nextHop?.toString();
    const before = this.routingTable.length;
    this.routingTable = this.routingTable.filter(r => {
      if (r.type !== 'static') return true;
      if (r.network.toString() !== networkStr) return true;
      if (r.mask.toString() !== maskStr) return true;
      if (nextHopStr && r.nextHop?.toString() !== nextHopStr) return true;
      return false;
    });
    return this.routingTable.length < before;
  }

  removeDefaultRoute(nextHop?: IPAddress): boolean {
    const before = this.routingTable.length;
    this.routingTable = this.routingTable.filter(r =>
      r.type !== 'default' || (nextHop !== undefined && String(r.nextHop) !== String(nextHop)));
    return this.routingTable.length < before;
  }

  /**
   * `ip route 0.0.0.0 0.0.0.0 <next-hop> [track <n>] [permanent]`.
   *
   * `track` et `permanent` étaient acceptés par l'analyseur et perdus ici :
   * la route par défaut passe par ce chemin plutôt que par
   * `addStaticRoute`, et cette signature ne les portait pas. La route
   * flottante par défaut — la forme la plus courante de tout le suivi
   * d'objets — était donc inconditionnelle, quel que soit l'objet suivi.
   */
  setDefaultRoute(
    nextHop: IPAddress, metric: number = 0,
    opts?: Partial<Pick<RouteEntry, 'preference' | 'tag' | 'description' | 'iface' | 'track' | 'permanent'>>,
  ): boolean {
    this.routingTable = this.routingTable.filter(r =>
      r.type !== 'default' || String(r.nextHop) !== String(nextHop));
    const iface = this.findInterfaceForIP(nextHop);
    const ifaceName = opts?.iface ?? (iface ? iface.getName() : '');

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop,
      iface: ifaceName,
      type: 'default',
      ad: opts?.preference ?? 1,
      metric,
      installedAt: Date.now(),
      preference: opts?.preference,
      tag: opts?.tag,
      description: opts?.description,
      track: opts?.track,
      permanent: opts?.permanent,
    });
    return true;
  }

  /**
   * Longest Prefix Match (LPM) — tiebreaking: prefix → AD → metric.
   *
   * Pure data plane: it reads the RIB and nothing else. Forwarding a
   * packet never runs protocol code, exactly as on real hardware, where
   * the linecard consults a FIB that the control plane downloaded to it.
   * This used to re-converge the dynamic routing engines first, which
   * made every forwarding decision a convergence — and a convergence
   * emits packets, so a packet could beget a convergence that begat more
   * packets. Keeping the RIB current is the control plane's job, and it
   * does it on the events that actually change routing: configuration,
   * interface up/down, and protocol packets arriving from the wire.
   */
  private lookupRoute(destIP: IPAddress): RouteEntry | null {
    // ECMP: collect every route genuinely tied for best (same prefix
    // length, AD, and metric) instead of freezing on whichever happened
    // to be inserted first, so equal-cost paths actually get used.
    let candidates: RouteEntry[] = [];
    let bestPrefix = -1;
    let bestAd = Infinity;
    let bestMetric = Infinity;
    const destInt = destIP.toUint32();

    for (const route of this.routingTable) {
      if (!this.isRouteInterfaceUsable(route.iface)) {
        // Interface went down — clear any IPSec SAs using this interface
        // (mirrors IOS: "line protocol down" triggers SA teardown)
        // Le démontage porte sur l'INTERFACE, pas sur la route : il a
        // donc lieu même pour une route `permanent`, qui elle survit.
        if (this.ipsecEngine) {
          this.ipsecEngine.clearSAsForInterface(route.iface);
        }
      }
      if (!this.isRouteUsable(route)) continue;

      const netInt = route.network.toUint32();
      const maskInt = route.mask.toUint32();
      const prefix = route.mask.toCIDR();

      if ((destInt & maskInt) !== (netInt & maskInt)) continue;

      if (prefix > bestPrefix
        || (prefix === bestPrefix && route.ad < bestAd)
        || (prefix === bestPrefix && route.ad === bestAd && route.metric < bestMetric)) {
        bestPrefix = prefix;
        bestAd = route.ad;
        bestMetric = route.metric;
        candidates = [route];
      } else if (prefix === bestPrefix && route.ad === bestAd && route.metric === bestMetric) {
        candidates.push(route);
      }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return this.forwardable(candidates[0]);
    // Le plafond du protocole s'applique ICI, sur le groupe de chemins à
    // égalité, et non route par route : `maximum-paths` borne un NOMBRE
    // DE CHEMINS vers une destination, pas la validité d'une route.
    const plafond = this.maximumPathsFor(candidates[0].type);
    const retenus = candidates.length > plafond ? candidates.slice(0, plafond) : candidates;
    if (retenus.length === 1) return this.forwardable(retenus[0]);
    return this.forwardable(retenus[this.ecmpCursor++ % retenus.length]);
  }

  private forwardable(route: RouteEntry): RouteEntry {
    if (route.iface !== '') return route;
    const resolved = this.resolveRecursiveNextHop(route.nextHop ?? null);
    if (!resolved) return route;
    return { ...route, iface: resolved.iface, nextHop: resolved.nextHop };
  }

  private findInterfaceForIP(targetIP: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(targetIP, mask)) return port;
      for (const e of port.getSecondaryIPs()) {
        if (e.ip.isInSameSubnet(targetIP, e.mask)) return port;
      }
    }
    return null;
  }

  private peerOnSameSubnet(portName: string, peerIP: IPAddress): boolean {
    const port = this.ports.get(portName);
    if (!port) return false;
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    if (ip && mask && ip.isInSameSubnet(peerIP, mask)) return true;
    return port.getSecondaryIPs().some((e) => e.ip.isInSameSubnet(peerIP, e.mask));
  }

  // ─── IPv6 Routing Table Management — delegated to IPv6DataPlane ─

  getIPv6RoutingTable() { return this.ipv6Engine.getRoutingTable(); }

  addIPv6StaticRoute(
    prefix: IPv6Address, prefixLength: number, nextHop: IPv6Address, metric: number = 0,
    opts?: { iface?: string; preference?: number },
  ): boolean {
    const ifaceName = opts?.iface ?? this._findInterfaceForIPv6(nextHop)?.getName() ?? '';
    this.ipv6Engine.addStaticRoute(prefix.getNetworkPrefix(prefixLength), prefixLength, nextHop, ifaceName, metric);
    const table = this.ipv6Engine.getRoutingTableInternal();
    const entry = table[table.length - 1];
    if (entry && opts?.preference !== undefined) entry.preference = opts.preference;
    Logger.info(this.id, 'router:ipv6-route-add',
      `${this.name}: static route ${prefix}/${prefixLength} via ${nextHop} metric ${metric}`);
    return true;
  }

  setIPv6DefaultRoute(
    nextHop: IPv6Address, metric: number = 0,
    opts?: { iface?: string; preference?: number },
  ): boolean {
    const ifaceName = opts?.iface ?? this._findInterfaceForIPv6(nextHop)?.getName() ?? '';
    this.ipv6Engine.setDefaultRoute(nextHop, ifaceName, metric);
    const table = this.ipv6Engine.getRoutingTableInternal();
    const entry = table[table.length - 1];
    if (entry && opts?.preference !== undefined) entry.preference = opts.preference;
    return true;
  }

  private _findInterfaceForIPv6(targetIP: IPv6Address): Port | null {
    for (const [, port] of this.ports) {
      if (!port.isIPv6Enabled()) continue;
      for (const entry of port.getIPv6Addresses()) {
        if (entry.address.isInSameSubnet(targetIP, entry.prefixLength)) {
          return port;
        }
      }
    }
    return null;
  }

  getNeighborCache() { return this.ipv6Engine.getNeighborCache(); }

  /**
   * `ipv6 traffic-filter` on an interface. The base router has no IPv6
   * access lists at all, so it filters nothing; a platform that has them
   * says where the binding lives by overriding `getIpv6TrafficFilter`,
   * which keeps ONE store — the one the running-config renders.
   */
  protected getIpv6TrafficFilter(_iface: string): { name: string; direction: 'in' | 'out' } | null {
    return null;
  }

  private ipv6FilterPermits(iface: string, direction: 'in' | 'out', pkt: IPv6Packet): boolean {
    const binding = this.getIpv6TrafficFilter(iface);
    if (!binding || binding.direction !== direction) return true;
    const acl = this.ipv6AccessLists.find((a) => a.name === binding.name);
    return evaluateIpv6Acl(acl, pkt) === 'permit';
  }

  /** What the IPv6 data plane has actually counted. */
  getIpv6Counters() { return this.ipv6Engine.getIpv6Counters(); }
  _clearIpv6Counters(): void { this.ipv6Engine.clearIpv6Counters(); }

  /**
   * One ICMPv6 Echo Request for IP SLA / NQA. It goes through the very
   * `resolveEgress`/`sendEchoRequest` pair `ping ipv6` uses, so a probe
   * and a ping cannot disagree about whether a target is reachable.
   */
  private sendIpSlaIcmpv6Echo(r: {
    destination: string; identifier: number; sequence: number;
    dataSize: number; sourceInterface: string | null; sourceIp: string | null;
  }): { sourceIp: string } | null {
    let source = r.sourceIp ?? undefined;
    if (!source && r.sourceInterface) {
      const port = this.ports.get(r.sourceInterface);
      const addr = port?.getGlobalIPv6() ?? port?.getLinkLocalIPv6();
      if (!addr) return null;
      source = addr.toString();
    }
    const target = new IPv6Address(r.destination);
    const egress = this.ipv6Engine.resolveEgress(target, source);
    if (!egress) return null;
    this.ipv6Engine.sendEchoRequest(
      egress, target, r.identifier, r.sequence, Math.max(0, r.dataSize));
    return { sourceIp: egress.sourceIP.toString() };
  }

  /** The clock an entry's `timestamp` is expressed in. */
  getNeighborCacheNow(): number { return this.ipv6Engine.neighborCacheNow(); }

  /** `clear ipv6 neighbors` / `reset ipv6 neighbors` — a command that
   *  promises to reset something has to reset it. */
  _clearNeighborCache(): void { this.ipv6Engine.clearNeighborCache(); }

  // ─── Performance Counters ─────────────────────────────────────

  getCounters(): RouterCounters {
    return { ...this.counters };
  }

  resetCounters(): void {
    for (const key of Object.keys(this.counters) as (keyof RouterCounters)[]) {
      this.counters[key] = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RIPv2 Engine — delegated to RouterRIPEngine
  // ═══════════════════════════════════════════════════════════════

  enableRIP(config?: Partial<import('./router/RouterRIPEngine').RIPConfig>) { this.ripEngine.enable(config); }
  disableRIP() { this.ripEngine.disable(); }
  isRIPEnabled() { return this.ripEngine.isEnabled(); }
  getRIPConfig() { return this.ripEngine.getConfig(); }
  getRIPRoutes() { return this.ripEngine.getRoutes(); }
  getRIPUpdateSources() { return this.ripEngine.getUpdateSources(); }
  ripOnInterfaceDown(iface: string) { this.ripEngine.onInterfaceDown(iface, this.getPort(iface)); }
  ripAdvertiseNetwork(network: IPAddress, mask: SubnetMask) { this.ripEngine.advertiseNetwork(network, mask); }
  ripWithdrawNetwork(network: IPAddress) { this.ripEngine.withdrawNetwork(network); }
  ripConfigure(config: Partial<import('./router/RouterRIPEngine').RIPConfig>) { this.ripEngine.configure(config); }
  ripSetPassiveInterface(iface: string) { this.ripEngine.setPassiveInterface(iface); }
  ripRemovePassiveInterface(iface: string) { this.ripEngine.removePassiveInterface(iface); }
  ripSetInterfaceSplitHorizon(iface: string, on: boolean | null) { this.ripEngine.setInterfaceSplitHorizon(iface, on); }
  ripSplitHorizonOn(iface: string) { return this.ripEngine.splitHorizonOn(iface); }
  ripSendVersionOn(iface: string): string | null {
    return this.getPort(iface)?.getRipSendVersion() ?? null;
  }
  ripReceiveVersionOn(iface: string): string | null {
    return this.getPort(iface)?.getRipReceiveVersion() ?? null;
  }
  ripAuthKeyChainOn(iface: string): string | null {
    return this.getPort(iface)?.getRipAuthKeyChain() ?? null;
  }

  ripAuthOn(iface: string): { mode: 'md5' | 'text'; keyId: number; key: string } | null {
    const port = this.getPort(iface);
    const chainName = port?.getRipAuthKeyChain();
    if (!chainName) return null;
    const chains = (this as unknown as {
      shell?: { getKeyChains?: () => import('./inspection/config/KeyChainRepository').KeyChainRepository };
    }).shell?.getKeyChains?.();
    const mode = port?.getRipAuthMode() === 'text' ? 'text' : 'md5';
    const chain = chains?.getChain(chainName);
    for (const [id, key] of [...(chain?.keys ?? [])].sort((a, b) => a[0] - b[0])) {
      if (key.keyString) return { mode, keyId: id, key: key.keyString };
    }
    return { mode, keyId: 0, key: '' };
  }
  ripSetRedistribution(source: import('./router/RouterRIPEngine').RIPRedistSourceArg, metric?: number, routePolicy?: string) { this.ripEngine.setRedistribution(source, metric, routePolicy); }
  ripRemoveRedistribution(source: import('./router/RouterRIPEngine').RIPRedistSourceArg) { this.ripEngine.removeRedistribution(source); }
  ripSetDefaultMetric(metric: number | null) { this.ripEngine.setDefaultMetric(metric); }
  ripSetDefaultInformationOriginate(on: boolean) { this.ripEngine.setDefaultInformationOriginate(on); }

  /**
   * Avance l'horloge de la simulation de `seconds`, pour observer une
   * mise à jour périodique, l'expiration d'une route ou un ramassage
   * sans attendre le temps réel. L'horloge est PARTAGÉE — le temps passe
   * pour tout le monde — mais aucun équipement ne touche l'état d'un
   * autre : ce que les voisins en apprennent leur vient des paquets que
   * ce routeur met sur le fil.
   */
  async processTimers(seconds: number): Promise<void> {
    const ms = Math.max(0, seconds) * 1000;
    this.convergeDynamicRouting();
    Router.simulationClock().advance(ms);
    this.advanceProtocolTimers(ms);
    this.convergeDynamicRouting();
  }

  advanceProtocolTimers(ms: number): void {
    this.ripEngine.advanceTime(ms);
  }

  private static simulationClock(): VirtualTimeScheduler {
    const current = getDefaultScheduler();
    if (current instanceof VirtualTimeScheduler) return current;
    const fresh = new VirtualTimeScheduler();
    __setDefaultScheduler(fresh);
    return fresh;
  }

  /** Real dynamic-routing engines (EIGRP/BGP) + topology adapter. */
  getDynamicRouting() { return this.dynamicRouting; }
  getEIGRPEngine() { return this.dynamicRouting.eigrp; }
  getBGPEngine() { return this.dynamicRouting.bgp; }
  /** Recompute EIGRP/BGP adjacencies+routes from real topology. */
  convergeDynamicRouting() { this.dynamicRouting.converge(); }

  /**
   * A powered-off router stops talking. EIGRP's Hello timer would
   * otherwise keep multicasting from a chassis with no power — and, in a
   * long-lived process, keep doing so forever, since nothing else ever
   * releases it.
   */
  override powerOff(): void {
    this.dynamicRouting?.shutdownTimers();
    this._sshSessionRegistry?.closeWhere(() => true, 'power-off');
    super.powerOff();
  }

  // ─── FHRP data plane (HSRP/VRRP/GLBP) ─────────────────────────
  //
  // Vendor subclasses override to expose their agents; the base router
  // then accepts frames sent to owned virtual MACs, answers ARP for
  // VIPs, and treats owned VIPs as local addresses.

  protected fhrpDataPlanes(): FhrpDataPlane[] { return []; }

  private fhrpVipArpOwner(iface: string, targetIp: string, requesterIp: string): string | null {
    for (const agent of this.fhrpDataPlanes()) {
      const mac = agent.vipArpOwner(iface, targetIp, requesterIp);
      if (mac) return mac;
    }
    return null;
  }

  private fhrpOwnsVirtualMac(iface: string, dstMac: string): boolean {
    return this.fhrpDataPlanes().some(a => a.ownsVirtualMac(iface, dstMac));
  }

  private fhrpOwnsVip(iface: string, ip: string): boolean {
    return this.fhrpDataPlanes().some(a => a.ownsVip(iface, ip));
  }

  /**
   * Answer an ARP request for an owned VIP with the virtual MAC
   * (RFC 2281 §5.3, RFC 5798 §8.1.2). The reply is sourced from the
   * virtual MAC so switches learn the virtual path. Single lookup —
   * GLBP's load-balancing cursor advances once per request.
   */
  private answerFhrpVipArp(portName: string, arp: ARPPacket): boolean {
    const mac = this.fhrpVipArpOwner(
      portName, arp.targetIP.toString(), arp.senderIP.toString());
    if (!mac) return false;
    const vmac = new MACAddress(mac);
    const reply: ARPPacket = {
      type: 'arp', operation: 'reply',
      senderMAC: vmac, senderIP: arp.targetIP,
      targetMAC: arp.senderMAC, targetIP: arp.senderIP,
    };
    this.sendFrame(portName, {
      srcMAC: vmac, dstMAC: arp.senderMAC,
      etherType: ETHERTYPE_ARP, payload: reply,
    });
    return true;
  }

  /**
   * True unless `subif` is a Huawei `dot1q termination vid` sub-interface
   * with ARP broadcast left disabled (VRP's default). Cisco sub-interfaces
   * (`encapsulation dot1Q`) never set `dot1qVlan`, so they always pass.
   */
  private subinterfaceAllowsArpBroadcast(subif: string): boolean {
    const subPort = this.ports.get(subif) as unknown as
      { dot1qVlan?: number; arpBroadcastEnabled?: boolean } | undefined;
    if (subPort?.dot1qVlan === undefined) return true;
    return !!subPort.arpBroadcastEnabled;
  }

  // ─── Data Plane: Phase A — Frame Handling (L2 → dispatch) ─────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const tag = (frame as TaggedEthernetFrame).dot1q;
    if (tag) {
      const subif = this.findSubinterfaceForVlan(portName, tag.vid);
      if (subif) {
        // Huawei VRP: a `dot1q termination vid` sub-interface drops ARP
        // broadcasts unless `arp broadcast enable` was configured on it —
        // real hardware behaviour distinct from Cisco's `encapsulation
        // dot1Q`, which floods ARP on a sub-interface unconditionally.
        // `dot1qVlan` is only ever set by the Huawei command handler, so it
        // doubles as the marker distinguishing the two.
        if (frame.etherType === ETHERTYPE_ARP && frame.dstMAC.isBroadcast()
          && !this.subinterfaceAllowsArpBroadcast(subif)) {
          return;
        }
        portName = subif;
        frame = {
          srcMAC: frame.srcMAC, dstMAC: frame.dstMAC,
          etherType: frame.etherType, payload: frame.payload,
        };
      }
    }

    const port = this.ports.get(portName);
    if (!port) return;

    const delivery = this.getLinkLayer().deliver(portName, frame);
    if (!delivery) return;

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.counters.ifInOctets += (frame.payload as IPv4Packet)?.totalLength || 0;
      this.processIPv4(portName, frame.payload as IPv4Packet);
    } else if (frame.etherType === ETHERTYPE_IPV6) {
      const ipv6 = frame.payload as IPv6Packet;
      if (this.ipv6Engine.isRoutingEnabled() || ipv6?.destinationIP?.isMulticast?.()) {
        this.ipv6Engine.processPacket(portName, ipv6, frame.srcMAC);
      }
    }
  }

  protected override ownsLocalUnicast(iface: string, destination: MACAddress): boolean {
    return this.fhrpOwnsVirtualMac(iface, destination.toString());
  }

  // ─── Control Plane: ARP Handling ──────────────────────────────

  private ownsNatGlobalAddress(portName: string, target: IPAddress): boolean {
    const engine = this._getNATEngine?.();
    if (!engine) return false;
    if (!engine.getOutsideInterfaces().has(portName)) return false;
    const wanted = target.toString();
    for (const entry of engine.getStaticEntries()) {
      if (entry.globalIP === wanted) return true;
    }
    const n = tryIpToUint32(wanted);
    if (n === null) return false;
    for (const pool of engine.getPools().values()) {
      const start = tryIpToUint32(pool.startIP);
      const end = tryIpToUint32(pool.endIP);
      if (start !== null && end !== null && n >= start && n <= end) return true;
    }
    return false;
  }

  private handleARP(portName: string, arp: ARPPacket): void {
    if (!arp || arp.type !== 'arp') return;
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    if (arp.senderIP.equals(myIP) && !arp.senderMAC.equals(port.getMAC())) {
      this.getLoggingConfig()?.append('warnings', 'ip',
        `Duplicate address ${myIP} on ${portName}, sourced by ${arp.senderMAC.toCiscoString()}`,
        true, 'DUPADDR');
      return;
    }

    // Learn sender (don't overwrite static entries)
    const existing = this.arpTable.get(arp.senderIP.toString());
    if (!existing || existing.type !== 'static') {
      this.arpTable.set(arp.senderIP.toString(), {
        mac: arp.senderMAC, iface: portName, timestamp: Date.now(), type: 'dynamic',
      });
      this.emitArpLearned({
        ip: arp.senderIP.toString(),
        mac: arp.senderMAC.toString(),
        iface: portName,
        source: arp.operation === 'request' ? 'request' : 'reply',
      });
    }

    if (arp.operation === 'request' && port.ownsIPv4(arp.targetIP)) {
      const reply: ARPPacket = {
        type: 'arp', operation: 'reply',
        senderMAC: port.getMAC(), senderIP: arp.targetIP,
        targetMAC: arp.senderMAC, targetIP: arp.senderIP,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP, payload: reply,
      });
    } else if (arp.operation === 'request'
      && !arp.senderIP.equals(arp.targetIP)
      && this.ownsNatGlobalAddress(portName, arp.targetIP)) {
      const reply: ARPPacket = {
        type: 'arp', operation: 'reply',
        senderMAC: port.getMAC(), senderIP: arp.targetIP,
        targetMAC: arp.senderMAC, targetIP: arp.senderIP,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP, payload: reply,
      });
    } else if (arp.operation === 'request'
      && !arp.senderIP.equals(arp.targetIP) // never answer a gratuitous ARP
      && this.answerFhrpVipArp(portName, arp)) {
      // handled — HSRP active / VRRP master / GLBP AVG answered for the VIP
    } else if (arp.operation === 'request' && port.isProxyArpEnabled()) {
      const targetMask = port.getSubnetMask();
      if (targetMask && !myIP.isInSameSubnet(arp.targetIP, targetMask)) {
        const route = this.lookupRoute(arp.targetIP);
        if (route && route.iface !== portName) {
          const reply: ARPPacket = {
            type: 'arp', operation: 'reply',
            senderMAC: port.getMAC(), senderIP: arp.targetIP,
            targetMAC: arp.senderMAC, targetIP: arp.senderIP,
          };
          this.sendFrame(portName, {
            srcMAC: port.getMAC(), dstMAC: arp.senderMAC,
            etherType: ETHERTYPE_ARP, payload: reply,
          });
          this.getBus().publish({
            topic: 'arp.proxy.responded',
            payload: {
              deviceId: this.id, hostname: this.getHostname(),
              port: portName, targetIp: arp.targetIP.toString(),
              senderIp: arp.senderIP.toString(), viaIface: route.iface,
            },
          });
        }
      }
    } else if (arp.operation === 'reply') {
      // Phase 5.8: callers awaiting resolution use waitForEvent('host.arp.entry-learned').
      // The receive handler just flushes the packet queue waiting on this IP.
      this.flushPacketQueue(arp.senderIP, arp.senderMAC);
    }
  }

  // ─── Data Plane: Phase B+C — IPv4 Processing ──────────────────

  protected processIPv4(inPort: string, ipPkt: IPv4Packet): void {
    if (!ipPkt || ipPkt.type !== 'ipv4') return;

    // Phase B: L3 Header Sanity Check (RFC 1812 §5.2.2)
    const headerProblem = ipv4HeaderProblem(ipPkt);
    if (headerProblem) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, `router:${headerProblem}-fail`,
        `${this.name}: IPv4 header ${headerProblem}, dropping`);
      return;
    }

    // C.1a: Inbound ACL
    const originalPkt = ipPkt;
    if (this.deniedByInboundACL(inPort, originalPkt)) return;

    const natInbound = this.natEngine.translateInbound(ipPkt, inPort);
    if (natInbound) ipPkt = natInbound;

    // Phase C: Forwarding Decision

    // C.1: Is this packet for us? (any interface IP, broadcast, or
    // link-local multicast — 224.0.0.0/24 is consumed by the control
    // plane and MUST never be forwarded, RFC 1112/4541)
    const destIP = ipPkt.destinationIP;
    const destClass = classifyIpv4Destination(destIP);
    const isMulticast = destClass === 'multicast';

    if (destClass === 'limited-broadcast' || destClass === 'link-local-multicast') {
      // Broadcast/link-local-multicast packet — deliver locally, never forward
      this.handleLocalDelivery(inPort, ipPkt);
      return;
    }
    if (isMulticast) {
      // Globally/admin-scoped multicast (224.0.1.0-239.255.255.255) —
      // real PIM-routed application traffic, RFC 1112 §6.4.
      this.forwardMulticast(inPort, ipPkt);
      return;
    }
    for (const [, port] of this.ports) {
      if (port.ownsIPv4(destIP)) {
        // Control plane — the inbound ACL has already had its say (C.1a)
        this.handleLocalDelivery(inPort, ipPkt);
        return;
      }
    }

    // C.1-ter: RFC 2644 — a subnet-directed broadcast reaching the router
    // that is directly connected to the target subnet is exploded onto it
    // only when the operator asked; blocking is the default.
    const directedEgress = this.directedBroadcastEgress(destIP);
    if (directedEgress) {
      this.explodeDirectedBroadcast(inPort, directedEgress, ipPkt);
      return;
    }

    // C.1-bis: FHRP — the active/master answers for the VIP (ICMP echo
    // to the default gateway must succeed against the virtual address)
    if (this.fhrpOwnsVip(inPort, destIP.toString())) {
      this.handleLocalDelivery(inPort, ipPkt);
      return;
    }

    // C.1b: SPD inbound check (RFC 4301 §4.4.1) — DISCARD/BYPASS before ACL
    if (this.ipsecEngine) {
      const spdResult = this.ipsecEngine.evaluateSPD(ipPkt, 'in');
      if (spdResult) {
        if (spdResult.action === 'DISCARD') {
          Logger.info(this.id, 'ipsec:spd-discard',
            `${this.name}: SPD DISCARD inbound: ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
          return;
        }
        // BYPASS → skip IPsec processing, continue to ACL/forward
        // PROTECT → already handled by ESP/AH decapsulation above
      }
    }

    // C.2: Not for us → forward via FIB
    // `rate-limit input` police AVANT le routage : sur un vrai IOS, CAR
    // s'applique à l'entrée de l'interface, donc un paquet en excès est
    // jeté sans jamais consommer de décision de routage.
    if (!this.policeCar(inPort, 'input', ipPkt)) return;
    this.forwardPacket(inPort, ipPkt, originalPkt);
  }

  // ─── CAR (`rate-limit`) ────────────────────────────────────────
  private readonly carPolicers = new Map<string, CarPolicer>();

  /** Le policier d'une interface, créé au premier `rate-limit`. */
  getCarPolicer(ifName: string, creer = false): CarPolicer | undefined {
    let p = this.carPolicers.get(ifName);
    if (!p && creer) { p = new CarPolicer(); this.carPolicers.set(ifName, p); }
    return p;
  }

  /**
   * Applique CAR et rend `false` quand le paquet doit être jeté.
   *
   * La taille prise en compte est `totalLength`, c'est-à-dire l'en-tête
   * IP compris — c'est ce que CAR compte sur un vrai routeur, la police
   * portant sur le débit du lien et non sur la charge utile.
   */
  private policeCar(ifName: string, direction: 'input' | 'output', pkt: IPv4Packet): boolean {
    const p = this.carPolicers.get(ifName);
    if (!p || p.isEmpty()) return true;
    if (p.police(direction, pkt.totalLength)) return true;
    Logger.info(this.id, 'router:car-drop',
      `${this.name}: rate-limit ${direction} dropped ${pkt.sourceIP} → ${pkt.destinationIP} on ${ifName}`);
    return false;
  }

  /**
   * `ip access-group <acl> in`. A denied packet is dropped and, unless the
   * interface carries `no ip unreachables`, answered with an ICMP
   * administratively-prohibited (code 13).
   */
  private deniedByInboundACL(inPort: string, ipPkt: IPv4Packet): boolean {
    const inboundACL = this.aclEngine.getInterfaceACL(inPort, 'in');
    if (inboundACL === null) return false;
    if (this.aclEngine.evaluateForDataPlane(inboundACL, ipPkt) !== 'deny') return false;

    Logger.info(this.id, 'router:acl-deny-in',
      `${this.name}: ACL denied inbound on ${inPort}: ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
    this._debugService?.emitLine('ip.packet',
      `IP: s=${ipPkt.sourceIP} (${inPort}), d=${ipPkt.destinationIP}, len ${ipPkt.totalLength}, access denied`);
    this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 13);
    return true;
  }

  /**
   * Control Plane: Handle packets addressed to our interface IPs.
   * Supports: ICMP echo-request → echo-reply, UDP/RIP.
   */
  private directedBroadcastEgress(destination: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const primary = port.getIPAddress();
      const mask = port.getSubnetMask();
      const connected = [
        ...(primary && mask ? [{ address: primary, mask }] : []),
        ...port.getSecondaryIPs().map((e) => ({ address: e.ip, mask: e.mask })),
      ];
      if (isDirectedBroadcast(destination, connected)) return port;
    }
    return null;
  }

  private explodeDirectedBroadcast(
    inPort: string, egress: Port, ipPkt: IPv4Packet,
  ): void {
    if (!egress.isDirectedBroadcastEnabled()) {
      Logger.info(this.id, 'ipv4:directed-broadcast-dropped',
        `${this.name}: directed broadcast to ${ipPkt.destinationIP} dropped `
        + `(no ip directed-broadcast on ${egress.getName()})`);
      return;
    }
    const decision = decrementForForwarding(ipPkt);
    if (decision.kind === 'expired') {
      this.sendICMPError(inPort, ipPkt, 'time-exceeded', 0);
      return;
    }
    this.sendFrame(egress.getName(), {
      srcMAC: egress.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: decision.packet,
    });
  }

  private handleLocalDelivery(inPort: string, ipPkt: IPv4Packet): void {
    // RFC 791 §3.2: hold non-first/more-fragments datagrams until the full
    // set arrives — buffered fragments return null here and are simply
    // dropped from this call; the reassembled datagram continues through
    // the same dispatch a non-fragmented one would.
    const reassembled = this.ipv4Reassembler.add(ipPkt);
    if (!reassembled) return;
    ipPkt = reassembled;

    // OSPF runs directly over IP (proto 89, RFC 2328 §4.3).
    if (ipPkt.protocol === IP_PROTO_OSPF) {
      const ospfPkt = ipPkt.payload as { type?: string };
      if (ospfPkt?.type === 'ospf' && this.ospfIntegration.isOSPFEnabled()) {
        this.ospfIntegration.receivePacket(
          inPort, ipPkt.sourceIP.toString(),
          ipPkt.payload as import('../ospf/types').OSPFPacket,
        );
      }
      return;
    }

    // EIGRP runs directly over IP (proto 88, RFC 7868 §4.2).
    if (ipPkt.protocol === IP_PROTO_EIGRP) {
      this.dynamicRouting.receiveEigrpPacket(inPort, ipPkt);
      return;
    }

    // NHRP runs directly over IP (proto 54, RFC 2332 §5.2).
    if (ipPkt.protocol === IP_PROTO_NHRP) {
      const nhrpPkt = ipPkt.payload as { type?: string };
      if (nhrpPkt?.type === 'nhrp') {
        this.receiveNhrpPacket(inPort, ipPkt.sourceIP.toString(), ipPkt.payload as NhrpPacket);
      }
      return;
    }

    // IPSec inbound decapsulation. A multicast-destined ESP/AH packet (e.g.
    // GDOI/GET-VPN group traffic) is keyed by (SPI, group address) in a
    // separate SA table from unicast SAs, so it must be routed to the
    // multicast decap path rather than the unicast SPI lookup.
    if (ipPkt.protocol === IP_PROTO_ESP && this.ipsecEngine) {
      const isMcast = this.ipsecEngine.isMulticast(ipPkt.destinationIP.toString());
      const inner = isMcast
        ? this.ipsecEngine.processMulticastInboundESP(ipPkt)
        : this.ipsecEngine.processInboundESP(ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_AH && this.ipsecEngine) {
      const isMcast = this.ipsecEngine.isMulticast(ipPkt.destinationIP.toString());
      const inner = isMcast
        ? this.ipsecEngine.processMulticastInboundAH(ipPkt)
        : this.ipsecEngine.processInboundAH(ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }
    // NAT-T: ESP-in-UDP on port 4500 (RFC 3948)
    if (ipPkt.protocol === IP_PROTO_UDP && this.ipsecEngine) {
      const udp = ipPkt.payload as UDPPacket;
      if (udp && udp.type === 'udp' && udp.destinationPort === UDP_PORT_IKE_NAT_T) {
        const esp = udp.payload as ESPPacket;
        if (esp && esp.type === 'esp') {
          // Reconstruct as ESP packet for IPSec processing
          const espPkt: IPv4Packet = {
            ...ipPkt,
            protocol: IP_PROTO_ESP,
            payload: esp,
          };
          const inner = this.ipsecEngine.processInboundESP(espPkt);
          if (inner) this.processIPv4(inPort, inner);
          return;
        }
      }
    }

    if (ipPkt.protocol === IP_PROTO_TCP) {
      this.tcpv2.handleIp(inPort, ipPkt.sourceIP, ipPkt);
      return;
    }

    if (ipPkt.protocol === IP_PROTO_ICMP) {
      const icmp = ipPkt.payload as ICMPPacket;
      if (!icmp || icmp.type !== 'icmp') return;

      if (icmp.icmpType === 'echo-request') {
        const port = this.ports.get(inPort);
        if (!port) return;

        // Use the destination IP of the request as the source of the reply
        // (correct for loopback/virtual interfaces and transport mode IPSec)
        const replySourceIP = ipPkt.destinationIP;

        const replyICMP: ICMPPacket = {
          type: 'icmp', icmpType: 'echo-reply', code: 0,
          id: icmp.id, sequence: icmp.sequence, dataSize: icmp.dataSize,
        };

        const replyIP = createIPv4Packet(
          replySourceIP, ipPkt.sourceIP, IP_PROTO_ICMP, this.defaultTTL,
          replyICMP, 8 + icmp.dataSize,
        );

        this.counters.icmpOutEchoReps++;
        this.counters.icmpOutMsgs++;

        const sameSubnetMac = this.peerOnSameSubnet(inPort, ipPkt.sourceIP)
          ? this.arpTable.get(ipPkt.sourceIP.toString())
          : undefined;
        if (sameSubnetMac && !this.ipsecEngine) {
          this.counters.ifOutOctets += replyIP.totalLength;
          this.sendFrame(inPort, {
            srcMAC: port.getMAC(), dstMAC: sameSubnetMac.mac,
            etherType: ETHERTYPE_IPV4, payload: replyIP,
          });
        } else if (!this.sendSelfOriginatedIPv4(replyIP, ipPkt.sourceIP)) {
          this.forwardPacket(inPort, replyIP);
        }
      } else if (icmp.icmpType === 'destination-unreachable' && icmp.code === 4) {
        // ── RFC 4301 §6 / RFC 1191: ICMP Fragmentation Needed (Type 3, Code 4) ──
        // When we receive this ICMP error referencing one of our IPsec-tunneled
        // packets, update the SA's Path MTU so future packets are sized correctly.
        if (this.ipsecEngine && icmp.originalPacket) {
          const origPkt = icmp.originalPacket;
          // Check if the original packet was an ESP or AH packet (IPsec tunneled)
          if (origPkt.protocol === IP_PROTO_ESP) {
            const esp = origPkt.payload as ESPPacket;
            if (esp && esp.type === 'esp' && icmp.mtu) {
              this.ipsecEngine.updatePathMTU(esp.spi, icmp.mtu);
            }
          } else if (origPkt.protocol === IP_PROTO_AH) {
            const ah = origPkt.payload as AHPacket;
            if (ah && ah.type === 'ah' && icmp.mtu) {
              this.ipsecEngine.updatePathMTU(ah.spi, icmp.mtu);
            }
          }
        }
        // A Fragmentation Needed answering one of our own echo requests is
        // the DF probe coming back: settle it so the CLI can mark it `M`
        // instead of waiting out the timeout as if nothing had replied.
        if (icmp.originalPacket) {
          const origICMP = icmp.originalPacket.payload as ICMPPacket;
          if (origICMP && origICMP.type === 'icmp' && origICMP.icmpType === 'echo-request') {
            this.emitIcmpEchoFailed({
              fromIp: ipPkt.sourceIP.toString(),
              toIp: icmp.originalPacket.destinationIP.toString(),
              id: origICMP.id, seq: origICMP.sequence,
              reason: `Destination unreachable (from ${ipPkt.sourceIP}) code 4`,
            });
          }
        }
      } else if (icmp.icmpType === 'echo-reply') {
        // Phase 5.8/5.9: settle awaiting _sendPing / traceroute via the bus.
        this.emitIcmpEchoReply({
          fromIp: ipPkt.sourceIP.toString(),
          toIp: ipPkt.destinationIP.toString(),
          id: icmp.id, seq: icmp.sequence, ttl: ipPkt.ttl, rttMs: 0,
        });
      } else if (icmp.icmpType === 'time-exceeded') {
        // Phase 5.9: emit echo-failed correlated by id/seq of the original packet.
        if (icmp.originalPacket) {
          const origICMP = icmp.originalPacket.payload as ICMPPacket;
          if (origICMP && origICMP.type === 'icmp' && origICMP.icmpType === 'echo-request') {
            this.emitIcmpEchoFailed({
              fromIp: ipPkt.sourceIP.toString(),
              toIp: icmp.originalPacket.destinationIP.toString(),
              id: origICMP.id, seq: origICMP.sequence,
              reason: `Time to live exceeded (from ${ipPkt.sourceIP})`,
            });
          }
        }
      } else if (icmp.icmpType === 'destination-unreachable' && icmp.code !== 4) {
        // Non-PMTU destination-unreachable: could be a traceroute reaching a dead end.
        if (icmp.originalPacket) {
          const origICMP = icmp.originalPacket.payload as ICMPPacket;
          if (origICMP && origICMP.type === 'icmp' && origICMP.icmpType === 'echo-request') {
            this.emitIcmpEchoFailed({
              fromIp: ipPkt.sourceIP.toString(),
              toIp: icmp.originalPacket.destinationIP.toString(),
              id: origICMP.id, seq: origICMP.sequence,
              reason: `Destination unreachable (from ${ipPkt.sourceIP}) code ${icmp.code}`,
            });
          }
        }
      }
    } else if (ipPkt.protocol === IP_PROTO_UDP) {
      const udp = ipPkt.payload as UDPPacket;
      if (!udp || udp.type !== 'udp') return;
      // RFC 768: a non-zero checksum that doesn't match is corruption —
      // silently discarded, no ICMP reply (matches EndHost.deliverUDP).
      if (!verifyUdpChecksum(udp, ipPkt.sourceIP.toString(), ipPkt.destinationIP.toString())) {
        Logger.warn(this.id, 'udp:checksum-fail',
          `${this.name}: invalid UDP checksum from ${ipPkt.sourceIP}:${udp.sourcePort}, dropping`);
        return;
      }

      if (this.receiveControlPlaneUdp(inPort, ipPkt, udp)) return;

      const claim = this.controlPlaneUdpClaims().get(udp.destinationPort);
      if (claim) { claim.receive(inPort, ipPkt, udp); return; }

      if (this.ipSlaEngine.handleUdp(ipPkt.sourceIP, udp)) return;
      if (this.udpEndpoint?.deliver(
        ipPkt.sourceIP, udp.destinationPort, udp.sourcePort, udp.payload,
      )) return;

      this.sendICMPError(inPort, ipPkt, 'destination-unreachable', ICMP_UNREACH_PORT);
    }
  }

  /** @internal ISAKMP payload as a UDP 500→500 datagram through the FIB (DPD). */
  _sendIkeUdp(destIp: string, payload: unknown): boolean {
    const dst = new IPAddress(destIp);
    const route = this.lookupRoute(dst);
    if (!route) return false;
    const egress = this.ports.get(route.iface);
    const srcIp = egress?.getIPAddress();
    if (!egress || !srcIp) return false;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: UDP_PORT_IKE, destinationPort: UDP_PORT_IKE,
      length: 8 + 64, checksum: 0, payload,
    };
    const ipPkt = createIPv4Packet(srcIp, dst, IP_PROTO_UDP, 64, udp, 8 + 64);
    const arpHit = this.arpTable.get(
      (route.nextHop ?? dst).toString(),
    ) ?? this.arpTable.get(dst.toString());
    this.sendFrame(route.iface, {
      srcMAC: egress.getMAC(),
      dstMAC: arpHit ? arpHit.mac : MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
    return true;
  }

  /** @internal RFC 3948 §4 single-byte 0xFF NAT-T keepalive on UDP 4500. */
  _sendNatTKeepalive(destIp: string): boolean {
    const dst = new IPAddress(destIp);
    const route = this.lookupRoute(dst);
    if (!route) return false;
    const egress = this.ports.get(route.iface);
    const srcIp = egress?.getIPAddress();
    if (!egress || !srcIp) return false;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 4500, destinationPort: 4500,
      length: 8 + 1, checksum: 0,
      payload: { type: 'nat-t-keepalive', bytes: new Uint8Array([0xff]) },
    };
    const ipPkt = createIPv4Packet(srcIp, dst, IP_PROTO_UDP, 64, udp, 20 + 8 + 1);
    const arpHit = this.arpTable.get(
      (route.nextHop ?? dst).toString(),
    ) ?? this.arpTable.get(dst.toString());
    this.sendFrame(route.iface, {
      srcMAC: egress.getMAC(),
      dstMAC: arpHit ? arpHit.mac : MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
    return true;
  }

  // ─── Data Plane: Phase D+E — Forwarding Engine ────────────────

  protected recordNetflowSample(_input: NetFlowRecordInput): void {}

  getNetFlowAgent(): NetFlowAgent | null { return null; }

  private sampleNetflowForward(pkt: IPv4Packet, nextHopIP: IPAddress): void {
    let sourcePort: number | undefined;
    let destinationPort: number | undefined;
    let tcpFlags: number | undefined;
    if (pkt.protocol === IP_PROTO_TCP) {
      const tcp = pkt.payload as TCPPacket;
      sourcePort = tcp.sourcePort;
      destinationPort = tcp.destinationPort;
      tcpFlags = (tcp.flags.fin ? 0x01 : 0)
        | (tcp.flags.syn ? 0x02 : 0)
        | (tcp.flags.rst ? 0x04 : 0)
        | (tcp.flags.psh ? 0x08 : 0)
        | (tcp.flags.ack ? 0x10 : 0)
        | (tcp.flags.urg ? 0x20 : 0);
    } else if (pkt.protocol === IP_PROTO_UDP) {
      const udp = pkt.payload as UDPPacket;
      sourcePort = udp.sourcePort;
      destinationPort = udp.destinationPort;
    }
    this.recordNetflowSample({
      sourceIp: pkt.sourceIP.toString(),
      destinationIp: pkt.destinationIP.toString(),
      sourcePort, destinationPort, tcpFlags,
      protocol: pkt.protocol,
      bytes: pkt.totalLength,
      packets: 1,
      tos: pkt.tos,
      nextHopIp: nextHopIP.toString(),
    });
  }

  /**
   * Forward an IPv4 packet to the next hop.
   * Implements the full RFC 1812 forwarding pipeline.
   */
  private forwardPacket(inPort: string, ipPkt: IPv4Packet, originalPkt: IPv4Packet = ipPkt): void {
    if (!this._ipRoutingEnabled) {
      Logger.info(this.id, 'router:ip-routing-disabled',
        `${this.name}: IP routing is disabled, dropping packet from ${ipPkt.sourceIP} to ${ipPkt.destinationIP}`);
      this.counters.ipForwDatagrams++;
      return;
    }
    const decision = decrementForForwarding(ipPkt);
    if (decision.kind === 'expired') {
      Logger.info(this.id, 'router:ttl-expired',
        `${this.name}: TTL expired for packet from ${ipPkt.sourceIP} to ${ipPkt.destinationIP}`);
      this.sendICMPError(inPort, ipPkt, 'time-exceeded', 0);
      return;
    }

    // Phase C.2: FIB lookup (LPM)
    const route = this.lookupRoute(ipPkt.destinationIP);
    if (!route) {
      this.counters.ipInAddrErrors++;
      Logger.info(this.id, 'router:no-route',
        `${this.name}: no route for ${ipPkt.destinationIP}`);
      this._debugService?.emitLine('ip.packet',
        `IP: s=${ipPkt.sourceIP} (${inPort}), d=${ipPkt.destinationIP}, len ${ipPkt.totalLength}, unroutable`);
      this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 0);
      return;
    }

    let fwdPkt: IPv4Packet = decision.packet;

    const outPort = this.ports.get(route.iface);
    if (!outPort) return;
    const effectiveMtu = outPort.getMTU();

    if (fwdPkt.totalLength > effectiveMtu) {
      const dfSet = (fwdPkt.flags & 0b010) !== 0;
      if (dfSet) {
        Logger.info(this.id, 'router:mtu-exceeded',
          `${this.name}: packet ${fwdPkt.totalLength} > MTU ${effectiveMtu}, DF=1`);
        this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 4, effectiveMtu);
        return;
      }
    }

    const nextHopIP = route.nextHop || ipPkt.destinationIP;

    this._debugService?.emitLine('ip.packet',
      `IP: s=${ipPkt.sourceIP} (${inPort}), d=${ipPkt.destinationIP} (${route.iface}), g=${nextHopIP}, len ${fwdPkt.totalLength}, forward`);

    // Phase E.2a: ICMP Redirect (RFC 1812 §5.2.7.2)
    // Send redirect when egress == ingress and source is on-link — host can reach next-hop directly.
    if (route.iface === inPort && route.nextHop) {
      const inPortObj = this.ports.get(inPort);
      const inPortIP = inPortObj?.getIPAddress();
      const inPortMask = inPortObj?.getSubnetMask();
      if (inPortIP && inPortMask && ipPkt.sourceIP.isInSameSubnet(inPortIP, inPortMask)) {
        this.sendICMPRedirect(inPort, ipPkt, route.nextHop);
      }
    }

    const isHairpin = !this.natEngine.isOutsideInterface(route.iface)
      && originalPkt.destinationIP.toString() !== fwdPkt.destinationIP.toString();
    const natOutbound = this.natEngine.translateOutbound(fwdPkt, route.iface, inPort,
      isHairpin ? { isHairpin: true, aclMatchPkt: originalPkt } : undefined);
    if (natOutbound) {
      const outsideIP = this.ports.get(route.iface)?.getIPAddress()?.toString();
      fwdPkt = outsideIP ? inspectAndRewriteFtpAlg(natOutbound, this.natEngine, outsideIP) : natOutbound;
    }

    // `rate-limit output` police à la SORTIE, donc sur l'interface
    // choisie par le routage et non sur celle d'arrivée, et avant l'ACL
    // sortante : un paquet jeté par CAR n'a pas à être filtré ensuite.
    if (!this.policeCar(route.iface, 'output', fwdPkt)) return;

    // Phase E.2b: Outbound ACL check
    const outboundACL = this.aclEngine.getInterfaceACL(route.iface, 'out');
    if (outboundACL !== null) {
      const verdict = this.aclEngine.evaluateForDataPlane(outboundACL, fwdPkt);
      if (verdict === 'deny') {
        Logger.info(this.id, 'router:acl-deny-out',
          `${this.name}: ACL denied outbound on ${route.iface}: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP}`);
        this._debugService?.emitLine('ip.packet',
          `IP: s=${fwdPkt.sourceIP} (${inPort}), d=${fwdPkt.destinationIP}, len ${fwdPkt.totalLength}, access denied`);
        this.sendICMPError(inPort, fwdPkt, 'destination-unreachable', 13);
        return;
      }
    }

    this.sampleNetflowForward(fwdPkt, nextHopIP);

    // Phase E.2c: SPD outbound check (RFC 4301 §4.4.1) + IPSec encryption
    if (this.ipsecEngine) {
      // Evaluate SPD first — explicit BYPASS/DISCARD overrides crypto maps
      const spdResult = this.ipsecEngine.evaluateSPD(fwdPkt, 'out');
      if (spdResult) {
        if (spdResult.action === 'DISCARD') {
          Logger.info(this.id, 'ipsec:spd-discard',
            `${this.name}: SPD DISCARD outbound: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP}`);
          return;
        }
        if (spdResult.action === 'BYPASS') {
          // Skip IPsec — fall through to normal forwarding
        } else {
          // PROTECT — use crypto map / tunnel protection as before
          const entry = this.ipsecEngine.findMatchingCryptoEntry(fwdPkt, route.iface);
          if (entry) {
            const encPkts = this.ipsecEngine.processOutbound(fwdPkt, route.iface, entry);
            if (!encPkts) {
              // Check if ICMP Fragmentation Needed should be sent back to source
              if (this.ipsecEngine.lastEncapICMP) {
                const { mtu, originalPkt } = this.ipsecEngine.lastEncapICMP;
                this.ipsecEngine.lastEncapICMP = null;
                this.sendICMPError(inPort, originalPkt, 'destination-unreachable', 4, mtu);
              }
              return;
            }
            for (const p of encPkts) this.processIPv4(route.iface, p);
            return;
          }
        }
      } else {
        // No explicit SPD policy — fall back to crypto map matching (legacy behavior)
        const entry = this.ipsecEngine.findMatchingCryptoEntry(fwdPkt, route.iface);
        if (entry) {
          const encPkts = this.ipsecEngine.processOutbound(fwdPkt, route.iface, entry);
          if (!encPkts) {
            if (this.ipsecEngine.lastEncapICMP) {
              const { mtu, originalPkt } = this.ipsecEngine.lastEncapICMP;
              this.ipsecEngine.lastEncapICMP = null;
              this.sendICMPError(inPort, originalPkt, 'destination-unreachable', 4, mtu);
            }
            return;
          }
          for (const p of encPkts) this.processIPv4(route.iface, p);
          return;
        }
      }
    }

    // Phase E.3: ARP resolve next-hop → L2 rewrite → send
    // RFC 791 §3.2: fragment now, as the very last step — NAT/ACL/IPSec
    // above have already acted on the whole logical datagram, since only
    // fragment 0 will carry the L4 header they need to inspect. The
    // DF=1-and-oversized case already returned earlier (ICMP frag-needed),
    // so any oversized packet reaching here is safe to split.
    const outgoingFragments = fragmentIPv4(fwdPkt, effectiveMtu);
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.counters.ipForwDatagrams++;
      Logger.info(
        this.id, 'router:forward',
        `${this.name}: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP} via ${nextHopIP} (${route.iface}, ttl=${fwdPkt.ttl})` +
          (outgoingFragments.length > 1 ? ` [fragmented x${outgoingFragments.length}]` : ''),
        {
          src: fwdPkt.sourceIP.toString(),
          dst: fwdPkt.destinationIP.toString(),
          nextHop: nextHopIP.toString(),
          iface: route.iface,
          ttl: fwdPkt.ttl,
          totalLength: fwdPkt.totalLength,
        },
      );
      for (const frag of outgoingFragments) {
        this.counters.ifOutOctets += frag.totalLength;
        this.sendFrame(route.iface, {
          srcMAC: outPort.getMAC(), dstMAC: cached.mac,
          etherType: ETHERTYPE_IPV4, payload: frag,
        });
      }
    } else {
      for (const frag of outgoingFragments) this.queueAndResolve(frag, route.iface, nextHopIP, outPort);
    }
  }

  /**
   * Replicate globally/admin-scoped multicast data (224.0.1.0-239.255.255.255)
   * out the (*,G) OIL built by PimAgent from IGMP membership and downstream
   * PIM Joins. Drops silently (no PIM/no matching mroute/RPF failure) —
   * strictly no worse than the previous always-drop behavior.
   */
  private forwardMulticast(inPort: string, ipPkt: IPv4Packet): void {
    const pimAgent = this.getPimAgent();
    if (!pimAgent) return;
    const group = ipPkt.destinationIP.toString();
    const mroute = pimAgent.getMroute(group);
    if (!mroute || mroute.outgoingInterfaces.size === 0) return;

    const rpfIface = mroute.incomingInterface ?? this.lookupRoute(ipPkt.sourceIP)?.iface;
    if (rpfIface && rpfIface !== inPort) {
      Logger.info(this.id, 'router:mcast-rpf-fail',
        `${this.name}: RPF failure for ${ipPkt.sourceIP} → ${group} on ${inPort} (expected ${rpfIface})`);
      return;
    }

    const mcastDecision = decrementForForwarding(ipPkt);
    if (mcastDecision.kind === 'expired') return;
    const fwdPktBase: IPv4Packet = mcastDecision.packet;
    const dstMAC = new MACAddress(ipv4MulticastToMac(group));

    for (const oif of mroute.outgoingInterfaces) {
      if (oif === inPort) continue;
      const outPort = this.ports.get(oif);
      if (!outPort || !outPort.getIsUp() || !outPort.isConnected()) continue;
      this.counters.ipForwDatagrams++;
      this.counters.ifOutOctets += fwdPktBase.totalLength;
      // Each OIF gets its own packet object — sendFrame() hands the same
      // reference all the way to the receiving device's handleFrame(), so
      // sharing one object across multiple egress ports would let one
      // receiver's in-place mutation (or a future one) leak into another's.
      this.sendFrame(oif, {
        srcMAC: outPort.getMAC(), dstMAC,
        etherType: ETHERTYPE_IPV4, payload: { ...fwdPktBase },
      });
    }
  }

  // ─── ICMP Error Generation (Control Plane) ────────────────────

  /**
   * Send an ICMP error message back to the source of the offending packet.
   * Supports: Time Exceeded (Type 11), Destination Unreachable (Type 3).
   *
   * RFC 1812 §4.3.2.7: The ICMP error is routed like any other packet —
   * use the routing table to find the egress interface and next-hop,
   * rather than blindly sending on the ingress port.
   */
  private icmpTypeSuppressedByLocalAcl(icmpType: ICMPErrorType): boolean {
    for (const acl of this.aclEngine.getAccessLists()) {
      for (const entry of acl.entries) {
        if (entry.action === 'deny' && entry.protocol === 'icmp' && entry.icmpType === icmpType) {
          return true;
        }
      }
    }
    return false;
  }

  protected receiveControlPlaneUdp(
    _inPort: string, _ipPkt: IPv4Packet, _udp: UDPPacket,
  ): boolean {
    return false;
  }

  private baseUdpClaims: Map<number, ControlPlaneUdpClaim> | null = null;

  protected controlPlaneUdpClaims(): Map<number, ControlPlaneUdpClaim> {
    if (this.baseUdpClaims) return this.baseUdpClaims;
    const claims = new Map<number, ControlPlaneUdpClaim>();
    claims.set(UDP_PORT_RIP, {
      owner: 'rip',
      receive: (inPort, ipPkt, udp) => {
        const rip = udp.payload as RIPPacket;
        if (rip && rip.type === 'rip') this.ripEngine.processPacket(inPort, ipPkt.sourceIP, rip);
      },
    });
    claims.set(DHCP_SERVER_PORT, {
      owner: 'dhcpd',
      receive: (inPort, ipPkt, udp) => { this.handleDhcpUdp(inPort, ipPkt, udp); },
    });
    claims.set(DHCP_CLIENT_PORT, {
      owner: 'dhclient',
      receive: (inPort, _ipPkt, udp) => {
        const reply = udp.payload as DHCPPacket | undefined;
        if (reply && reply.type === 'dhcp') this.dhcpClientAgent.deliver(inPort, reply);
      },
    });
    claims.set(UDP_PORT_IKE, {
      owner: 'isakmp',
      receive: (inPort, ipPkt, udp) => { this.ipsecEngine?.handleIkeUdp(inPort, ipPkt, udp); },
    });
    claims.set(UDP_PORT_IKE_NAT_T, { owner: 'isakmp-natt', receive: () => undefined });
    this.baseUdpClaims = claims;
    return claims;
  }

  protected controlPlaneUdpOwner(port: number): string | null {
    return this.controlPlaneUdpClaims().get(port)?.owner ?? null;
  }

  private sendICMPError(
    inPort: string,
    offendingPkt: IPv4Packet,
    icmpType: ICMPErrorType,
    code: number,
    nextHopMTU?: number,
  ): void {
    // RFC 1122 §3.2.2: never generate an error about an ICMP error,
    // a fragment, or a broadcast/multicast packet (prevents error storms).
    if (!mayGenerateICMPError(offendingPkt)) return;

    if (icmpType === 'destination-unreachable'
      && !this.isIcmpUnreachablesEnabled(inPort)) return;

    const inPortObj = this.ports.get(inPort);
    if (!inPortObj) return;
    const myIP = inPortObj.getIPAddress();
    if (!myIP) return;

    if (this.icmpTypeSuppressedByLocalAcl(icmpType)) return;

    const errorIP = buildICMPError(
      myIP, offendingPkt, icmpType, code, this.defaultTTL,
      { nextHopMTU: nextHopMTU ?? this.interfaceMTU },
    );

    this.counters.icmpOutMsgs++;
    if (icmpType === 'time-exceeded') this.counters.icmpOutTimeExcds++;
    if (icmpType === 'destination-unreachable') this.counters.icmpOutDestUnreachs++;
    this._debugService?.emitIcmpError(
      icmpType, code,
      offendingPkt.destinationIP.toString(), myIP.toString(),
      offendingPkt.sourceIP.toString());

    this.sendSelfOriginatedIPv4(errorIP, offendingPkt.sourceIP);
  }

  /**
   * Send ICMP Redirect (Type 5, Code 1 — Redirect for Host) back to the source.
   * Tells the originating host to send future packets directly to `redirectGW`.
   * RFC 792; RFC 1812 §5.2.7.
   */
  private sendSelfOriginatedIPv4(ipPkt: IPv4Packet, destination: IPAddress): boolean {
    const route = this.lookupRoute(destination);
    if (!route) return false;
    const outPort = this.ports.get(route.iface);
    if (!outPort) return false;
    this.counters.ifOutOctets += ipPkt.totalLength;
    this.sendIpv4FrameArpAware(route.iface, ipPkt, route.nextHop || destination);
    return true;
  }

  private sendICMPRedirect(inPort: string, offendingPkt: IPv4Packet, redirectGW: IPAddress): void {
    const inPortObj = this.ports.get(inPort);
    if (!inPortObj) return;
    const myIP = inPortObj.getIPAddress();
    if (!myIP) return;

    const redirectICMP: ICMPPacket = {
      type: 'icmp',
      icmpType: 'redirect',
      code: 1, // Redirect for Host
      id: 0, sequence: 0, dataSize: 0,
      gateway: redirectGW,
      originalPacket: offendingPkt,
    };

    const redirectIP = createIPv4Packet(
      myIP, offendingPkt.sourceIP, IP_PROTO_ICMP, this.defaultTTL,
      redirectICMP, 8,
    );

    this.counters.icmpOutMsgs++;
    this.sendSelfOriginatedIPv4(redirectIP, offendingPkt.sourceIP);
  }

  // ─── ARP Resolution + Packet Queue ────────────────────────────

  private queueAndResolve(pkt: IPv4Packet, iface: string, nextHopIP: IPAddress, port: Port): void {
    const key = nextHopIP.toString();
    const timer = this.routerTimers.setTimeout(() => {
      const abandonnes = this.packetQueue.filter(
        q => q.nextHopIP.equals(nextHopIP) && q.outIface === iface
      );
      this.packetQueue = this.packetQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
      this.inFlightFwdARPs.delete(key);
      for (const q of abandonnes) {
        this._debugService?.emitLine('ip.packet',
          `IP: s=${q.frame.sourceIP} (${iface}), d=${q.frame.destinationIP}, encapsulation failed`);
        this.sendICMPError(iface, q.frame, 'destination-unreachable', 1);
      }
    }, 2000);

    this.packetQueue.push({ frame: pkt, outIface: iface, nextHopIP, timer });

    if (!this.inFlightFwdARPs.has(key)) {
      this.inFlightFwdARPs.add(key);
      const myIP = port.getIPAddress()!;
      const arpReq: ARPPacket = {
        type: 'arp', operation: 'request',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: MACAddress.broadcast(), targetIP: nextHopIP,
      };
      this.emitArpRequestSent(iface, key);
      this.sendFrame(iface, {
        srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP, payload: arpReq,
      });
    }
  }

  /**
   * Émettre une requête ARP pour une adresse, sans paquet à envoyer.
   *
   * C'est ce que `logging server-arp` demande : résoudre le collecteur
   * syslog AU MOMENT où on le configure, plutôt qu'au premier message.
   * Le chemin ordinaire (`sendIpv4FrameArpAware`) résout aussi, mais
   * seulement quand il a déjà un datagramme en main — la différence est
   * exactement celle que ce mot-clé existe pour faire.
   */
  public sendArpRequestFor(ifaceName: string, targetIP: IPAddress): boolean {
    const port = this.ports.get(ifaceName);
    const myIP = port?.getIPAddress();
    if (!port || !myIP || !port.getIsUp()) return false;
    const key = targetIP.toString();
    if (this.arpTable.get(key) || this.inFlightFwdARPs.has(key)) return false;
    this.inFlightFwdARPs.add(key);
    const arpReq: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: port.getMAC(), senderIP: myIP,
      targetMAC: MACAddress.broadcast(), targetIP,
    };
    this.emitArpRequestSent(ifaceName, key);
    this.sendFrame(ifaceName, {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: arpReq,
    });
    return true;
  }

  private flushPacketQueue(resolvedIP: IPAddress, resolvedMAC: MACAddress): void {
    const ready = this.packetQueue.filter(q => q.nextHopIP.equals(resolvedIP));
    this.packetQueue = this.packetQueue.filter(q => !q.nextHopIP.equals(resolvedIP));
    this.inFlightFwdARPs.delete(resolvedIP.toString());

    for (const q of ready) {
      this.routerTimers.clear(q.timer);
      const outPort = this.ports.get(q.outIface);
      if (outPort) {
        this.counters.ipForwDatagrams++;
        this.counters.ifOutOctets += q.frame.totalLength;
        this.sendFrame(q.outIface, {
          srcMAC: outPort.getMAC(), dstMAC: resolvedMAC,
          etherType: ETHERTYPE_IPV4, payload: q.frame,
        });
      }
    }
  }

  /**
   * ARP-aware send for control-plane agents (NTP/SNMP/Syslog/NetFlow/RADIUS,
   * this router's own TCP stack) — queues on a cold ARP cache and resolves
   * the real next-hop MAC instead of broadcasting (PRD audit #26).
   */
  public sendIpv4FrameArpAware(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void {
    const port = this.ports.get(outPortName);
    if (!port) return;
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.sendFrame(outPortName, {
        srcMAC: port.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: ipPkt,
      });
    } else {
      this.queueAndResolve(ipPkt, outPortName, nextHopIP, port);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // IPv6 Data Plane — delegated to IPv6DataPlane
  // ═══════════════════════════════════════════════════════════════════

  configureRA(ifName: string, config: Partial<import('./router/IPv6DataPlane').RAConfig>) { this.ipv6Engine.configureRA(ifName, config); }
  /** Set an interface's ND advertisement parameters (`ipv6 nd …`). */
  setRaParams(ifName: string, params: Partial<import('./router/IPv6DataPlane').RAConfig>): void {
    this.ipv6Engine.setRaParams(ifName, params);
  }

  getRaParams(ifName: string) { return this.ipv6Engine.getRaParams(ifName); }

  addRAPrefix(ifName: string, prefix: IPv6Address, prefixLength: number, options?: {
    onLink?: boolean; autonomous?: boolean; validLifetime?: number; preferredLifetime?: number;
  }) { this.ipv6Engine.addRAPrefix(ifName, prefix, prefixLength, options); }

  // ─── Management Plane: Terminal (vendor-abstracted) ────────────

  async executeCommand(command: string, answers?: HeadlessAnswers): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    if (hasHeadlessAnswers(answers)) {
      const dialogue = await this.jouerDialogueSansTerminal(command, answers as HeadlessAnswers);
      if (dialogue !== null) { this.syncRouteDebug(); return dialogue; }
    }
    const porteAaa = this.refusAutorisationAaa(command);
    if (porteAaa !== null) {
      const refus = await porteAaa;
      if (refus !== null) return refus;
    }
    const out = await this.shell.execute(this, command);
    this.syncRouteDebug();
    return out;
  }

  /**
   * `executeCommand` allait droit au gestionnaire du trie, c'est-a-dire
   * de l'autre cote de la porte : sur une machine portant `enable
   * secret`, un appelant programmatique obtenait le niveau 15 sans avoir
   * a produire le moindre mot de passe. Le plan d'interaction — celui-la
   * meme que joue le terminal — est desormais joue ici quand l'appelant
   * fournit une reponse, donc les deux chemins traversent la MEME porte.
   */
  private async jouerDialogueSansTerminal(
    command: string, answers: HeadlessAnswers,
  ): Promise<string | null> {
    const shell = this.shell as unknown as { getMode?: () => string };
    if (!isInteractionPlanner(this.shell)) return null;
    const plan = this.shell.interactionPlanFor(command, {
      mode: shell.getMode?.() ?? 'privileged',
      device: this,
      onVtyLine: false,
    });
    if (!plan) return null;
    return runInteractionPlanHeadless(plan, answers,
      async (c) => this.shell.execute(this, c));
  }

  /**
   * L'autorisation AAA par commande, sur la porte que TOUS les appelants
   * empruntent.
   *
   * `authorizeCommand` etait correcte et n'avait qu'un appelant :
   * `CiscoTerminalSession`. Une session SSH, telnet ou scriptee
   * echappait donc entierement a `aaa authorization commands`, pourtant
   * configuree et rendue dans la configuration. La porte vit ici, une
   * seule fois, parce que deux portes finiraient par ne pas soumettre
   * les memes commandes — et parce que le terminal, en la portant, en
   * chargeait deux fois le serveur.
   *
   * La liste consultee est celle du niveau de la COMMANDE, comme IOS, et
   * non celle du niveau de la session.
   *
   * Rend `null` SYNCHRONEMENT quand il n'y a rien a autoriser, et une
   * promesse seulement sinon. Ce n'est pas une optimisation : `await`
   * sur ce chemin differe l'execution d'un tour de micro-taches, donc
   * change le moment ou une commande prend effet — mesure sur un appelant
   * qui n'attendait pas `executeCommand` et voyait son changement de mode
   * arriver trop tard.
   */
  protected refusAutorisationAaa(command: string): Promise<string | null> | null {
    const ligne = command.trim();
    if (ligne === '') return null;
    const shell = this.shell as unknown as {
      niveauEffectifDe?: (c: string, d?: unknown) => number | null;
      utilisateurDeSession?: () => string | null;
    };
    const utilisateur = shell.utilisateurDeSession?.() ?? null;
    if (!utilisateur) return null;
    const niveau = shell.niveauEffectifDe?.(ligne, this) ?? null;
    if (niveau === null) return null;
    const aaa = this.getAaaAuthenticator();
    if (!aaa.hasCommandAuthorization(niveau)) return null;
    return aaa.authorizeCommand(utilisateur, ligne, niveau)
      .then((v) => (v === 'denied' ? 'Command authorization failed.' : null));
  }

  /**
   * Ouvrir une session EXEC au nom d'un compte, sans terminal.
   *
   * C'est ce que fait une ligne en `login local` quand l'operateur se
   * presente : le compte est verifie, puis la session s'ouvre AU NIVEAU
   * DU COMPTE. Sans cette porte, un appelant programmatique n'avait
   * aucun moyen d'etre quelqu'un — il etait toujours la console anonyme.
   */
  async loginAs(username: string, password: string): Promise<boolean> {
    if (!this.isPoweredOn) return false;
    // `authenticateLine` repond pour la LIGNE : une console sans `login`
    // n'exige rien, donc elle accordait — et `loginAs` rendait `true`
    // pour un compte SUPPRIME, VERROUILLE, ou qui n'a jamais existe.
    // Ce n'est pas la meme question : ouvrir une ligne et DEVENIR
    // quelqu'un sont deux choses, et cette methode demande la seconde.
    const identifie = this.getCredentialStore().authenticate(username, password)
      || await this.authenticateViaAaa(username, password);
    if (!identifie) {
      this.getCredentialStore().recordLoginFailure(username, '', 'bad password', Date.now());
      return false;
    }
    const verdict = await this.authenticateLine('console', { user: username, pass: password });
    if (!verdict) return false;
    // `aaa authorization exec` decide si ce compte obtient un shell, et a
    // quel niveau. Un REFUS refuse la session — il ne la degrade pas vers
    // le niveau du compte local, ce qui reviendrait a ignorer la
    // commande.
    const exec = await this.getAaaAuthenticator().authorizeExec(username);
    if (!exec.allowed) {
      this.getCredentialStore().recordLoginFailure(username, '', 'exec authorization failed', Date.now());
      return false;
    }
    const refus = this.perUserAdmissionRefusal(username, '');
    if (refus !== null) {
      this.getCredentialStore().recordLoginFailure(username, '', refus, Date.now());
      return false;
    }
    const compte = this.getCredentialStore().lookup(username);
    // La precedence qu'IOS documente : AAA > ligne > compte. Le niveau de
    // la ligne est un REMPLACEMENT et non un plancher, donc il vaut aussi
    // quand il est INFERIEUR a celui du compte.
    const niveau = exec.privilegeLevel ?? this.resolveConsoleExecLevel(username);
    const shell = this.shell as unknown as {
      beginExecSession?: (lvl: number, u?: string, vue?: string | null) => void;
    };
    shell.beginExecSession?.(niveau, username, compte?.view ?? null);
    const registre = this.getSshSessionRegistry();
    const ouverte = registre.sessionSurLigne('con');
    if (ouverte) registre.noterAuthentification(ouverte.id, username, niveau);
    else registre.open({ user: username, privilege: niveau, fromIp: '', transport: 'console' });
    const autocommand = this.getCredentialStore().get(username)?.autocommand ?? null;
    this.getCredentialStore().consumeOneTime(username);
    if (autocommand) await this.executeCommand(autocommand);
    return true;
  }

  /**
   * Presenter des identifiants A UNE LIGNE, en respectant la methode que
   * cette ligne declare (`login`, `login local`, `login authentication`).
   *
   * La difference console/vty n'est pas cosmetique : le mode silencieux
   * de `login block-for` ne ferme QUE les lignes reseau — « when the
   * device is in quiet mode, all login requests are denied and the only
   * available connection is through the console » (guide de configuration
   * Login Block). Une console refusee par le mode silencieux enfermerait
   * l'operateur dehors, ce qu'IOS existe precisement pour eviter.
   */
  async authenticateLine(
    kind: 'console' | 'vty' | 'aux', credentials: { user?: string; pass: string },
  ): Promise<boolean> {
    if (!this.isPoweredOn) return false;
    if (kind === 'vty' && this.getLoginBlocker()?.isBlocked()) return false;
    const user = credentials.user ?? '';
    const methode = this.methodeDeLigne(kind);
    if (methode === 'none') return true;
    if (methode === 'password') {
      const attendu = this.motDePasseDeLigne(kind);
      const ok = attendu !== null && attendu === credentials.pass;
      if (!ok) this.getCredentialStore().recordLoginFailure(user, '', 'bad password', Date.now());
      return ok;
    }
    if (methode === 'aaa') {
      const ok = await this.authenticateViaAaa(user, credentials.pass);
      if (!ok) this.getCredentialStore().recordLoginFailure(user, '', 'bad password', Date.now());
      return ok;
    }
    const ok = this.getCredentialStore().authenticate(user, credentials.pass);
    if (!ok) this.getCredentialStore().recordLoginFailure(user, '', 'bad password', Date.now());
    return ok;
  }

  /**
   * Authentifier par la chaine de methodes AAA et DIRE laquelle a
   * tranche. `authenticateViaAaa` rend un booleen, donc « le serveur a
   * refuse » et « aucun serveur n'a repondu, la base locale a tranche »
   * etaient indiscernables — c'est pourtant la distinction que le repli
   * existe pour produire.
   */
  async authenticateAAA(req: {
    user: string; pass: string; methodList?: string; serverAvailable?: boolean;
  }): Promise<{ success: boolean; methodUsed: string }> {
    const outcome = await this.getAaaAuthenticator()
      .authenticate(req.user, req.pass, req.methodList);
    return { success: outcome.accepted, methodUsed: outcome.method };
  }

  private configurationDeConsole(): {
    login: 'password' | 'local' | 'none' | 'aaa' | null; password: string | null;
  } | null {
    const shell = this.shell as unknown as {
      _getConsoleLineConfig?: () => {
        login: 'password' | 'local' | 'none' | 'aaa' | null; password: string | null;
      } | null;
    };
    return shell._getConsoleLineConfig?.() ?? null;
  }

  protected methodeDeLigne(kind: 'console' | 'vty' | 'aux'): 'none' | 'password' | 'local' | 'aaa' {
    // Une seule regle : `resolveVtyLoginMode` connait `login` (IOS) ET
    // `authentication-mode` (VRP). Cette methode-ci ne lisait que le
    // premier, donc sur un routeur Huawei elle rendait toujours `none`
    // et la ligne accordait a n'importe quel mot de passe.
    if (kind === 'vty') return this.resolveVtyLoginMode();
    if (kind === 'aux') return 'none';
    return this.configurationDeConsole()?.login ?? 'none';
  }

  protected motDePasseDeLigne(kind: 'console' | 'vty' | 'aux'): string | null {
    if (kind === 'vty') return this.blocVtyCourant()?.linePassword ?? null;
    if (kind === 'aux') return null;
    return this.configurationDeConsole()?.password ?? null;
  }

  private _routeDebugSnapshot: Map<string, string> | null = null;

  private routeKey(r: RouteEntry): string {
    return `${r.network}/${r.mask.toCIDR()}`;
  }

  syncRouteDebug(): void {
    const svc = this._debugService;
    if (!svc) return;
    const best = new Map<string, RouteEntry>();
    for (const r of this.routingTable) {
      if (r.iface && this.ports.get(r.iface)?.getIsUp() === false) continue;
      if (r.iface && this.ports.get(r.iface)?.isConnected() === false) continue;
      const key = this.routeKey(r);
      const prev = best.get(key);
      if (!prev || r.ad < prev.ad || (r.ad === prev.ad && r.metric < prev.metric)) best.set(key, r);
    }
    const current = new Map<string, string>();
    for (const [key, r] of best) {
      const via = r.nextHop ? String(r.nextHop) : r.iface;
      current.set(key, `${via}, ${routeDebugSource(r.type)} metric [${r.ad}/${r.metric}]`);
    }
    const previous = this._routeDebugSnapshot;
    this._routeDebugSnapshot = current;
    if (!previous) return;
    for (const [key, queue] of previous) {
      if (!current.has(key)) svc.emitLine('ip.routing', `RT: del ${key} via ${queue}`);
    }
    for (const [key, queue] of current) {
      if (!previous.has(key)) svc.emitLine('ip.routing', `RT: add ${key} via ${queue}`);
      else if (previous.get(key) !== queue) {
        svc.emitLine('ip.routing', `RT: del ${key} via ${previous.get(key)}`);
        svc.emitLine('ip.routing', `RT: add ${key} via ${queue}`);
      }
    }
  }

  getPrompt(): string {
    return this.shell.getPrompt(this);
  }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliExecutablePaths(): string[] {
    return (this.shell as unknown as { executablePathsInCurrentMode?: () => string[] })
      .executablePathsInCurrentMode?.() ?? [];
  }

  cliCommandPaths(): string[] {
    return (this.shell as unknown as { commandPathsInCurrentMode?: () => string[] })
      .commandPathsInCurrentMode?.() ?? [];
  }

  cliDerivedContinuations(): string[] {
    return (this.shell as unknown as { derivedContinuationsInCurrentMode?: () => string[] })
      .derivedContinuationsInCurrentMode?.() ?? [];
  }

  cliUndescribedContinuations(): string[] {
    return (this.shell as unknown as { undescribedContinuationsInCurrentMode?: () => string[] })
      .undescribedContinuationsInCurrentMode?.() ?? [];
  }

  cliHelp(inputBeforeQuestion: string): string {
    return this.shell.getHelp(inputBeforeQuestion, this);
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    return this.shell.tabComplete(input, this);
  }

  override getCompletions(partial: string): string[] {
    return this.shell.tabCandidates(partial, this);
  }

  /** All full-line Tab candidates (static keywords + live device values). */
  cliTabCandidates(input: string): string[] {
    return this.shell.tabCandidates(input, this);
  }

  getAclIdentifiers(): string[] {
    return this.aclEngine.getAccessLists()
      .map((a) => a.name ?? (a.id !== undefined ? String(a.id) : ''))
      .filter((v) => v.length > 0);
  }

  getConfiguredIPv4Addresses(): string[] {
    const out: string[] = [];
    for (const port of this.getPorts()) {
      const ip = port.getIPAddress()?.toString();
      if (ip) out.push(ip);
    }
    return out;
  }

  getKnownHostnames(): string[] {
    return this.hostsTable.entries().map((e) => e.name);
  }

  getKnownMacAddresses(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of this.arpTable.values()) {
      const mac = entry.mac.toString();
      if (seen.has(mac)) continue;
      seen.add(mac);
      out.push(mac);
    }
    return out;
  }

  // ─── vty sessions (per-terminal CLI isolation, §5.1 of terminal_gap.md) ──

  /** Live vty sessions, keyed by their internal id. */
  private readonly vtySessions = new Map<string, CliShellSession>();
  /** Per-device queue serialising swap-and-restore around the shared shell. */
  private vtyExecQueue: Promise<unknown> = Promise.resolve();

  /**
   * Allocate a fresh vty session — one per opened terminal. Each session
   * carries its own mode, selectedInterface, terminalLength, … so two
   * concurrent terminals do not leak privilege escalation or sub-mode
   * pointers across each other.
   */
  openVtySession(): CliShellSession {
    const initialMode = this.getOSType() === 'huawei-vrp' ? 'user-view' : 'user';
    const s = new CliShellSession({ initialMode });
    this.vtySessions.set(s.id, s);
    return s;
  }

  /** Tear down a vty session and remove it from the active set. */
  closeVtySession(sessionOrId: CliShellSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    const s = this.vtySessions.get(id);
    if (!s) return;
    s.dispose();
    this.vtySessions.delete(id);
  }

  /** Lookup helper. */
  getVtySession(id: string): CliShellSession | undefined {
    return this.vtySessions.get(id);
  }

  /**
   * Like `executeCommand`, but routes through the per-terminal vty
   * session so each terminal observes its own mode / selection context.
   * Sync swap-and-restore around the shared shell instance — async
   * commands are awaited inside the swap window.
   */
  async executeCommandInVty(
    command: string, session: CliShellSession, answers?: HeadlessAnswers,
  ): Promise<string> {
    const shell = this.shell as unknown as {
      snapshotVtyState?: () => import('./shells/vty/CliShellSession').VtySnapshot;
      applyVtyState?: (s: import('./shells/vty/CliShellSession').VtySnapshot) => void;
    };
    // Older shells (HuaweiVRPShell pre-§5.1) may not expose the snapshot
    // hooks yet — degrade gracefully to the legacy shared-state path so
    // commands still work, even if isolation is not yet enforced there.
    if (!shell.snapshotVtyState || !shell.applyVtyState) {
      return this.executeCommand(command, answers);
    }
    const run = async (): Promise<string> => {
      if (!this.isPoweredOn) return '% Device is powered off';
      if (session.disposed) return '';
      const baseline = shell.snapshotVtyState!();
      shell.applyVtyState!(session.state);
      if (session.lineRecordId !== null) {
        this.getSshSessionRegistry().setCurrentSession(session.lineRecordId);
      }
      try {
        const out = await this.executeCommand(command, answers);
        session.state = shell.snapshotVtyState!();
        return out;
      } finally {
        shell.applyVtyState!(baseline);
      }
    };
    const promise = this.vtyExecQueue.then(run, run) as Promise<string>;
    this.vtyExecQueue = promise.catch(() => undefined);
    return promise;
  }

  cliHelpForVty(input: string, session: CliShellSession): string {
    return this.withSwappedVtyState(session, () => this.cliHelp(input)) ?? this.cliHelp(input);
  }

  cliTabCompleteForVty(input: string, session: CliShellSession): string | null {
    return this.withSwappedVtyState(session, () => this.cliTabComplete(input));
  }

  cliTabCandidatesForVty(input: string, session: CliShellSession): string[] {
    return this.withSwappedVtyState(session, () => this.cliTabCandidates(input)) ?? [];
  }

  private withSwappedVtyState<T>(session: CliShellSession, fn: () => T): T | null {
    const shell = this.shell as unknown as {
      snapshotVtyState?: () => import('./shells/vty/CliShellSession').VtySnapshot;
      applyVtyState?: (s: import('./shells/vty/CliShellSession').VtySnapshot) => void;
    };
    if (!shell.snapshotVtyState || !shell.applyVtyState) return null;
    const baseline = shell.snapshotVtyState();
    shell.applyVtyState(session.state);
    try {
      return fn();
    } finally {
      shell.applyVtyState(baseline);
    }
  }

  /** Read the per-vty prompt without disturbing the shared shell state. */
  getPromptForVty(session: CliShellSession): string {
    const shell = this.shell as unknown as {
      snapshotVtyState?: () => import('./shells/vty/CliShellSession').VtySnapshot;
      applyVtyState?: (s: import('./shells/vty/CliShellSession').VtySnapshot) => void;
    };
    if (!shell.snapshotVtyState || !shell.applyVtyState) {
      return this.getPrompt();
    }
    const baseline = shell.snapshotVtyState!();
    shell.applyVtyState!(session.state);
    try {
      return this.getPrompt();
    } finally {
      shell.applyVtyState!(baseline);
    }
  }

  getBanner(type: string = 'motd'): string {
    if (type === 'motd') return this.motdBannerText;
    if (type === 'login') return this.loginBannerText;
    if (type === 'exec') return this.execBannerText;
    if (type === 'incoming') return this.incomingBannerText;
    return '';
  }

  protected motdBannerText: string = '';
  protected loginBannerText: string = '';
  protected execBannerText: string = '';
  protected incomingBannerText: string = '';

  _setMotdBanner(text: string): void { this.motdBannerText = text; }
  _setLoginBanner(text: string): void { this.loginBannerText = text; }
  _setExecBanner(text: string): void { this.execBannerText = text; }
  _setIncomingBanner(text: string): void { this.incomingBannerText = text; }

  // ── Public accessors used by CLI shells ──────────────────────

  /** @internal Used by CLI shells */
  _getRoutingTableInternal(): RouteEntry[] { return this.routingTable; }
  /** @internal Used by CLI shells */
  _getArpTableInternal(): Map<string, ARPEntry> { return this.arpTable; }

  /**
   * Real RIB lookup (LPM) exposed to UDP/TCP agents hosted on this router
   * (e.g. RADIUS) that need genuine egress resolution instead of a
   * same-subnet/first-up-port heuristic — mirrors `resolveRoute` on
   * `TcpHost`. Read-only: no packet mutation, same freshness refresh as
   * the data-path lookup in `forwardPacket`.
   */
  resolveRouteForHost(destIp: string): { iface: string; nextHopIp: string } | null {
    const dest = new IPAddress(destIp);
    const route = this.lookupRoute(dest);
    if (!route) return null;
    return { iface: route.iface, nextHopIp: (route.nextHop ?? dest).toString() };
  }

  /** Add a static ARP entry */
  _addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void {
    this.arpTable.set(ip.toString(), { mac, iface, timestamp: Date.now(), type: 'static' });
  }

  /** Delete an ARP entry by IP */
  _deleteARP(ip: IPAddress): boolean {
    return this.arpTable.delete(ip.toString());
  }

  /** Clear all dynamic ARP entries (preserves static) */
  _clearARPCache(): void {
    for (const [ip, entry] of this.arpTable) {
      if (entry.type !== 'static') {
        this.arpTable.delete(ip);
      }
    }
  }
  /** @internal Used by CLI shells */
  _getPortsInternal(): Map<string, Port> { return this.ports; }

  _ipsecLocalIp(iface: string): string | null {
    if (!iface) {
      for (const [, port] of this.ports) {
        const any = port.getIPAddress();
        if (any) return any.toString();
      }
      return null;
    }
    if (/^Tunnel/i.test(iface)) {
      const configured = this._getOSPFExtraConfig()?.pendingIfConfig?.get(iface) as
        { tunnelSource?: string } | undefined;
      const sourceIP = configured?.tunnelSource
        ? this.ports.get(configured.tunnelSource)?.getIPAddress()
        : null;
      if (sourceIP) return sourceIP.toString();
    }
    return this.ports.get(iface)?.getIPAddress()?.toString() ?? null;
  }

  _ipsecLocalIps(): string[] {
    const addresses: string[] = [];
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      if (ip) addresses.push(ip.toString());
    }
    return addresses;
  }

  _ipsecInterfaceDown(iface: string): boolean {
    if (/^(Tunnel|Loopback)/i.test(iface)) return false;
    const port = this.ports.get(iface);
    return port !== undefined && !port.isConnected();
  }

  _ipsecEgressInterfaceFor(peerIp: string): string | undefined {
    try {
      return this.lookupRoute(new IPAddress(peerIp))?.iface;
    } catch {
      return undefined;
    }
  }
  /** @internal Used by CLI shells */
  _getHostnameInternal(): string { return this.hostname; }
  _getUptimeMs(): number { return this.getUptimeMs(); }
  /** @internal Used by CLI shells and OSPF */
  _getIPv6RoutingTableInternal() { return this.ipv6Engine.getRoutingTableInternal(); }
  /** @internal Used by CLI shells */
  _getNeighborCacheInternal() { return this.ipv6Engine.getNeighborCacheInternal(); }
  /** @internal Used by CLI shells */
  _getDHCPServerInternal(): DHCPServer { return this.dhcpServer; }

  private handleDhcpUdp(inPort: string, ipPkt: IPv4Packet, udp: UDPPacket): void {
    const pkt = udp.payload as DHCPPacket | undefined;
    if (!pkt || !(pkt instanceof DHCPPacket)) return;
    if (pkt.op === 1) {
      const helpers = this.dhcpServer.getHelperAddresses(inPort);
      if (helpers.length > 0) {
        this.relayDhcpToHelpers(inPort, pkt, helpers);
        return;
      }
      if (this.dhcpServer.isEnabled()) this.serveDhcpOnWire(inPort, pkt);
      return;
    }
    if (pkt.op === 2) {
      for (const [name, port] of this.ports) {
        const ip = port.getIPAddress();
        if (ip && pkt.giaddr === ip.toString()) {
          pkt.removeOption(82);
          this.sendDhcpFrameOnPort(name, pkt, new IPAddress('255.255.255.255'), MACAddress.broadcast());
          this.dhcpServer.countRelayReply();
          this.getBus().publish({
            topic: 'dhcp.relay.reply-forwarded',
            payload: {
              deviceId: this.id, hostname: this.getHostname(),
              iface: name, clientMac: pkt.chaddr, assignedIp: pkt.yiaddr,
            },
          });
          return;
        }
      }
    }
  }

  private relayDhcpToHelpers(inPort: string, pkt: DHCPPacket, helpers: string[]): void {
    const inIp = this.ports.get(inPort)?.getIPAddress();
    if (!inIp) return;
    if (pkt.hops >= 16) {
      this.dhcpServer.countRelayDrop();
      this.getBus().publish({
        topic: 'dhcp.relay.dropped',
        payload: {
          deviceId: this.id, hostname: this.getHostname(),
          iface: inPort, reason: 'hops-exceeded', hops: pkt.hops,
          clientMac: pkt.chaddr,
        },
      });
      return;
    }
    pkt.hops++;
    if (pkt.giaddr === '0.0.0.0') pkt.giaddr = inIp.toString();
    let option82: { circuitId: string; remoteId: string } | null = null;
    if (this.dhcpServer.isRelayInformationOptionEnabled()) {
      option82 = { circuitId: inPort, remoteId: this.getHostname() };
      pkt.setOption(82, option82);
    }
    for (const helper of helpers) {
      const dst = new IPAddress(helper);
      const route = this.lookupRoute(dst);
      if (!route) continue;
      const egress = this.ports.get(route.iface);
      const srcIp = egress?.getIPAddress();
      if (!egress || !srcIp) continue;
      const udp: UDPPacket = {
        type: 'udp', sourcePort: 67, destinationPort: 67,
        length: 8 + 300, checksum: 0, payload: pkt,
      };
      const relayed = createIPv4Packet(new IPAddress(pkt.giaddr), dst, IP_PROTO_UDP, 64, udp, 8 + 300);
      this.sendFrame(route.iface, {
        srcMAC: egress.getMAC(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_IPV4, payload: relayed,
      });
    }
    this.dhcpServer.countRelayForward();
    this.getBus().publish({
      topic: 'dhcp.relay.forwarded',
      payload: {
        deviceId: this.id, hostname: this.getHostname(),
        iface: inPort, giaddr: pkt.giaddr, helpers: [...helpers],
        clientMac: pkt.chaddr, hops: pkt.hops,
        circuitId: option82?.circuitId ?? null,
        remoteId: option82?.remoteId ?? null,
      },
    });
  }

  private serveDhcpOnWire(inPort: string, pkt: DHCPPacket): void {
    const giaddr = pkt.giaddr !== '0.0.0.0' ? pkt.giaddr : undefined;
    const option82 = pkt.getOption(82) as { circuitId: string; remoteId: string } | undefined;
    if (option82) {
      this.getBus().publish({
        topic: 'dhcp.server.option82-received',
        payload: {
          deviceId: this.id, hostname: this.getHostname(),
          messageType: pkt.getMessageType(), clientMac: pkt.chaddr,
          giaddr: giaddr ?? null,
          circuitId: option82.circuitId, remoteId: option82.remoteId,
        },
      });
    }
    // A client that just RELEASEd is the strongest possible signal that
    // this address is free — stronger than staying silent about it. A
    // stale ARP entry left over from while the lease was still active
    // would otherwise make the next DISCOVER's `ip dhcp ping packets`
    // pre-offer conflict check (isCandidateAddressInUse, which consults
    // the ARP table before ever sending a real probe) falsely conclude
    // the just-released address is still in use, skipping past it to
    // the next one instead of re-offering it — the address a real
    // Cisco IOS DHCP server, and this same client on its next DISCOVER,
    // would expect back.
    if (pkt.getMessageType() === 'DHCPRELEASE') this.arpTable.delete(pkt.ciaddr);

    this.dhcpServer.setServerOwnedAddresses(
      [...this.ports.values()]
        .map(p => p.getIPAddress()?.toString())
        .filter((ip): ip is string => !!ip),
    );
    const reply = buildDhcpServerReply(pkt, {
      server: this.dhcpServer,
      localGatewayIP: this.ports.get(inPort)?.getIPAddress()?.toString(),
      isAddressInUse: (ip) => this.isCandidateAddressInUse(new IPAddress(ip)),
    });
    if (!reply) return;
    this.dispatchDhcpReply(inPort, pkt, reply, option82, giaddr);
  }

  private dispatchDhcpReply(
    inPort: string, pkt: DHCPPacket, reply: DHCPPacket,
    option82: { circuitId: string; remoteId: string } | undefined,
    giaddr: string | undefined,
  ): void {
    if (option82) reply.setOption(82, option82);
    reply.giaddr = pkt.giaddr;
    if (giaddr) {
      const dst = new IPAddress(giaddr);
      const route = this.lookupRoute(dst);
      const egress = route ? this.ports.get(route.iface) : undefined;
      if (!route || !egress) return;
      this.sendDhcpFrameOnPort(route.iface, reply, dst, MACAddress.broadcast());
    } else {
      this.sendDhcpFrameOnPort(inPort, reply, new IPAddress('255.255.255.255'), MACAddress.broadcast());
    }
  }

  /**
   * `ip dhcp ping packets` — probe a candidate address before offering it,
   * the way real DHCP servers ping-check to avoid double-assigning an
   * address some non-DHCP host already holds (the server's own binding
   * table has no record of it, since it was never leased).
   *
   * DHCP DISCOVER→OFFER is handled synchronously end-to-end on this wire
   * (see DhcpServerChannel.exchange), so the probe uses the router's own
   * synchronous ARP path rather than the timer-driven `executePingSequence`
   * used by the interactive `ping`/`traceroute` commands: an in-use address
   * answers the ARP request within the same call, same as real frame
   * delivery already does for ordinary IP forwarding.
   */
  private isCandidateAddressInUse(candidateIP: IPAddress): boolean {
    const route = this.lookupRoute(candidateIP);
    if (!route) return false;
    const port = this.ports.get(route.iface);
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
    }, route.iface, port, candidateIP);
  }

  private sendDhcpFrameOnPort(
    portName: string,
    pkt: DHCPPacket,
    dstIp: IPAddress,
    dstMac: MACAddress,
  ): void {
    const port = this.ports.get(portName);
    const srcIp = port?.getIPAddress();
    if (!port || !srcIp) return;
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 67,
      destinationPort: dstIp.toString() === '255.255.255.255' ? 68 : 67,
      length: 8 + 300, checksum: 0, payload: pkt,
    };
    const ipPkt = createIPv4Packet(srcIp, dstIp, IP_PROTO_UDP, 64, udp, 8 + 300);
    this.sendFrame(portName, {
      srcMAC: port.getMAC(), dstMAC: dstMac,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });
  }
  /** @internal Used by CLI shells */
  _setHostnameInternal(name: string): void { this.hostname = name; this.name = name; }

  defaultHostname(): string { return 'Router'; }

  private _globalToggles = new Map<string, boolean>();
  _setGlobalToggle(key: string, enabled: boolean): void { this._globalToggles.set(key, enabled); }
  _getGlobalToggle(key: string): boolean | undefined { return this._globalToggles.get(key); }
  _undoGlobalToggle(commandTail: string): void {
    const key = commandTail.replace(/\s+enable\s*$/, '').trim();
    this._globalToggles.set(key, false);
    if (key === 'ssh' || /^stelnet/.test(commandTail)) this._setSshServerEnabled(false);
    if (key === 'dhcp') this._getDHCPServerInternal().disable();
    if (key === 'ftp server' || key === 'ftp') this._setFtpServerEnabled(false);
  }

  // ─── SSH server surface (SshExecTarget) ────────────────────────
  //
  // Routers and switches that grow an `ip ssh / stelnet server`
  // configuration expose a synchronous SSH server surface so the
  // cross-platform client dispatch can talk to them uniformly.
  // Concrete answers to vendor commands (show / display) come from
  // the per-vendor subclasses (CiscoRouter, HuaweiRouter).
  //
  // Defaults below assume a freshly-provisioned device: SSH is
  // enabled by default but the per-vendor `transport input none`
  // path can flip the flag through `_setSshServerEnabled`.

  /** Whether ssh/stelnet is currently advertised on the VTY. */
  protected sshServerEnabled: boolean = true;
  protected sshBannerText: string = '';
  _setSshBanner(text: string): void {
    this.sshBannerText = text;
    if (this._sshHost) this._sshHost.setBanner(text);
  }
  /** Inbound transport list (telnet/ssh/all/none) — mirrors VTY config. */
  protected vtyTransportInput: 'ssh' | 'telnet' | 'all' | 'none' = 'all';
  /**
   * Per-vendor VTY-line configuration registry. CiscoShellBase /
   * HuaweiVRPShell populate it from `exec-timeout`, `idle-timeout`,
   * `access-class`, `acl inbound`, `transport input`, `login local`,
   * etc.; show running-config / display current-configuration walk it.
   */
  readonly vtyLineConfig = new VtyLineConfigStore();
  _getVtyLineConfig(): VtyLineConfigStore { return this.vtyLineConfig; }
  private _vtyIncomingPolicy: VtyIncomingPolicy | null = null;
  vtyAdmissionVerdict(transport: VtyTransportKind, sourceIp: string): VtyAdmissionVerdict {
    if (!this._vtyIncomingPolicy) {
      this._vtyIncomingPolicy = new VtyIncomingPolicy({
        lines: () => this.vtyLineConfig,
        evaluateAcl: (name, packet) => this.aclEngine.evaluateACLByName(name, packet),
        localIp: () => this.getPorts()
          .map(p => p.getIPAddress()?.toString())
          .find((ip): ip is string => !!ip) ?? null,
        hasFreeLine: () => this.getSshSessionRegistry().hasFreeLine(),
        loginBlocker: () => this.getLoginBlocker(),
        ligneCandidate: () => this.getSshSessionRegistry().prochaineLigne(),
        transportParDefaut: () => this.vtyTransportInput,
        quietModeAccessClass: () => {
          const sec = (this as unknown as Record<symbol, CiscoSecurityConfig | undefined>)[
            Symbol.for('CiscoSecurityConfig')
          ];
          return sec?.login.quietModeAcl ?? null;
        },
      });
    }
    return this._vtyIncomingPolicy.admit(transport, sourceIp);
  }

  perUserAdmissionRefusal(user: string, sourceIp: string): string | null {
    const account = this.getCredentialStore().get(user);
    if (!account) return null;
    if (this.getCredentialStore().exceedsMaxLinks(user)) {
      return `user-maxlinks ${account.maxConcurrentSessions} reached`;
    }
    if (account.accessClassIn !== null) {
      const src = IPAddress.tryParse(sourceIp) ?? new IPAddress('0.0.0.0');
      const dst = IPAddress.tryParse(this.getPorts()
        .map(p => p.getIPAddress()?.toString())
        .find((ip): ip is string => !!ip) ?? '') ?? new IPAddress('0.0.0.0');
      const verdict = this.aclEngine
        .evaluateACLByName(String(account.accessClassIn), synthTcpPacket(src, dst));
      if (verdict === 'deny') return `access-class ${account.accessClassIn} denied ${sourceIp}`;
    }
    return null;
  }
  /** Static hostname → IP table (Cisco/Huawei `ip host` directives). */
  consoleLineCount(): number { return 1; }

  readonly hostsTable = new RouterHostsTable();
  _getHostsTable(): RouterHostsTable { return this.hostsTable; }

  private readonly dnsConfig = new CiscoDnsConfig();
  _getDnsConfig(): CiscoDnsConfig { return this.dnsConfig; }
  _getDnsStats() { return this.getDnsService().stats; }
  _syncDnsService(): void { this.getDnsService().sync(); }

  private dnsService: RouterDnsService | null = null;
  getDnsService(): RouterDnsService {
    if (!this.dnsService) {
      this.dnsService = new RouterDnsService(
        () => this.dnsConfig,
        () => this.hostsTable,
        () => this.dnsTransport(),
        (texte) => {
          this._debugService?.emitLine('ip.domain', texte);
          this.getLoggingConfig()?.append('debugging', 'domain', texte, true, 'DOMAIN');
        },
      );
    }
    return this.dnsService;
  }

  private dnsTransport(): DnsTransport {
    const ep = this.getUdpEndpoint();
    return {
      bind: (port, onQuery) => ep.udpBind(port, (d) => {
        onQuery(d.sourceIP.toString(), d.udp.sourcePort, d.udp.payload);
      }),
      unbind: (port) => { ep.udpClose(port); },
      reply: (dst, dstPort, charge) => {
        ep.sendUdpDatagramTo(new IPAddress(dst), dstPort, DNS_PORT, charge as Uint8Array);
      },
      sendQuery: (serveur, nom) => this.dnsQuerySurLeFil(serveur, nom),
    };
  }

  private dnsQuerySurLeFil(serveur: string, nom: string): Promise<string[]> {
    return new Promise((resolve) => {
      const ep = this.getUdpEndpoint();
      const port = ep.allocateEphemeralPort();
      let fini = false;
      const terminer = (adresses: string[]) => {
        if (fini) return;
        fini = true;
        ep.udpClose(port);
        resolve(adresses);
      };
      ep.udpBind(port, (d) => {
        try {
          const msg = decodeDnsMessage(d.udp.payload as unknown as Uint8Array);
          const ips: string[] = [];
          for (const rr of msg.answers) {
            const data = rr.data as { type: number; address?: { toString(): string } };
            if (data.type === RRType.A && data.address) ips.push(data.address.toString());
          }
          terminer(ips);
        } catch { terminer([]); }
      });
      const requete: DnsMessage = {
        id: Math.floor(Math.random() * 65535),
        flags: { qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: 0 },
        questions: [{ qname: `${nom}.`, qtype: RRType.A, qclass: 1 }],
        answers: [], authorities: [], additionals: [],
      };
      ep.sendUdpDatagramTo(new IPAddress(serveur), DNS_PORT, port, encodeDnsMessage(requete));
      let tours = 0;
      const attendre = () => {
        if (fini) return;
        if (tours++ > 40) { terminer([]); return; }
        queueMicrotask(attendre);
      };
      queueMicrotask(attendre);
    });
  }
  /** Outbound-SSH known-hosts store (Cisco `show ip ssh known-hosts`). */
  readonly sshKnownHosts = new RouterSshKnownHosts();
  _getSshKnownHosts(): RouterSshKnownHosts { return this.sshKnownHosts; }
  /** Vendor-neutral CLI alias table (Huawei command-alias, Cisco alias). */
  readonly commandAliases = new CommandAliasTable();
  _getCommandAliases(): CommandAliasTable { return this.commandAliases; }
  /**
   * Local-user database (vendor-agnostic). Populated by the per-vendor
   * shell when `username … secret …` (Cisco) or `local-user … password
   * …` (Huawei) is executed.
   */
  private _credentialStore: NetworkOsCredentialStore | null = null;
  private _debugService: RouterDebugService | null = null;
  private _ipRoutingEnabled: boolean = true;
  private _ripVersion: 1 | 2 = 2;

  isIpRoutingEnabled(): boolean { return this._ipRoutingEnabled; }
  _setIpRoutingEnabled(enabled: boolean): void { this._ipRoutingEnabled = enabled; }
  getRipVersion(): 1 | 2 { return this._ripVersion; }
  _setRipVersion(v: 1 | 2): void { this._ripVersion = v; }

  private readonly _unhandledConfigLines: string[] = [];
  private readonly _systemClock = new SystemClock();

  getUnhandledConfigLines(): readonly string[] { return [...this._unhandledConfigLines]; }
  _recordUnhandledConfigLine(line: string): void {
    if (this._unhandledConfigLines.length < 1024) this._unhandledConfigLines.push(line);
  }
  _removeUnhandledConfigLine(needle: string): void {
    const idx = this._unhandledConfigLines.findIndex(l => l === needle || l.startsWith(needle));
    if (idx >= 0) this._unhandledConfigLines.splice(idx, 1);
  }

  /**
   * `ip address negotiated` (PPP/IPCP) — le mode d'obtention d'adresse
   * déclaré sur une interface. Mémorisé pour la running-config ; il n'y
   * a pas de pile PPP derrière, donc l'interface reste sans adresse,
   * ce qu'un vrai routeur montre aussi tant que la négociation n'a pas
   * abouti.
   */
  private readonly _ifAddressMode = new Map<string, 'negotiated'>();
  setInterfaceAddressMode(iface: string, mode: 'negotiated'): void {
    this._ifAddressMode.set(iface, mode);
  }
  getInterfaceAddressMode(iface: string): 'negotiated' | undefined {
    return this._ifAddressMode.get(iface);
  }

  _setSystemClock(epochMs: number): void {
    this._systemClock.set(epochMs);
  }
  getSystemClockMs(): number {
    return this._systemClock.now();
  }

  /**
   * La PROVENANCE de la configuration : quand la running-config a
   * changé pour la dernière fois et par qui, et quand la NVRAM a été
   * écrite pour la dernière fois et par qui.
   *
   * IOS écrit ces deux lignes en tête de `show running-config` et de
   * `show startup-config`, et l'écart entre elles est LE signal d'audit
   * du chapitre : deux dates différentes veulent dire que quelqu'un a
   * modifié sans sauvegarder. Elles n'existaient pas ici, donc la
   * question ne pouvait pas être posée à la machine.
   */
  private _configChangedAtMs: number | null = null;
  private _configChangedBy: string | null = null;
  private _nvramWrittenAtMs: number | null = null;
  private _nvramWrittenBy: string | null = null;

  _noteConfigChange(user: string): void {
    this._configChangedAtMs = this.getSystemClockMs();
    this._configChangedBy = user;
  }
  _noteNvramWrite(user: string): void {
    this._nvramWrittenAtMs = this.getSystemClockMs();
    this._nvramWrittenBy = user;
    // Sauvegarder rend les deux dates égales : c'est exactement ce que
    // l'auditeur vérifie.
    if (this._configChangedAtMs === null) {
      this._configChangedAtMs = this._nvramWrittenAtMs;
      this._configChangedBy = user;
    }
  }
  _getConfigProvenance(): {
    changedAtMs: number | null; changedBy: string | null;
    nvramAtMs: number | null; nvramBy: string | null;
  } {
    return {
      changedAtMs: this._configChangedAtMs, changedBy: this._configChangedBy,
      nvramAtMs: this._nvramWrittenAtMs, nvramBy: this._nvramWrittenBy,
    };
  }

  private _startupConfigSnapshot: string | null = null;
  private readonly _hostnameUsine = this.name;
  _captureStartupConfig(snapshot: string): void { this._startupConfigSnapshot = snapshot; }
  _eraseStartupConfig(): void { this._startupConfigSnapshot = null; }

  /** Real rendered running-config text (`show running-config`), delegated
   *  to the vendor shell since Cisco/Huawei render completely different
   *  dialects (mirrors `getRunningConfigText` on `IRouterShell`). */
  getRunningConfig(): string {
    return this.shell.getRunningConfigText?.(this) ?? '';
  }

  /** `write memory` / `save` — capture the live config text as NVRAM. */
  writeMemory(): string {
    this._startupConfigSnapshot = this.getRunningConfig();
    return '[OK]';
  }

  /** @internal Re-apply NVRAM onto the live config (`copy startup-config
   *  running-config`). Returns false when NVRAM is empty. */
  _restoreStartupConfig(): boolean {
    if (this._startupConfigSnapshot === null) return false;
    this._applyConfigText(this._startupConfigSnapshot);
    return true;
  }

  /** @internal Re-apply arbitrary saved config text onto live state — the
   *  vendor shell owns the parsing since Cisco/Huawei config text differs
   *  (interface naming, `hostname` vs `sysname`, `ip route` vs
   *  `ip route-static`, …), mirroring `getRunningConfig`'s delegation. */
  _applyConfigText(text: string): void {
    this.shell.applyConfigText?.(this, text);
  }

  /**
   * @internal Discard the unsaved slice of running-config that
   * `_applyConfigText` knows how to replay (interface addressing/state and
   * static routes) before a `reload` boots from NVRAM — a real router loses
   * exactly this kind of in-memory-only change on power-cycle. Deliberately
   * scoped to what gets rendered/re-applied above; ACL/NAT/OSPF/etc. object
   * state is untouched here (see rapport 04 §5.9 for the narrower-than-full
   * fidelity this mirrors from `Switch._applyConfigText`).
   */
  _resetConfigurableStateForReload(): void {
    this._setHostnameInternal(this._hostnameUsine);
    for (const ifName of [...this.ports.keys()]) {
      this.unconfigureInterface(ifName);
      this.setInterfaceDescription(ifName, '');
      this.ports.get(ifName)?.setUp(true);
    }
    this.routingTable = this.routingTable.filter(r => r.type !== 'static' && r.type !== 'default');
  }

  getStartupConfigSnapshot(): string | null { return this._startupConfigSnapshot; }

  private _routingTableLimit: { max: number; thresholdPct?: number } | null = null;
  getRoutingTableLimit(): { max: number; thresholdPct?: number } | null { return this._routingTableLimit; }
  _setRoutingTableLimit(max: number | null, thresholdPct?: number): void {
    this._routingTableLimit = max === null ? null : { max, thresholdPct };
  }

  private debugLineMatchesAcl(
    aclRef: string,
    line: string,
    faits?: import('./router/diag/RouterDebugService').DebugPacketFacts,
  ): boolean {
    const ref = /^\d+$/.test(aclRef) ? Number(aclRef) : aclRef;
    const acl = typeof ref === 'number'
      ? this.aclEngine.findById(ref)
      : this.aclEngine.findByName(ref);
    if (!acl || acl.entries.length === 0) return true;

    let src = faits?.src;
    let dst = faits?.dst;
    if (!src || !dst) {
      const ips = line.match(/\d{1,3}(?:\.\d{1,3}){3}/g);
      if (!ips || ips.length === 0) return true;
      src = ips[0];
      dst = ips[1] ?? ips[0];
    }

    const proto = faits?.proto ?? 1;
    const ports = faits && (faits.srcPort !== undefined || faits.dstPort !== undefined)
      ? {
        type: proto === 6 ? 'tcp' : 'udp',
        sourcePort: faits.srcPort ?? 0,
        destinationPort: faits.dstPort ?? 0,
      }
      : undefined;

    const probe = {
      version: 4, ihl: 5, dscp: 0, ecn: 0, tos: 0,
      totalLength: 20, identification: 0, flags: 0, fragmentOffset: 0,
      ttl: 255, protocol: proto, headerChecksum: 0,
      sourceIP: new IPAddress(src),
      destinationIP: new IPAddress(dst),
      payload: ports,
    } as unknown as IPv4Packet;

    // Filtre d'AFFICHAGE : il observe, il ne compte pas.
    return this.aclEngine.evaluateACL(ref, probe, undefined, false) !== 'deny';
  }

  /**
   * Put the logging buffer on this device's bus, and gate its severity-7
   * lines behind this device's debug registry: those lines ARE `debug`
   * output, so they may only appear while the matching `debug` is on and
   * must stop on `undebug all`.
   */
  private attachLoggingBus(bus: import('@/events/EventBus').IEventBus): void {
    this.shell.attachLoggingToBus?.(bus, this.id, this);
    const journal = this.shell.getLoggingConfig?.();
    if (journal) {
      (this as unknown as { _loggingConfig?: unknown })._loggingConfig = journal;
    }
    journal?.setDebugGate(
      (tag) => this.getDebugService().isEnabledForSyslogTag(tag));
    if (journal) {
      journal.attachClockSource(deviceClockSource(this));
      this.getDebugService().setJournal({ record: (text) => journal.recordDebugLine(text) });
    }
  }

  getDebugService(): RouterDebugService {
    if (!this._debugService) {
      this._debugService = new RouterDebugService();
      const svc = this._debugService;
      this.natEngine.setDebugEmitter((line) => svc.emitLine('ip.nat', line));
      this._getDHCPServerInternal().setDebugEmitter((line) => svc.emitLine('ip.dhcp.server', line));
      svc.setAclFilterEvaluator((aclName, line, faits) => this.debugLineMatchesAcl(aclName, line, faits));
      svc.setCategoryRenderer('ip.dhcp.server', () => this._getDHCPServerInternal().formatDebugShow());
      this.ipsecEngine?.setDebugEmitter((kind, line) => {
        svc.emitLine(kind === 'ipsec' ? 'crypto.ipsec' : 'crypto.isakmp', line);
      });
      // `no logging on` and `logging rate-limit N` govern debug output too:
      // both are read live, so a change applies to the very next line
      // rather than to the next `debug` command.
      svc.setOutputGate(() => this.shell.getLoggingConfig?.()?.enabled !== false);
      const configuredLimit = () => this.shell.getLoggingConfig?.()?.rateLimit ?? null;
      const followConfiguredLimit = () => {
        const n = configuredLimit();
        if (n !== null && n !== svc.getRateLimit()) svc.setRateLimit(n);
      };
      svc.setRateLimitResolver(followConfiguredLimit);
    }
    this._debugService.attachToBus(this.getBus(), this.id, this);
    return this._debugService;
  }

  getLoggingConfig(): import('./inspection/config/LoggingConfig').LoggingConfig | null {
    const cfg = this.shell.getLoggingConfig?.();
    if (!cfg) return null;
    this.attachLoggingBus(this.getBus());
    return cfg;
  }

  private _nhrpService: NhrpService | null = null;
  private _dmvpnService: DmvpnService | null = null;

  getNhrpService(): NhrpService {
    if (!this._nhrpService) this._nhrpService = new NhrpService();
    return this._nhrpService;
  }

  getDmvpnService(): DmvpnService {
    if (!this._dmvpnService) this._dmvpnService = new DmvpnService(this.getNhrpService());
    return this._dmvpnService;
  }

  private _nhrpEngine: NhrpEngine | null = null;

  getNhrpEngine(): NhrpEngine {
    if (!this._nhrpEngine) {
      this._nhrpEngine = new NhrpEngine(
        {
          id: this.id,
          name: this.name,
          getPorts: () => this.ports,
          sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
          getArpEntry: (ip) => this.arpTable.get(ip),
        },
        this.getNhrpService(),
        this.getDmvpnService(),
        () => this.getBus(),
      );
    }
    return this._nhrpEngine;
  }

  /** NHRP packets arriving from the wire (proto 54) — the only path into the engine. */
  receiveNhrpPacket(inPort: string, srcIp: string, pkt: NhrpPacket): void {
    this.getNhrpEngine().processPacket(inPort, srcIp, pkt);
  }

  private _managementService: RouterManagementService | null = null;
  getManagementService(): RouterManagementService {
    if (!this._managementService) this._managementService = new RouterManagementService();
    return this._managementService;
  }

  /**
   * Le serveur HTTP d'IOS (`docs/PRD-Serveur-HTTP-Cisco.md`). Il vit sur
   * l'ÉQUIPEMENT et non sur le shell, pour la raison que `PRD-IP-SLA.md`
   * a déjà rencontrée : `createVtyShell()` fabrique un shell par session,
   * donc un `ip http server` tapé en SSH serait invisible depuis la
   * console de la même machine, et la configuration rendue — qui décrit
   * l'équipement — ne pourrait pas le voir.
   */
  private _httpService: CiscoHttpService | null = null;
  getHttpService(): CiscoHttpService {
    if (!this._httpService) this._httpService = new CiscoHttpService();
    return this._httpService;
  }

  /**
   * Ouvre ou ferme les ports du serveur web pour qu'ils reflètent la
   * configuration. Appelé par CHAQUE commande `ip http` — y compris
   * celles qui changent le port — parce qu'un serveur qui resterait sur
   * l'ancien port après `ip http port 8080` afficherait une configuration
   * que la machine ne respecte pas.
   */
  _refreshHttpListeners(): void {
    const svc = this.getHttpService();
    const bound = new Set(this.tcpv2.listListeners().map((l) => l.localPort));

    for (const port of [...this._httpBoundPorts]) {
      const wanted = (svc.enabled && port === svc.port)
        || (svc.secureEnabled && port === svc.securePort);
      if (wanted) continue;
      if (bound.has(port)) this._httpSessions.get(port)?.stop();
      this._httpSessions.delete(port);
      this._httpBoundPorts.delete(port);
    }

    if (svc.enabled && !this._httpBoundPorts.has(svc.port)) {
      this.bindHttpListener(svc.port, false);
    }
    if (svc.secureEnabled && !this._httpBoundPorts.has(svc.securePort)) {
      this.bindHttpListener(svc.securePort, true);
    }
  }

  private readonly _httpBoundPorts = new Set<number>();
  private readonly _httpSessions = new Map<number, { stop(): void }>();
  private _httpUi: CiscoHttpUi | null = null;
  private _httpTlsMaterial: ReturnType<typeof generateSelfSignedCertificate> | null = null;

  private buildHttpUi(): CiscoHttpUi {
    if (this._httpUi) return this._httpUi;
    const svc = this.getHttpService();
    this._httpUi = new CiscoHttpUi({
      hostname: () => this.hostname,
      authMethod: () => svc.authMethod,
      permitted: (ip) => this.httpAccessPermitted(ip),
      authenticate: (method, user, password) => this.authenticateHttp(method, user, password),
      runExec: (command, level, user) => this.runHttpExec(command, level, user),
    });
    return this._httpUi;
  }

  /**
   * Le serveur en clair et le serveur chiffré servent la MÊME interface :
   * `ip http secure-server` change le transport, pas ce qu'on obtient.
   * `identity` nomme le processus pour que `show tcp brief` et un scan de
   * ports désignent un propriétaire, comme pour les autres écouteurs.
   */
  private bindHttpListener(port: number, secure: boolean): void {
    const ui = this.buildHttpUi();
    const handler = (request: HttpMessage, peer?: { ip: string; port: number }) =>
      ui.handle(request, peer?.ip ?? '0.0.0.0');
    const identity = { processName: secure ? 'HTTPS CORE' : 'HTTP CORE', pid: 1 };

    const session = secure
      ? new HttpsServerSession(this.tcpv2, port, this.httpTlsConfig(), handler, this.getBus())
      : new Http1ServerSession(this.tcpv2, port, handler, this.getBus());
    session.start(identity);
    this._httpSessions.set(port, session);
    this._httpBoundPorts.add(port);
  }

  /**
   * IOS fabrique un certificat auto-signé la première fois que le
   * serveur sécurisé démarre. Il est gardé pour que deux démarrages
   * successifs présentent le MÊME certificat — en présenter un nouveau à
   * chaque `no ip http secure-server`/`ip http secure-server` se lirait,
   * chez le client, comme une usurpation.
   */
  private httpTlsConfig(): { serverCert: X509Certificate; serverPrivateKey: PkiPrivateKey } {
    if (!this._httpTlsMaterial) {
      this._httpTlsMaterial = generateSelfSignedCertificate(
        `CN = ${this.hostname}`, { now: Date.now(), subjectAltName: [`DNS:${this.hostname}`] });
    }
    return {
      serverCert: this._httpTlsMaterial.cert,
      serverPrivateKey: this._httpTlsMaterial.privateKey,
    };
  }

  private httpAccessPermitted(sourceIp: string): boolean {
    const acl = this.getHttpService().accessClass;
    if (!acl) return true;
    const src = IPAddress.tryParse(sourceIp);
    if (!src) return true;
    const dst = IPAddress.tryParse(
      this.getPorts().map((p) => p.getIPAddress()?.toString())
        .find((ip): ip is string => !!ip) ?? '0.0.0.0') ?? new IPAddress('0.0.0.0');
    const verdict = this.aclEngine.evaluateACLByName(acl, synthTcpPacket(src, dst));
    // Une ACL qui n'existe pas ne filtre rien : IOS accepte la référence
    // avant la liste (même règle que `ip nat inside source list`), donc
    // un serveur muet le temps qu'on écrive l'ACL serait un piège.
    return verdict === null || verdict === 'permit';
  }

  private async authenticateHttp(
    method: 'enable' | 'local' | 'aaa' | 'tacacs', user: string, password: string,
  ): Promise<{ ok: boolean; privilege: number }> {
    if (method === 'enable') {
      // `enable` ignore le nom d'utilisateur : le mot de passe EST le
      // secret d'activation, et l'accès obtenu est de niveau 15.
      const secret = this.getEnableSecret();
      const ok = secret !== null && password.length > 0
        && ciscoPasswordMatches(password, secret.value, secret.algo);
      return { ok, privilege: ok ? 15 : 1 };
    }
    if (method === 'local') {
      const ok = this.getCredentialStore().authenticate(user, password);
      return { ok, privilege: ok ? (this.getCredentialStore().lookup(user)?.privilege ?? 1) : 1 };
    }
    const ok = await this.authenticateViaAaa(user, password);
    return { ok, privilege: ok ? (this.getCredentialStore().lookup(user)?.privilege ?? 15) : 1 };
  }

  /**
   * L'exec derrière l'URL passe par le MÊME shell que la console : une
   * machine dont `show version` répondrait deux textes selon la porte
   * serait pire qu'une machine sans serveur web.
   */
  private async runHttpExec(command: string, level: number, user: string): Promise<string> {
    if (!command) return '';
    const shell = this.createVtyShell(user);
    try {
      const shellAtLevel = shell as unknown as {
        beginExecSession?: (lvl: number, u?: string) => void;
      };
      shellAtLevel.beginExecSession?.(level, user);
      return String(await shell.execute(command));
    } finally {
      shell.dispose();
    }
  }

  private _snmpService: import('./router/management/SnmpService').SnmpService | null = null;
  getSnmpService(): import('./router/management/SnmpService').SnmpService {
    if (!this._snmpService) {
      this._snmpService = new SnmpService();
    }
    return this._snmpService;
  }

  private _eemService: EemService | null = null;
  private _eemEngine: EemEngine | null = null;
  private _netflowService: NetflowService | null = null;
  private _archiveService: ArchiveService | null = null;
  private _keypairService: KeypairService | null = null;

  getKeypairService(): KeypairService {
    if (!this._keypairService) this._keypairService = new KeypairService();
    return this._keypairService;
  }

  getEemService(): EemService {
    if (!this._eemService) this._eemService = new EemService();
    return this._eemService;
  }

  getEemEngine(): EemEngine {
    if (!this._eemEngine) {
      const host: EemHost = {
        id: this.id,
        getHostname: () => this.getHostname(),
        executeCommand: (command: string) => this.executeCommand(command),
        getSnmpAgent: () => (this as unknown as { getSnmpAgent?: () => SnmpAgent }).getSnmpAgent?.(),
        logSyslog: (severityNum, tag, mnemonic, message) => {
          const journal = this.shell.getLoggingConfig?.();
          if (!journal) return;
          journal.append(SEVERITY_NAMES[severityNum] ?? 'informational', tag, message, true, mnemonic);
        },
      };
      this._eemEngine = new EemEngine(host, this.getEemService(), () => this.getBus(), () => this.getRouterScheduler());
      this._eemEngine.start();
    }
    return this._eemEngine;
  }
  getNetflowService(): NetflowService {
    if (!this._netflowService) this._netflowService = new NetflowService();
    return this._netflowService;
  }
  getArchiveService(): ArchiveService {
    if (!this._archiveService) this._archiveService = new ArchiveService();
    return this._archiveService;
  }

  private _huaweiRoutingExtras: HuaweiRoutingExtras | null = null;
  getHuaweiRoutingExtras(): HuaweiRoutingExtras {
    if (!this._huaweiRoutingExtras) this._huaweiRoutingExtras = new HuaweiRoutingExtras();
    return this._huaweiRoutingExtras;
  }

  /**
   * Cette liste d'acces accepte-t-elle cette source ?
   *
   * Un seul point d'evaluation, partage (lot N6) : NAT, VTY et
   * `ntp access-group` posent la meme question, et deux evaluateurs
   * finiraient par repondre differemment pour la meme liste.
   */
  evaluateAclPermit(acl: string, srcIp: string): boolean {
    // Sonde COMPLÈTE : une liste étendue cherche la destination, et
    // l'objet source-seul d'avant la faisait planter (`as never` avait
    // fait taire le vérificateur qui l'annonçait).
    const dst = this.getPorts().map(p => p.getIPAddress()).find(ip => !!ip) ?? undefined;
    return this.aclEngine.evaluateACLByName(
      acl, sourceProbePacket(new IPAddress(srcIp), dst ?? undefined)) === 'permit';
  }

  private _huaweiBfdService: HuaweiBfdService | null = null;
  getHuaweiBfdService(): HuaweiBfdService {
    if (!this._huaweiBfdService) this._huaweiBfdService = new HuaweiBfdService();
    return this._huaweiBfdService;
  }

  private _huaweiAaaService: HuaweiAaaService | null = null;
  getHuaweiAaaService(): HuaweiAaaService {
    if (!this._huaweiAaaService) this._huaweiAaaService = new HuaweiAaaService();
    return this._huaweiAaaService;
  }
  private _securityAuditLog: SecurityAuditLog | null = null;
  private _loginBlocker: LoginBlocker | null = null;
  private _loginBlockConfig: { attempts: number; withinSeconds: number; blockSeconds: number } | null = null;
  private _sshAuthRetries: number | null = null;

  getLoginBlocker(): LoginBlocker | null { return this._loginBlocker; }
  getLoginBlockConfig(): { attempts: number; withinSeconds: number; blockSeconds: number } | null {
    return this._loginBlockConfig;
  }
  getSshAuthenticationRetries(): number | null { return this._sshAuthRetries; }

  _configureLoginBlock(blockSeconds: number, attempts: number, withinSeconds: number): void {
    this._loginBlockConfig = { attempts, withinSeconds, blockSeconds };
    if (this._loginBlocker) this._loginBlocker.detach();
    this._loginBlocker = new LoginBlocker({
      deviceId: this.id, bus: this.getBus(),
      attempts, withinSeconds, blockSeconds,
    });
  }

  /** `aaa local authentication attempts max-fail <n>` — per-account lockout. */
  _configureLocalAuthMaxFail(n: number): void {
    this.getCredentialStore().setMaxFailedAttempts(n);
  }

  _configureSshAuthRetries(retries: number): void {
    this._sshAuthRetries = retries;
    if (this._loginBlocker) this._loginBlocker.detach();
    this._loginBlocker = new LoginBlocker({
      deviceId: this.id, bus: this.getBus(),
      attempts: retries, withinSeconds: 60, blockSeconds: 60,
    });
  }

  private _sshSessionRegistry: SshSessionRegistry | null = null;
  private _sshHost: CrossVendorSshHost | null = null;

  protected sshVendorTag(): CrossVendorSshVendor { return 'generic'; }

  /**
   * Le couple chiffrement/HMAC qu'annoncent `show ssh` et
   * `%SSH-5-SSH2_SESSION`. Un routeur generique n'a pas de configuration
   * SSH a lire ; `CiscoRouter` surcharge pour lire la sienne, de sorte
   * que les deux vues ne puissent pas se contredire.
   */
  protected sshNegotiatedAlgorithms(): { chiffrement: string; hmac: string } {
    return algorithmesRetenus();
  }

  getCredentialStore(): NetworkOsCredentialStore {
    if (!this._credentialStore) {
      this._securityAuditLog = new SecurityAuditLog({ deviceId: this.id, bus: this.getBus() });
      this._sshSessionRegistry = new SshSessionRegistry({
        deviceId: this.id,
        bus: this.getBus(),
        capacity: () => this.vtyLineConfig.lineCapacity(),
        algorithms: () => this.sshNegotiatedAlgorithms(),
      });
      this._credentialStore = new NetworkOsCredentialStore({ deviceId: this.id, bus: this.getBus() });
      this._credentialStore.liveSessionCount = (user) =>
        this._sshSessionRegistry!.list().filter(s => s.user === user && s.state !== 'closed').length;
      this._sshHost = new CrossVendorSshHost({
        deviceId: this.id,
        hostname: this.hostname,
        vendor: this.sshVendorTag(),
        bus: this.getBus(),
        authority: this._credentialStore,
        active: this.sshServerEnabled,
        banner: this.sshBannerText,
      });
      for (const u of ['alice', 'bob', 'carl', 'dave']) {
        const acc = NetworkOsAccount.create({
          name: u, privilege: 1, secret: u, passwordHashAlgorithm: 'md5',
        }).asFactoryDefault();
        this._credentialStore.upsert(acc);
      }
    }
    return this._credentialStore;
  }

  getSecurityAuditLog(): SecurityAuditLog {
    if (!this._securityAuditLog) this.getCredentialStore();
    return this._securityAuditLog!;
  }

  getSshSessionRegistry(): SshSessionRegistry {
    if (!this._sshSessionRegistry) this.getCredentialStore();
    return this._sshSessionRegistry!;
  }

  getSshHost(): CrossVendorSshHost {
    if (!this._sshHost) this.getCredentialStore();
    return this._sshHost!;
  }

  _addLocalUser(name: string, privilege: number, secret: string): void {
    this.getSecurityAuditLog();
    const existing = this.getCredentialStore().get(name);
    let acc = (existing ?? NetworkOsAccount.create({ name }))
      .withPrivilege(privilege)
      .withSecret(secret);
    if (acc.factoryDefault) acc = acc.asOperatorOwned();
    this.getCredentialStore().upsert(acc);
  }

  _upsertCiscoUsername(name: string, kv: CiscoUsernamePatch): void {
    this.getSecurityAuditLog();
    const store = this.getCredentialStore();
    const account = applyCiscoUsernamePatch(store.get(name) ?? NetworkOsAccount.create({ name }), kv);
    store.upsert(account);
  }
  _removeLocalUser(name: string): void {
    this.getSecurityAuditLog();
    this.getCredentialStore().remove(name);
  }
  _getLocalUser(name: string): { name: string; privilege: number; secret: string } | undefined {
    const a = this.getCredentialStore().get(name);
    return a ? { name: a.name, privilege: a.privilege, secret: a.secret } : undefined;
  }
  _listLocalUsers(): ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo: PasswordHashAlgorithm; view?: string; factoryDefault: boolean; serviceTypes: readonly string[]; noPassword: boolean; oneTime: boolean; noHangup: boolean; autocommand: string | null; description: string | null; accessClassIn: number | null; maxConcurrentSessions: number }> {
    return this.getCredentialStore().list().map(a => ({
      name: a.name, privilege: a.privilege, secret: a.secret,
      secretAlgo: a.passwordHashAlgorithm,
      view: a.view ?? undefined,
      factoryDefault: a.factoryDefault,
      noPassword: a.noPassword, oneTime: a.oneTime, noHangup: a.noHangup,
      autocommand: a.autocommand, description: a.description,
      accessClassIn: a.accessClassIn, maxConcurrentSessions: a.maxConcurrentSessions,
      // Le `service-type` etait stocke par `withServiceTypes()` et
      // laisse de cote par cette projection, si bien que le rendu
      // ecrivait `ssh` en dur : un compte configure `telnet` revenait
      // `ssh` apres rechargement.
      serviceTypes: a.serviceTypes,
    }));
  }

  _setSshServerEnabled(enabled: boolean): void {
    this.sshServerEnabled = enabled;
    if (this._sshHost) this._sshHost.setSshActive(enabled);
    this.syncSshListener();
  }

  /**
   * Does the box hold RSA host keys?
   *
   * IOS will not run an SSH server without them: `crypto key generate rsa`
   * is what actually turns SSH on, and `crypto key zeroize rsa` turns it
   * back off — which is the router's own version of deleting a Linux
   * host's `/etc/ssh/ssh_host_*_key` (docs/PRD-Pannes.md §F7.2). Overridden
   * by `CiscoRouter`, which owns the key store; a plain `Router` has no
   * crypto configuration to consult and therefore never withholds SSH.
   */
  hasSshHostKeys(): boolean { return true; }

  /**
   * Re-evaluate whether the SSH listener should be up, after something
   * that changes the answer without touching `transport input` — today,
   * generating or zeroizing the host keys.
   */
  _refreshSshAvailability(): void {
    if (this._sshHost) this._sshHost.setSshActive(this.isSshActive());
    this.syncSshListener();
  }

  // ─── FTP server surface (§2.1.20/P19) ───────────────────────────
  //
  // `ftp server enable` used to just flip a write-only toggle nothing
  // ever read (`_setGlobalToggle('ftp', true)`); this mounts a real
  // FtpServer on the router's own TcpStack, authenticated through the
  // same AAA-backed credential store as SSH (`checkPassword`), serving
  // a minimal flash: file surface (§2.1.19's `RouterSftpFileSystem`,
  // the same adapter the SCP/SFTP side uses for running-config-style
  // files) — real STOR/RETR/LIST against real files, not a config
  // serializer.

  protected ftpServerEnabled = false;
  private ftpServer: FtpServer | null = null;
  private ciscoFs: CiscoFileSystem | null = null;
  private udpEndpoint: ControlPlaneUdpEndpoint | null = null;

  /**
   * Les ports UDP que le plan de contrôle de CETTE machine tient
   * ouverts. Construit à la demande : un routeur qui ne fait aucune
   * copie réseau n'a aucun port éphémère et ne paie rien.
   */
  getUdpEndpoint(): ControlPlaneUdpEndpoint {
    if (!this.udpEndpoint) {
      this.udpEndpoint = new ControlPlaneUdpEndpoint({
        sendUdpBytes: (dst, dstPort, srcPort, payload) =>
          this.sendUdpBytesThroughFib(dst, dstPort, srcPort, payload),
      }, (port) => this.controlPlaneUdpOwner(port));
    }
    return this.udpEndpoint;
  }

  /**
   * Un datagramme d'octets émis à travers la FIB, comme `_sendIkeUdp` le
   * fait pour IKE. La somme de contrôle est nulle : c'est la clause de
   * retrait d'IPv4 de la RFC 768, et c'est ce que font déjà tous les
   * agents internes de ce simulateur.
   */
  sendUdpDatagram(request: UdpSendRequest): boolean {
    const route = this.lookupRoute(request.destination);
    if (!route) return false;
    const egress = this.ports.get(route.iface);
    if (!egress || !egress.isOperationallyUp()) return false;
    const source = request.source ?? egress.getIPAddress();
    if (!source) return false;

    this.sendIpv4FrameArpAware(
      route.iface, buildUdpOverIpv4(source, request),
      route.nextHop ?? request.destination);
    return true;
  }

  private sendUdpBytesThroughFib(
    destination: IPAddress, destinationPort: number,
    sourcePort: number, payload: Uint8Array,
  ): boolean {
    return this.sendUdpDatagram({
      destination, destinationPort, sourcePort,
      payload, payloadBytes: payload.length,
    });
  }

  /**
   * Le `flash:`/`nvram:` de CETTE machine, partagé par toutes ses
   * sessions. Il vivait sur le shell, donc `createVtyShell()` en donnait
   * un neuf à chaque session SSH : un fichier copié depuis la console
   * n'existait pas pour SSH, et réciproquement.
   *
   * Le profil châssis vient du shell, seul à le connaître ; il n'est lu
   * qu'à la création, la machine ne changeant pas de châssis.
   */
  _getCiscoFileSystem(
    profile: import('./shells/cisco/CiscoCommonShow').CiscoChassisProfile,
  ): CiscoFileSystem {
    if (!this.ciscoFs) this.ciscoFs = new CiscoFileSystem(profile);
    return this.ciscoFs;
  }

  /**
   * Les trois accesseurs que le serveur FTP/SFTP et `copy` utilisent.
   * Ils écrivaient dans une Map À PART, si bien que
   * `copy running-config flash:X` répondait `[OK]` et que `dir flash:`
   * ne montrait rien : deux magasins pour un seul `flash:`.
   */
  _writeFlashFile(name: string, content: string): void {
    this._getCiscoFileSystem('router-isr2911').write(name, content);
  }
  _readFlashFile(name: string): string | null {
    return this._getCiscoFileSystem('router-isr2911').read(name);
  }
  _listFlashFiles(): readonly string[] {
    return this._getCiscoFileSystem('router-isr2911').list().map((f) => f.name);
  }

  isFtpServerEnabled(): boolean { return this.ftpServerEnabled; }

  _setFtpServerEnabled(enabled: boolean): void {
    this.ftpServerEnabled = enabled;
    this.syncFtpListener();
  }

  private syncFtpListener(): void {
    if (this.ftpServerEnabled && !this.ftpServer) {
      this.ftpServer = this.buildFtpServer();
      this.ftpServer.start();
    }
    if (!this.ftpServerEnabled && this.ftpServer) {
      this.ftpServer.stop();
      this.ftpServer = null;
    }
  }

  private primaryIpAddress(): string {
    for (const port of this.ports.values()) {
      const ip = port.getIPAddress();
      if (ip) return ip.toString();
    }
    return '0.0.0.0';
  }

  private buildFtpServer(): FtpServer {
    const fs = new RouterSftpFileSystem({
      read: (path) => this._readFlashFile(path),
      write: (path, content) => { this._writeFlashFile(path, content); return true; },
      list: () => this._listFlashFiles(),
    });
    return new FtpServer(this.tcpv2, this.primaryIpAddress(), {
      users: new Map(),
      authenticate: (user, password) => this.checkPassword(user, password),
      fs,
      rootPath: '/',
      eventBus: this.getBus(),
    });
  }
  _setVtyTransportInput(t: 'ssh' | 'telnet' | 'all' | 'none', range?: { first: number; last: number }): void {
    if (range) {
      this.vtyLineConfig.upsert({ first: range.first, last: range.last, transportInput: t });
    } else {
      this.vtyTransportInput = t;
    }
    if (this._sshHost) this._sshHost.setSshActive(this.isSshActive());
    this.syncSshListener();
  }

  /**
   * Real `transport input` on the VTY lines — read by peers deciding
   * whether an OUTBOUND telnet/ssh from THEM would be accepted here
   * (`CiscoShellBase.remoteAcceptsTelnet`).
   */
  _getVtyTransportInput(): 'ssh' | 'telnet' | 'all' | 'none' {
    const ssh = this.transportAdmisSurUneVty('ssh');
    const telnet = this.transportAdmisSurUneVty('telnet');
    if (ssh && telnet) return 'all';
    if (ssh) return 'ssh';
    if (telnet) return 'telnet';
    return 'none';
  }

  /**
   * Validate <user, password> through the local-user AAA database the
   * router builds from `username … secret …` (Cisco) or `local-user …
   * password cipher …` (Huawei). Overrides the {@link Equipment} stub
   * so the SSH client doesn't need to know which vendor it's talking
   * to — `device.checkPassword` is the single-call entry point that
   * the LinuxMachine / WindowsPC counterparts already expose.
   */
  checkPassword(username: string, password: string): boolean {
    const authority = this.getSshHost().getAuthority();
    return authority.authenticate(username, password);
  }

  private _aaaAuthenticator: AaaAuthenticator | null = null;
  getAaaAuthenticator(): AaaAuthenticator {
    if (!this._aaaAuthenticator) this._aaaAuthenticator = new AaaAuthenticator(this);
    return this._aaaAuthenticator;
  }

  async authenticateViaAaa(username: string, password: string, methodListName?: string): Promise<boolean> {
    const outcome = await this.getAaaAuthenticator().authenticate(username, password, methodListName);
    return outcome.accepted;
  }

  /** SshExecTarget. */
  getSshHostname(): string { return this.hostname; }
  isSshActive(): boolean {
    return this.sshServerEnabled && this.hasSshHostKeys() && this.transportAdmisSurUneVty('ssh');
  }
  sshdAcceptsLogin(user: string): { ok: boolean; reason?: string } {
    return this.getSshHost().acceptsLogin(user);
  }
  recordSshLogin(
    user: string, fromIp: string, _fromHost: string,
    accepted: boolean, _method?: 'password' | 'publickey' | 'keyboard-interactive',
    localPort: number = 22,
  ): void {
    // Failures feed the same AAA event bus a native `CrossVendorSshHost
    // .evaluate()` login would — required so LoginBlocker/SecurityAuditLog
    // see failures from the interactive `ssh user@router` (bash) path too,
    // not just the synchronous cross-vendor exec path.
    if (!accepted) {
      this.getCredentialStore().recordLoginFailure(user, fromIp, 'bad password', Date.now());
      return;
    }
    // Successes are logged directly to the audit trail rather than through
    // `credentialStore.recordLoginSuccess()` -- that publishes on the same
    // bus topic SshSessionRegistry listens to for auto-opening a vty
    // session, and every caller of this method (sshLauncher.ts,
    // LinuxTerminalSession's cross-vendor ssh push, the cross-platform ssh
    // exec paths) already manages its own session lifecycle explicitly.
    // Going through the bus here would double-book the vty line.
    this.getSecurityAuditLog().record('SEC_LOGIN', 5, 'LOGIN_SUCCESS',
      `Login Success [user: ${user}] [Source: ${fromIp}] [localport: ${localPort}] [Reason: Login Authentication]`);
    this.getCredentialStore().consumeOneTime(user);
  }
  getSshBanner(): string { return this.sshBannerText; }
  getSshMotd(): string { return ''; }
  getSshPolicy(): {
    readonly active: boolean;
    readonly ports: readonly number[];
    readonly permitRootLogin: boolean;
    readonly passwordAuthentication: boolean;
    readonly pubkeyAuthentication: boolean;
    readonly maxAuthTries: number;
    readonly permitEmptyPasswords: boolean;
  } {
    return Object.freeze({
      active: this.sshServerEnabled,
      ports: Object.freeze([22]),
      permitRootLogin: true,
      passwordAuthentication: true,
      pubkeyAuthentication: true,
      maxAuthTries: 6,
      permitEmptyPasswords: false,
    });
  }
  getSshHostKey(): {
    readonly type: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
    readonly fingerprintSha256: string;
    readonly publicKey: string;
  } {
    return Object.freeze({
      type: 'ssh-rsa' as const,
      fingerprintSha256: `SHA256:router-${this.id}`,
      publicKey: `ssh-rsa AAAA-router-${this.id}`,
    });
  }

  /**
   * Per-vendor sync command whitelist. Default returns null so the
   * caller falls back; CiscoRouter and HuaweiRouter override with
   * their own pure show/display dispatch.
   */
  runSshCommandSync(_user: string, _command: string): { output: string; exitCode: number } | null {
    return null;
  }

  /**
   * Une commande executee a travers SSH, dans SA propre session vty et
   * AU NIVEAU DE SON COMPTE.
   *
   * Elle retombait sur `executeCommand`, c'est-a-dire sur le shell
   * partage de la console. Deux consequences, toutes deux mesurees :
   * un compte declare `privilege 7` repondait `Current privilege level
   * is 15` — le chapitre « qui a le droit de faire quoi » ne tenait pas
   * sur la porte par laquelle les administrateurs entrent vraiment — et
   * la session heritait du mode ou la console avait ete laissee, donc
   * deux connexions se marchaient dessus.
   *
   * Le niveau vient du compte, la ligne vty pouvant l'imposer par
   * `privilege level N` — c'est la meme regle que la session
   * interactive applique deja (`prepareAsRemoteUser`), lue ici au meme
   * endroit pour que les deux portes ne puissent pas diverger.
   */
  async runSshCommand(user: string, command: string): Promise<{ output: string; exitCode: number }> {
    const sync = this.runSshCommandSync(user, command);
    if (sync) return sync;
    const session = this.openVtySession();
    try {
      const niveau = this.sshSessionPrivilege(user);
      session.state.privilegeLevel = niveau;
      session.state.mode = niveau >= 15 ? 'privileged' : 'user';
      const output = await this.executeCommandInVty(command, session);
      return { output, exitCode: 0 };
    } finally {
      this.closeVtySession(session);
    }
  }

  /**
   * Le niveau qu'une session distante prend : celui que la ligne vty
   * impose, sinon celui du compte. Une seule regle, lue par le chemin
   * interactif comme par le chemin non interactif — deux portes qui
   * calculeraient le niveau chacune de leur cote finiraient par ne pas
   * donner le meme.
   */
  _niveauPourCompte(user: string): number {
    return this.sshSessionPrivilege(user);
  }

  /** Le niveau qu'une session SSH prend : celui de la ligne vty s'il est impose, sinon celui du compte. */
  private sshSessionPrivilege(user: string): number {
    const ligne = this._getVtyLineConfig().all()[0];
    const impose = (ligne as unknown as { privilege?: number | null } | undefined)?.privilege;
    if (typeof impose === 'number') return impose;
    return this.getCredentialStore().get(user)?.privilege ?? 1;
  }

  sshBanner(): string { return this.getSshBanner(); }
  /** @internal Used by CLI shells */
  setInterfaceDescription(portName: string, desc: string): void { this.interfaceDescriptions.set(portName, desc); }
  /** @internal Used by CLI shells */
  getInterfaceDescription(portName: string): string | undefined { return this.interfaceDescriptions.get(portName); }
  /** @internal Used by CLI shells */
  _getInterfaceDescriptions(): Map<string, string> { return this.interfaceDescriptions; }

  // ─── Ping (router-initiated ICMP echo) ────────────────────────

  /**
   * Execute a full ping sequence from this router.
   * Used by the Cisco IOS `ping` CLI command.
   */
  async executePingSequence(
    targetIP: IPAddress,
    count: number = 5,
    timeoutMs: number = 2000,
    sourceIPStr?: string,
    hooks?: {
      onResult?: (row: { success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string }) => void;
      /** IOS extended ping: `Set DF bit in IP header?` and `Type of service`. */
      df?: boolean;
      tos?: number;
      sizeBytes?: number;
      shouldStop?: () => boolean;
    },
  ): Promise<Array<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string }>> {
    // 127.0.0.0/8 est TOUJOURS local (RFC 1122 §3.2.1.3) : il n'a pas
    // besoin d'être configuré sur une interface pour répondre, et il
    // n'a pas de route. Sans ce cas, `ping 127.0.0.1` — le premier
    // réflexe pour vérifier qu'une pile IP est vivante — échouait à
    // 100 % sur une machine parfaitement saine.
    const boucleLocale = targetIP.toString().startsWith('127.');
    // Self-ping: check all interface IPs
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (boucleLocale || (myIP && myIP.equals(targetIP))) {
        const results = [];
        for (let seq = 1; seq <= count; seq++) {
          if (hooks?.shouldStop?.()) break;
          const row = { success: true, rttMs: 0.01, ttl: this.defaultTTL, seq, fromIP: targetIP.toString() };
          results.push(row);
          hooks?.onResult?.(row);
        }
        return results;
      }
    }

    const route = this.lookupRoute(targetIP);
    if (!route) {
      const rows = [];
      for (let seq = 1; seq <= count; seq++) {
        if (hooks?.shouldStop?.()) break;
        const row = { success: false, rttMs: 0, ttl: 0, seq, fromIP: '', error: 'timeout' };
        rows.push(row);
        hooks?.onResult?.(row);
      }
      return rows;
    }

    const outPort = this.ports.get(route.iface);
    if (!outPort) return [];

    // Determine source IP: use explicit source if provided, otherwise egress interface IP
    let myIP: IPAddress;
    if (sourceIPStr) {
      myIP = new IPAddress(sourceIPStr);
    } else {
      const ifIP = outPort.getIPAddress();
      if (!ifIP) return [];
      myIP = ifIP;
    }

    // Determine next-hop IP
    const nextHopIP = route.nextHop || targetIP;

    const existingArp = this.arpTable.get(nextHopIP.toString());
    let nextHopMAC: MACAddress | null = existingArp ? existingArp.mac : null;
    const arpAApprendre = !nextHopMAC;

    if (!nextHopMAC) {
      nextHopMAC = await this._resolveARPForPing(route.iface, outPort, nextHopIP, timeoutMs);
      if (!nextHopMAC) return [];
    }

    // Send pings
    const results: Array<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string }> = [];
    for (let seq = 1; seq <= count; seq++) {
      if (hooks?.shouldStop?.()) break;
      let row: { success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string };
      if (seq === 1 && arpAApprendre) {
        row = { success: false, rttMs: 0, ttl: 0, seq, fromIP: '', error: 'timeout' };
        results.push(row);
        hooks?.onResult?.(row);
        continue;
      }
      try {
        row = await this._sendPing(
          route.iface, outPort, myIP, targetIP, nextHopMAC, seq, timeoutMs,
          { df: hooks?.df, tos: hooks?.tos, sizeBytes: hooks?.sizeBytes },
        );
      } catch (err) {
        // A probe that ended because a router answered with an ICMP error
        // is not the same event as one nothing answered — the CLI prints a
        // different character for each.
        const cause = (err as { pingCause?: string } | null)?.pingCause ?? 'timeout';
        row = { success: false, rttMs: 0, ttl: 0, seq, fromIP: '', error: cause };
      }
      results.push(row);
      hooks?.onResult?.(row);
    }
    return results;
  }

  /**
   * The IPv6 counterpart of {@link executePingSequence}. A router had no
   * ICMPv6 emitter at all: it ANSWERED an Echo Request and could not send
   * one, so `ping ipv6` was refused on both vendors and every IPv6 lab on
   * a router was unverifiable from the router itself.
   */
  async executePing6Sequence(
    targetIP: IPv6Address,
    count: number = 5,
    timeoutMs: number = 2000,
    sourceIPStr?: string,
    hooks?: { sizeBytes?: number; shouldStop?: () => boolean },
  ): Promise<CiscoPingRow[]> {
    const targetStr = targetIP.toString();
    const rows: CiscoPingRow[] = [];
    const fill = (row: Omit<CiscoPingRow, 'seq'>): CiscoPingRow[] => {
      for (let seq = 1; seq <= count; seq++) {
        if (hooks?.shouldStop?.()) break;
        rows.push({ ...row, seq });
      }
      return rows;
    };

    let mine = targetIP.isLoopback();
    for (const [, port] of this.ports) {
      if (port.getIPv6Addresses().some((e) => e.address.equals(targetIP))) mine = true;
    }
    if (mine) {
      return fill({ success: true, rttMs: 0.01, ttl: 64, fromIP: targetStr });
    }

    const egress = this.ipv6Engine.resolveEgress(targetIP, sourceIPStr);
    if (!egress) return fill({ success: false, rttMs: 0, ttl: 0, fromIP: '', error: 'timeout' });

    // IOS counts the whole datagram: 40 bytes of IPv6 header and 8 of
    // ICMPv6 come off before the payload.
    const dataSize = Math.max(0, (hooks?.sizeBytes ?? 100) - 48);
    for (let seq = 1; seq <= count; seq++) {
      if (hooks?.shouldStop?.()) break;
      this.pingIdCounter++;
      const id = this.pingIdCounter;
      const sentAt = performance.now();
      const reply = waitForEvent(
        this.getBus(), 'host.icmp.echo-reply',
        (p) => p.deviceId === this.id && p.fromIp === targetStr && p.id === id && p.seq === seq,
        { timeoutMs, scheduler: this.getRouterScheduler() },
      );
      const failed = waitForEvent(
        this.getBus(), 'host.icmp.echo-failed',
        (p) => p.deviceId === this.id && (p.id === -1 || (p.id === id && p.seq === seq)),
        { timeoutMs, scheduler: this.getRouterScheduler() },
      );
      const replyOutcome = reply.then((r) => ({ kind: 'reply' as const, r }));
      const failedOutcome = failed.then((r) => ({ kind: 'failed' as const, r }));
      replyOutcome.catch(() => {});
      failedOutcome.catch(() => {});

      this.ipv6Engine.sendEchoRequest(egress, targetIP, id, seq, dataSize);
      this.emitIcmpEchoSent({
        fromIp: egress.sourceIP.toString(), toIp: targetStr,
        id, seq, ttl: 64, size: 8 + dataSize,
      });

      try {
        const winner = await Promise.race([replyOutcome, failedOutcome]);
        if (winner.kind === 'failed') {
          rows.push({
            success: false, rttMs: 0, ttl: 0, seq, fromIP: winner.r.fromIp,
            error: winner.r.reason,
          });
          continue;
        }
        rows.push({
          success: true, rttMs: performance.now() - sentAt,
          ttl: winner.r.ttl, seq, fromIP: targetStr,
        });
      } catch {
        rows.push({ success: false, rttMs: 0, ttl: 0, seq, fromIP: '', error: 'timeout' });
      }
    }
    return rows;
  }

  /**
   * The IPv6 counterpart of {@link executeTraceroute}. An intermediate
   * router answers Time Exceeded without echoing an identifier, so a
   * probe is correlated by the wildcard the failure path already uses
   * (`id === -1`) rather than by sequence — the same rule the IPv4 side
   * relies on for its own ICMP errors.
   */
  async executeTraceroute6(
    targetIP: IPv6Address,
    maxHops: number = 30,
    timeoutMs: number = 2000,
    probesPerHop: number = 3,
  ): Promise<TracerouteHop[]> {
    const egress = this.ipv6Engine.resolveEgress(targetIP);
    if (!egress) return [];
    const targetStr = targetIP.toString();
    const hops: TracerouteHop[] = [];

    for (let hopLimit = 1; hopLimit <= maxHops; hopLimit++) {
      const probes: TracerouteProbe[] = [];
      let reached = false;

      for (let p = 0; p < probesPerHop; p++) {
        this.pingIdCounter++;
        const id = this.pingIdCounter;
        const seq = p + 1;
        const sentAt = performance.now();

        const replyP = waitForEvent(
          this.getBus(), 'host.icmp.echo-reply',
          (pl) => pl.deviceId === this.id && pl.fromIp === targetStr
            && pl.id === id && pl.seq === seq,
          { timeoutMs, scheduler: this.getRouterScheduler() },
        );
        const failP = waitForEvent(
          this.getBus(), 'host.icmp.echo-failed',
          (pl) => pl.deviceId === this.id && (pl.id === -1 || (pl.id === id && pl.seq === seq)),
          { timeoutMs, scheduler: this.getRouterScheduler() },
        );
        const replyOutcome = replyP.then((pl) => ({
          ip: pl.fromIp, rttMs: performance.now() - sentAt,
          timeout: false, reached: true, unreachable: undefined as boolean | undefined,
        }));
        const failOutcome = failP.then((pl) => ({
          ip: pl.fromIp, rttMs: performance.now() - sentAt,
          timeout: false, reached: false, unreachable: pl.reason === 'unreachable',
        }));
        replyOutcome.catch(() => {});
        failOutcome.catch(() => {});

        this.ipv6Engine.sendEchoRequest(egress, targetIP, id, seq, 56, hopLimit);

        const probe = await Promise.race([replyOutcome, failOutcome]).catch((err) => {
          if (err instanceof WaitForEventTimeoutError) {
            return { timeout: true, reached: false } as {
              ip?: string; rttMs?: number; timeout: boolean; reached: boolean;
              unreachable?: boolean;
            };
          }
          throw err;
        });

        probes.push({
          responded: !probe.timeout, rttMs: probe.rttMs,
          ip: probe.ip, unreachable: probe.unreachable,
        });
        if (probe.reached) reached = true;
      }

      const firstResponded = probes.find(p => p.responded);
      const firstUnreachable = probes.find(p => p.unreachable);
      hops.push({
        hop: hopLimit,
        ip: firstResponded?.ip,
        rttMs: firstResponded?.rttMs,
        timeout: probes.every(p => !p.responded),
        unreachable: !!firstUnreachable,
        probes,
      });

      if (reached || firstUnreachable) break;
    }
    return hops;
  }

  /**
   * Execute a traceroute from this router to `targetIP`.
   * Used by Cisco IOS `traceroute` and Huawei VRP `tracert` CLI commands.
   * Sends ICMP echo probes with incrementing TTL and collects Time Exceeded / echo-reply.
   */
  async executeTraceroute(
    targetIP: IPAddress,
    maxHops: number = 30,
    timeoutMs: number = 2000,
    probesPerHop: number = 3,
  ): Promise<Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; probes: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> }>> {
    const route = this.lookupRoute(targetIP);
    if (!route) return [];

    const outPort = this.ports.get(route.iface);
    if (!outPort) return [];
    const myIP = outPort.getIPAddress();
    if (!myIP) return [];

    const nextHopIP = route.nextHop || targetIP;

    // ARP resolve first-hop MAC
    const existingArp = this.arpTable.get(nextHopIP.toString());
    let nextHopMAC: MACAddress | null = existingArp ? existingArp.mac : null;
    if (!nextHopMAC) {
      nextHopMAC = await this._resolveARPForPing(route.iface, outPort, nextHopIP, timeoutMs);
      if (!nextHopMAC) return [{ hop: 1, timeout: true, probes: [{ responded: false }] }];
    }

    const hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; probes: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> }> = [];

    for (let ttl = 1; ttl <= maxHops; ttl++) {
      const probes: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> = [];
      let destinationReached = false;

      for (let p = 0; p < probesPerHop; p++) {
        this.pingIdCounter++;
        const id = this.pingIdCounter;
        const seq = p + 1;
        const targetIpStr = targetIP.toString();
        const sentAt = performance.now();

        // Phase 5.9: traceroute settles via the bus.
        const replyP = waitForEvent(
          this.getBus(),
          'host.icmp.echo-reply',
          (pl) => pl.deviceId === this.id && pl.fromIp === targetIpStr && pl.id === id && pl.seq === seq,
          { timeoutMs, scheduler: this.getRouterScheduler() },
        );
        const failP = waitForEvent(
          this.getBus(),
          'host.icmp.echo-failed',
          (pl) => pl.deviceId === this.id && pl.id === id && pl.seq === seq,
          { timeoutMs, scheduler: this.getRouterScheduler() },
        );

        const icmp: ICMPPacket = {
          type: 'icmp', icmpType: 'echo-request', code: 0,
          id, sequence: seq, dataSize: 56,
        };
        const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, ttl, icmp, 64);

        this.sendFrame(route.iface, {
          srcMAC: outPort.getMAC(),
          dstMAC: nextHopMAC!,
          etherType: ETHERTYPE_IPV4,
          payload: ipPkt,
        });

        const replyOutcome = replyP.then((pl) => ({
          ip: pl.fromIp,
          rttMs: performance.now() - sentAt,
          timeout: false, reached: true,
          unreachable: undefined as boolean | undefined,
        }));
        const failOutcome = failP.then((pl) => ({
          ip: pl.fromIp,
          rttMs: performance.now() - sentAt,
          timeout: false, reached: false,
          unreachable: pl.reason.includes('Destination unreachable'),
        }));
        // Observe the race loser's eventual timeout rejection.
        replyOutcome.catch(() => {});
        failOutcome.catch(() => {});

        const probe = await Promise.race([replyOutcome, failOutcome]).catch((err) => {
          if (err instanceof WaitForEventTimeoutError) {
            return { timeout: true, reached: false } as {
              ip?: string; rttMs?: number; timeout: boolean; reached: boolean;
              unreachable?: boolean;
            };
          }
          throw err;
        });

        probes.push({
          responded: !probe.timeout,
          rttMs: probe.rttMs,
          ip: probe.ip,
          unreachable: probe.unreachable,
        });
        if (probe.reached) destinationReached = true;
      }

      const firstResponded = probes.find(p => p.responded);
      const firstUnreachable = probes.find(p => p.unreachable);
      const allTimeout = probes.every(p => !p.responded);

      hops.push({
        hop: ttl,
        ip: firstResponded?.ip,
        rttMs: firstResponded?.rttMs,
        timeout: allTimeout,
        unreachable: !!firstUnreachable,
        probes,
      });

      if (destinationReached) break;
      if (firstUnreachable) break;
    }

    return hops;
  }

  /** @internal Resolve ARP for ping, returns MAC or null on timeout */
  private async _resolveARPForPing(iface: string, port: Port, nextHopIP: IPAddress, timeoutMs: number): Promise<MACAddress | null> {
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) return cached.mac;

    const myIP = port.getIPAddress()!;
    const key = nextHopIP.toString();

    // Phase 5.8: await the reactive learn event instead of a pendingARPs callback.
    const waitPromise = waitForEvent(
      this.getBus(),
      'host.arp.entry-learned',
      (p) => p.deviceId === this.id && p.ip === key,
      { timeoutMs, scheduler: this.getRouterScheduler() },
    );

    const arpReq: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: port.getMAC(), senderIP: myIP,
      targetMAC: MACAddress.broadcast(), targetIP: nextHopIP,
    };
    this.emitArpRequestSent(iface, key);
    this.sendFrame(iface, {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: arpReq,
    });

    try {
      const learned = await waitPromise;
      return new MACAddress(learned.mac);
    } catch (err) {
      if (err instanceof WaitForEventTimeoutError) return null;
      throw err;
    }
  }

  /** @internal Send a single ping and wait for reply */
  private async _sendPing(
    iface: string, port: Port, myIP: IPAddress, targetIP: IPAddress,
    dstMAC: MACAddress, seq: number, timeoutMs: number,
    opts?: { df?: boolean; tos?: number; sizeBytes?: number },
  ): Promise<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string }> {
    // Line protocol down — the probe fails immediately instead of burning a
    // full timeout waiting for a reply the severed link can never carry
    // (docs/PRD-Link-State.md §2.1 P4).
    if (!port.isOperationallyUp()) {
      throw new Error(`Destination unreachable from ${myIP}`);
    }

    this.pingIdCounter++;
    const id = this.pingIdCounter;

    const targetIpStr = targetIP.toString();
    const sentAt = performance.now();

    // Phase 5.8: settle via the reactive bus instead of pendingPings.
    const replyPromise = waitForEvent(
      this.getBus(),
      'host.icmp.echo-reply',
      (p) => p.deviceId === this.id && p.fromIp === targetIpStr && p.id === id && p.seq === seq,
      { timeoutMs, scheduler: this.getRouterScheduler() },
    );
    const failedPromise = waitForEvent(
      this.getBus(),
      'host.icmp.echo-failed',
      (p) => p.deviceId === this.id
        && (p.id === -1 || (p.id === id && p.seq === seq))
        && (p.toIp === targetIpStr || p.toIp === ''),
      { timeoutMs, scheduler: this.getRouterScheduler() },
    );

    // IOS counts the whole IP datagram in `Datagram size`, so the ICMP
    // payload is that minus the 20-byte IP header and the 8-byte ICMP one.
    const datagram = Math.max(28, opts?.sizeBytes ?? 100);
    const dataSize = datagram - 28;
    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-request', code: 0,
      id, sequence: seq, dataSize,
    };
    const icmpSize = 8 + dataSize;
    const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, this.defaultTTL, icmp, icmpSize);
    if (opts?.tos) ipPkt.tos = opts.tos;
    // RFC 791 §3.1: DF is bit 1 of the flags field. With it set a router
    // that would have to fragment answers ICMP type 3 code 4 instead,
    // which is what makes `Set DF bit` a real path-MTU probe.
    if (opts?.df) ipPkt.flags |= 0x2;

    this.emitIcmpEchoSent({
      fromIp: myIP.toString(), toIp: targetIpStr,
      id, seq, ttl: this.defaultTTL, size: icmpSize,
    });

    // IPSec outbound processing for locally-originated packets
    if (this.ipsecEngine) {
      const entry = this.ipsecEngine.findMatchingCryptoEntry(ipPkt, iface);
      if (entry) {
        const encPkts = this.ipsecEngine.processOutbound(ipPkt, iface, entry);
        if (encPkts) {
          for (const p of encPkts) {
            this.sendFrame(iface, {
              srcMAC: port.getMAC(), dstMAC,
              etherType: ETHERTYPE_IPV4, payload: p,
            });
          }
        }
        // If processOutbound returned null, packet is dropped — the timeout
        // will reject. Either way, fall through to the wait below.
      } else {
        this.sendFrame(iface, {
          srcMAC: port.getMAC(), dstMAC,
          etherType: ETHERTYPE_IPV4, payload: ipPkt,
        });
      }
    } else {
      this.sendFrame(iface, {
        srcMAC: port.getMAC(), dstMAC,
        etherType: ETHERTYPE_IPV4, payload: ipPkt,
      });
    }

    const replyOutcome = replyPromise.then((r) => ({ kind: 'reply' as const, r }));
    const failedOutcome = failedPromise.then((r) => ({ kind: 'failed' as const, r }));
    // Observe the race loser's eventual timeout rejection.
    replyOutcome.catch(() => {});
    failedOutcome.catch(() => {});

    try {
      const winner = await Promise.race([replyOutcome, failedOutcome]);
      if (winner.kind === 'failed') {
        const err = new Error(winner.r.reason) as Error & { pingCause?: string };
        // IOS marks the probe by the ICMP type that answered it: a
        // Destination Unreachable is `U`, a Time Exceeded is `&`.
        err.pingCause = /Time to live exceeded/i.test(winner.r.reason)
          ? 'ttl-exceeded'
          : /code 4\b/.test(winner.r.reason)
            ? 'frag-needed'
            : /Destination unreachable/i.test(winner.r.reason)
              ? 'unreachable'
              : 'timeout';
        throw err;
      }
      const rtt = performance.now() - sentAt;
      return {
        success: true,
        rttMs: rtt,
        ttl: winner.r.ttl,
        seq,
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

  /** @internal Used by CLI shells for NAT configuration */
  _getNATEngine(): NATEngine { return this.natEngine; }

  /** @internal Lazily create + return the IPSec engine for this router */
  _getOrCreateIPSecEngine(): IPSecEngine {
    if (!this.ipsecEngine) {
      this.ipsecEngine = new IPSecEngine(this);
      this.ipsecEngine.setEventBus(this.getBus());
      const svc = this._debugService;
      if (svc) {
        this.ipsecEngine.setDebugEmitter((kind, line) => {
          svc.emitLine(kind === 'ipsec' ? 'crypto.ipsec' : 'crypto.isakmp', line);
        });
      }
    }
    return this.ipsecEngine;
  }

  /** @internal Return IPSec engine (null if not yet configured) */
  _getIPSecEngineInternal(): IPSecEngine | null { return this.ipsecEngine; }

  // ─── ACL Public API — delegated to ACLEngine ──────────────────

  getAccessLists() { return this.aclEngine.getAccessLists(); }
  /**
   * Quelle plage de numéros désigne quel type de liste. IOS par défaut ;
   * les sous-classes VRP posent la leur, les deux conventions se
   * contredisant sur 2000-2699.
   */
  _setAclNumberingPolicy(fn: AclNumbering) { this.aclEngine.setNumberingPolicy(fn); }
  _setAclSequencingPolicy(fn: AclSequencing, step: number) { this.aclEngine.setSequencingPolicy(fn, step); }
  _setAclUnmatchedDataPlaneAction(a: 'permit' | 'deny') { this.aclEngine.setUnmatchedDataPlaneAction(a); }
  _aclEnsure(id: number) { this.aclEngine.ensureAccessList(id); }
  _aclSetStep(ref: number | string, step: number) { return this.aclEngine.setStep(ref, step); }
  _aclSetDescription(ref: number | string, t: string) { return this.aclEngine.setDescription(ref, t); }
  _aclRemoveEntry(ref: number | string, seq: number) { return this.aclEngine.removeEntryBySequence(ref, seq); }
  _aclFind(ref: number | string) { return this.aclEngine.findRef(ref); }
  _aclDefaultStep() { return this.aclEngine.getDefaultStep(); }
  _aclEvaluateDataPlane(ref: number | string, pkt: IPv4Packet) { return this.aclEngine.evaluateForDataPlane(ref, pkt); }
  addAccessListEntry(...args: Parameters<ACLEngine['addAccessListEntry']>) { this.aclEngine.addAccessListEntry(...args); }
  addNamedAccessListEntry(...args: Parameters<ACLEngine['addNamedAccessListEntry']>) { this.aclEngine.addNamedAccessListEntry(...args); }
  removeAccessList(id: number) { this.aclEngine.removeAccessList(id); }
  removeNamedAccessList(name: string) { this.aclEngine.removeNamedAccessList(name); }
  setInterfaceACL(ifName: string, direction: 'in' | 'out', aclRef: number | string) { this.aclEngine.setInterfaceACL(ifName, direction, aclRef); }
  removeInterfaceACL(ifName: string, direction: 'in' | 'out') { this.aclEngine.removeInterfaceACL(ifName, direction); }
  getInterfaceACL(ifName: string, direction: 'in' | 'out') { return this.aclEngine.getInterfaceACL(ifName, direction); }
  evaluateACLByName(name: string, ipPkt: IPv4Packet, now?: Date) {
    return this.aclEngine.evaluateACLByName(name, ipPkt, now);
  }

  _getReflexiveSessions() { return this.aclEngine.getReflexiveSessions(); }

  _ensureNamedAccessList(name: string, type: 'standard' | 'extended') { this.aclEngine.ensureNamedAccessList(name, type); }
  _aclHasSequence(name: string, seq: number) { return this.aclEngine.hasSequence(name, seq); }
  _getAccessListsInternal() { return this.aclEngine.getAccessListsInternal(); }

  /** @internal Le moteur d'ACL lui-meme, pour les groupes d'objets. */
  _getACLEngineInternal() { return this.aclEngine; }
  _getInterfaceACLBindingsInternal() { return this.aclEngine.getInterfaceACLBindingsInternal(); }
  _removeNamedACLEntryBySequence(name: string, seq: number) { return this.aclEngine.removeNamedACLEntryBySequence(name, seq); }
  _resequenceNamedACL(name: string, start: number, step: number) { return this.aclEngine.resequenceNamedACL(name, start, step); }
  _findNamedACL(name: string) { return this.aclEngine.findByName(name); }
  _findNumberedACL(id: number) { return this.aclEngine.findById(id); }
  resetAclCounters(aclRef: number | string): boolean { return this.aclEngine.resetCounters(aclRef); }
  resetAllAclCounters(): void { this.aclEngine.resetAllCounters(); }

  // ─── DHCP Server Public API ────────────────────────────────────

  getDHCPServer(): DHCPServer { return this.dhcpServer; }

  // ═══════════════════════════════════════════════════════════════════
  // OSPF Engine Integration — delegated to RouterOSPFIntegration
  // ═══════════════════════════════════════════════════════════════════

  /** @internal Used by CLI shells */
  _enableOSPF(processId: number = 1): void { this.ospfIntegration.enableOSPF(processId); }

  /** @internal Used by CLI shells */
  _disableOSPF(): void { this.ospfIntegration.disableOSPF(); }

  /** @internal Used by CLI shells */
  _enableOSPFv3(processId: number = 1): void { this.ospfIntegration.enableOSPFv3(processId); }

  /** Overridden by vendor subclasses that actually own a BfdAgent. */
  getBfdAgent(): import('../bfd/BfdAgent').BfdAgent | undefined { return undefined; }

  /** Overridden by vendor subclasses that actually own a PimAgent. */
  getPimAgent(): import('../pim/PimAgent').PimAgent | undefined { return undefined; }

  /** @internal */
  _getOSPFEngineInternal() { return this.ospfIntegration.getOSPFEngine(); }

  /** @internal */
  _getOSPFv3EngineInternal() { return this.ospfIntegration.getOSPFv3Engine(); }

  isOSPFEnabled(): boolean { return this.ospfIntegration.isOSPFEnabled(); }

  /** @internal */
  _getOSPFExtraConfig() { return this.ospfIntegration.getExtraConfig(); }

  /** @internal */
  _getOSPFIntegration(): RouterOSPFIntegration { return this.ospfIntegration; }

  /** Trigger OSPF convergence. @internal */
  _ospfAutoConverge(): void { this.ospfIntegration.autoConverge(); }

  /**
   * Send an OSPF packet out an interface (encapsulated in IP).
   * Called by OSPFEngine sendCallback.
   * @internal
   */
  ospfSendPacket(outIface: string, ospfPkt: any, destIP: string): void {
    // Packet sending is now handled internally by RouterOSPFIntegration.
    // This method is kept for backward compatibility if anything calls it directly.
    this._ospfAutoConverge();
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return this.shell.getOSType(); }
}

