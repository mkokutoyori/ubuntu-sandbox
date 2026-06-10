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
import type { IEventBus } from '@/events/EventBus';
import { VtyLineConfigStore } from './router/vty/VtyLineConfigStore';
import { AaaAuthenticator } from './router/aaa/AaaAuthenticator';
import { RouterHostsTable } from './router/dns/RouterHostsTable';
import { RouterSshKnownHosts } from './router/ssh/RouterSshKnownHosts';
import { CommandAliasTable } from './router/cli/CommandAliasTable';
import { IpPrefixListStore } from './router/policy/IpPrefixList';
import { RoutePolicyStore } from './router/policy/RoutePolicy';
import { TrafficPolicyStore } from './router/policy/TrafficPolicy';
import { NqaEngine } from './router/diag/NqaEngine';
import { Port } from '../hardware/Port';
import { CliShellSession } from './shells/vty/CliShellSession';
import { TimerSet } from '@/events/TimerSet';
import { TcpStack } from '../tcp/TcpStack';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { RouterSshServerContext } from '../protocols/ssh/server/RouterSshServerContext';
import { SshHostKey } from '../protocols/ssh/SshHostKey';
import type { SshExecTarget } from '../protocols/ssh/server/SshExecTarget';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { waitForEvent, WaitForEventTimeoutError } from '@/events/waitForEvent';
import {
  EthernetFrame, IPv4Packet, ESPPacket, AHPacket, MACAddress, IPAddress, SubnetMask,
  ARPPacket, ICMPPacket, UDPPacket, RIPPacket,
  ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6,
  IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ESP, IP_PROTO_AH,
  UDP_PORT_RIP, UDP_PORT_IKE_NAT_T,
  TCPPacket,
  createIPv4Packet, verifyIPv4Checksum, computeIPv4Checksum,
  DeviceType,
  IPv6Address, IPv6Packet,
} from '../core/types';
import { Logger } from '../core/Logger';
import { DHCPServer } from '../dhcp/DHCPServer';
import { IPSecEngine } from '../ipsec/IPSecEngine';
import type { NetFlowAgent, NetFlowRecordInput } from '../netflow/NetFlowAgent';
import { ACLEngine } from './router/ACLEngine';
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
import { RouterDebugService } from './router/diag/RouterDebugService';
import { NhrpService } from './router/nhrp/NhrpService';
import { DmvpnService } from './router/nhrp/DmvpnService';
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
export type { NatStaticEntry, NatPool, NatDynamicRule, NatSession, NatTranslationEntry } from './router/NATEngine';

// ─── Routing Table (RIB) ───────────────────────────────────────────

export interface RouteEntry {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress | null;
  iface: string;
  type: 'connected' | 'static' | 'default' | 'rip' | 'ospf' | 'eigrp' | 'bgp';
  ad: number;
  metric: number;
  preference?: number;
  tag?: number;
  description?: string;
  track?: string;
  vpnInstance?: string;
  permanent?: boolean;
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

export abstract class Router extends Equipment {
  // ── Control Plane ─────────────────────────────────────────────
  private routingTable: RouteEntry[] = [];
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
  private aclEngine = new ACLEngine();

  // ── Interface Descriptions ──────────────────────────────────
  private interfaceDescriptions: Map<string, string> = new Map();

  private pingIdCounter = 1;

  // ── DHCP Server (RFC 2131) ──────────────────────────────────
  private dhcpServer: DHCPServer = new DHCPServer();

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
  private nqaEngine = new NqaEngine();

  getIpPrefixListStore(): IpPrefixListStore { return this.ipPrefixListStore; }
  getRoutePolicyStore(): RoutePolicyStore { return this.routePolicyStore; }
  getTrafficPolicyStore(): TrafficPolicyStore { return this.trafficPolicyStore; }
  getNqaEngine(): NqaEngine { return this.nqaEngine; }

  // ── Reactive (Phase 5.8) — scheduler + TimerSet + event helpers ──
  private routerScheduler: IScheduler | null = null;
  protected readonly routerTimers = new TimerSet(() => this.getRouterScheduler());
  /** In-flight ARP solicitations for forwarding — dedup signal that replaces
   *  pendingARPs use as a "request-already-sent" check (Phase 5.8). */
  private inFlightFwdARPs: Set<string> = new Set();

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
      pushRoute: (route) => { this.routingTable.push(route); },
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getRipVersion: () => this._ripVersion,
      getBus: () => this.getBus(),
      getScheduler: () => this.getRouterScheduler(),
    });
    this.ipv6Engine = new IPv6DataPlane({
      id: this.id,
      name: this.name,
      getPorts: () => this.ports,
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getCounters: () => this.counters,
      getBus: () => this.getBus(),
      getScheduler: () => this.getRouterScheduler(),
    });
    this.ospfIntegration = new RouterOSPFIntegration({
      id: this.id,
      name: this.name,
      getPorts: () => this.ports,
      getRoutingTable: () => this.routingTable,
      setRoutingTable: (table) => { this.routingTable = table; },
      pushRoute: (route) => { this.routingTable.push(route); },
      sendFrame: (iface, frame) => { this.sendFrame(iface, frame); },
      getArpEntry: (ip) => this.arpTable.get(ip),
      getACLEngine: () => this.aclEngine,
      getIPv6Engine: () => this.ipv6Engine,
      getIPv6AccessLists: () => this.ipv6AccessLists,
    });
    this.dynamicRouting = new RouterDynamicRouting({
      id: this.id,
      getPorts: () => this.ports,
      getRoutingTable: () => this.routingTable,
      setRoutingTable: (table) => { this.routingTable = table; },
      getRipEngine: () => this.ripEngine,
      getOspfIntegration: () => this.ospfIntegration,
    });
    this.shell = this.createShell();
    this.natEngine.setACLMatchFn((aclId, srcIP) => {
      const pkt = { type: 'ipv4', sourceIP: new IPAddress(srcIP) } as any;
      return this.aclEngine.evaluateACLByName(String(aclId), pkt) !== 'deny';
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
    };
    this.tcpv2 = new TcpStack(tcpHost, () => this.getBus());
    this.tcpv2.start();
    this.getEemEngine();
    this.getCredentialStore();
    this.mountSshDaemon();
    this.startArpAgingTimer();
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
    if (bus) this.shell.attachLoggingToBus?.(bus, this.id);
    if (bus) this.getSnmpService().attachToBus(bus, this.id);
    if (this._eemEngine) { this._eemEngine.stop(); this._eemEngine.start(); }
  }

  // ── SSH daemon over real TCP ───────────────────────────────────────

  private _sshHandlerMounted = false;

  private mountSshDaemon(): void {
    if (this._sshHandlerMounted) return;
    this._sshHandlerMounted = true;
    this.tcpv2.listen(22, {
      onAccept: (socket) => {
        const handler = this.buildRouterSshServerHandler();
        handler.register(socket, socket.remoteIp);
      },
    });
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
      banner: () => this.sshBannerText || null,
      aaaAuthenticate: (n, p) => this.authenticateViaAaa(n, p),
    });
    return new SshServerHandler(ctx);
  }

  protected readonly tcpv2: TcpStack;
  public getTcpStack(): TcpStack { return this.tcpv2; }

  private createPorts(): void {
    const portCount = 4;
    for (let i = 0; i < portCount; i++) {
      const portName = this.getVendorPortName(i);
      this.addPort(new Port(portName, 'ethernet'));
    }
  }

  /** Register link-change handlers on all ports to trigger OSPF convergence and DPD */
  private _setupPortMonitoring(): void {
    for (const [name, port] of this.ports) {
      port.onLinkChange((state) => {
        if (state === 'up') {
          this._ospfAutoConverge();
        } else {
          this.ipsecEngine?.onPortDown(name);
        }
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
  _createVirtualInterface(name: string): boolean {
    if (this.ports.has(name)) return true; // already exists
    const port = new Port(name, 'ethernet');
    port.setUp(true); // virtual interfaces are always up
    this.addPort(port);
    // Register OSPF monitor
    port.onLinkChange((state) => {
      if (state === 'up') this._ospfAutoConverge();
    });
    return true;
  }

  /** Vendor-specific interface naming convention */
  protected abstract getVendorPortName(index: number): string;

  /** Create the vendor-specific CLI shell */
  protected abstract createShell(): IRouterShell;

  getShell(): IRouterShell { return this.shell; }

  /** Get the vendor-specific boot sequence */
  abstract getBootSequence(): string;

  // ─── Interface IP Configuration ──────────────────────────────

  /**
   * Configure an IP on an interface. Automatically adds a connected route.
   */
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.configureIP(ip, mask);

    // Remove old connected route for this interface
    this.routingTable = this.routingTable.filter(
      r => !(r.type === 'connected' && r.iface === ifName)
    );

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
    });

    Logger.info(this.id, 'router:interface-config',
      `${this.name}: ${ifName} configured ${ip}/${mask.toCIDR()}`);

    // Gratuitous ARP (RFC 5227): announce the address so neighbours
    // refresh stale cache entries — real IOS does this on `ip address`.
    if (port.isConnected() && port.getIsUp()) {
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
      ad: 1,
      metric,
      preference: opts?.preference,
      tag: opts?.tag,
      description: opts?.description,
      track: opts?.track,
      vpnInstance: opts?.vpnInstance,
      permanent: opts?.permanent,
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

  removeDefaultRoute(): boolean {
    const before = this.routingTable.length;
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
    return this.routingTable.length < before;
  }

  setDefaultRoute(
    nextHop: IPAddress, metric: number = 0,
    opts?: Partial<Pick<RouteEntry, 'preference' | 'tag' | 'description' | 'iface'>>,
  ): boolean {
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
    const iface = this.findInterfaceForIP(nextHop);
    const ifaceName = opts?.iface ?? (iface ? iface.getName() : '');

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop,
      iface: ifaceName,
      type: 'default',
      ad: 1,
      metric,
      preference: opts?.preference,
      tag: opts?.tag,
      description: opts?.description,
    });
    return true;
  }

  /** Longest Prefix Match (LPM) — tiebreaking: prefix → AD → metric */
  private lookupRoute(destIP: IPAddress): RouteEntry | null {
    // Keep EIGRP/BGP-learned routes fresh for the data path: a real
    // adjacency over the live topology installs/withdraws routes
    // before every forwarding decision (config-driven, reactive).
    if (this.dynamicRouting?.hasActive()) this.dynamicRouting.converge();

    let bestRoute: RouteEntry | null = null;
    let bestPrefix = -1;
    const destInt = destIP.toUint32();

    for (const route of this.routingTable) {
      // Skip routes through disconnected physical interfaces (like real IOS behavior)
      // Virtual interfaces (Tunnel, Loopback) don't require cable connectivity
      const isVirtual = /^(Tunnel|Loopback)/i.test(route.iface);
      if (!isVirtual) {
        const port = this.ports.get(route.iface);
        if (port && !port.isConnected()) {
          // Interface went down — clear any IPSec SAs using this interface
          // (mirrors IOS: "line protocol down" triggers SA teardown)
          if (this.ipsecEngine) {
            this.ipsecEngine.clearSAsForInterface(route.iface);
          }
          continue;
        }
      }

      const netInt = route.network.toUint32();
      const maskInt = route.mask.toUint32();
      const prefix = route.mask.toCIDR();

      if ((destInt & maskInt) === (netInt & maskInt)) {
        if (prefix > bestPrefix) {
          bestPrefix = prefix;
          bestRoute = route;
        } else if (prefix === bestPrefix && bestRoute) {
          if (route.ad < bestRoute.ad ||
              (route.ad === bestRoute.ad && route.metric < bestRoute.metric)) {
            bestRoute = route;
          }
        }
      }
    }
    return bestRoute;
  }

  private findInterfaceForIP(targetIP: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && ip.isInSameSubnet(targetIP, mask)) return port;
    }
    return null;
  }

  private peerOnSameSubnet(portName: string, peerIP: IPAddress): boolean {
    const port = this.ports.get(portName);
    if (!port) return false;
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    return !!(ip && mask && ip.isInSameSubnet(peerIP, mask));
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

  /** Real dynamic-routing engines (EIGRP/BGP) + topology adapter. */
  getDynamicRouting() { return this.dynamicRouting; }
  getEIGRPEngine() { return this.dynamicRouting.eigrp; }
  getBGPEngine() { return this.dynamicRouting.bgp; }
  /** Recompute EIGRP/BGP adjacencies+routes from real topology. */
  convergeDynamicRouting() { this.dynamicRouting.converge(); }

  // ─── Data Plane: Phase A — Frame Handling (L2 → dispatch) ─────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
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

    if (!isForUs && !isBroadcast && !isIpv6Multicast && !isIpv4Multicast) {
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
        this.ipv6Engine.processPacket(portName, frame.payload as IPv6Packet);
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

    if (arp.operation === 'request' && arp.targetIP.equals(myIP)) {
      const reply: ARPPacket = {
        type: 'arp', operation: 'reply',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: arp.senderMAC, targetIP: arp.senderIP,
      };
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: arp.senderMAC,
        etherType: ETHERTYPE_ARP, payload: reply,
      });
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

    // NAT PREROUTING (DNAT): rewrite destination before routing decision
    const natInbound = this.natEngine.translateInbound(ipPkt, inPort);
    if (natInbound) ipPkt = natInbound;

    // Phase C: Forwarding Decision

    // C.1: Is this packet for us? (any interface IP, broadcast, or
    // link-local multicast — 224.0.0.0/24 is consumed by the control
    // plane and MUST never be forwarded, RFC 1112/4541)
    const destIP = ipPkt.destinationIP;
    const isBroadcast = destIP.toString() === '255.255.255.255';
    const destFirstOctet = Number(destIP.toString().split('.')[0] ?? 0);
    const isMulticast = destFirstOctet >= 224 && destFirstOctet <= 239;

    if (isBroadcast || isMulticast) {
      // Broadcast/multicast packet — deliver locally, never forward
      this.handleLocalDelivery(inPort, ipPkt);
      return;
    }
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && destIP.equals(myIP)) {
        // Control plane — deliver locally (ACL does not filter router-destined traffic)
        this.handleLocalDelivery(inPort, ipPkt);
        return;
      }
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

    // C.1c: Inbound ACL check (only for transit/forwarded traffic)
    const inboundACL = this.aclEngine.getInterfaceACL(inPort, 'in');
    if (inboundACL !== null) {
      const verdict = this.aclEngine.evaluateACL(inboundACL, ipPkt);
      if (verdict === 'deny') {
        Logger.info(this.id, 'router:acl-deny-in',
          `${this.name}: ACL denied inbound on ${inPort}: ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
        return;
      }
    }

    // C.2: Not for us → forward via FIB
    this.forwardPacket(inPort, ipPkt);
  }

  /**
   * Control Plane: Handle packets addressed to our interface IPs.
   * Supports: ICMP echo-request → echo-reply, UDP/RIP.
   */
  private handleLocalDelivery(inPort: string, ipPkt: IPv4Packet): void {
    // IPSec inbound decapsulation
    if (ipPkt.protocol === IP_PROTO_ESP && this.ipsecEngine) {
      const inner = this.ipsecEngine.processInboundESP(ipPkt);
      if (inner) this.processIPv4(inPort, inner);
      return;
    }
    if (ipPkt.protocol === IP_PROTO_AH && this.ipsecEngine) {
      const inner = this.ipsecEngine.processInboundAH(ipPkt);
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
      const inboundACL = this.aclEngine.getInterfaceACL(inPort, 'in');
      if (inboundACL !== null) {
        const verdict = this.aclEngine.evaluateACL(inboundACL, ipPkt);
        if (verdict === 'deny') {
          Logger.info(this.id, 'router:acl-deny-in',
            `${this.name}: ACL denied inbound TCP on ${inPort}: ${ipPkt.sourceIP} → ${ipPkt.destinationIP}`);
          return;
        }
      }
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

      // Dispatch by destination port
      if (udp.destinationPort === UDP_PORT_RIP) {
        const rip = udp.payload as RIPPacket;
        if (!rip || rip.type !== 'rip') return;
        this.ripEngine.processPacket(inPort, ipPkt.sourceIP, rip);
      }
      // Other UDP ports silently dropped (no DNS/DHCP/etc. yet)
    }
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
  private forwardPacket(inPort: string, ipPkt: IPv4Packet): void {
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

    // Phase E.1: MTU check
    if (fwdPkt.totalLength > this.interfaceMTU) {
      // Check Don't Fragment flag (bit 1 of flags field, 0b010 = DF set)
      const dfSet = (fwdPkt.flags & 0b010) !== 0;
      if (dfSet) {
        // ICMP Type 3, Code 4: Fragmentation Needed and DF Set
        Logger.info(this.id, 'router:mtu-exceeded',
          `${this.name}: packet ${fwdPkt.totalLength} > MTU ${this.interfaceMTU}, DF=1`);
        this.sendICMPError(inPort, ipPkt, 'destination-unreachable', 4);
        return;
      }
      // If DF=0, we would fragment — not implemented in this simulator
    }

    // Phase E.2: Determine next-hop IP
    const nextHopIP = route.nextHop || ipPkt.destinationIP;
    const outPort = this.ports.get(route.iface);
    if (!outPort) return;

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

    // Phase E.2b: Outbound ACL check
    const outboundACL = this.aclEngine.getInterfaceACL(route.iface, 'out');
    if (outboundACL !== null) {
      const verdict = this.aclEngine.evaluateACL(outboundACL, fwdPkt);
      if (verdict === 'deny') {
        Logger.info(this.id, 'router:acl-deny-out',
          `${this.name}: ACL denied outbound on ${route.iface}: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP}`);
        return;
      }
    }

    // NAT POSTROUTING (SNAT/PAT): rewrite source before sending
    const natOutbound = this.natEngine.translateOutbound(fwdPkt, route.iface, inPort);
    if (natOutbound) fwdPkt = natOutbound;

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
    const cached = this.arpTable.get(nextHopIP.toString());
    if (cached) {
      this.counters.ipForwDatagrams++;
      this.counters.ifOutOctets += fwdPkt.totalLength;
      Logger.info(
        this.id, 'router:forward',
        `${this.name}: ${fwdPkt.sourceIP} → ${fwdPkt.destinationIP} via ${nextHopIP} (${route.iface}, ttl=${fwdPkt.ttl})`,
        {
          src: fwdPkt.sourceIP.toString(),
          dst: fwdPkt.destinationIP.toString(),
          nextHop: nextHopIP.toString(),
          iface: route.iface,
          ttl: fwdPkt.ttl,
          totalLength: fwdPkt.totalLength,
        },
      );
      this.sendFrame(route.iface, {
        srcMAC: outPort.getMAC(), dstMAC: cached.mac,
        etherType: ETHERTYPE_IPV4, payload: fwdPkt,
      });
    } else {
      this.queueAndResolve(fwdPkt, route.iface, nextHopIP, outPort);
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
  private sendICMPError(
    inPort: string,
    offendingPkt: IPv4Packet,
    icmpType: 'time-exceeded' | 'destination-unreachable',
    code: number,
    nextHopMTU?: number,
  ): void {
    const inPortObj = this.ports.get(inPort);
    if (!inPortObj) return;
    const myIP = inPortObj.getIPAddress();
    if (!myIP) return;

    const icmpError: ICMPPacket = {
      type: 'icmp', icmpType, code,
      id: 0, sequence: 0, dataSize: 0,
      // RFC 1191 §4: include Next-Hop MTU for Fragmentation Needed (Type 3, Code 4)
      mtu: (icmpType === 'destination-unreachable' && code === 4) ? (nextHopMTU ?? this.interfaceMTU) : undefined,
      // Include reference to the offending packet so receivers can identify the SA
      originalPacket: offendingPkt,
    };

    const errorIP = createIPv4Packet(
      myIP, offendingPkt.sourceIP, IP_PROTO_ICMP, this.defaultTTL,
      icmpError, 8,
    );

    // Update counters
    this.counters.icmpOutMsgs++;
    if (icmpType === 'time-exceeded') this.counters.icmpOutTimeExcds++;
    if (icmpType === 'destination-unreachable') this.counters.icmpOutDestUnreachs++;

    // Route the ICMP error through the routing table (RFC 1812 §4.3.2.7)
    const route = this.lookupRoute(offendingPkt.sourceIP);
    if (!route) {
      // No route back to source — silently drop
      return;
    }

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
      this.packetQueue = this.packetQueue.filter(
        q => !(q.nextHopIP.equals(nextHopIP) && q.outIface === iface)
      );
      this.inFlightFwdARPs.delete(key);
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
    return this.shell.execute(this, command);
  }

  getPrompt(): string {
    return this.shell.getPrompt(this);
  }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliHelp(inputBeforeQuestion: string): string {
    return this.shell.getHelp(inputBeforeQuestion);
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    return this.shell.tabComplete(input);
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
    return '';
  }

  protected motdBannerText: string = '';
  protected loginBannerText: string = '';
  protected execBannerText: string = '';

  _setMotdBanner(text: string): void { this.motdBannerText = text; }
  _setLoginBanner(text: string): void { this.loginBannerText = text; }
  _setExecBanner(text: string): void { this.execBannerText = text; }

  // ── Public accessors used by CLI shells ──────────────────────

  /** @internal Used by CLI shells */
  _getRoutingTableInternal(): RouteEntry[] { return this.routingTable; }
  /** @internal Used by CLI shells */
  _getArpTableInternal(): Map<string, ARPEntry> { return this.arpTable; }

  /** Add a static ARP entry */
  _addStaticARP(ip: string, mac: MACAddress, iface: string): void {
    this.arpTable.set(ip, { mac, iface, timestamp: Date.now(), type: 'static' });
  }

  /** Delete an ARP entry by IP */
  _deleteARP(ip: string): boolean {
    return this.arpTable.delete(ip);
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
  /** @internal Used by CLI shells */
  _setHostnameInternal(name: string): void { this.hostname = name; this.name = name; }

  private _globalToggles = new Map<string, boolean>();
  _setGlobalToggle(key: string, enabled: boolean): void { this._globalToggles.set(key, enabled); }
  _getGlobalToggle(key: string): boolean | undefined { return this._globalToggles.get(key); }
  _undoGlobalToggle(commandTail: string): void {
    const key = commandTail.replace(/\s+enable\s*$/, '').trim();
    this._globalToggles.set(key, false);
    if (key === 'ssh' || /^stelnet/.test(commandTail)) this._setSshServerEnabled(false);
    if (key === 'dhcp') this._getDHCPServerInternal().disable();
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

  private _enableSecret: { value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' } | null = null;
  private _enablePassword: { value: string; algo: 'plain' | 'type-7' } | null = null;
  private readonly _serviceFlags: Map<string, boolean> = new Map();
  private readonly _unhandledConfigLines: string[] = [];
  private _systemClockOverrideMs: number | null = null;
  private _systemClockSetAtMs: number = 0;

  getEnableSecret(): { value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' } | null { return this._enableSecret; }
  _setEnableSecret(value: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7'): void {
    this._enableSecret = { value, algo };
  }

  getEnablePassword(): { value: string; algo: 'plain' | 'type-7' } | null { return this._enablePassword; }
  _setEnablePassword(value: string, algo: 'plain' | 'type-7'): void {
    this._enablePassword = { value, algo };
  }

  getServiceFlags(): ReadonlyMap<string, boolean> { return this._serviceFlags; }
  _setServiceFlag(name: string, on: boolean): void {
    if (on) this._serviceFlags.set(name, true);
    else this._serviceFlags.delete(name);
  }

  getUnhandledConfigLines(): readonly string[] { return [...this._unhandledConfigLines]; }
  _recordUnhandledConfigLine(line: string): void {
    if (this._unhandledConfigLines.length < 1024) this._unhandledConfigLines.push(line);
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
  _captureStartupConfig(snapshot: string): void { this._startupConfigSnapshot = snapshot; }
  _eraseStartupConfig(): void { this._startupConfigSnapshot = null; }
  _restoreStartupConfig(): boolean {
    return this._startupConfigSnapshot !== null;
  }
  getStartupConfigSnapshot(): string | null { return this._startupConfigSnapshot; }

  private _scheduledReloadAtMs: number | null = null;
  _scheduleReload(when: 'immediate' | { atMs: number } | 'cancel'): void {
    if (when === 'cancel') { this._scheduledReloadAtMs = null; return; }
    if (when === 'immediate') { this._scheduledReloadAtMs = Date.now(); return; }
    this._scheduledReloadAtMs = when.atMs;
  }
  _getScheduledReloadMs(): number | null { return this._scheduledReloadAtMs; }

  private _routingTableLimit: { max: number; thresholdPct?: number } | null = null;
  getRoutingTableLimit(): { max: number; thresholdPct?: number } | null { return this._routingTableLimit; }
  _setRoutingTableLimit(max: number | null, thresholdPct?: number): void {
    this._routingTableLimit = max === null ? null : { max, thresholdPct };
  }

  getDebugService(): RouterDebugService {
    if (!this._debugService) this._debugService = new RouterDebugService();
    return this._debugService;
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
      this._sshSessionRegistry = new SshSessionRegistry({ deviceId: this.id, bus: this.getBus() });
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
        const acc = NetworkOsAccount.create({ name: u, privilege: 15, secret: u })
          .asFactoryDefault();
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
    secretAlgo?: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
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
  }
  _setVtyTransportInput(t: 'ssh' | 'telnet' | 'all' | 'none'): void {
    this.vtyTransportInput = t;
    this.sshServerEnabled = (t === 'all' || t === 'ssh');
    if (this._sshHost) this._sshHost.setSshActive(this.sshServerEnabled);
  }

  /**
   * Validate <user, password> through the local-user AAA database the
   * router builds from `username … secret …` (Cisco) or `local-user …
   * password cipher …` (Huawei). Overrides the {@link Equipment} stub
   * so the SSH client doesn't need to know which vendor it's talking
   * to — `device.checkPassword` is the single-call entry point that
   * the LinuxMachine / WindowsPC counterparts already expose.
   */
  override checkPassword(username: string, password: string): boolean {
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
  isSshActive(): boolean { return this.sshServerEnabled; }
  sshdAcceptsLogin(user: string): { ok: boolean; reason?: string } {
    return this.getSshHost().acceptsLogin(user);
  }
  recordSshLogin(
    _user: string, _fromIp: string, _fromHost: string,
    _accepted: boolean, _method?: 'password' | 'publickey' | 'keyboard-interactive',
  ): void {
    // Routers log via syslog / info-center elsewhere — the audit hook
    // is implemented per vendor when those subscribers wire in.
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
  ): Promise<Array<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string }>> {
    // Self-ping: check all interface IPs
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && myIP.equals(targetIP)) {
        const results = [];
        for (let seq = 1; seq <= count; seq++) {
          results.push({ success: true, rttMs: 0.01, ttl: this.defaultTTL, seq, fromIP: targetIP.toString() });
        }
        return results;
      }
    }

    // Route lookup
    const route = this.lookupRoute(targetIP);
    if (!route) {
      return []; // empty = unreachable
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

    // ARP resolution for next-hop
    const existingArp = this.arpTable.get(nextHopIP.toString());
    let nextHopMAC: MACAddress | null = existingArp ? existingArp.mac : null;

    if (!nextHopMAC) {
      // Send ARP request and wait
      nextHopMAC = await this._resolveARPForPing(route.iface, outPort, nextHopIP, timeoutMs);
      if (!nextHopMAC) return []; // ARP failed
    }

    // Send pings
    const results: Array<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string; error?: string }> = [];
    for (let seq = 1; seq <= count; seq++) {
      try {
        const result = await this._sendPing(route.iface, outPort, myIP, targetIP, nextHopMAC, seq, timeoutMs);
        results.push(result);
      } catch {
        results.push({ success: false, rttMs: 0, ttl: 0, seq, fromIP: '', error: 'timeout' });
      }
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

        const probe = await Promise.race([
          replyP.then((pl) => ({
            ip: pl.fromIp,
            rttMs: performance.now() - sentAt,
            timeout: false, reached: true,
            unreachable: undefined as boolean | undefined,
          })),
          failP.then((pl) => ({
            ip: pl.fromIp,
            rttMs: performance.now() - sentAt,
            timeout: false, reached: false,
            unreachable: pl.reason.includes('Destination unreachable'),
          })),
        ]).catch((err) => {
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
  ): Promise<{ success: boolean; rttMs: number; ttl: number; seq: number; fromIP: string }> {
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

    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-request', code: 0,
      id, sequence: seq, dataSize: 92,
    };
    const icmpSize = 8 + 92;
    const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, this.defaultTTL, icmp, icmpSize);

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

    try {
      const winner = await Promise.race([
        replyPromise.then((r) => ({ kind: 'reply' as const, r })),
        failedPromise.then((r) => ({ kind: 'failed' as const, r })),
      ]);
      if (winner.kind === 'failed') throw new Error(winner.r.reason);
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

