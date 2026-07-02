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
import { EquipmentRegistry } from '../equipment/EquipmentRegistry';
import { Port } from '../hardware/Port';
import { SocketTable } from '../core/SocketTable';
import { TcpStack } from '../tcp/TcpStack';
import { TimerSet } from '@/events/TimerSet';
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
import { Logger } from '../core/Logger';
import {
  buildICMPError,
  mayGenerateICMPError,
  ICMP_UNREACH_NET,
  ICMP_UNREACH_PORT,
  ICMP_UNREACH_ADMIN_PROHIBITED,
  ICMP_TTL_EXPIRED_IN_TRANSIT,
  type ICMPErrorType,
} from '../core/IcmpErrors';
import { DNS_PORT } from '../dns/transport/DnsUdpTransport';
import { encodeDnsMessage, decodeDnsMessage } from '../dns/wire/DnsMessageCodec';
import type { DnsMessage } from '../dns/wire/DnsMessage';
import {
  nextDnsTransactionId,
  buildLegacyQueryMessage,
} from '../dns/compat/DnsWireCompat';
import { HardwareProfile } from './host/hardware';
import { HostLifecycle } from './host/lifecycle';
import { SystemIdentity } from './host/identity';
import { DHCPClient } from '../dhcp/DHCPClient';
import { DHCPPacket } from '../dhcp/DHCPPacket';
import { WireDhcpChannel } from '../dhcp/DhcpServerChannel';
import type { DHCPClientIfaceState } from '../dhcp/types';
import type { DHCPServer } from '../dhcp/DHCPServer';

// ─── Internal Types ────────────────────────────────────────────────

export interface ARPEntry {
  mac: MACAddress;
  /** Interface on which this entry was learned */
  iface: string;
  timestamp: number;
  /** Dynamic = learned, static = manual, failed = resolution timed out (NUD FAILED). */
  type: 'dynamic' | 'static' | 'failed';
}

/** Linux reachable time default (RFC 4861 §10): 30 seconds */
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
  sourceIP: IPAddress;
  destinationIP: IPAddress;
  udp: UDPPacket;
}

/** Callback invoked for every datagram delivered to a bound UDP port. */
export type UdpListener = (delivery: UdpDelivery) => void;

// ─── IPv6 Neighbor Cache (RFC 4861) ─────────────────────────────────

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
}

// ─── EndHost ───────────────────────────────────────────────────────

export abstract class EndHost extends Equipment {
  // ─── Socket Table (L4) ──────────────────────────────────────────
  /** Per-device socket table — tracks listening and established sockets */
  protected readonly socketTable: SocketTable = new SocketTable();

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
  protected hostRef() {
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
      id: this.id, name: this.name,
      getHostname: () => this.getHostname(),
      getPort: (n: string) => this.getPort(n),
      getPorts: () => this.getPorts(),
      sendFrame: (p: string, f: EthernetFrame) => { this.sendFrame(p, f); },
      resolveMac: (nextHopIp: string) => this.arpTable.get(nextHopIp)?.mac ?? null,
      resolveRoute: (targetIp: string) => {
        const addr = IPAddress.tryParse(targetIp);
        if (!addr) return null;
        const r = this.resolveRoute(addr);
        if (!r) return null;
        return { iface: r.port.getName(), nextHopIp: r.nextHopIP.toString() };
      },
    };
    this.tcpv2 = new TcpStack(hostBase, () => this.getBus());
    this.tcpv2.start();
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
        this.onDhcpLeaseConfigured(iface);
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
        this.onDhcpLeaseReleased(iface);
      },
    );
    this.dhcpClient.setWireChannelFactory((iface) => this.getDhcpWireChannel(iface));
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
        this.dhcpWireChannels.get(dgram.inPort)?.deliver(pkt);
      }
    });
  }

  protected onDhcpLeaseConfigured(_iface: string): void {}

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

    this.getBus().publish({
      topic: 'host.address.changed',
      payload: { ...this.hostRef(), iface: ifName, ip: ip.toString(), cidr: mask.toCIDR(), added: true },
    });

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

    this.routingTable.push({
      network: new IPAddress('0.0.0.0'),
      mask: new SubnetMask('0.0.0.0'),
      nextHop: gw,
      iface: gwIface,
      type: 'default',
      metric: 0,
    });

    Logger.info(this.id, 'host:gateway', `${this.name}: default gateway set to ${gw}`);

    const unchanged = previousDefault !== undefined
      && previousDefault.nextHop?.equals(gw) === true
      && previousDefault.iface === gwIface;
    if (unchanged) return;
    if (previousDefault) {
      this.emitRouteRemoved({
        destination: '0.0.0.0', mask: '0.0.0.0', iface: previousDefault.iface,
      });
    }
    this.emitRouteAdded({
      destination: '0.0.0.0', mask: '0.0.0.0',
      gateway: gw.toString(), iface: gwIface, metric: 0, type: 'default',
    });
  }

  clearDefaultGateway(): void {
    this.defaultGateway = null;
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
          // Find a configured IP to use as server identifier. Physical
          // port IPs cover routers; L3 switches expose IPs only through
          // their Vlanif SVIs (their physical ports stay L2), so fall
          // back to the SVI list when no port carries an address.
          const routerPorts = equip.getPorts();
          let serverIP = '0.0.0.0';
          for (const rPort of routerPorts) {
            const ip = rPort.getIPAddress();
            if (ip) { serverIP = ip.toString(); break; }
          }
          if (serverIP === '0.0.0.0' && typeof router.getSvis === 'function') {
            const svis = router.getSvis() as { ip?: { toString(): string } }[];
            const sviIp = svis.find((s) => s.ip)?.ip?.toString();
            if (sviIp) serverIP = sviIp;
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

      // If connected to a Switch, traverse through the switch's other ports.
      // We can't rely on the DeviceType string alone (test fixtures often
      // pass arbitrary ids as the type), so also duck-type by the SVI
      // surface — any L2/L3 switch in the simulator exposes getSvis.
      const remoteType = remoteEquip.getDeviceType();
      const looksLikeSwitch =
        remoteType.includes('switch')
        || typeof (remoteEquip as unknown as { getSvis?: unknown }).getSvis === 'function';
      if (looksLikeSwitch) {
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
        // DHCP relay (ip helper-address / dhcp relay server-ip): even
        // when the upstream DHCP server is several L3 hops away, the
        // L3 switch's SVI explicitly points clients at it. Resolve each
        // helper IP to its hosting Equipment and register its server.
        const helperBearer = remoteEquip as unknown as {
          getDhcpHelpersForIngressPort?: (port: string) => string[];
        };
        const helpers = helperBearer.getDhcpHelpersForIngressPort?.(remotePort.getName()) ?? [];
        for (const helperIp of helpers) {
          for (const candidate of Equipment.getAllEquipment()) {
            if (candidate.getPorts().some((p) => p.getIPAddress()?.toString() === helperIp)) {
              tryRegisterRouter(candidate);
              break;
            }
          }
        }
      }
    }

    // Strategy 2: Fallback — scan all Equipment instances.
    //
    // This is a pure unit-test convenience for hosts that were never cabled
    // into a topology. A host that HAS at least one cabled interface must never
    // reach a DHCP server it cannot physically touch: real DHCP relies on a
    // broadcast on the local segment (already attempted first over the wire) or
    // a configured relay (ip helper-address). Letting a cabled host pull a lease
    // from a globally-scanned server would break subnet isolation — exactly the
    // god-mode shortcut this refactoring is removing. So the global scan is
    // gated on the host being entirely uncabled.
    const hasCabledInterface = [...this.ports.values()].some((p) => p.getCable());
    if (!hasCabledInterface && this.dhcpClient['connectedServers'].length === 0) {
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
    this.emitRouteAdded({
      destination: network.toString(), mask: mask.toString(),
      gateway: nextHop.toString(), iface: gwIface, metric, type: 'static',
    });
    return true;
  }

  /** Add an on-link (directly-connected) static route via an interface, no gateway. */
  addDeviceRoute(network: IPAddress, mask: SubnetMask, iface: string, metric: number = 0): boolean {
    if (!this.ports.has(iface)) return false;
    this.routingTable.push({ network, mask, nextHop: null, iface, type: 'static', metric });
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
      this.routingTable.push({
        network: new IPAddress('0.0.0.0'),
        mask: new SubnetMask('0.0.0.0'),
        nextHop,
        iface,
        type: 'default',
        metric,
      });
    } else {
      this.routingTable.push({ network, mask, nextHop, iface, type: 'static', metric });
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

  /** Return the port that owns the given unicast IPv4 address, if any. */
  protected getPortOwningIP(ip: IPAddress): Port | null {
    for (const [, port] of this.ports) {
      const portIP = port.getIPAddress();
      if (portIP && portIP.equals(ip)) return port;
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

    const isForUs = this.isLocalDestination(portName, ipPkt.destinationIP);
    // Also accept if destination is the broadcast for our subnet, or the
    // limited broadcast 255.255.255.255 — RFC 1122 §3.3.6 requires accepting
    // it even on an unconfigured interface (DHCP clients depend on this).
    const mask = port.getSubnetMask();
    const isBroadcast = ipPkt.destinationIP.toString() === '255.255.255.255'
      || (myIP && mask && ipPkt.destinationIP.isBroadcastFor(mask));

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
        this.tcpv2.handleIp(portName, ipPkt.sourceIP, ipPkt);
      } else if (ipPkt.protocol === IP_PROTO_UDP) {
        this.deliverUDP(portName, ipPkt, !!isBroadcast);
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
    if (newTTL <= 0) {
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
    this.sendICMPError(portName, offendingPkt, 'destination-unreachable', ICMP_UNREACH_ADMIN_PROHIBITED);
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
  ): void {
    if (!mayGenerateICMPError(offendingPkt)) return;

    const route = this.resolveRoute(offendingPkt.sourceIP);
    if (!route) return; // no route back to source — silently drop

    const srcIP = this.ports.get(inPort)?.getIPAddress() ?? route.port.getIPAddress();
    if (!srcIP) return;

    const errorIP = buildICMPError(srcIP, offendingPkt, icmpType, code, this.defaultTTL);

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

  public async tcpConnect(dstIp: string, dstPort: number): Promise<import('../tcp/TcpStack').TcpSocket | null> {
    const socket = this.tcpv2.connect(dstIp, dstPort);
    if (!socket) return null;
    if (socket.state !== 'established') return null;
    return socket;
  }

  // ─── UDP Transport (RFC 768) ───────────────────────────────────

  /**
   * Bind a UDP port and register a datagram listener (socket-style API).
   * The binding is recorded in the socket table so `netstat`/`ss` show it.
   * Throws EADDRINUSE when the port is already bound (Fail Fast).
   */
  public udpBind(port: number, listener: UdpListener, processName?: string): void {
    this.socketTable.bind('udp', '0.0.0.0', port, undefined, processName);
    this.udpListeners.set(port, listener);
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
  public sendUdpDatagram(
    destinationIP: IPAddress,
    destinationPort: number,
    sourcePort: number,
    payload: unknown,
    payloadBytes: number = 0,
  ): boolean {
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort,
      destinationPort,
      length: 8 + payloadBytes,
      checksum: 0,
      payload,
    };

    // Local delivery (loopback or own address) — like a real kernel, this
    // never reaches the wire.
    if (destinationIP.isLoopback() || this.getPortOwningIP(destinationIP)) {
      const localPkt = createIPv4Packet(
        destinationIP, destinationIP, IP_PROTO_UDP, this.defaultTTL, udp, udp.length,
      );
      this.deliverUDP('lo', localPkt, false);
      return true;
    }

    const route = this.resolveRoute(destinationIP);
    if (!route) return false;
    const srcIP = route.port.getIPAddress();
    if (!srcIP) return false;

    const ipPkt = createIPv4Packet(
      srcIP, destinationIP, IP_PROTO_UDP, this.defaultTTL, udp, udp.length,
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
   * Deliver a locally-addressed UDP datagram to its bound listener.
   * RFC 1122 §4.1.3.1: a datagram for a port with no listener elicits
   * ICMP Destination Unreachable Code 3 (port unreachable) — never for
   * broadcast-directed datagrams.
   */
  private deliverUDP(portName: string, ipPkt: IPv4Packet, wasBroadcast: boolean): void {
    const udp = ipPkt.payload as UDPPacket;
    if (!udp || udp.type !== 'udp') return;

    const listener = this.udpListeners.get(udp.destinationPort);
    if (listener) {
      listener({
        inPort: portName,
        sourceIP: ipPkt.sourceIP,
        destinationIP: ipPkt.destinationIP,
        udp,
      });
      return;
    }

    if (!wasBroadcast) {
      Logger.info(this.id, 'udp:port-unreachable',
        `${this.name}: no listener on UDP ${udp.destinationPort}, ` +
        `replying port unreachable to ${ipPkt.sourceIP}`);
      this.sendICMPError(portName, ipPkt, 'destination-unreachable', ICMP_UNREACH_PORT);
    }
  }

  public async queryDnsServer(
    serverIP: IPAddress,
    name: string,
    qtype: string,
    timeoutMs: number = 2000,
  ): Promise<DnsMessage | null> {
    const wire = this.encodeDnsQuery(name, qtype);
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

      const sent = this.sendUdpDatagram(
        serverIP, DNS_PORT, sourcePort, wire.bytes, wire.bytes.length,
      );
      if (!sent) {
        finish(null);
        return;
      }
      timer = this.hostTimers.setTimeout(() => finish(null), timeoutMs);
    });
  }

  public queryDnsServerSync(
    serverIP: IPAddress,
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
    this.sendUdpDatagram(
      serverIP, DNS_PORT, sourcePort, wire.bytes, wire.bytes.length,
    );
    this.udpClose(sourcePort);
    return reply;
  }

  private encodeDnsQuery(name: string, qtype: string): { id: number; bytes: Uint8Array } | null {
    const id = nextDnsTransactionId();
    const query = buildLegacyQueryMessage(id, name, qtype);
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
    // The ping can abort before both waiters settle (firewall verdict below,
    // race loser timing out later); observe rejections so abandoned waiters
    // never surface as unhandled errors.
    replyPromise.catch(() => {});
    failedPromise.catch(() => {});

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

    const replyOutcome = replyPromise.then((r) => ({ kind: 'reply' as const, r }));
    const failedOutcome = failedPromise.then((r) => ({ kind: 'failed' as const, r }));
    // The race loser keeps waiting until its own timeout fires; observe its
    // rejection so it never surfaces as an unhandled error.
    replyOutcome.catch(() => {});
    failedOutcome.catch(() => {});

    try {
      const winner = await Promise.race([replyOutcome, failedOutcome]);
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

  protected async executePingSequence(
    targetIP: IPAddress,
    count: number = 4,
    timeoutMs: number = 2000,
    ttl?: number,
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
    let arpEntry = this.arpTable.get(nextHopIpStr);
    if (!arpEntry) {
      const arpReq: ARPPacket = {
        type: 'arp', operation: 'request',
        senderMAC: port.getMAC(), senderIP: myIP,
        targetMAC: MACAddress.broadcast(), targetIP: route.nextHopIP,
      };
      this.emitArpRequestSent(portName, nextHopIpStr);
      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_ARP, payload: arpReq,
      });
      arpEntry = this.arpTable.get(nextHopIpStr);
      if (!arpEntry) return { success: false, rttMs: 0, ttl: 0 };
    }

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
      srcMAC: port.getMAC(), dstMAC: arpEntry.mac,
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    });

    unsubReply(); unsubFailed();
    if (reply) return { success: true, rttMs: (reply as { rttMs: number }).rttMs, ttl: (reply as { ttl: number }).ttl };
    if (failed) return { success: false, rttMs: 0, ttl: 0 };
    return { success: false, rttMs: 0, ttl: 0 };
  }

  tcpProbeSync(targetIP: IPAddress, port: number): boolean {
    const socket = this.tcpv2.connect(targetIP.toString(), port);
    if (!socket) return false;
    const established = socket.state === 'established';
    socket.close();
    return established;
  }

  tcpProbeSyncIPv6(targetAddr: string, port: number): boolean {
    const bareTarget = targetAddr.split('%')[0].toLowerCase();
    const sourceAddr = this.findFirstGlobalIPv6();
    if (!sourceAddr) return false;

    const registry = EquipmentRegistry.getInstance();
    for (const dev of registry.getAll()) {
      for (const port6 of dev.getPorts()) {
        const owns = port6.getIPv6Addresses().some((e) =>
          e.address.toString().split('%')[0].toLowerCase() === bareTarget,
        );
        if (!owns) continue;
        if (!dev.getIsPoweredOn()) return false;
        if (!port6.getIsUp()) return false;

        const targetHost = dev as unknown as {
          socketTable?: { getAll(): Array<{ protocol: string; localAddress: string; localPort: number; state: string }> };
          executor?: {
            ip6tables?: { hasDropOnInputPort?: (port: number) => boolean };
            captureLog?: { captureTcpHandshake(src: { ip: string; port: number }, dst: { ip: string; port: number }): void };
          };
        };
        if (!targetHost.socketTable) return false;
        const hasListener = targetHost.socketTable.getAll().some((s) =>
          s.protocol === 'tcp' &&
          s.state === 'LISTEN' &&
          s.localPort === port &&
          (s.localAddress === '::' || s.localAddress.toLowerCase() === bareTarget),
        );
        if (!hasListener) return false;

        if (targetHost.executor?.ip6tables?.hasDropOnInputPort?.(port)) return false;

        const srcPort = 49152 + Math.floor(Math.random() * 16000);
        const localCapture = (this as unknown as { executor?: { captureLog?: { captureTcpHandshake(src: { ip: string; port: number }, dst: { ip: string; port: number }): void } } }).executor?.captureLog;
        localCapture?.captureTcpHandshake({ ip: sourceAddr, port: srcPort }, { ip: bareTarget, port });
        targetHost.executor?.captureLog?.captureTcpHandshake({ ip: sourceAddr, port: srcPort }, { ip: bareTarget, port });

        return true;
      }
    }
    return false;
  }

  private findFirstGlobalIPv6(): string | null {
    for (const port of this.ports.values()) {
      if (!port.getIsUp()) continue;
      for (const entry of port.getIPv6Addresses()) {
        if (entry.origin === 'link-local') continue;
        return entry.address.toString().split('%')[0];
      }
    }
    return null;
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
    return this.neighborCache.snapshot();
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

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const waitPromise = waitForEvent(
        this.getBus(),
        'host.ndp.entry-learned',
        (p) => p.deviceId === this.id && p.ip === targetIpStr,
        { timeoutMs: perAttemptMs, scheduler: this.getScheduler() },
      );

      this.sendFrame(portName, {
        srcMAC: port.getMAC(), dstMAC,
        etherType: ETHERTYPE_IPV6, payload: nsPkt,
      });

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
