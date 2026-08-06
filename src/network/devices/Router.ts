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
import { deviceClockSource } from './inspection/config/LoggingConfig';
import type { IEventBus } from '@/events/EventBus';
import { VtyLineConfigStore } from './router/vty/VtyLineConfigStore';
import { VtyIncomingPolicy, type VtyAdmissionVerdict, type VtyTransportKind } from './router/vty/VtyIncomingPolicy';
import { AaaAuthenticator } from './router/aaa/AaaAuthenticator';
import { RouterHostsTable } from './router/dns/RouterHostsTable';
import { RouterSshKnownHosts } from './router/ssh/RouterSshKnownHosts';
import { CommandAliasTable } from './router/cli/CommandAliasTable';
import { IpPrefixListStore } from './router/policy/IpPrefixList';
import { RoutePolicyStore } from './router/policy/RoutePolicy';
import { TrafficPolicyStore } from './router/policy/TrafficPolicy';
import { NqaService } from '../nqa/NqaService';
import { Port } from '../hardware/Port';
import { CliShellSession } from './shells/vty/CliShellSession';
import { TimerSet } from '@/events/TimerSet';
import { TcpStack, type TcpSocket } from '../tcp/TcpStack';
import type { TcpStream } from '../tcp/types';
import { verifyUdpChecksum } from '../tcp/types';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { RouterSshServerContext } from '../protocols/ssh/server/RouterSshServerContext';
import { TelnetServerHandler } from '../protocols/telnet/TelnetServerHandler';
import { RouterTelnetServerContext } from '../protocols/telnet/RouterTelnetServerContext';
import { SshHostKey } from '../protocols/ssh/SshHostKey';
import { FtpServer } from '../ftp/FtpServer';
import { RouterSftpFileSystem } from '../protocols/ssh/sftp/RouterSftpFileSystem';
import type { SshExecTarget } from '../protocols/ssh/server/SshExecTarget';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { waitForEvent, WaitForEventTimeoutError } from '@/events/waitForEvent';
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
import type { IIPv4Route } from '../core/interfaces';
import { ipv4MulticastToMac } from '../core/ip';
import { Logger } from '../core/Logger';
import { CarPolicer } from './router/qos/CarPolicer';
import { buildICMPError, mayGenerateICMPError, type ICMPErrorType } from '../core/IcmpErrors';
import { IpSlaEngine } from '../ipsla/IpSlaEngine';
import { TrackService } from '../ipsla/TrackService';
import type { IpSlaEgress } from '../ipsla/types';
import { dialHttp } from '../http/HttpClient';
import { md5Hex } from '@/crypto/hash/md5';
import type { KeyChainRepository } from './inspection/config/KeyChainRepository';
import { fragmentIPv4, IPv4Reassembler } from '../core/Ipv4Fragmentation';
import type { FhrpDataPlane } from '../fhrp/types';
import { DHCPServer } from '../dhcp/DHCPServer';
import { DHCPPacket } from '../dhcp/DHCPPacket';
import { buildDhcpServerReply } from '../dhcp/DhcpServerExchange';
import type { DHCPDiscoverParams, DHCPOfferResult } from '../dhcp/types';
import { DHCPv6Server } from '../dhcpv6/DHCPv6Server';
import { DHCPv6Packet } from '../dhcpv6/DHCPv6Packet';
import { IPSecEngine } from '../ipsec/IPSecEngine';
import type { NetFlowAgent, NetFlowRecordInput } from '../netflow/NetFlowAgent';
import { ACLEngine } from './router/ACLEngine';
import { isTimeRangeActive, type CiscoSecurityConfig } from './router/security/CiscoSecurityConfig';
export type { ACLEntry, AccessList, InterfaceACLBinding } from './router/ACLEngine';
import { RouterRIPEngine } from './router/RouterRIPEngine';
export type { RIPConfig } from './router/RouterRIPEngine';
import { IPv6DataPlane } from './router/IPv6DataPlane';
export type { IPv6RouteEntry, NeighborState, NeighborCacheEntry, RAConfig } from './router/IPv6DataPlane';
import { RouterOSPFIntegration } from './router/RouterOSPFIntegration';
import { RouterDynamicRouting } from './router/RouterDynamicRouting';
import { NetworkOsCredentialStore } from './router/aaa/NetworkOsCredentialStore';
import { SecurityAuditLog } from './router/aaa/SecurityAuditLog';
import { NetworkOsAccount, type PasswordHashAlgorithm } from './router/aaa/NetworkOsAccount';
import { LoginBlocker } from './router/aaa/LoginBlocker';
import { SshSessionRegistry } from './router/aaa/SshSessionRegistry';
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
import { SnmpService } from './router/management/SnmpService';
import { EemService } from './router/eem/EemService';
import { EemEngine, type EemHost } from './router/eem/EemEngine';
import type { SnmpAgent } from '../snmp/SnmpAgent';
import { NetflowService } from './router/netflow/NetflowService';
import { ArchiveService } from './router/archive/ArchiveService';
import { KeypairService } from './router/security/KeypairService';
import { HuaweiRoutingExtras } from './router/routing/HuaweiRoutingExtras';
import { HuaweiVrrpService } from './router/redundancy/HuaweiVrrpService';
import { HuaweiBfdService } from './router/bfd/HuaweiBfdService';
import { HuaweiAaaService } from './router/aaa/HuaweiAaaService';
export type { NatStaticEntry, NatPool, NatDynamicRule, NatSession, NatTranslationEntry } from './router/NATEngine';

// ─── Routing Table (RIB) ───────────────────────────────────────────

/**
 * A router's IPv4 routing-table entry — the canonical IIPv4Route
 * (network/mask/nextHop/iface/type/ad/metric) plus router-only annotations.
 */
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

interface ARPEntry {
  mac: MACAddress;
  iface: string;
  timestamp: number;
  type: 'dynamic' | 'static';
}

/** Packets waiting for ARP resolution */
interface QueuedPacket {
  frame: IPv4Packet;
  outIface: string;
  nextHopIP: IPAddress;
  timer: symbol;
}

// ─── CLI Shell (imported from shells/) ──────────────────────────────

import type { IRouterShell } from './shells/IRouterShell';
import { iosInterfaceUsable, interfacesBootShutdown } from './inspection/InterfaceStatusView';

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

export abstract class Router extends Equipment implements CredentialAuthenticator {
  // ── Control Plane ─────────────────────────────────────────────
  private routingTable: RouteEntry[] = [];
  /** Round-robin cursor across genuinely tied (same prefix/AD/metric) ECMP candidates in lookupRoute(). */
  private ecmpCursor = 0;
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
  private ospfIntegration!: RouterOSPFIntegration;
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
    });
    this.shell = this.createShell();
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
    this.natEngine.setACLMatchFn((aclId, srcIP, realPkt) => {
      const pkt = realPkt ?? ({ type: 'ipv4', sourceIP: new IPAddress(srcIP) } as any);
      // Undefined ACL = no interesting traffic, so require an explicit permit.
      return this.aclEngine.evaluateACLByName(String(aclId), pkt) === 'permit';
    });
    this.natEngine.setInterfaceIPFn((iface) => {
      const port = this.ports.get(iface);
      return port?.getIPAddress()?.toString() ?? null;
    });
    this.createPorts();
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
    this._debugService?.attachToBus(this.getBus(), this.id);
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
  private resolveVtyLoginMode(): 'none' | 'local' | 'aaa' | 'password' {
    const block = this.vtyLineConfig.all()[0];
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
      linePassword: () => this.vtyLineConfig.all()[0]?.linePassword ?? null,
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

  private telnetAllowedByTransport(): boolean {
    return this.vtyTransportInput === 'all' || this.vtyTransportInput === 'telnet';
  }

  private syncSshListener(): void {
    const sshBound = this.tcpv2.listListeners().some(l => l.localPort === 22);
    // Keys are part of "is the server up", not a separate switch: IOS
    // refuses to listen without them.
    const shouldListen = this.sshServerEnabled && this.hasSshHostKeys();
    if (shouldListen && !sshBound) this.bindSshListener();
    if (!shouldListen && sshBound) this.tcpv2.closeListener(22);
    const telnetWanted = this.telnetAllowedByTransport();
    const telnetBound = this.tcpv2.listListeners().some(l => l.localPort === 23);
    if (telnetWanted && !telnetBound) this.bindTelnetListener();
    if (!telnetWanted && telnetBound) this.tcpv2.closeListener(23);
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
      execIdleTimeoutMs: () => this.resolveVtyIdleTimeoutMs(),
      banner: () => this.sshBannerText || null,
      aaaAuthenticate: (n, p) => this.authenticateViaAaa(n, p),
      // Reuse the exact admission/failure-tracking the cross-vendor bypass
      // used to gate on its own (login block-for / quiet-mode ACL /
      // LoginBlocker) so real-wire SSH enforces the same security policy a
      // Cisco/Huawei device configures via CLI, instead of losing it when
      // the client stops calling checkPassword() directly.
      isClientBlocked: (ip) => !this.vtyAdmissionVerdict('ssh', ip).accept,
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
    const socket = this.tcpv2.connect(dstIp, dstPort);
    if (!socket) return null;
    if (socket.state === 'established') return socket;
    return new Promise((resolve) => {
      let offOpen: () => void = () => {};
      let offClose: () => void = () => {};
      offOpen = socket.onOpen(() => { offOpen(); offClose(); resolve(socket); });
      offClose = socket.onClose(() => { offOpen(); offClose(); resolve(null); });
    });
  }

  private createPorts(): void {
    const portCount = 4;
    const adminDown = this.bootsInterfacesShutdown() && interfacesBootShutdown();
    for (let i = 0; i < portCount; i++) {
      const portName = this.getVendorPortName(i);
      this.addPort(new Port(portName, 'ethernet', undefined, { adminDown }));
    }
  }

  protected bootsInterfacesShutdown(): boolean {
    return false;
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
  isRouteUsable(route: { iface: string; track?: string; permanent?: boolean }): boolean {
    if (!this.isRouteTrackUp(route.track)) return false;
    if (route.permanent) return true;
    return this.isRouteInterfaceUsable(route.iface);
  }

  private _setupPortMonitoring(): void {
    for (const [name, port] of this.ports) {
      port.onLinkChange((state) => {
        this.syncRouteDebug();
        if (state === 'up') {
          this._ospfAutoConverge();
        } else {
          this.ipsecEngine?.onPortDown(name);
          this.ospfIntegration.onPortDown(name);
        }
        // EIGRP/BGP have no port-down hook of their own (unlike OSPF's
        // onPortDown above): without this, a dead neighbor/route just
        // lingers in the RIB until an operator happens to run a CLI
        // command, since converge() is otherwise only CLI-triggered
        // (RouterDynamicRouting.ts — no real hold/SIA timers yet, see
        // CLAUDE.md). This doesn't add real timer-driven convergence,
        // it only makes the existing recompute run on link events too.
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
    const block = this.vtyLineConfig.all()[0];
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
  private resolveVtyExecLevel(user?: string): number {
    const lineLevel = this.vtyLineConfig.all()[0]?.privilege;
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

    this.routingTable.push({
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
    });

    Logger.info(this.id, 'router:route-add',
      `${this.name}: static route ${network}/${mask.toCIDR()} via ${nextHop} metric ${metric}`);
    return true;
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

  /** Longest Prefix Match (LPM) — tiebreaking: prefix → AD → metric */
  private lookupRoute(destIP: IPAddress): RouteEntry | null {
    // Keep EIGRP/BGP-learned routes fresh for the data path WITHOUT
    // emitting protocol frames: routes already received from the wire
    // are reflected into the RIB before every forwarding decision.
    // Real Hello/Update rounds happen at config/show time (triggered
    // updates) — a router does not hello on every packet it forwards.
    if (this.dynamicRouting?.hasActive()) this.dynamicRouting.refresh();

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
    if (candidates.length === 1) return candidates[0];
    return candidates[this.ecmpCursor++ % candidates.length];
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
  ripAdvertiseNetwork(network: IPAddress, mask: SubnetMask) { this.ripEngine.advertiseNetwork(network, mask); }
  ripSetPassiveInterface(iface: string) { this.ripEngine.setPassiveInterface(iface); }
  ripRemovePassiveInterface(iface: string) { this.ripEngine.removePassiveInterface(iface); }
  ripSetRedistribution(source: import('./router/RouterRIPEngine').RIPRedistSourceArg, metric?: number, routePolicy?: string) { this.ripEngine.setRedistribution(source, metric, routePolicy); }
  ripRemoveRedistribution(source: import('./router/RouterRIPEngine').RIPRedistSourceArg) { this.ripEngine.removeRedistribution(source); }
  ripSetDefaultMetric(metric: number | null) { this.ripEngine.setDefaultMetric(metric); }
  ripSetDefaultInformationOriginate(on: boolean) { this.ripEngine.setDefaultInformationOriginate(on); }

  /** Real dynamic-routing engines (EIGRP/BGP) + topology adapter. */
  getDynamicRouting() { return this.dynamicRouting; }
  getEIGRPEngine() { return this.dynamicRouting.eigrp; }
  getBGPEngine() { return this.dynamicRouting.bgp; }
  /** Recompute EIGRP/BGP adjacencies+routes from real topology. */
  convergeDynamicRouting() { this.dynamicRouting.converge(); }

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

    // Phase A.1: L2 Filter — accept unicast for us, broadcast, or multicast
    const isForUs = frame.dstMAC.equals(port.getMAC());
    const isBroadcast = frame.dstMAC.isBroadcast();
    const octets = frame.dstMAC.getOctets();
    const isIpv6Multicast = octets[0] === 0x33 && octets[1] === 0x33;
    // RFC 1112 §6.4 — IPv4 multicast maps to 01:00:5e:…
    const isIpv4Multicast =
      octets[0] === 0x01 && octets[1] === 0x00 && octets[2] === 0x5e;

    if (!isForUs && !isBroadcast && !isIpv6Multicast && !isIpv4Multicast
      && !this.fhrpOwnsVirtualMac(portName, frame.dstMAC.toString())) {
      return;
    }

    // Phase A.2: EtherType dispatch
    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.counters.ifInOctets += (frame.payload as IPv4Packet)?.totalLength || 0;
      this.processIPv4(portName, frame.payload as IPv4Packet);
    } else if (frame.etherType === ETHERTYPE_IPV6) {
      if (this.ipv6Engine.isRoutingEnabled() || isIpv6Multicast) {
        this.ipv6Engine.processPacket(portName, frame.payload as IPv6Packet, frame.srcMAC);
      }
    }
  }

  // ─── Control Plane: ARP Handling ──────────────────────────────

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

    // B.1: Checksum verification
    if (!verifyIPv4Checksum(ipPkt)) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:checksum-fail',
        `${this.name}: invalid IPv4 checksum, dropping`);
      return;
    }

    // B.2: Version check — must be 4
    if (ipPkt.version !== 4) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:version-fail',
        `${this.name}: IPv4 version ${ipPkt.version} != 4, dropping`);
      return;
    }

    // B.3: IHL check — must be >= 5 (20 bytes minimum header)
    if (ipPkt.ihl < 5) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:ihl-fail',
        `${this.name}: IHL ${ipPkt.ihl} < 5, dropping`);
      return;
    }

    // B.4: TotalLength check — must be at least IHL*4
    if (ipPkt.totalLength < ipPkt.ihl * 4) {
      this.counters.ipInHdrErrors++;
      Logger.warn(this.id, 'router:length-fail',
        `${this.name}: totalLength ${ipPkt.totalLength} < header ${ipPkt.ihl * 4}, dropping`);
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
    const isBroadcast = destIP.toString() === '255.255.255.255';
    const destOctets = destIP.toString().split('.').map(Number);
    const isMulticast = destOctets[0] >= 224 && destOctets[0] <= 239;
    const isLinkLocalMulticast = destOctets[0] === 224 && destOctets[1] === 0 && destOctets[2] === 0;

    if (isBroadcast || isLinkLocalMulticast) {
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
    if (this.aclEngine.evaluateACL(inboundACL, ipPkt) !== 'deny') return false;

    Logger.info(this.id, 'router:acl-deny-in',
      `${this.name}: ACL denied inbound on ${inPort}: ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
    this._debugService?.emitLine('ip.packet',
      `IP: s=${ipPkt.sourceIP} (${inPort}), d=${ipPkt.destinationIP}, len ${ipPkt.totalLength}, access denied`);
    if (this.isIcmpUnreachablesEnabled(inPort)) {
      this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 13);
    }
    return true;
  }

  /**
   * Control Plane: Handle packets addressed to our interface IPs.
   * Supports: ICMP echo-request → echo-reply, UDP/RIP.
   */
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
        this.counters.ifOutOctets += replyIP.totalLength;

        const sameSubnetMac = this.peerOnSameSubnet(inPort, ipPkt.sourceIP)
          ? this.arpTable.get(ipPkt.sourceIP.toString())
          : undefined;
        if (sameSubnetMac && !this.ipsecEngine) {
          this.sendFrame(inPort, {
            srcMAC: port.getMAC(), dstMAC: sameSubnetMac.mac,
            etherType: ETHERTYPE_IPV4, payload: replyIP,
          });
        } else {
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

      // Dispatch by destination port
      if (udp.destinationPort === UDP_PORT_RIP) {
        const rip = udp.payload as RIPPacket;
        if (!rip || rip.type !== 'rip') return;
        this.ripEngine.processPacket(inPort, ipPkt.sourceIP, rip);
      } else if (udp.destinationPort === 67) {
        this.handleDhcpUdp(inPort, ipPkt, udp);
      } else if (udp.destinationPort === UDP_PORT_IKE) {
        this.ipsecEngine?.handleIkeUdp(inPort, ipPkt, udp);
      } else if (this.ipSlaEngine.handleUdp(ipPkt.sourceIP, udp)) {
        return;
      }
      // Other UDP ports silently dropped (no DNS/DHCP/etc. yet)
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
    const newTTL = ipPkt.ttl - 1;
    if (newTTL <= 0) {
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

    // Phase D.2: Header mutation — create forwarded packet with new TTL + checksum
    let fwdPkt: IPv4Packet = {
      ...ipPkt,
      ttl: newTTL,
      headerChecksum: 0,
    };
    fwdPkt.headerChecksum = computeIPv4Checksum(fwdPkt);

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
      const verdict = this.aclEngine.evaluateACL(outboundACL, fwdPkt);
      if (verdict === 'deny') {
        Logger.info(this.id, 'router:acl-deny-out',
          `${this.name}: ACL denied outbound on ${route.iface}: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP}`);
        this._debugService?.emitLine('ip.packet',
          `IP: s=${fwdPkt.sourceIP} (${inPort}), d=${fwdPkt.destinationIP}, len ${fwdPkt.totalLength}, access denied`);
        if (this.isIcmpUnreachablesEnabled(inPort)) {
          this.sendICMPError(inPort, fwdPkt, 'destination-unreachable', 13);
        }
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

    const newTTL = ipPkt.ttl - 1;
    if (newTTL <= 0) return;

    const fwdPktBase: IPv4Packet = { ...ipPkt, ttl: newTTL, headerChecksum: 0 };
    fwdPktBase.headerChecksum = computeIPv4Checksum(fwdPktBase);
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

    const route = this.lookupRoute(offendingPkt.sourceIP);
    if (!route) return;

    const outPort = this.ports.get(route.iface);
    if (!outPort) return;

    const nextHopIP = route.nextHop || offendingPkt.sourceIP;
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.counters.ifOutOctets += errorIP.totalLength;
      this.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: errorIP,
      });
    } else {
      this.queueAndResolve(errorIP, route.iface, nextHopIP, outPort);
    }
  }

  /**
   * Send ICMP Redirect (Type 5, Code 1 — Redirect for Host) back to the source.
   * Tells the originating host to send future packets directly to `redirectGW`.
   * RFC 792; RFC 1812 §5.2.7.
   */
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

    const route = this.lookupRoute(offendingPkt.sourceIP);
    if (!route) return;

    const outPort = this.ports.get(route.iface);
    if (!outPort) return;

    const nextHopIP = route.nextHop || offendingPkt.sourceIP;
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: redirectIP,
      });
    } else {
      this.queueAndResolve(redirectIP, route.iface, nextHopIP, outPort);
    }
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
  addRAPrefix(ifName: string, prefix: IPv6Address, prefixLength: number, options?: {
    onLink?: boolean; autonomous?: boolean; validLifetime?: number; preferredLifetime?: number;
  }) { this.ipv6Engine.addRAPrefix(ifName, prefix, prefixLength, options); }

  // ─── Management Plane: Terminal (vendor-abstracted) ────────────

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    const out = await this.shell.execute(this, command);
    this.syncRouteDebug();
    return out;
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
      current.set(key, r.nextHop ? String(r.nextHop) : r.iface);
    }
    const previous = this._routeDebugSnapshot;
    this._routeDebugSnapshot = current;
    if (!previous) return;
    for (const [key, via] of previous) {
      if (!current.has(key)) svc.emitLine('ip.routing', `RT: del ${key.split('/')[0]} via ${via}`);
    }
    for (const [key, via] of current) {
      if (!previous.has(key)) svc.emitLine('ip.routing', `RT: add ${key.split('/')[0]} via ${via}`);
      else if (previous.get(key) !== via) {
        svc.emitLine('ip.routing', `RT: del ${key.split('/')[0]} via ${previous.get(key)}`);
        svc.emitLine('ip.routing', `RT: add ${key.split('/')[0]} via ${via}`);
      }
    }
  }

  getPrompt(): string {
    return this.shell.getPrompt(this);
  }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliHelp(inputBeforeQuestion: string): string {
    return this.shell.getHelp(inputBeforeQuestion, this);
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    return this.shell.tabComplete(input);
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
  async executeCommandInVty(command: string, session: CliShellSession): Promise<string> {
    const shell = this.shell as unknown as {
      snapshotVtyState?: () => import('./shells/vty/CliShellSession').VtySnapshot;
      applyVtyState?: (s: import('./shells/vty/CliShellSession').VtySnapshot) => void;
    };
    // Older shells (HuaweiVRPShell pre-§5.1) may not expose the snapshot
    // hooks yet — degrade gracefully to the legacy shared-state path so
    // commands still work, even if isolation is not yet enforced there.
    if (!shell.snapshotVtyState || !shell.applyVtyState) {
      return this.executeCommand(command);
    }
    const run = async (): Promise<string> => {
      if (!this.isPoweredOn) return '% Device is powered off';
      if (session.disposed) return '';
      const baseline = shell.snapshotVtyState!();
      shell.applyVtyState!(session.state);
      try {
        const out = await this.executeCommand(command);
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

  getBanner(type: string): string {
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
    const key = candidateIP.toString();
    if (this.arpTable.has(key)) return true;
    const route = this.lookupRoute(candidateIP);
    if (!route) return false;
    const port = this.ports.get(route.iface);
    const myIP = port?.getIPAddress();
    if (!port || !myIP) return false;
    const arpReq: ARPPacket = {
      type: 'arp', operation: 'request',
      senderMAC: port.getMAC(), senderIP: myIP,
      targetMAC: MACAddress.broadcast(), targetIP: candidateIP,
    };
    this.sendFrame(route.iface, {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_ARP, payload: arpReq,
    });
    return this.arpTable.has(key);
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
  /** Static hostname → IP table (Cisco/Huawei `ip host` directives). */
  readonly hostsTable = new RouterHostsTable();
  _getHostsTable(): RouterHostsTable { return this.hostsTable; }
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

  private readonly _serviceFlags: Map<string, boolean> = new Map();
  private readonly _unhandledConfigLines: string[] = [];
  private _systemClockOverrideMs: number | null = null;
  private _systemClockSetAtMs: number = 0;

  getServiceFlags(): ReadonlyMap<string, boolean> { return this._serviceFlags; }
  _setServiceFlag(name: string, on: boolean): void {
    this._serviceFlags.set(name, on);
  }

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
    this._systemClockOverrideMs = epochMs;
    this._systemClockSetAtMs = Date.now();
  }
  getSystemClockMs(): number {
    if (this._systemClockOverrideMs === null) return Date.now();
    return this._systemClockOverrideMs + (Date.now() - this._systemClockSetAtMs);
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

    return this.aclEngine.evaluateACL(ref, probe) !== 'deny';
  }

  /**
   * Put the logging buffer on this device's bus, and gate its severity-7
   * lines behind this device's debug registry: those lines ARE `debug`
   * output, so they may only appear while the matching `debug` is on and
   * must stop on `undebug all`.
   */
  private attachLoggingBus(bus: import('@/events/EventBus').IEventBus): void {
    this.shell.attachLoggingToBus?.(bus, this.id);
    const journal = this.shell.getLoggingConfig?.();
    journal?.setDebugGate(
      (tag) => this.getDebugService().isEnabledForSyslogTag(tag));
    if (journal) {
      journal.attachClockSource(deviceClockSource(this));
      this.getDebugService().setSyslogSink((line) => journal.appendDebugLine(line));
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
    this._debugService.attachToBus(this.getBus(), this.id);
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

  private _huaweiVrrpService: HuaweiVrrpService | null = null;
  getHuaweiVrrpService(): HuaweiVrrpService {
    if (!this._huaweiVrrpService) this._huaweiVrrpService = new HuaweiVrrpService();
    return this._huaweiVrrpService;
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

  getCredentialStore(): NetworkOsCredentialStore {
    if (!this._credentialStore) {
      this._securityAuditLog = new SecurityAuditLog({ deviceId: this.id, bus: this.getBus() });
      this._sshSessionRegistry = new SshSessionRegistry({
        deviceId: this.id,
        bus: this.getBus(),
        capacity: () => this.vtyLineConfig.lineCapacity(),
      });
      this._credentialStore = new NetworkOsCredentialStore({ deviceId: this.id, bus: this.getBus() });
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
          name: u, privilege: 15, secret: u, passwordHashAlgorithm: 'md5',
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

  _upsertCiscoUsername(name: string, kv: {
    privilege?: number; secret?: string;
    secretAlgo?: 'plain' | 'plain-password' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
    autocommand?: string; nopassword?: boolean; description?: string;
  }): void {
    this.getSecurityAuditLog();
    const store = this.getCredentialStore();
    let account = store.get(name) ?? NetworkOsAccount.create({ name });
    if (kv.privilege !== undefined) account = account.withPrivilege(kv.privilege);
    if (kv.nopassword) account = account.withSecret('', 'plain');
    else if (kv.secret !== undefined) account = account.withSecret(kv.secret, kv.secretAlgo ?? 'plain');
    if (kv.description) account = account.withDescription(kv.description);
    if (account.factoryDefault) account = account.asOperatorOwned();
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
  _listLocalUsers(): ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo: PasswordHashAlgorithm; factoryDefault: boolean }> {
    return this.getCredentialStore().list().map(a => ({
      name: a.name, privilege: a.privilege, secret: a.secret,
      secretAlgo: a.passwordHashAlgorithm,
      factoryDefault: a.factoryDefault,
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
  private flashFiles = new Map<string, string>();

  _writeFlashFile(name: string, content: string): void { this.flashFiles.set(name, content); }
  _readFlashFile(name: string): string | null { return this.flashFiles.get(name) ?? null; }
  _listFlashFiles(): readonly string[] { return [...this.flashFiles.keys()]; }

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
  _setVtyTransportInput(t: 'ssh' | 'telnet' | 'all' | 'none'): void {
    this.vtyTransportInput = t;
    this.sshServerEnabled = (t === 'all' || t === 'ssh');
    if (this._sshHost) this._sshHost.setSshActive(this.sshServerEnabled);
    this.syncSshListener();
  }

  /**
   * Real `transport input` on the VTY lines — read by peers deciding
   * whether an OUTBOUND telnet/ssh from THEM would be accepted here
   * (`CiscoShellBase.remoteAcceptsTelnet`).
   */
  _getVtyTransportInput(): 'ssh' | 'telnet' | 'all' | 'none' {
    return this.vtyTransportInput;
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
  isSshActive(): boolean { return this.sshServerEnabled && this.hasSshHostKeys(); }
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

  async runSshCommand(user: string, command: string): Promise<{ output: string; exitCode: number }> {
    const sync = this.runSshCommandSync(user, command);
    if (sync) return sync;
    const output = await this.executeCommand(command);
    return { output, exitCode: 0 };
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
    // Self-ping: check all interface IPs
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && myIP.equals(targetIP)) {
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
  addAccessListEntry(...args: Parameters<ACLEngine['addAccessListEntry']>) { this.aclEngine.addAccessListEntry(...args); }
  addNamedAccessListEntry(...args: Parameters<ACLEngine['addNamedAccessListEntry']>) { this.aclEngine.addNamedAccessListEntry(...args); }
  removeAccessList(id: number) { this.aclEngine.removeAccessList(id); }
  removeNamedAccessList(name: string) { this.aclEngine.removeNamedAccessList(name); }
  setInterfaceACL(ifName: string, direction: 'in' | 'out', aclRef: number | string) { this.aclEngine.setInterfaceACL(ifName, direction, aclRef); }
  removeInterfaceACL(ifName: string, direction: 'in' | 'out') { this.aclEngine.removeInterfaceACL(ifName, direction); }
  getInterfaceACL(ifName: string, direction: 'in' | 'out') { return this.aclEngine.getInterfaceACL(ifName, direction); }
  evaluateACLByName(name: string, ipPkt: IPv4Packet) { return this.aclEngine.evaluateACLByName(name, ipPkt); }

  _getAccessListsInternal() { return this.aclEngine.getAccessListsInternal(); }
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

