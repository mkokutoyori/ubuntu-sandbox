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
import { Port } from '../hardware/Port';
import { SocketTable } from '../core/SocketTable';
import { TcpConnection } from '../core/TcpConnection';
import { TimerSet } from '@/events/TimerSet';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { waitForEvent, WaitForEventTimeoutError } from '@/events/waitForEvent';
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
import { Logger } from '../core/Logger';
import { HardwareProfile } from './host/hardware';
import { HostLifecycle } from './host/lifecycle';
import { SystemIdentity } from './host/identity';
import { DHCPClient } from '../dhcp/DHCPClient';
import type { DHCPClientIfaceState } from '../dhcp/types';
import type { DHCPServer } from '../dhcp/DHCPServer';

// ─── Internal Types ────────────────────────────────────────────────

export interface ARPEntry {
  mac: MACAddress;
  /** Interface on which this entry was learned */
  iface: string;
  timestamp: number;
  /** Whether this entry was learned dynamically or added manually */
  type: 'dynamic' | 'static';
}

/** Linux reachable time default (RFC 4861 §10): 30 seconds */
export const ARP_REACHABLE_TIME_MS = 30_000;

/** Compute NUD (Neighbor Unreachability Detection) state from an ARP entry. */
export function getNUDState(entry: ARPEntry): string {
  if (entry.type === 'static') return 'PERMANENT';
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

// ─── IPv6 Neighbor Cache (RFC 4861) ─────────────────────────────────

export type NeighborState = 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';

export interface NeighborCacheEntry {
  /** Link-layer (MAC) address */
  mac: MACAddress;
  /** Interface on which this neighbor is reachable */
  iface: string;
  /** NDP state machine state */
  state: NeighborState;
  /** Whether this neighbor is a router */
  isRouter: boolean;
  /** Last reachability confirmation timestamp */
  timestamp: number;
}

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
}

// ─── EndHost ───────────────────────────────────────────────────────

export abstract class EndHost extends Equipment {
  // ─── Socket Table (L4) ──────────────────────────────────────────
  /** Per-device socket table — tracks listening and established sockets */
  protected readonly socketTable: SocketTable = new SocketTable();

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
  /** Queued forwarded packets waiting for ARP resolution. Timer is a
   *  TimerSet token (Phase 5 migration to IScheduler). */
  protected fwdQueue: Array<{ pkt: IPv4Packet; outPort: string; nextHopIP: string; timer: symbol }> = [];
  /** In-flight ARP solicitations for forwarding — dedup signal for
   *  fwdQueueAndResolve (replaces the pendingARPs map after Phase 5.5). */
  private inFlightFwdARPs: Set<string> = new Set();
  /** Monotonically increasing ICMP echo identifier */
  protected pingIdCounter: number = 0;
  /** Default gateway IP (set via `ip route add default via ...` or `route add`) */
  protected defaultGateway: IPAddress | null = null;
  /** Full routing table (connected + static + default) with LPM support */
  protected routingTable: HostRouteEntry[] = [];

  // ─── IPv6 State (RFC 4861, RFC 8200) ─────────────────────────────
  /** Neighbor cache: IPv6 string → { mac, iface, state, isRouter, timestamp } */
  protected neighborCache: Map<string, NeighborCacheEntry> = new Map();
  /** Monotonically increasing ICMPv6 echo identifier */
  protected ping6IdCounter: number = 0;
  /** Default IPv6 gateway (learned from RA or configured) */
  protected defaultGateway6: IPv6Address | null = null;
  /** IPv6 routing table */
  protected ipv6RoutingTable: HostIPv6RouteEntry[] = [];

  // ─── TCP State (RFC 793) ─────────────────────────────────────────
  /** Active TCP connections: "localPort:remoteIp:remotePort" → TcpConnection */
  private readonly tcpConnections = new Map<string, TcpConnection>();
  /** TCP server listeners: port → handler callback */
  private readonly tcpListeners = new Map<number, (conn: TcpConnection) => void>();
  /** Pending TCP handshakes: "remoteIp:remotePort:localPort" → resolve callback */
  private readonly pendingTcpHandshakes = new Map<string, () => void>();

  // ─── DHCP Client (RFC 2131) ─────────────────────────────────────
  protected dhcpClient: DHCPClient;
  /** Track DHCP-configured interfaces for 'dynamic' display */
  protected dhcpInterfaces: Set<string> = new Set();

  // ─── IP Forwarding / NAT (for NAT-T topologies) ──────────────────
  /** Whether IPv4 forwarding is enabled (sysctl net.ipv4.ip_forward=1) */
  protected ipForwardEnabled: boolean = false;
  /** Interfaces on which MASQUERADE is applied (iptables POSTROUTING MASQUERADE) */
  protected masqueradeOnInterfaces: Set<string> = new Set();

  /** Default TTL for outgoing packets (Linux=64, Windows=128) */
  protected abstract readonly defaultTTL: number;
  /** Default Hop Limit for IPv6 (typically same as TTL) */
  protected get defaultHopLimit(): number { return this.defaultTTL; }

  // ─── Reactive plumbing (Phase 5) ──────────────────────────────────
  /** Owns scheduler-driven timers (fwdQueue, future Phase 5 migrations). */
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
  }
  protected getScheduler(): IScheduler {
    return this.hostScheduler ?? getDefaultScheduler();
  }

  /** Common host identity stamped on every `host.*` event. */
  private hostRef() {
    return { deviceId: this.id, hostname: this.hostname };
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
  }

  // ─── Actor-API: signal refresh helpers ─────────────────────────────

  /** [actor-API] Refresh the ARP signal from `this.arpTable`. */
  _refreshArpSignal(): void {
    const map = (this as unknown as { arpTable?: Map<string, { mac: { toString(): string }; iface: string; timestamp: number }> }).arpTable;
    if (!map) return;
    this.hostSignalStore.arp.set(projectArpTable(map));
  }

  /** [actor-API] Refresh the NDP signal from `this.ndpCache`. */
  _refreshNdpSignal(): void {
    const map = (this as unknown as { ndpCache?: Map<string, { mac: { toString(): string }; iface: string }> }).ndpCache;
    if (!map) return;
    this.hostSignalStore.ndp.set(projectNdpTable(map));
  }

  /** [actor-API] Refresh the routes signal from `this.routingTable`. */
  _refreshRoutesSignal(): void {
    const routes = (this as unknown as {
      routingTable?: Iterable<{
        destination: { toString(): string };
        mask: { toString(): string };
        gateway: { toString(): string } | null;
        iface: string;
        metric?: number;
        type?: string;
      }>;
    }).routingTable;
    if (!routes) return;
    this.hostSignalStore.routes.set(projectHostRoutes(routes));
  }

  /** [actor-API] Refresh the TCP listeners + connections signals. */
  _refreshTcpSignal(): void {
    const listeners = (this as unknown as { tcpListeners?: Map<number, unknown> }).tcpListeners;
    const connections = (this as unknown as { tcpConnections?: Map<string, { localPort: number; remoteIP: string; remotePort: number; localIP?: string; side?: 'client' | 'server' }> }).tcpConnections;

    if (listeners) {
      const out: { ip: string; port: number }[] = [];
      for (const port of listeners.keys()) out.push({ ip: '0.0.0.0', port });
      this.hostSignalStore.tcpListeners.set(out);
    }
    if (connections) {
      const out: { localIp: string; localPort: number; remoteIp: string; remotePort: number; side: 'client' | 'server' }[] = [];
      for (const [, c] of connections) {
        out.push({
          localIp: c.localIP ?? '0.0.0.0',
          localPort: c.localPort,
          remoteIp: c.remoteIP,
          remotePort: c.remotePort,
          side: c.side ?? 'client',
        });
      }
      this.hostSignalStore.tcpConnections.set(out);
    }
  }

  /** [actor-API] Refresh the aggregate stats signal. */
  _refreshHostStatsSignal(): void {
    const arpMap = (this as unknown as { arpTable?: Map<unknown, unknown> }).arpTable;
    const ndpMap = (this as unknown as { ndpCache?: Map<unknown, unknown> }).ndpCache;
    const routes = (this as unknown as { routingTable?: { length: number } }).routingTable;
    const listeners = (this as unknown as { tcpListeners?: Map<unknown, unknown> }).tcpListeners;
    const connections = (this as unknown as { tcpConnections?: Map<unknown, unknown> }).tcpConnections;
    this.hostSignalStore.stats.set({
      arpCacheSize: arpMap?.size ?? 0,
      ndpCacheSize: ndpMap?.size ?? 0,
      routeCount: routes?.length ?? 0,
      tcpListeners: listeners?.size ?? 0,
      tcpConnections: connections?.size ?? 0,
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
  }

  /** Bus emission helper for ICMP echo timeout. */
  protected emitIcmpEchoTimeout(payload: { toIp: string; id: number; seq: number }): void {
    this.icmpTimeouts++;
    this.getBus().publish({
      topic: 'host.icmp.echo-timeout',
      payload: { ...this.hostRef(), ...payload },
    });
  }

  /** Bus emission helper for ICMP echo failed (TTL exceeded / unreachable). */
  protected emitIcmpEchoFailed(payload: {
    fromIp: string; toIp: string; id: number; seq: number; reason: string;
  }): void {
    this.getBus().publish({
      topic: 'host.icmp.echo-failed',
      payload: { ...this.hostRef(), ...payload },
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
  }

  /** Bus emission helper for NDP entry learned (IPv6 equivalent of ARP learn). */
  protected emitNdpLearned(payload: { ip: string; mac: string; iface: string }): void {
    this.getBus().publish({
      topic: 'host.ndp.entry-learned',
      payload: { ...this.hostRef(), ...payload },
    });
  }

  /** Bus emission helper for TCP listener started. */
  protected emitTcpListenerStarted(ip: string, port: number): void {
    this.getBus().publish({
      topic: 'host.tcp.listener-started',
      payload: { ...this.hostRef(), ip, port },
    });
  }

  /** Bus emission helper for TCP listener stopped. */
  protected emitTcpListenerStopped(ip: string, port: number): void {
    this.getBus().publish({
      topic: 'host.tcp.listener-stopped',
      payload: { ...this.hostRef(), ip, port },
    });
  }

  /** Bus emission helper for TCP connection established. */
  protected emitTcpConnectionEstablished(payload: {
    localIp: string; localPort: number; remoteIp: string; remotePort: number;
    side: 'client' | 'server';
  }): void {
    this.getBus().publish({
      topic: 'host.tcp.connection-established',
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
    this.hardware = HardwareProfile.defaultFor(
      String(type).includes('server') ? 'server' : 'workstation',
    );
    this.lifecycle = new HostLifecycle();
    this.lifecycle.attachBus(this.getBus(), this.id, name);
    this.identity = String(type).includes('windows')
      ? SystemIdentity.windows()
      : SystemIdentity.ubuntu();
    this.identity.attachBus(this.getBus(), this.id);
    this.attachHostActors();
    this.dhcpClient = new DHCPClient(
      (iface: string) => {
        const port = this.ports.get(iface);
        return port ? port.getMAC().toString() : '00:00:00:00:00:00';
      },
      (iface: string, ip: string, mask: string, gateway: string | null) => {
        this.configureInterface(iface, new IPAddress(ip), new SubnetMask(mask));
        if (gateway) this.setDefaultGateway(new IPAddress(gateway));
        this.dhcpInterfaces.add(iface);
      },
      (iface: string) => {
        const port = this.ports.get(iface);
        if (port) port.clearIP();
        // Remove connected route for this interface
        this.routingTable = this.routingTable.filter(
          r => !(r.type === 'connected' && r.iface === iface)
        );
        this.defaultGateway = null;
        this.routingTable = this.routingTable.filter(r => r.type !== 'default');
        this.dhcpInterfaces.delete(iface);
      },
    );
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
      metric: 0,
    });

    Logger.info(this.id, 'host:interface-config',
      `${this.name}: ${ifName} configured ${ip}/${mask.toCIDR()}`);

    // Send gratuitous ARP (RFC 5227) to announce new IP and update neighbors' caches
    if (port.isConnected()) {
      const gratuitousARP: ARPPacket = {
        type: 'arp',
        operation: 'request',
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
        `${this.name}: gratuitous ARP for ${ip} on ${ifName}`);
    }

    return true;
  }

  // ─── Default Gateway ──────────────────────────────────────────

  getDefaultGateway(): IPAddress | null { return this.defaultGateway; }

  setDefaultGateway(gw: IPAddress): void {
    this.defaultGateway = gw;

    // Remove old default route and add new one
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

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop: gw,
      iface: gwIface,
      type: 'default',
      metric: 0,
    });

    Logger.info(this.id, 'host:gateway', `${this.name}: default gateway set to ${gw}`);
  }

  clearDefaultGateway(): void {
    this.defaultGateway = null;
    this.routingTable = this.routingTable.filter(r => r.type !== 'default');
  }

  // ─── DHCP Client API ──────────────────────────────────────────

  /** Expose the per-device socket table (used by netstat/ss commands). */
  getSocketTable(): SocketTable { return this.socketTable; }

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

  /**
   * Auto-discover DHCP servers reachable through the network topology.
   * Traverses cables and switches to find Routers with DHCP servers,
   * and falls back to scanning all Equipment instances (simulator convenience).
   */
  autoDiscoverDHCPServers(): void {
    this.dhcpClient.clearServers();
    const visited = new Set<string>();

    // Helper: check if an Equipment is a Router with a DHCP server
    const tryRegisterRouter = (equip: Equipment) => {
      if (visited.has(equip.getId())) return;
      visited.add(equip.getId());
      // Use duck-typing to check for getDHCPServer method (avoids circular import of Router)
      const router = equip as any;
      if (typeof router.getDHCPServer === 'function') {
        const dhcpServer: DHCPServer = router.getDHCPServer();
        if (dhcpServer && dhcpServer.isEnabled()) {
          // Find a configured IP on the router to use as server identifier
          const routerPorts = equip.getPorts();
          let serverIP = '0.0.0.0';
          for (const rPort of routerPorts) {
            const ip = rPort.getIPAddress();
            if (ip) { serverIP = ip.toString(); break; }
          }
          this.dhcpClient.registerServer(dhcpServer, serverIP);
        }
      }
    };

    // Strategy 1: Traverse physical topology from our ports
    for (const [, port] of this.ports) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteId = remotePort.getEquipmentId();
      const remoteEquip = Equipment.getById(remoteId);
      if (!remoteEquip) continue;

      // Direct connection to a Router
      tryRegisterRouter(remoteEquip);

      // If connected to a Switch, traverse through the switch's other ports
      const remoteType = remoteEquip.getDeviceType();
      if (remoteType.includes('switch')) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue; // Skip the port we came from
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const farPort = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!farPort) continue;
          const farId = farPort.getEquipmentId();
          const farEquip = Equipment.getById(farId);
          if (farEquip) tryRegisterRouter(farEquip);
        }
      }
    }

    // Strategy 2: Fallback — scan all Equipment instances (for tests without cables)
    if (this.dhcpClient['connectedServers'].length === 0) {
      for (const equip of Equipment.getAllEquipment()) {
        if (equip === this) continue;
        tryRegisterRouter(equip);
      }
    }
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

    this.routingTable.push({
      network, mask, nextHop,
      iface: gwIface,
      type: 'static',
      metric,
    });

    Logger.info(this.id, 'host:route-add',
      `${this.name}: static route ${network}/${mask.toCIDR()} via ${nextHop} metric ${metric}`);
    return true;
  }

  /**
   * Remove a route by network/mask match.
   * Returns true if a route was removed.
   */
  removeRoute(network: IPAddress, mask: SubnetMask): boolean {
    const before = this.routingTable.length;
    this.routingTable = this.routingTable.filter(
      r => !(r.network.equals(network) && r.mask.toCIDR() === mask.toCIDR() && r.type === 'static')
    );
    return this.routingTable.length < before;
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
  addStaticARP(ip: string, mac: MACAddress, iface: string): void {
    this.arpTable.set(ip, {
      mac,
      iface,
      timestamp: Date.now(),
      type: 'static',
    });
    this.emitArpLearned({ ip, mac: mac.toString(), iface, source: 'static' });
  }

  /** Delete a single ARP entry by IP. Returns true if an entry was removed. */
  deleteARP(ip: string): boolean {
    return this.arpTable.delete(ip);
  }

  /** Clear all ARP entries (both static and dynamic). */
  clearARPTable(): void {
    this.arpTable.clear();
  }

  // ─── Frame Handling (L2 → L3 dispatch) ────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    const port = this.ports.get(portName);
    if (!port) return;

    // L2 filter: accept frames addressed to us, broadcast, or multicast
    const isForUs = frame.dstMAC.equals(port.getMAC());
    const isBroadcast = frame.dstMAC.isBroadcast();
    // IPv6 multicast MAC: 33:33:XX:XX:XX:XX
    const octets = frame.dstMAC.getOctets();
    const isMulticast = octets[0] === 0x33 && octets[1] === 0x33;

    if (!isForUs && !isBroadcast && !isMulticast) {
      return;
    }

    // For multicast, verify we're actually subscribed (have matching IPv6 address)
    if (isMulticast && frame.etherType === ETHERTYPE_IPV6) {
      // Accept all-nodes multicast (ff02::1) and solicited-node multicast for our addresses
      const ipv6 = frame.payload as IPv6Packet;
      if (!this.shouldAcceptIPv6Multicast(port, ipv6.destinationIP)) {
        return;
      }
    }

    if (frame.etherType === ETHERTYPE_ARP) {
      this.handleARP(portName, frame.payload as ARPPacket);
    } else if (frame.etherType === ETHERTYPE_IPV4) {
      this.handleIPv4(portName, frame.payload as IPv4Packet);
    } else if (frame.etherType === ETHERTYPE_IPV6) {
      this.handleIPv6(portName, frame.payload as IPv6Packet);
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

    // Always learn sender's MAC→IP mapping — real Linux does this even when
    // the interface has no IP configured yet (e.g. during bootstrap).
    const existing = this.arpTable.get(arp.senderIP.toString());
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
        source: arp.opcode === 1 ? 'request' : 'reply',
      });
    }

    const myIP = port.getIPAddress();
    if (!myIP) return;

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

      this.sendFrame(portName, {
        srcMAC: port.getMAC(),
        dstMAC: arp.senderMAC,
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
    const ready = this.fwdQueue.filter(q => q.nextHopIP === resolvedIP);
    this.fwdQueue = this.fwdQueue.filter(q => q.nextHopIP !== resolvedIP);
    this.inFlightFwdARPs.delete(resolvedIP);
    for (const q of ready) {
      this.hostTimers.clear(q.timer);
      const outPort = this.ports.get(q.outPort);
      if (outPort) {
        this.sendFrame(q.outPort, {
          srcMAC: outPort.getMAC(),
          dstMAC: resolvedMAC,
          etherType: ETHERTYPE_IPV4,
          payload: q.pkt,
        });
      }
    }
  }

  // ─── Firewall Hook ─────────────────────────────────────────────

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

  private handleIPv4(portName: string, ipPkt: IPv4Packet): void {
    if (!ipPkt || ipPkt.type !== 'ipv4') return;

    // Verify checksum
    if (!verifyIPv4Checksum(ipPkt)) {
      Logger.warn(this.id, 'ipv4:checksum-fail',
        `${this.name}: invalid IPv4 checksum, dropping packet`);
      return;
    }

    // ── PREROUTING: evaluate DNAT rules before routing decision ──
    // This allows NAT devices to redirect packets addressed to themselves
    // to a different destination (e.g. port forwarding / DNAT).
    const preNat = this.evaluatePreRouting(portName, ipPkt);
    if (preNat && preNat.action === 'DNAT' && preNat.address) {
      try {
        const newDst = new IPAddress(preNat.address.split(':')[0]);
        ipPkt = {
          ...ipPkt,
          destinationIP: newDst,
          headerChecksum: 0,
        };
        ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
      } catch { /* keep original */ }
    }

    // Check if packet is for us
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();

    const isForUs = myIP && ipPkt.destinationIP.equals(myIP);
    // Also accept if destination is the broadcast for our subnet
    const mask = port.getSubnetMask();
    const isBroadcast = myIP && mask && ipPkt.destinationIP.isBroadcastFor(mask);

    if (isForUs || isBroadcast) {
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
        this.handleTCP(portName, ipPkt);
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
    const newTTL = ipPkt.ttl - 1;
    if (newTTL <= 0) return; // TTL expired — drop silently

    const route = this.resolveRoute(ipPkt.destinationIP);
    if (!route) return; // no route — drop

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

    // NAT: apply POSTROUTING rules (MASQUERADE/SNAT)
    let srcIP = ipPkt.sourceIP;
    let dstIP = ipPkt.destinationIP;
    const natResult = this.evaluateNat(ipPkt, inPort, outPortName);
    if (natResult) {
      if (natResult.action === 'MASQUERADE') {
        const outPortIP = route.port.getIPAddress();
        if (outPortIP) srcIP = outPortIP;
      } else if (natResult.action === 'SNAT' && natResult.address) {
        try { srcIP = new IPAddress(natResult.address.split(':')[0]); } catch { /* keep original */ }
      } else if (natResult.action === 'DNAT' && natResult.address) {
        try { dstIP = new IPAddress(natResult.address.split(':')[0]); } catch { /* keep original */ }
      }
    } else if (this.masqueradeOnInterfaces.has(outPortName)) {
      // Fallback: legacy masquerade support
      const outPortIP = route.port.getIPAddress();
      if (outPortIP) srcIP = outPortIP;
    }

    const fwdPkt: IPv4Packet = {
      ...ipPkt,
      sourceIP: srcIP,
      destinationIP: dstIP,
      ttl: newTTL,
      headerChecksum: 0,
    };
    fwdPkt.headerChecksum = computeIPv4Checksum(fwdPkt);

    const nextHopMAC = this.arpTable.get(route.nextHopIP.toString());
    if (nextHopMAC) {
      this.sendFrame(outPortName, {
        srcMAC: route.port.getMAC(),
        dstMAC: nextHopMAC.mac,
        etherType: ETHERTYPE_IPV4,
        payload: fwdPkt,
      });
    } else {
      // Queue packet and send ARP request (async resolution for forwarded packets)
      this.fwdQueueAndResolve(fwdPkt, outPortName, route.nextHopIP, route.port);
    }
  }

  /** Queue a forwarded packet and send an ARP request for the next hop. */
  private fwdQueueAndResolve(pkt: IPv4Packet, outPort: string, nextHopIP: IPAddress, port: Port): void {
    const key = nextHopIP.toString();
    const timer = this.hostTimers.setTimeout(() => {
      this.fwdQueue = this.fwdQueue.filter(q => !(q.nextHopIP === key && q.outPort === outPort));
      this.inFlightFwdARPs.delete(key);
    }, 2000);
    this.fwdQueue.push({ pkt, outPort, nextHopIP: key, timer });

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
      this.sendFrame(outPort, {
        srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP, payload: arpReq,
      });
    }
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
        : `Destination unreachable (from ${ipPkt.sourceIP}) code ${icmp.code}`;

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
      this.routingTable.push({
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
    const myIP = port.getIPAddress();
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
    const replyIP = createIPv4Packet(
      myIP,
      requestIP.sourceIP,
      IP_PROTO_ICMP,
      this.defaultTTL,
      replyICMP,
      icmpSize,
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
   * Send ICMP destination-unreachable (admin prohibited) back to the sender.
   * Used when firewall verdict is 'reject' (as opposed to silent 'drop').
   */
  private sendICMPReject(portName: string, offendingPkt: IPv4Packet): void {
    const port = this.ports.get(portName);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    const icmpError: ICMPPacket = {
      type: 'icmp',
      icmpType: 'destination-unreachable',
      code: 13, // Communication administratively prohibited
      id: 0,
      sequence: 0,
      dataSize: 0,
      originalPacket: offendingPkt,
    };

    const errorIP = createIPv4Packet(
      myIP,
      offendingPkt.sourceIP,
      IP_PROTO_ICMP,
      this.defaultTTL,
      icmpError,
      8,
    );

    const targetMAC = this.arpTable.get(offendingPkt.sourceIP.toString());
    if (!targetMAC) return;

    this.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC: targetMAC.mac,
      etherType: ETHERTYPE_IPV4,
      payload: errorIP,
    });
  }

  // ─── TCP Transport (RFC 793) ───────────────────────────────────

  /**
   * Register a TCP server listener on the given port.
   * The handler is called synchronously (within the SYN handler) with the
   * new server-side TcpConnection so it can set up onData() before data arrives.
   */
  public listenTcp(port: number, handler: (conn: TcpConnection) => void): void {
    this.tcpListeners.set(port, handler);
    this.emitTcpListenerStarted('0.0.0.0', port);
  }

  /** Stop listening on a TCP port. Emits host.tcp.listener-stopped. */
  public unlistenTcp(port: number): boolean {
    const removed = this.tcpListeners.delete(port);
    if (removed) {
      this.emitTcpListenerStopped('0.0.0.0', port);
    }
    return removed;
  }

  /**
   * Establish an outgoing TCP connection to dstIp:dstPort.
   *
   * Flow:
   *   1. Route lookup (LPM) — fail fast if no route.
   *   2. ARP resolution for next-hop (one Promise.resolve microtask if cached).
   *   3. Send SYN.  The SYN travels synchronously through the cable/switch/router
   *      chain; the remote device sends SYN-ACK synchronously inside our
   *      sendFrame() call, which calls handleTCP() → pendingHandshake.resolve().
   *   4. await the handshake Promise (one microtask — already resolved).
   *   5. Return TcpConnection ready for write()/onData().
   */
  public async tcpConnect(dstIp: string, dstPort: number): Promise<TcpConnection | null> {
    let dstIPObj: IPAddress;
    try { dstIPObj = new IPAddress(dstIp); } catch { return null; }

    const route = this.resolveRoute(dstIPObj);
    if (!route) return null;

    const portName = route.port.getName();
    const myIP = route.port.getIPAddress();
    if (!myIP) return null;

    try {
      await this.resolveARP(portName, route.nextHopIP);
    } catch {
      return null;
    }

    const localPort = this.socketTable.allocateEphemeralPort();
    const initialSeq = Math.floor(Math.random() * 0xFFFF);

    // Capture route once; the connection persists for its lifetime
    const capturedRoute = { port: route.port, nextHopIP: route.nextHopIP };

    const conn = new TcpConnection(
      myIP.toString(), localPort,
      dstIp, dstPort,
      initialSeq + 1,
      (seg: TCPPacket) => this.sendTcpFrame(myIP, dstIPObj, capturedRoute, seg),
    );

    const connKey = `${localPort}:${dstIp}:${dstPort}`;
    this.tcpConnections.set(connKey, conn);

    const handshakeKey = `${dstIp}:${dstPort}:${localPort}`;
    const established = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTcpHandshakes.delete(handshakeKey);
        this.tcpConnections.delete(connKey);
        reject(new Error('TCP handshake timeout'));
      }, 2000);
      this.pendingTcpHandshakes.set(handshakeKey, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Send SYN — SYN-ACK arrives synchronously, resolving `established`
    const synSeg: TCPPacket = {
      type: 'tcp',
      sourcePort: localPort,
      destinationPort: dstPort,
      sequenceNumber: initialSeq,
      acknowledgementNumber: 0,
      flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
      windowSize: 65535,
      checksum: 0,
      payload: null,
    };
    this.sendTcpFrame(myIP, dstIPObj, capturedRoute, synSeg);

    try {
      await established;
    } catch {
      return null;
    }

    return conn;
  }

  /** Wrap a TCPPacket in IPv4 and send it using a pre-resolved route + ARP entry. */
  private sendTcpFrame(
    srcIP: IPAddress,
    dstIP: IPAddress,
    route: { port: Port; nextHopIP: IPAddress },
    seg: TCPPacket,
  ): void {
    const ipPkt = createIPv4Packet(srcIP, dstIP, IP_PROTO_TCP, this.defaultTTL, seg, 0);
    const nextHopMACEntry = this.arpTable.get(route.nextHopIP.toString());
    if (nextHopMACEntry) {
      this.sendFrame(route.port.getName(), {
        srcMAC: route.port.getMAC(),
        dstMAC: nextHopMACEntry.mac,
        etherType: ETHERTYPE_IPV4,
        payload: ipPkt,
      });
    } else {
      // MAC not yet cached — queue and trigger ARP resolution synchronously
      this.fwdQueueAndResolve(ipPkt, route.port.getName(), route.nextHopIP, route.port);
    }
  }

  /** Dispatch an incoming IPv4/TCP packet to the correct connection or listener. */
  private handleTCP(portName: string, ipPkt: IPv4Packet): void {
    const seg = ipPkt.payload as TCPPacket;
    if (!seg || seg.type !== 'tcp') return;

    const srcIp = ipPkt.sourceIP.toString();
    const { sourcePort: srcPort, destinationPort: dstPort, flags } = seg;

    // ── Incoming SYN: passive open (server role) ──────────────────
    if (flags.syn && !flags.ack) {
      const handler = this.tcpListeners.get(dstPort);
      if (!handler) return;

      const rcvPort = this.ports.get(portName);
      const serverIP = rcvPort?.getIPAddress();
      if (!serverIP) return;

      const serverSeq = Math.floor(Math.random() * 0xFFFF);
      const connKey = `${dstPort}:${srcIp}:${srcPort}`;

      const serverConn = new TcpConnection(
        serverIP.toString(), dstPort,
        srcIp, srcPort,
        serverSeq + 1,
        (respSeg: TCPPacket) => {
          const r = this.resolveRoute(new IPAddress(srcIp));
          if (!r) return;
          this.sendTcpFrame(serverIP, new IPAddress(srcIp), r, respSeg);
        },
      );
      serverConn.updateAck(seg.sequenceNumber, 1);
      this.tcpConnections.set(connKey, serverConn);
      this.emitTcpConnectionEstablished({
        localIp: serverIP.toString(),
        localPort: dstPort,
        remoteIp: srcIp,
        remotePort: srcPort,
        side: 'server',
      });

      // Send SYN-ACK
      const r = this.resolveRoute(ipPkt.sourceIP);
      if (!r) return;
      const synAck: TCPPacket = {
        type: 'tcp',
        sourcePort: dstPort,
        destinationPort: srcPort,
        sequenceNumber: serverSeq,
        acknowledgementNumber: seg.sequenceNumber + 1,
        flags: { syn: true, ack: true, fin: false, rst: false, psh: false, urg: false },
        windowSize: 65535,
        checksum: 0,
        payload: null,
      };
      this.sendTcpFrame(serverIP, ipPkt.sourceIP, r, synAck);

      // Call the handler NOW so onData() is registered before the first data segment
      handler(serverConn);
      return;
    }

    // ── SYN-ACK: complete our outgoing handshake ──────────────────
    if (flags.syn && flags.ack) {
      const handshakeKey = `${srcIp}:${srcPort}:${dstPort}`;
      const resolve = this.pendingTcpHandshakes.get(handshakeKey);
      if (!resolve) return;

      this.pendingTcpHandshakes.delete(handshakeKey);

      // Update our connection's ACK counter
      const connKey = `${dstPort}:${srcIp}:${srcPort}`;
      const conn = this.tcpConnections.get(connKey);
      if (conn) conn.updateAck(seg.sequenceNumber, 1);

      // Send ACK to complete the 3-way handshake
      const rcvPort = this.ports.get(portName);
      const myIP = rcvPort?.getIPAddress();
      if (myIP) {
        const route = this.resolveRoute(ipPkt.sourceIP);
        if (route) {
          const ackSeg: TCPPacket = {
            type: 'tcp',
            sourcePort: dstPort,
            destinationPort: srcPort,
            sequenceNumber: seg.acknowledgementNumber,
            acknowledgementNumber: seg.sequenceNumber + 1,
            flags: { syn: false, ack: true, fin: false, rst: false, psh: false, urg: false },
            windowSize: 65535,
            checksum: 0,
            payload: null,
          };
          this.sendTcpFrame(myIP, ipPkt.sourceIP, route, ackSeg);
        }
      }

      // Reactive: handshake completed → emit
      // host.tcp.connection-established (client side).
      const localIp = this.ports.get(portName)?.getIPAddress()?.toString() ?? '';
      this.emitTcpConnectionEstablished({
        localIp,
        localPort: dstPort,
        remoteIp: srcIp,
        remotePort: srcPort,
        side: 'client',
      });

      resolve();
      return;
    }

    // ── Data segment (PSH+ACK or ACK with payload) ────────────────
    if (seg.payload != null) {
      const connKey = `${dstPort}:${srcIp}:${srcPort}`;
      const conn = this.tcpConnections.get(connKey);
      if (conn && typeof seg.payload === 'string') {
        conn.receiveData(seg.payload, seg.sequenceNumber);
      }
      return;
    }

    // ── FIN: connection teardown ──────────────────────────────────
    if (flags.fin) {
      const connKey = `${dstPort}:${srcIp}:${srcPort}`;
      this.tcpConnections.delete(connKey);

      const rcvPort = this.ports.get(portName);
      const myIP = rcvPort?.getIPAddress();
      if (!myIP) return;
      const route = this.resolveRoute(ipPkt.sourceIP);
      if (!route) return;

      const finAck: TCPPacket = {
        type: 'tcp',
        sourcePort: dstPort,
        destinationPort: srcPort,
        sequenceNumber: seg.acknowledgementNumber,
        acknowledgementNumber: seg.sequenceNumber + 1,
        flags: { syn: false, ack: true, fin: false, rst: false, psh: false, urg: false },
        windowSize: 65535,
        checksum: 0,
        payload: null,
      };
      this.sendTcpFrame(myIP, ipPkt.sourceIP, route, finAck);
    }
  }

  // ─── ARP Resolution ────────────────────────────────────────────

  /**
   * Resolve an IP address to a MAC address via ARP.
   * Returns cached result if available, otherwise sends ARP request and waits.
   */
  protected async resolveARP(portName: string, targetIP: IPAddress, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.arpTable.get(targetIP.toString());
    if (cached) return cached.mac;

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
      if (err instanceof WaitForEventTimeoutError) throw new Error('ARP timeout');
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
  ): Promise<PingResult> {
    const port = this.ports.get(portName);
    if (!port) throw new Error('Port not found');
    const myIP = port.getIPAddress();
    if (!myIP) throw new Error('No IP configured');

    this.pingIdCounter++;
    const id = this.pingIdCounter;

    const targetIpStr = targetIP.toString();
    const sentAt = performance.now();
    const useTtl = ttl ?? this.defaultTTL;

    // Phase 5.6: settle through the bus instead of a pendingPings Map.
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

    const icmp: ICMPPacket = {
      type: 'icmp', icmpType: 'echo-request', code: 0,
      id, sequence: seq, dataSize: 56,
    };
    const icmpSize = 8 + 56;
    const ipPkt = createIPv4Packet(myIP, targetIP, IP_PROTO_ICMP, useTtl, icmp, icmpSize);

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
    const table = [...this.routingTable];

    // Auto-detect connected routes from ports not already in the table
    for (const [, port] of this.ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;

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
      table.push({
        network: new IPAddress('0.0.0.0'),
        mask: new SubnetMask('0.0.0.0'),
        nextHop: this.defaultGateway,
        iface: gwIface,
        type: 'default',
        metric: 0,
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
  protected resolveRoute(targetIP: IPAddress): { port: Port; nextHopIP: IPAddress } | null {
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

    return { port, nextHopIP };
  }

  // ─── High-level Ping (used by terminal commands) ──────────────

  /**
   * Execute a full ping sequence: route lookup → ARP → ICMP echo × count.
   * Returns an array of PingResult (one per ping attempt).
   */
  protected async executePingSequence(
    targetIP: IPAddress,
    count: number = 4,
    timeoutMs: number = 2000,
    ttl?: number,
  ): Promise<PingResult[]> {
    // Self-ping (loopback)
    for (const [, port] of this.ports) {
      const myIP = port.getIPAddress();
      if (myIP && myIP.equals(targetIP)) {
        const results: PingResult[] = [];
        for (let seq = 1; seq <= count; seq++) {
          results.push({
            success: true,
            rttMs: 0.01,
            ttl: this.defaultTTL,
            seq,
            bytes: 64,
            fromIP: targetIP.toString(),
          });
        }
        return results;
      }
    }

    // Route resolution
    const route = this.resolveRoute(targetIP);
    if (!route) {
      return []; // Empty = unreachable, caller formats the error
    }

    const portName = route.port.getName();

    // ARP resolution (for next-hop, not necessarily the final destination)
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return []; // ARP failed = no replies
    }

    // Send pings
    const results: PingResult[] = [];
    for (let seq = 1; seq <= count; seq++) {
      try {
        const result = await this.sendPing(portName, targetIP, nextHopMAC, seq, timeoutMs, ttl);
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
  ): Promise<Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; icmpCode?: number; probes: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean; icmpCode?: number }> }>> {
    const route = this.resolveRoute(targetIP);
    if (!route) return [];

    const portName = route.port.getName();
    const myIP = route.port.getIPAddress()!;

    // ARP resolve next hop
    let nextHopMAC: MACAddress;
    try {
      nextHopMAC = await this.resolveARP(portName, route.nextHopIP, timeoutMs);
    } catch {
      return [{ hop: firstTtl, timeout: true, probes: [{ responded: false }] }];
    }

    const hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; icmpCode?: number; probes: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean; icmpCode?: number }> }> = [];

    for (let ttl = firstTtl; ttl <= maxHops; ttl++) {
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

        const probe = await Promise.race([
          replyP.then((pl) => ({
            ip: pl.fromIp,
            rttMs: performance.now() - sentAt,
            timeout: false, reached: true,
            unreachable: undefined as boolean | undefined,
            icmpCode: undefined as number | undefined,
          })),
          failP.then((pl) => {
            const codeMatch = pl.reason.match(/code (\d+)/);
            const isUnreachable = pl.reason.includes('Destination unreachable');
            return {
              ip: pl.fromIp,
              rttMs: performance.now() - sentAt,
              timeout: false, reached: false,
              unreachable: isUnreachable,
              icmpCode: codeMatch ? parseInt(codeMatch[1], 10) : undefined,
            };
          }),
        ]).catch((err) => {
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

      const hop = {
        hop: ttl,
        ip: firstResponded?.ip,
        rttMs: firstResponded?.rttMs,
        timeout: allTimeout,
        unreachable: !!firstUnreachable,
        icmpCode: firstUnreachable?.icmpCode ?? firstResponded?.icmpCode,
        probes,
      };

      hops.push(hop);

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

    // Add connected route for link-local
    const linkLocal = port.getLinkLocalIPv6();
    if (linkLocal) {
      this.ipv6RoutingTable.push({
        prefix: new IPv6Address('fe80::'),
        prefixLength: 10,
        nextHop: null,
        iface: ifName,
        type: 'connected',
        metric: 0,
      });
    }

    return true;
  }

  /**
   * Configure a static IPv6 address on an interface.
   */
  configureIPv6Interface(ifName: string, address: IPv6Address, prefixLength: number): boolean {
    const port = this.ports.get(ifName);
    if (!port) return false;

    port.configureIPv6(address, prefixLength);

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
    return new Map(this.neighborCache);
  }

  // ─── IPv6 Packet Handling ──────────────────────────────────────

  private handleIPv6(portName: string, ipv6: IPv6Packet): void {
    if (!ipv6 || ipv6.type !== 'ipv6') return;

    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) return;

    // Check if packet is for us
    const isForUs = port.hasIPv6Address(ipv6.destinationIP);
    const isMulticast = ipv6.destinationIP.isMulticast();
    const isLoopback = ipv6.destinationIP.isLoopback();

    if (isForUs || isMulticast || isLoopback) {
      if (ipv6.nextHeader === IP_PROTO_ICMPV6) {
        this.handleICMPv6(portName, ipv6);
      }
      // Future: TCP, UDP dispatch here
    }
    // End hosts don't forward IPv6 packets
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

    // Determine source address for reply
    let srcIP: IPv6Address | null = null;
    if (ipv6.destinationIP.isLinkLocal()) {
      srcIP = port.getLinkLocalIPv6();
    } else {
      srcIP = port.getGlobalIPv6() || port.getLinkLocalIPv6();
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

    const dstMAC = this.neighborCache.get(route.nextHopIP.toString());
    if (dstMAC) {
      this.sendFrame(route.port.getName(), {
        srcMAC: route.port.getMAC(),
        dstMAC: dstMAC.mac,
        etherType: ETHERTYPE_IPV6,
        payload: replyPkt,
      });
    }
  }

  private handleICMPv6EchoReply(ipv6: IPv6Packet, icmpv6: ICMPv6Packet): void {
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
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: portName,
        state: 'stale',
        isRouter: false,
        timestamp: Date.now(),
      });
      this.emitNdpLearned({
        ip: ipv6.sourceIP.toString(),
        mac: srcLLOpt.address.toString(),
        iface: portName,
      });
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

    // Update neighbor cache
    this.neighborCache.set(key, {
      mac,
      iface: portName,
      state: na.solicitedFlag ? 'reachable' : 'stale',
      isRouter: na.routerFlag,
      timestamp: Date.now(),
    });

    // Phase 5.7: resolveNDP awaits this event via the bus.
    this.emitNdpLearned({ ip: key, mac: mac.toString(), iface: portName });

    Logger.debug(this.id, 'ndp:na-received',
      `${this.name}: learned ${na.targetAddress} -> ${mac}`);
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
      this.neighborCache.set(ipv6.sourceIP.toString(), {
        mac: srcLLOpt.address,
        iface: portName,
        state: 'reachable',
        isRouter: true,
        timestamp: Date.now(),
      });
      this.emitNdpLearned({
        ip: ipv6.sourceIP.toString(),
        mac: srcLLOpt.address.toString(),
        iface: portName,
      });
    }

    // If router lifetime > 0, consider as default router
    if (ra.routerLifetime > 0 && !this.defaultGateway6) {
      this.setDefaultGateway6(ipv6.sourceIP);
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
  }

  // ─── NDP Resolution (IPv6 equivalent of ARP) ────────────────────

  /**
   * Resolve an IPv6 address to a MAC address via NDP.
   * Returns cached result if available, otherwise sends NS and waits.
   */
  protected async resolveNDP(portName: string, targetIP: IPv6Address, timeoutMs: number = 2000): Promise<MACAddress> {
    const cached = this.neighborCache.get(targetIP.toString());
    if (cached && cached.state === 'reachable') return cached.mac;

    const port = this.ports.get(portName);
    if (!port || !port.isIPv6Enabled()) throw new Error('IPv6 not enabled');

    const srcIP = port.getLinkLocalIPv6();
    if (!srcIP) throw new Error('No link-local address');

    const targetIpStr = targetIP.toString();
    const waitPromise = waitForEvent(
      this.getBus(),
      'host.ndp.entry-learned',
      (p) => p.deviceId === this.id && p.ip === targetIpStr,
      { timeoutMs, scheduler: this.getScheduler() },
    );

    const ns = createNeighborSolicitation(targetIP, port.getMAC());
    const nsPkt = createIPv6Packet(
      srcIP,
      targetIP.toSolicitedNodeMulticast(),
      IP_PROTO_ICMPV6,
      255,
      ns,
      24,
    );
    const dstMAC = targetIP.toSolicitedNodeMulticast().toMulticastMAC();

    this.sendFrame(portName, {
      srcMAC: port.getMAC(), dstMAC,
      etherType: ETHERTYPE_IPV6, payload: nsPkt,
    });

    Logger.debug(this.id, 'ndp:ns-sent', `${this.name}: NS for ${targetIP} sent`);

    try {
      const learned = await waitPromise;
      return new MACAddress(learned.mac);
    } catch (err) {
      if (err instanceof WaitForEventTimeoutError) throw new Error('NDP timeout');
      throw err;
    }
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
      } catch {
        results.push({
          success: false,
          rttMs: 0,
          ttl: 0,
          seq,
          bytes: 0,
          fromIP: '',
        });
      }
    }
    return results;
  }

  // ─── Router Solicitation ────────────────────────────────────────

  /**
   * Send Router Solicitation to discover routers and obtain prefix info.
   */
  protected sendRouterSolicitation(portName: string): void {
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
