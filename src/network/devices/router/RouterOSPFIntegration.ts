/**
 * RouterOSPFIntegration - OSPF/OSPFv3 Integration Engine
 *
 * Extracted from Router to follow Single Responsibility Principle.
 * Manages OSPF convergence, adjacency formation, route computation,
 * and topology-wide LSA exchange for both OSPFv2 (RFC 2328) and
 * OSPFv3 (RFC 5340).
 *
 * Uses a static registry pattern for cross-router topology traversal
 * without importing Router directly (avoids circular dependencies).
 */

import type { Port } from '../../hardware/Port';
import {
  EthernetFrame, IPv4Packet, MACAddress, IPAddress, SubnetMask,
  IPv6Address,
  ETHERTYPE_IPV4, ETHERTYPE_IPV6, IP_PROTO_OSPF,
  createIPv4Packet, createIPv6Packet,
} from '../../core/types';
import { resolveAcrossTransparentDevices } from '../../equipment/TopologyWalk';
import { ipv4MulticastToMac } from '../../core/ip';
import { Logger } from '../../core/Logger';
import { OSPFEngine } from '../../ospf/OSPFEngine';
import { OSPFv3Engine } from '../../ospf/OSPFv3Engine';
import type { OSPFNeighbor, OSPFPacket, OSPFInterface } from '../../ospf/types';
import type { ACLEngine } from './ACLEngine';
import type { IPv6DataPlane } from './IPv6DataPlane';
import type { RouteEntry } from '../Router';
import type { BfdAgent } from '../../bfd/BfdAgent';
import type { Equipment } from '@/network/equipment/Equipment';

// ─── OSPF Extra Config Type ─────────────────────────────────────

/** Advanced OSPF configuration not stored in OSPFEngine itself */
export interface OSPFExtraConfig {
  spfThrottle?: { initial: number; hold: number; max: number };
  maxLsa?: number;
  gracefulRestart?: { enabled: boolean; gracePeriod: number };
  bfdAllInterfaces?: boolean;
  redistributeStatic?: { subnets: boolean; metricType: number };
  redistributeConnected?: { subnets: boolean };
  redistributeRip?: { subnets: boolean; metric?: number; metricType: number };
  areaRanges: Map<string, Array<{ network: string; mask: string }>>;
  virtualLinks: Map<string, string>;
  areaDefaultCost: Map<string, number>;
  areaAuthentication: Map<string, 'simple' | 'message-digest' | 'null'>;
  shamLinks?: Map<string, { areaId: string; source: string; destination: string }>;
  distributeList?: { aclId?: string; prefixListName?: string; direction: 'in' | 'out' };
  defaultInfoMetricType?: number;
  defaultInfoAlways?: boolean;
  pendingIfConfig: Map<string, {
    cost?: number; priority?: number;
    helloInterval?: number; deadInterval?: number;
    authType?: number; authKey?: string;
    demandCircuit?: boolean; networkType?: string;
    mtuIgnore?: boolean; retransmitInterval?: number; transmitDelay?: number;
    authKeyId?: number; silent?: boolean;
    bfd?: boolean; bfdEchoDisabled?: boolean; bfdInterval?: number;
    bfdMinRx?: number; bfdMultiplier?: number; bfdTemplate?: string;
  }>;
  pendingV3IfConfig: Map<string, {
    cost?: number; priority?: number;
    networkType?: string; ipsecAuth?: boolean;
    helloInterval?: number; deadInterval?: number;
  }>;
  redistributeV3Static?: boolean;
  v3AreaRanges: Map<string, Array<{ prefix: string }>>;
  v3VirtualLinks: Map<string, string>;
  v3DistributeList?: { aclId: string; direction: 'in' | 'out' };
  maxMetric?: { enabled: boolean; onStartup?: number };
  nbmaNeighbors?: Array<{ ip: string; priority?: number; pollInterval?: number }>;
  summaryAddresses?: Array<{ network: string; mask: string }>;
  capabilities?: { transit?: boolean; opaque?: boolean };
  logAdjacencyChanges?: boolean;
  /** `log-adjacency-changes detail` — journalise chaque transition d'état. */
  logAdjacencyChangesDetail?: boolean;
}

// ─── Router Context Interface ───────────────────────────────────

/** Interface to access router state needed by OSPF integration */
export interface OSPFRouterContext {
  readonly id: string;
  readonly name: string;
  getPorts(): Map<string, Port>;
  getRoutingTable(): RouteEntry[];
  setRoutingTable(table: RouteEntry[]): void;
  pushRoute(route: RouteEntry): void;
  sendFrame(iface: string, frame: EthernetFrame): void;
  getArpEntry(ip: string): { mac: MACAddress; iface: string } | undefined;
  getACLEngine(): ACLEngine;
  getIPv6Engine(): IPv6DataPlane;
  getIPv6AccessLists(): import('../Router').IPv6ACL[] | undefined;
  getBfdAgent?(): BfdAgent | undefined;
  getIpPrefixListStore?(): import('./policy/IpPrefixList').IpPrefixListStore;
  getBus?(): import('@/events/EventBus').IEventBus;
  /**
   * Le plafond de chemins à coût égal du protocole (`maximum-paths` /
   * `maximum load-balancing`). Optionnel parce que ce contexte est aussi
   * rempli par des objets de test qui n'ont pas de `Router` derrière ;
   * absent, rien n'est plafonné, ce qui est le comportement d'avant.
   */
  maximumPathsFor?(proto: string): number;
}

// ─── OSPF Integration Engine ────────────────────────────────────

export class RouterOSPFIntegration {
  /** Static registry for cross-router topology traversal */
  private static registry = new Map<string, RouterOSPFIntegration>();

  static getByEquipmentId(id: string): RouterOSPFIntegration | undefined {
    return this.registry.get(id);
  }

  // ── OSPF Engine instances ──
  private ospfEngine: OSPFEngine | null = null;
  private readonly carrierDown = new Set<string>();
  private ospfv3Engine: OSPFv3Engine | null = null;

  // ── Extra config (advanced features not in OSPFEngine) ──
  private extraConfig: OSPFExtraConfig = {
    areaRanges: new Map(),
    virtualLinks: new Map(),
    areaDefaultCost: new Map(),
    areaAuthentication: new Map(),
    pendingIfConfig: new Map(),
    pendingV3IfConfig: new Map(),
    v3AreaRanges: new Map(),
    v3VirtualLinks: new Map(),
  };

  constructor(private readonly ctx: OSPFRouterContext) {
    RouterOSPFIntegration.registry.set(ctx.id, this);
  }

  /** Unregister from static registry (called when router is destroyed) */
  dispose(): void {
    RouterOSPFIntegration.registry.delete(this.ctx.id);
  }

  /** Expose context for peer access during topology traversal */
  getContext(): OSPFRouterContext { return this.ctx; }

  // ════════════════════════════════════════════════════════════════
  // Public Methods — Enable/Disable/Getters
  // ════════════════════════════════════════════════════════════════

  routerIdManuel = false;

  routerIdAutomatique(): string | null {
    let loopback: { ip: string; n: number } | null = null;
    let physique: { ip: string; n: number } | null = null;
    for (const [nom, port] of this.ctx.getPorts()) {
      const ip = port.getIPAddress();
      if (!ip) continue;
      const estLoopback = /^Loopback/i.test(nom);
      if (!estLoopback && !(port.getIsUp() && !port.isAdminDown())) continue;
      const n = ip.toUint32();
      const cible = estLoopback ? loopback : physique;
      if (!cible || n > cible.n) {
        if (estLoopback) loopback = { ip: ip.toString(), n };
        else physique = { ip: ip.toString(), n };
      }
    }
    return (loopback ?? physique)?.ip ?? null;
  }

  reelireRouterId(): string | null {
    if (!this.ospfEngine) return null;
    if (this.routerIdManuel) return this.ospfEngine.getRouterId();
    const auto = this.routerIdAutomatique();
    if (auto) this.ospfEngine.setRouterId(auto);
    return auto;
  }

  /** Enable OSPF and create the engine with the given process ID */
  enableOSPF(processId: number = 1): void {
    if (this.ospfEngine) return;
    this.ospfEngine = new OSPFEngine(processId);
    this.ospfEngine.setDeviceId(this.ctx.id);
    const bus = this.ctx.getBus?.();
    if (bus) this.ospfEngine.setEventBus(bus);

    const auto = this.routerIdAutomatique();
    if (auto) this.ospfEngine.setRouterId(auto);

    // Set up send callback for OSPF packets
    this.ospfEngine.setSendCallback((iface, packet, destIP) => {
      this.sendPacket(iface, packet, destIP);
    });

    // Reactive RIB sync: every `ospf.routes-recomputed` the engine ever
    // publishes — including ones the engine schedules and fires entirely on
    // its own (SPF throttle timer after a link/neighbor goes down, LSA
    // aging, dead-interval expiry) — gets pushed into the RIB. Without this,
    // only `autoConverge()`'s own direct `installRoutes()` call (driven by
    // CLI commands / link-up) ever reached the RIB, so autonomous
    // reconvergence recomputed routes the engine never actually installed.
    this.ospfEngine.routingTableSync?.onRoutes((routes) => this.installRoutes(routes));

    Logger.info(this.ctx.id, 'ospf:enabled',
      `${this.ctx.name}: OSPFv2 process ${processId} enabled, Router ID ${this.ospfEngine.getRouterId()}`);
  }

  /** Disable OSPF and remove all OSPF routes */
  disableOSPF(): void {
    if (this.ospfEngine) {
      this.ospfEngine.shutdown();
      this.ospfEngine = null;
      this.ctx.setRoutingTable(this.ctx.getRoutingTable().filter(r => r.type !== 'ospf'));
      Logger.info(this.ctx.id, 'ospf:disabled', `${this.ctx.name}: OSPF disabled`);
    }
  }

  /** Enable OSPFv3 for IPv6 routing */
  enableOSPFv3(processId: number = 1): void {
    if (this.ospfv3Engine) return;
    this.ospfv3Engine = new OSPFv3Engine(processId);
    const v3Bus = this.ctx.getBus?.();
    if (v3Bus) this.ospfv3Engine.setEventBus(v3Bus);

    // The v3 engine already sent its Hellos to ff02::5; nobody had
    // wired the callback, so `sendHello` returned on its first line.
    this.ospfv3Engine.setSendCallback((ifaceName, packet, destIPv6) => {
      this.sendPacketV3(ifaceName, packet, destIPv6);
    });
    Logger.info(this.ctx.id, 'ospfv3:enabled', `${this.ctx.name}: OSPFv3 process ${processId} enabled`);
  }

  getOSPFEngine(): OSPFEngine | null { return this.ospfEngine; }
  getOSPFv3Engine(): OSPFv3Engine | null { return this.ospfv3Engine; }
  isOSPFEnabled(): boolean { return this.ospfEngine !== null; }
  isOSPFv3Enabled(): boolean { return this.ospfv3Engine !== null; }
  getExtraConfig(): OSPFExtraConfig { return this.extraConfig; }

  // ════════════════════════════════════════════════════════════════
  // OSPF Packet Sending & Delivery
  // ════════════════════════════════════════════════════════════════

  /**
   * Send an OSPF packet out an interface (encapsulated in IP).
   * OSPF uses IP protocol 89 directly (not UDP).
   */
  private sendPacket(outIface: string, ospfPkt: any, destIP: string): void {
    const port = this.ctx.getPorts().get(outIface);
    if (!port) return;
    const myIP = port.getIPAddress();
    if (!myIP) return;

    const ipPkt = createIPv4Packet(
      myIP,
      new IPAddress(destIP),
      IP_PROTO_OSPF,
      1,  // TTL=1 (link-local)
      ospfPkt,
      64,
    );

    // Determine destination MAC (RFC 1112 §6.4 for multicast groups)
    let dstMAC: MACAddress;
    if (destIP === '224.0.0.5' || destIP === '224.0.0.6') {
      dstMAC = new MACAddress(ipv4MulticastToMac(destIP));
    } else {
      const cached = this.ctx.getArpEntry(destIP);
      dstMAC = cached ? cached.mac : MACAddress.broadcast();
    }

    this.ctx.sendFrame(outIface, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    });
  }

  /** OSPF packets from the wire (proto 89) — the only path into the engine. */
  receivePacket(ifaceName: string, srcIP: string, packet: OSPFPacket): void {
    this.ospfEngine?.processPacket(ifaceName, srcIP, packet);
  }

  /**
   * Send an OSPFv3 packet (RFC 5340 §2: next header 89, no UDP).
   *
   * The source is the interface's link-local address (RFC 5340 §2.5) —
   * what the neighbour records as next hop. The Ethernet destination
   * derives from the group (RFC 2464 §7).
   */
  private sendPacketV3(outIface: string, ospfPkt: unknown, destIPv6: string): void {
    const port = this.ctx.getPorts().get(outIface);
    if (!port) return;
    const src = port.getLinkLocalIPv6?.() ?? port.getGlobalIPv6?.();
    if (!src) return;

    const dest = new IPv6Address(destIPv6);
    const ipPkt = createIPv6Packet(src, dest, IP_PROTO_OSPF, 1, ospfPkt, 64);
    if (this.extraConfig.pendingV3IfConfig.get(outIface)?.ipsecAuth) {
      ipPkt.ipsecProtected = true;
    }

    const dstMAC = dest.isMulticast()
      ? dest.toMulticastMAC()
      : (this.ctx.getIPv6Engine().getNeighborCache().get(destIPv6)?.mac ?? MACAddress.broadcast());

    this.ctx.sendFrame(outIface, {
      srcMAC: port.getMAC(),
      dstMAC,
      etherType: ETHERTYPE_IPV6,
      payload: ipPkt,
    });
  }

  /** OSPFv3 packets off the wire — the only path into the v3 engine. */
  receivePacketV3(
    ifaceName: string, srcIP: string, packet: unknown, ipsecProtected = false,
  ): void {
    const pkt = packet as { packetType?: number };
    if (!this.ospfv3Engine || pkt?.packetType !== 1) return;

    // RFC 4552 §3: without a matching security association the packet
    // is dropped by IPsec before reaching OSPF — both ways.
    const expectsIpsec = !!this.extraConfig.pendingV3IfConfig.get(ifaceName)?.ipsecAuth;
    if (expectsIpsec !== ipsecProtected) return;

    this.ospfv3Engine.processHello(
      ifaceName, srcIP,
      packet as import('../../ospf/types').OSPFv3HelloPacket,
    );
  }

  /** Wire every peer's v3 send callback to real frames. */
  private setupV3SendCallbacks(allPeers: RouterOSPFIntegration[]): void {
    for (const peer of allPeers) {
      if (!peer.ospfv3Engine) continue;
      peer.ospfv3Engine.setSendCallback((ifaceName, packet, destIPv6) => {
        peer.sendPacketV3(ifaceName, packet, destIPv6);
      });
    }
  }

  /** One real v3 Hello per cabled, non-passive interface of every peer. */
  private pumpHellosV3(allPeers: RouterOSPFIntegration[]): void {
    for (const peer of allPeers) {
      if (!peer.ospfv3Engine) continue;
      for (const [name, iface] of peer.ospfv3Engine.getInterfaces()) {
        if (iface.passive) continue;
        if (!RouterOSPFIntegration.isCabled(peer, name)) continue;
        peer.ospfv3Engine.sendHelloOnInterface(name);
      }
    }
  }

  /**
   * Wire every engine's sendCallback to sendPacket (real frames out the
   * port). Cable delivery is synchronous, so the FSM-driven exchange
   * completes within the convergence call.
   */
  private setupSendCallbacks(allPeers: RouterOSPFIntegration[], useDelay = false): void {
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      peer.ospfEngine.setSendCallback((ifaceName, packet, destIP) => {
        if (!useDelay) {
          peer.sendPacket(ifaceName, packet, destIP);
          return;
        }
        const iface = peer.ospfEngine!.getInterface(ifaceName);
        const delay = iface?.propagationDelayMs ?? 0;
        if (delay > 0) {
          setTimeout(() => peer.sendPacket(ifaceName, packet, destIP), delay);
        } else {
          peer.sendPacket(ifaceName, packet, destIP);
        }
      });
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Adjacency Formation & State Machine (RFC 2328 §10.3)
  // ════════════════════════════════════════════════════════════════

  /**
   * Register a neighbor entry on a local OSPF interface in Down state.
   * State machine transitions are driven separately by driveStateMachine().
   */
  private formAdjacency(
    engine: OSPFEngine,
    localIface: any,
    remoteIface: any,
    remoteRid: string,
    remotePort: Port,
  ): void {
    const remoteIP = remotePort.getIPAddress()?.toString() ?? '0.0.0.0';

    if (localIface.neighbors.has(remoteRid)) return;

    const neighbor: OSPFNeighbor = {
      routerId: remoteRid,
      ipAddress: remoteIP,
      iface: localIface.name,
      state: 'Down',
      priority: remoteIface.priority ?? 1,
      neighborDR: '0.0.0.0',
      neighborBDR: '0.0.0.0',
      deadTimer: null,
      ddSeqNumber: 0,
      isMaster: false,
      lsRequestList: [],
      lsRetransmissionList: [],
      dbSummaryList: [],
      lastHelloReceived: Date.now(),
      options: 0,
      ddRetransmitTimer: null,
      lsrRetransmitTimer: null,
      lastSentDD: null,
    };

    localIface.neighbors.set(remoteRid, neighbor);
  }

  /** True when the engine interface maps to a cabled physical port. */
  private static isCabled(peer: RouterOSPFIntegration, ifaceName: string): boolean {
    return !!peer.ctx.getPorts().get(ifaceName)?.getCable();
  }

  /** One real Hello per cabled, non-passive interface of every peer. */
  private pumpHellos(allPeers: RouterOSPFIntegration[]): void {
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [name, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.passive) continue;
        if (!RouterOSPFIntegration.isCabled(peer, name)) continue;
        peer.ospfEngine.sendHelloOnInterface(name);
      }
    }
  }

  /**
   * Converge the domain. Cabled links: neighbor discovery, 2-Way and the
   * DD/LSR/LSU exchange are all driven by REAL Hello frames (the FSM
   * transitions fire inside processHello/processDD). Virtual interfaces
   * (tunnels, VLs — no frame transport) keep synthetic FSM events.
   * Timer-bound steps (WaitTimer-gated DR election, §10.6 DD
   * retransmit) are fired synchronously so a converge call completes
   * without waiting simulated seconds.
   */
  private drainLoadingNeighbors(allPeers: RouterOSPFIntegration[]): boolean {
    let drained = false;
    for (let round = 0; round < 3; round++) {
      let pending = false;
      for (const peer of allPeers) {
        if (!peer.ospfEngine) continue;
        for (const [, iface] of peer.ospfEngine.getInterfaces()) {
          if (iface.passive) continue;
          for (const [remoteRid, neighbor] of iface.neighbors) {
            if (neighbor.state !== 'Loading') continue;
            pending = true;
            drained = true;
            peer.ospfEngine.triggerLSRRetransmit(iface.name, remoteRid);
          }
        }
      }
      if (!pending) break;
    }
    return drained;
  }

  private driveWireConvergence(allPeers: RouterOSPFIntegration[]): void {
    // Round 1: mutual discovery (Init); round 2: 2-Way both sides →
    // p2p ExStart → DD exchange cascades synchronously over the cables.
    this.pumpHellos(allPeers);
    this.pumpHellos(allPeers);

    // Synthetic Down→Init→2-Way for virtual interfaces only.
    type Entry = { peer: RouterOSPFIntegration; iface: OSPFInterface; neighbor: OSPFNeighbor };
    const p2pInit: Entry[] = [];
    const broadcastInit: Entry[] = [];
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [name, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.passive || iface.state === 'Down') continue;
        if (RouterOSPFIntegration.isCabled(peer, name)) continue;
        for (const [, neighbor] of iface.neighbors) {
          if (neighbor.state === 'Down') {
            peer.ospfEngine.neighborEvent(iface, neighbor, 'HelloReceived');
          }
          if (neighbor.state !== 'Init') continue;
          const bucket = (iface.networkType === 'broadcast' || iface.networkType === 'nbma')
            ? broadcastInit : p2pInit;
          bucket.push({ peer, iface, neighbor });
        }
      }
    }
    // P2P slaves first so the master's startDDExchange finds them in ExStart.
    p2pInit.sort((a, b) => {
      const aIsSlave = a.peer.ospfEngine!.getRouterId() < a.neighbor.routerId ? 0 : 1;
      const bIsSlave = b.peer.ospfEngine!.getRouterId() < b.neighbor.routerId ? 0 : 1;
      return aIsSlave - bIsSlave;
    });
    for (const { peer, iface, neighbor } of [...p2pInit, ...broadcastInit]) {
      if (peer.ospfEngine && neighbor.state === 'Init') {
        peer.ospfEngine.neighborEvent(iface, neighbor, 'TwoWayReceived');
      }
    }

    // WaitTimer accelerator: only ifaces still Waiting elect now —
    // established ones re-elect via BackupSeen/NbrChange on real hellos.
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [, iface] of peer.ospfEngine.getInterfaces()) {
        if ((iface.networkType === 'broadcast' || iface.networkType === 'nbma')
          && iface.state === 'Waiting') {
          peer.ospfEngine.drElection(iface);
        }
      }
    }

    // Propagate DR/BDR declarations (AdjOK → ExStart with the DR).
    this.pumpHellos(allPeers);

    // §10.6 retransmit accelerator: masters whose first DD found the
    // slave not yet in ExStart.
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.passive) continue;
        for (const [remoteRid, neighbor] of iface.neighbors) {
          if (neighbor.state === 'ExStart' && neighbor.isMaster) {
            peer.ospfEngine.triggerDDRetransmit(iface.name, remoteRid);
          }
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // OSPFv2 Auto-Convergence & LSA Exchange
  // ════════════════════════════════════════════════════════════════

  /**
   * Trigger OSPF convergence: activate matching interfaces, discover neighbors
   * via cables, exchange LSAs, and compute/install routes.
   * Called after network commands and cable connects.
   */
  /**
   * A port lost its carrier: the OSPF interface goes down, taking its
   * adjacencies with it, and the SPF routes learned through it are
   * withdrawn. Symmetrical with {@link autoConverge}, which re-activates
   * the interface when the cable comes back
   * (docs/PRD-Link-State.md §2.1 P7).
   */
  onPortUp(portName: string): void {
    this.carrierDown.delete(portName);
    const port = this.ctx.getPorts().get(portName);
    if (!port?.isOperationallyUp()) return;
    const iface = this.ospfEngine?.getInterface(portName);
    if (iface && iface.state === 'Down') this.ospfEngine!.interfaceUp(portName);
  }

  onPortDown(portName: string): void {
    this.carrierDown.add(portName);
    if (!this.ospfEngine) return;
    if (!this.ospfEngine.getInterface(portName)) return;
    // deactivateInterface() only schedules SPF (RFC 2328 §16.5 throttle
    // timer) — it doesn't recompute routes synchronously, so there is
    // nothing fresh to install yet. The routingTableSync subscription
    // wired in enableOSPF() installs the real result once that timer
    // actually fires.
    this.ospfEngine.deactivateInterface(portName);
  }

  autoConverge(): void {
    if (!this.ospfEngine && !this.ospfv3Engine) return;
    // OSPFv3-only mode: skip OSPFv2 steps, jump straight to v3
    if (!this.ospfEngine) {
      this.v3AutoConverge();
      return;
    }

    // Step 1: Auto-activate interfaces matching OSPF network statements
    const routerIfaces: Array<{ name: string; ip: string; mask: string }> = [];
    for (const [portName, port] of this.ctx.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask && !this.carrierDown.has(portName)) {
        routerIfaces.push({ name: portName, ip: ip.toString(), mask: mask.toString() });
      }
    }

    const matches = this.ospfEngine.matchInterfaces(routerIfaces);
    for (const m of matches) {
      if (!this.ospfEngine.getInterface(m.name)) {
        const pending = this.extraConfig.pendingIfConfig.get(m.name);
        this.ospfEngine.activateInterface(m.name, m.ip, m.mask, m.areaId, {
          cost: pending?.cost,
          priority: pending?.priority,
          helloInterval: pending?.helloInterval,
          deadInterval: pending?.deadInterval,
          networkType: pending?.networkType as any,
        });
        if (pending) {
          const iface = this.ospfEngine.getInterface(m.name);
          if (iface) {
            if (pending.authType !== undefined) iface.authType = pending.authType;
            if (pending.authKey !== undefined) iface.authKey = pending.authKey;
            if (pending.retransmitInterval !== undefined) iface.retransmitInterval = pending.retransmitInterval;
            if (pending.transmitDelay !== undefined) iface.transmitDelay = pending.transmitDelay;
          }
        }
      }
    }

    // Step 2: neighbor discovery happens via real Hello frames inside
    // exchangeAndCompute — no out-of-band adjacency seeding here.

    // Step 3: Exchange LSAs between adjacent routers and compute routes
    this.exchangeAndCompute();

    // Step 4: OSPFv3 convergence for IPv6
    this.v3AutoConverge();
  }


  /** Activate interfaces on a remote OSPF peer that match its network statements */
  private activateRemoteInterfaces(remote: RouterOSPFIntegration): void {
    if (!remote.ospfEngine) return;
    const remoteIfaces: Array<{ name: string; ip: string; mask: string }> = [];
    for (const [rp, rPortInner] of remote.ctx.getPorts()) {
      const rIp = rPortInner.getIPAddress();
      const rMask = rPortInner.getSubnetMask();
      if (rIp && rMask && !remote.carrierDown.has(rp)) {
        remoteIfaces.push({ name: rp, ip: rIp.toString(), mask: rMask.toString() });
      }
    }
    const remoteMatches = remote.ospfEngine.matchInterfaces(remoteIfaces);
    for (const rm of remoteMatches) {
      if (!remote.ospfEngine.getInterface(rm.name)) {
        const rPending = remote.extraConfig.pendingIfConfig.get(rm.name);
        remote.ospfEngine.activateInterface(rm.name, rm.ip, rm.mask, rm.areaId, {
          cost: rPending?.cost,
          priority: rPending?.priority,
          helloInterval: rPending?.helloInterval,
          deadInterval: rPending?.deadInterval,
          networkType: rPending?.networkType as any,
        });
        if (rPending) {
          const iface = remote.ospfEngine.getInterface(rm.name);
          if (iface) {
            if (rPending.authType !== undefined) iface.authType = rPending.authType;
            if (rPending.authKey !== undefined) iface.authKey = rPending.authKey;
          }
        }
      }
    }
  }

  /**
   * Exchange LSAs between all connected OSPF routers and compute routes.
   * Simulates LSDB sync and SPF computation in one step.
   */
  private exchangeAndCompute(): void {
    if (!this.ospfEngine) return;

    // Collect all routers in the OSPF domain (BFS via cables, including through switches)
    const allPeers = this.collectOSPFDomain();

    // Ensure all routers have their interfaces properly activated (including Loopbacks)
    for (const peer of allPeers) {
      this.activateRemoteInterfaces(peer);
    }

    // Wire sendCallbacks first: discovery itself runs over real frames.
    this.setupSendCallbacks(allPeers);

    // Form adjacencies over GRE tunnels (no frame transport on virtual
    // ports yet — these stay synthetically seeded)
    for (const peer1 of allPeers) {
      if (!peer1.ospfEngine) continue;
      for (const [tunName, tunPort] of peer1.ctx.getPorts()) {
        if (!tunName.startsWith('Tunnel')) continue;
        const localIface = peer1.ospfEngine.getInterface(tunName);
        if (!localIface) continue;
        const tunCfg = peer1.extraConfig.pendingIfConfig.get(tunName);
        const tunDest = (tunCfg as any)?.tunnelDest;
        if (!tunDest) continue;
        for (const peer2 of allPeers) {
          if (peer1 === peer2 || !peer2.ospfEngine) continue;
          for (const [pn, p] of peer2.ctx.getPorts()) {
            if (p.getIPAddress()?.toString() === tunDest) {
              for (const [tn2, tp2] of peer2.ctx.getPorts()) {
                if (!tn2.startsWith('Tunnel')) continue;
                const remoteIface = peer2.ospfEngine.getInterface(tn2);
                if (!remoteIface) continue;
                const localRid = peer1.ospfEngine.getRouterId();
                const remoteRid = peer2.ospfEngine.getRouterId();
                peer1.formAdjacency(peer1.ospfEngine, localIface, remoteIface, remoteRid, tp2);
                peer2.formAdjacency(peer2.ospfEngine, remoteIface, localIface, localRid, tunPort);
              }
            }
          }
        }
      }
    }

    // Converge: real Hello rounds for cabled links, synthetic FSM events
    // only for virtual interfaces (tunnels / virtual links).
    this.driveWireConvergence(allPeers);

    // Batch reconvergence: relax the wall-clock pacing rules
    // (MinLSInterval/MinLSArrival) on every engine for the duration of this
    // synchronous origination + flood pass — no simulated time elapses here,
    // so a newer LSA instance must still be free to supersede a stale copy.
    for (const peer of allPeers) peer.ospfEngine?.setBatchConvergence(true);

    // Each router originates its Router-LSA after adjacencies are Full
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [areaId] of peer.ospfEngine.getConfig().areas) {
        peer.ospfEngine.originateRouterLSA(areaId);
      }
      for (const [, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.state === 'DR') {
          peer.ospfEngine.originateNetworkLSA(iface);
        }
      }
    }

    // Each router self-originates real external LSAs for its own
    // redistribute/default-information-originate config (RFC 3101 §2.4)
    // before the reflood pass below, so the fresh LSA reaches every
    // already-Full neighbor in the same synchronous convergence pass.
    for (const peer of allPeers) {
      peer.originateRedistributedRoutes();
    }

    // Propagate every router's (possibly updated) self-originated LSAs over
    // real LSU frames so newer instances supersede any stale copy held by a
    // peer that converged earlier — e.g. a router joining an already-converged
    // domain. This replaces the former out-of-band `synchronizeLSDBs` merge:
    // LSDB synchronisation now happens entirely on the wire (RFC 2328 §13.3).
    // Done while sendCallbacks are still synchronous (pre-delay re-wire).
    for (const peer of allPeers) {
      peer.ospfEngine?.refloodSelfOriginatedLSAs();
    }

    if (this.drainLoadingNeighbors(allPeers)) {
      for (const peer of allPeers) {
        if (!peer.ospfEngine) continue;
        for (const [areaId] of peer.ospfEngine.getConfig().areas) {
          peer.ospfEngine.originateRouterLSA(areaId);
        }
        for (const [, iface] of peer.ospfEngine.getInterfaces()) {
          if (iface.state === 'DR') peer.ospfEngine.originateNetworkLSA(iface);
        }
      }
      for (const peer of allPeers) peer.ospfEngine?.refloodSelfOriginatedLSAs();
    }

    for (const peer of allPeers) peer.ospfEngine?.setBatchConvergence(false);

    // Re-wire sendCallbacks with delay enabled for live simulation
    this.setupSendCallbacks(allPeers, true);

    // Run SPF and install routes for each router
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      const routes = peer.ospfEngine.runSPF();
      const extraRoutes = peer.computeAdvancedRoutes(allPeers);
      const allOSPFRoutes = [...routes, ...extraRoutes];

      if ((globalThis as any).__OSPF_DEBUG) {
        const rid = peer.ospfEngine.getRouterId();
        console.log(`[OSPF-DBG] ${peer.ctx.name} (${rid}): SPF routes=${routes.length}, extra=${extraRoutes.length}`);
        for (const rt of routes) console.log(`  SPF: ${rt.network}/${rt.mask} via ${rt.nextHop} iface=${rt.iface} cost=${rt.cost}`);
        for (const rt of extraRoutes) console.log(`  EXT: ${rt.network}/${rt.mask} via ${rt.nextHop} type=${rt.routeType}`);
      }

      peer.installRoutes(allOSPFRoutes);
      peer.provisionBfdSessions();
    }
  }

  /** For every Full neighbor on a BFD-enabled interface, ensure a BFD session exists. */
  private provisionBfdSessions(): void {
    if (!this.ospfEngine) return;
    const bfdAgent = this.ctx.getBfdAgent?.();
    if (!bfdAgent) return;
    for (const [ifaceName, iface] of this.ospfEngine.getInterfaces()) {
      const bfdEnabled = this.extraConfig.bfdAllInterfaces
        || this.extraConfig.pendingIfConfig.get(ifaceName)?.bfd === true;
      if (!bfdEnabled) continue;
      for (const neighbor of iface.neighbors.values()) {
        if (neighbor.state === 'Full') bfdAgent.ensureSession(ifaceName, neighbor.ipAddress);
      }
    }
  }

  /**
   * A BFD session went Down on an interface where OSPF requested BFD
   * tracking — kill the neighbor immediately instead of waiting out the
   * dead-interval (RFC 5880's whole reason to exist).
   */
  onBfdSessionDown(iface: string, neighborIp: string): void {
    if (!this.ospfEngine) return;
    const bfdEnabled = this.extraConfig.bfdAllInterfaces
      || this.extraConfig.pendingIfConfig.get(iface)?.bfd === true;
    if (!bfdEnabled) return;
    const ospfIface = this.ospfEngine.getInterface(iface);
    if (!ospfIface) return;
    const neighbor = [...ospfIface.neighbors.values()].find(n => n.ipAddress === neighborIp);
    if (!neighbor) return;
    this.ospfEngine.neighborEvent(ospfIface, neighbor, 'KillNbr');
  }

  /** Collect all OSPF routers in the domain — BFS through cables,
   *  transparently crossing any number of chained switches/hubs. */
  private collectOSPFDomain(): RouterOSPFIntegration[] {
    const visited = new Set<string>();
    const queue: RouterOSPFIntegration[] = [this];
    const allPeers: RouterOSPFIntegration[] = [];
    visited.add(this.ctx.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      allPeers.push(current);
      if (!current.ospfEngine) continue;

      for (const [, port] of current.ctx.getPorts()) {
        const cable = port.getCable();
        if (!cable) continue;
        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        const found = resolveAcrossTransparentDevices(
          remotePort,
          e => !!RouterOSPFIntegration.getByEquipmentId(e.getId())?.ospfEngine,
        );
        for (const { device } of found) {
          if (visited.has(device.getId())) continue;
          visited.add(device.getId());
          queue.push(RouterOSPFIntegration.getByEquipmentId(device.getId())!);
        }
      }
    }
    return allPeers;
  }

  // ════════════════════════════════════════════════════════════════
  // OSPFv3 Auto-Convergence & IPv6 Route Computation
  // ════════════════════════════════════════════════════════════════

  /**
   * OSPFv3 convergence, driven by REAL Hellos to `ff02::5`.
   *
   * What the topology walk used to decide, the packet now decides:
   * `processHello` refuses mismatched timers, a passive interface sends
   * nothing, and a neighbour exists only because its Hello arrived.
   */
  private v3AutoConverge(): void {
    if (!this.ospfv3Engine) return;

    const allPeers = this.collectOSPFv3Domain();
    this.setupV3SendCallbacks(allPeers);

    // Two rounds, as in v2: discovery (Down → Init), then the neighbour
    // list that carries the pair past 2-Way.
    this.pumpHellosV3(allPeers);
    this.pumpHellosV3(allPeers);

    // WaitTimer accelerator: a broadcast interface still waiting elects
    // now, otherwise nobody is DR before the dead interval.
    for (const peer of allPeers) {
      if (!peer.ospfv3Engine) continue;
      for (const [, iface] of peer.ospfv3Engine.getInterfaces()) {
        if ((iface.networkType === 'broadcast' || iface.networkType === 'nbma')
          && iface.state === 'Waiting') {
          peer.ospfv3Engine.drElection(iface);
        }
      }
    }

    // A third round carries the DR/BDR declarations.
    this.pumpHellosV3(allPeers);

    this.floodV3LinkLSAs(allPeers);
    this.v3ComputeRoutes(allPeers);
  }

  /**
   * Propagate Link-LSAs (RFC 5340 §4.4.3.8) between neighbours.
   *
   * Still by copy rather than an LSU on the wire — this engine has
   * neither DD exchange nor LSU handling — but the copy is now DRIVEN by
   * the real adjacency.
   */
  private floodV3LinkLSAs(allPeers: RouterOSPFIntegration[]): void {
    for (const peer of allPeers) {
      if (!peer.ospfv3Engine) continue;
      for (const [portName, port] of peer.ctx.getPorts()) {
        const iface = peer.ospfv3Engine.getInterface(portName);
        if (!iface || iface.neighbors.size === 0) continue;
        const localLink = peer.ospfv3Engine.getLinkLSA(portName);
        if (!localLink) continue;
        const cable = port.getCable();
        if (!cable) continue;
        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        for (const { ospf: other, port: oPort } of peer.collectV3CandidateRouters(remotePort)) {
          if (!other.ospfv3Engine) continue;
          if (!iface.neighbors.has(other.ospfv3Engine.getRouterId())) continue;
          other.ospfv3Engine.installRemoteLinkLSA(oPort.getName(), localLink);
        }
      }
    }
  }

  /** Collect all OSPFv3 routers in the domain via BFS */
  private collectOSPFv3Domain(): RouterOSPFIntegration[] {
    const visited = new Set<string>();
    const queue: RouterOSPFIntegration[] = [this];
    const allPeers: RouterOSPFIntegration[] = [];
    visited.add(this.ctx.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      allPeers.push(current);
      for (const [, port] of current.ctx.getPorts()) {
        const cable = port.getCable();
        if (!cable) continue;
        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        const found = resolveAcrossTransparentDevices(
          remotePort,
          e => !!RouterOSPFIntegration.getByEquipmentId(e.getId())?.ospfv3Engine,
        );
        for (const { device } of found) {
          if (visited.has(device.getId())) continue;
          visited.add(device.getId());
          queue.push(RouterOSPFIntegration.getByEquipmentId(device.getId())!);
        }
      }
    }
    return allPeers;
  }

  /** Collect candidate OSPFv3 routers connected to a remote port —
   *  transparently crossing any number of chained switches/hubs. */
  private collectV3CandidateRouters(remotePort: Port): Array<{ ospf: RouterOSPFIntegration; port: Port }> {
    return resolveAcrossTransparentDevices(
      remotePort,
      e => !!RouterOSPFIntegration.getByEquipmentId(e.getId())?.ospfv3Engine,
    ).map(({ device, port }) => ({ ospf: RouterOSPFIntegration.getByEquipmentId(device.getId())!, port }));
  }

  /** Compute and install OSPFv3 IPv6 routes from adjacency information */
  private v3ComputeRoutes(allPeers: RouterOSPFIntegration[]): void {
    if (!this.ospfv3Engine) return;
    const ipv6Engine = this.ctx.getIPv6Engine();

    // Remove old OSPFv3 routes from IPv6 table
    ipv6Engine.setRoutingTable(ipv6Engine.getRoutingTableInternal().filter((r: any) => r.type !== 'ospf'));

    const myAreas = new Set(this.ospfv3Engine.getConfig().areas.keys());

    // For each reachable router, install routes for their connected IPv6 networks
    for (const peer of allPeers) {
      if (peer === this || !peer.ospfv3Engine) continue;

      // Check reachability via adjacency chain
      let hasAdjacency = false;
      for (const [, iface] of this.ospfv3Engine.getInterfaces()) {
        for (const [, n] of iface.neighbors) {
          if ((n as any).routerId === peer.ospfv3Engine.getRouterId()) {
            hasAdjacency = true;
            break;
          }
        }
        if (hasAdjacency) break;
      }
      if (!hasAdjacency) {
        hasAdjacency = this.isV3Reachable(peer, allPeers);
      }
      if (!hasAdjacency) continue;

      // Find next hop to reach this router
      const nhInfo = this.findIPv6NextHopTo(peer) || this.findIPv6NextHopViaBFS(peer, allPeers);
      if (!nhInfo) continue;

      // Install routes for remote router's IPv6 connected networks
      const remoteIPv6 = peer.ctx.getIPv6Engine();
      for (const rEntry of remoteIPv6.getRoutingTableInternal()) {
        if (rEntry.type !== 'connected') continue;
        const prefStr = rEntry.prefix?.toString() || '';
        if (prefStr.startsWith('fe80')) continue;
        const alreadyConnected = ipv6Engine.getRoutingTableInternal().some(
          (rt: any) => rt.type === 'connected' &&
            rt.prefix?.toString() === prefStr &&
            rt.prefixLength === rEntry.prefixLength
        );
        if (alreadyConnected) continue;
        const alreadyHave = ipv6Engine.getRoutingTableInternal().some(
          (rt: any) => rt.prefix?.toString() === prefStr && rt.prefixLength === rEntry.prefixLength
        );
        if (alreadyHave) continue;

        const cost = nhInfo.cost || 1;
        const rAreas = new Set(peer.ospfv3Engine.getConfig().areas.keys());
        let isInterArea = false;
        for (const a of rAreas) { if (!myAreas.has(a)) isInterArea = true; }

        ipv6Engine.getRoutingTableInternal().push({
          prefix: rEntry.prefix,
          prefixLength: rEntry.prefixLength,
          nextHop: nhInfo.nextHop,
          iface: nhInfo.iface,
          type: 'ospf' as any,
          ad: 110,
          metric: cost,
          routeType: isInterArea ? 'inter-area' : 'intra-area',
        });
      }

      // Also install routes for remote router's OSPFv3 learned routes (for multi-hop)
      for (const rEntry of remoteIPv6.getRoutingTableInternal()) {
        if ((rEntry as any).type !== 'ospf') continue;
        const prefStr = rEntry.prefix?.toString() || '';
        if (prefStr.startsWith('fe80')) continue;
        const alreadyHave = ipv6Engine.getRoutingTableInternal().some(
          (rt: any) => rt.prefix?.toString() === prefStr && rt.prefixLength === rEntry.prefixLength
        );
        if (alreadyHave) continue;

        const cost = (nhInfo.cost || 1) + (rEntry.metric || 0);
        ipv6Engine.getRoutingTableInternal().push({
          prefix: rEntry.prefix,
          prefixLength: rEntry.prefixLength,
          nextHop: nhInfo.nextHop,
          iface: nhInfo.iface,
          type: 'ospf' as any,
          ad: 110,
          metric: cost,
          routeType: (rEntry as any).routeType || 'intra-area',
        });
      }

      // External routes: redistribute static
      if (peer.extraConfig.redistributeV3Static) {
        for (const rEntry of remoteIPv6.getRoutingTableInternal()) {
          if (rEntry.type !== 'static') continue;
          const prefStr = rEntry.prefix?.toString() || '';
          if (prefStr === '::') continue;
          const alreadyHave = ipv6Engine.getRoutingTableInternal().some(
            (rt: any) => rt.prefix?.toString() === prefStr && rt.prefixLength === rEntry.prefixLength
          );
          if (alreadyHave) continue;
          ipv6Engine.getRoutingTableInternal().push({
            prefix: rEntry.prefix,
            prefixLength: rEntry.prefixLength,
            nextHop: nhInfo.nextHop,
            iface: nhInfo.iface,
            type: 'ospf' as any,
            ad: 110,
            metric: 20,
            routeType: 'type2-external',
          });
        }
      }

      // Default-information originate
      if ((peer.ospfv3Engine.getConfig() as any).defaultInfoOriginate) {
        const alwaysInject = (peer.ospfv3Engine.getConfig() as any).defaultInfoOriginate === 'always';
        const hasDefault = alwaysInject || remoteIPv6.getRoutingTableInternal().some(
          (rt: any) => (rt.type === 'default' || rt.type === 'static') &&
            (rt.prefix?.toString() === '::' || rt.prefix?.toString() === '0000:0000:0000:0000:0000:0000:0000:0000') &&
            (rt.prefixLength === 0)
        );
        if (hasDefault) {
          const alreadyHave = ipv6Engine.getRoutingTableInternal().some(
            (rt: any) => rt.prefix?.toString() === '::' && rt.prefixLength === 0
          );
          if (!alreadyHave) {
            ipv6Engine.getRoutingTableInternal().push({
              prefix: new IPv6Address('::'),
              prefixLength: 0,
              nextHop: nhInfo.nextHop,
              iface: nhInfo.iface,
              type: 'ospf' as any,
              ad: 110,
              metric: 1,
              routeType: 'type2-external',
            });
          }
        }
      }
    }

    // Stub area default route
    for (const [areaId, area] of this.ospfv3Engine.getConfig().areas) {
      if (area.type !== 'stub') continue;
      for (const peer of allPeers) {
        if (peer === this || !peer.ospfv3Engine) continue;
        const rAreas = peer.ospfv3Engine.getConfig().areas;
        if (!rAreas.has(areaId) || rAreas.size <= 1) continue;
        const nhInfo = this.findIPv6NextHopTo(peer) || this.findIPv6NextHopViaBFS(peer, allPeers);
        if (nhInfo) {
          const alreadyHave = ipv6Engine.getRoutingTableInternal().some(
            (rt: any) => rt.prefix?.toString() === '::' && rt.prefixLength === 0
          );
          if (!alreadyHave) {
            ipv6Engine.getRoutingTableInternal().push({
              prefix: new IPv6Address('::'),
              prefixLength: 0,
              nextHop: nhInfo.nextHop,
              iface: nhInfo.iface,
              type: 'ospf' as any,
              ad: 110,
              metric: (nhInfo.cost || 1) + 1,
              routeType: 'inter-area',
              _isDefault: true,
              _isStubDefault: true,
            });
          }
        }
      }
    }

    // OSPFv3 area range summarization
    for (const peer of allPeers) {
      if (peer === this || !peer.ospfv3Engine) continue;
      if (!peer.extraConfig.v3AreaRanges || peer.extraConfig.v3AreaRanges.size === 0) continue;

      for (const [areaId, ranges] of peer.extraConfig.v3AreaRanges) {
        for (const range of ranges) {
          const rangeParts = range.prefix.split('/');
          const rangePrefix = rangeParts[0];
          const rangePrefLen = parseInt(rangeParts[1]);

          const covered = ipv6Engine.getRoutingTableInternal().filter(
            (rt: any) => rt.type === 'ospf' &&
              this.ipv6PrefixMatch(rt.prefix?.toString() || '', rt.prefixLength, rangePrefix, rangePrefLen)
          );

          if (covered.length > 0) {
            ipv6Engine.setRoutingTable(ipv6Engine.getRoutingTableInternal().filter(
              (rt: any) => !(rt.type === 'ospf' &&
                this.ipv6PrefixMatch(rt.prefix?.toString() || '', rt.prefixLength, rangePrefix, rangePrefLen))
            ));

            const nhInfo = this.findIPv6NextHopTo(peer) || this.findIPv6NextHopViaBFS(peer, allPeers);
            if (nhInfo) {
              ipv6Engine.getRoutingTableInternal().push({
                prefix: new IPv6Address(rangePrefix),
                prefixLength: rangePrefLen,
                nextHop: nhInfo.nextHop,
                iface: nhInfo.iface,
                type: 'ospf' as any,
                ad: 110,
                metric: nhInfo.cost || 1,
                routeType: 'intra-area',
              });
            }
          }
        }
      }
    }

    if (this.extraConfig.v3DistributeList) {
      const aclName = this.extraConfig.v3DistributeList.aclId;
      const v3Acl = this.ctx.getIPv6AccessLists()?.find((a) => a.name === aclName);
      if (v3Acl) {
        ipv6Engine.setRoutingTable(ipv6Engine.getRoutingTableInternal().filter((rt: any) => {
          if (rt.type !== 'ospf') return true;
          const prefStr = rt.prefix?.toString() || '';
          const prefLen = rt.prefixLength ?? 64;
          for (const entry of v3Acl.entries) {
            const entryPrefix = entry.srcPrefix ?? entry.prefix;
            const entryPrefixLen = entry.srcPrefixLength ?? entry.prefixLength;
            if (!entryPrefix || entryPrefix === 'any') {
              return entry.action === 'permit';
            }
            if (this.ipv6PrefixMatch(prefStr, prefLen, entryPrefix, entryPrefixLen)) {
              return entry.action === 'permit';
            }
          }
          return true;
        }));
      }
    }

    const routeTypeMap: Record<string, import('@/network/ospf/types').OSPFRouteType> = {
      'intra-area': 'intra-area',
      'inter-area': 'inter-area',
      'type1-external': 'external-type1',
      'type2-external': 'external-type2',
      'external-type1': 'external-type1',
      'external-type2': 'external-type2',
    };
    const myAreaIds = [...this.ospfv3Engine.getConfig().areas.keys()];
    const areaId = myAreaIds[0] ?? '0';
    const engineRoutes = ipv6Engine.getRoutingTableInternal()
      .filter((rt: any) => rt.type === 'ospf')
      .map((rt: any) => ({
        network: rt.prefix?.toString() ?? '',
        mask: String(rt.prefixLength ?? 64),
        routeType: routeTypeMap[rt.routeType] ?? 'intra-area',
        areaId,
        nextHop: rt.nextHop?.toString() ?? '',
        iface: rt.iface ?? '',
        cost: rt.metric ?? 1,
        advertisingRouter: this.ospfv3Engine.getRouterId(),
      } as import('@/network/ospf/types').OSPFRouteEntry));
    this.ospfv3Engine.setRoutes(engineRoutes);
  }

  // ── OSPFv3 Topology Helpers ──

  private isV3Reachable(target: RouterOSPFIntegration, allPeers: RouterOSPFIntegration[]): boolean {
    const visited = new Set<string>();
    const queue: RouterOSPFIntegration[] = [this];
    visited.add(this.ctx.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.ctx.id === target.ctx.id) return true;
      if (!current.ospfv3Engine) continue;

      for (const [, iface] of current.ospfv3Engine.getInterfaces()) {
        for (const [, n] of iface.neighbors) {
          const nRid = (n as any).routerId;
          const neighbor = allPeers.find(p => p.ospfv3Engine?.getRouterId() === nRid);
          if (neighbor && !visited.has(neighbor.ctx.id)) {
            visited.add(neighbor.ctx.id);
            queue.push(neighbor);
          }
        }
      }
    }
    return false;
  }

  private findIPv6NextHopTo(target: RouterOSPFIntegration): { nextHop: any; iface: string; cost: number } | null {
    for (const [portName, port] of this.ctx.getPorts()) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;

      if (remotePort.getEquipmentId() === target.ctx.id) {
        const remoteAddrs = remotePort.getIPv6Addresses?.();
        const linkLocal = remoteAddrs?.find((a: any) => a.origin === 'link-local');
        const globalAddr = remoteAddrs?.find((a: any) => a.origin !== 'link-local');
        const nextHop = linkLocal?.address || globalAddr?.address;
        if (nextHop) {
          const v3Iface = this.ospfv3Engine?.getInterface(portName);
          return { nextHop, iface: portName, cost: v3Iface?.cost ?? 1 };
        }
      }

      // Through switch
      const remoteEquipId = remotePort.getEquipmentId();
      if (!RouterOSPFIntegration.getByEquipmentId(remoteEquipId)) {
        const remoteEquip = remotePort.getOwner() as Equipment | null;
        if (!remoteEquip) continue;
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          if (otherEnd.getEquipmentId() === target.ctx.id) {
            const remoteAddrs = otherEnd.getIPv6Addresses?.();
            const linkLocal = remoteAddrs?.find((a: any) => a.origin === 'link-local');
            const globalAddr = remoteAddrs?.find((a: any) => a.origin !== 'link-local');
            const nextHop = linkLocal?.address || globalAddr?.address;
            if (nextHop) {
              const v3Iface = this.ospfv3Engine?.getInterface(portName);
              return { nextHop, iface: portName, cost: v3Iface?.cost ?? 1 };
            }
          }
        }
      }
    }
    return null;
  }

  private findIPv6NextHopViaBFS(target: RouterOSPFIntegration, allPeers: RouterOSPFIntegration[]): { nextHop: any; iface: string; cost: number } | null {
    const visited = new Set<string>();
    const queue: Array<{ peer: RouterOSPFIntegration; nextHop: any; iface: string; cost: number }> = [];
    visited.add(this.ctx.id);

    // Seed with direct neighbors
    for (const [portName, port] of this.ctx.getPorts()) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteEquipId = remotePort.getEquipmentId();
      const remoteEquip = remotePort.getOwner() as Equipment | null;

      const tryAdd = (peer: RouterOSPFIntegration, rPort: Port) => {
        if (visited.has(peer.ctx.id) || !peer.ospfv3Engine) return;
        const remoteAddrs = rPort.getIPv6Addresses?.();
        const linkLocal = remoteAddrs?.find((a: any) => a.origin === 'link-local');
        const globalAddr = remoteAddrs?.find((a: any) => a.origin !== 'link-local');
        const nextHop = linkLocal?.address || globalAddr?.address;
        if (!nextHop) return;
        const v3Iface = this.ospfv3Engine?.getInterface(portName);
        visited.add(peer.ctx.id);
        queue.push({ peer, nextHop, iface: portName, cost: v3Iface?.cost ?? 1 });
      };

      const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteEquipId);
      if (remoteOSPF) {
        tryAdd(remoteOSPF, remotePort);
      } else if (remoteEquip) {
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          const otherOSPF = RouterOSPFIntegration.getByEquipmentId(otherEnd.getEquipmentId());
          if (otherOSPF) tryAdd(otherOSPF, otherEnd);
        }
      }
    }

    while (queue.length > 0) {
      const { peer: curr, nextHop, iface, cost } = queue.shift()!;
      if (curr.ctx.id === target.ctx.id) return { nextHop, iface, cost };
      for (const [pn, p] of curr.ctx.getPorts()) {
        const cable = p.getCable();
        if (!cable) continue;
        const rp = cable.getPortA() === p ? cable.getPortB() : cable.getPortA();
        if (!rp) continue;
        const rid = rp.getEquipmentId();
        if (visited.has(rid)) continue;
        const re = RouterOSPFIntegration.getByEquipmentId(rid);
        if (re?.ospfv3Engine) {
          visited.add(rid);
          const currIface = curr.ospfv3Engine?.getInterface(pn);
          queue.push({ peer: re, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
        } else {
          const equip = rp.getOwner() as Equipment | null;
          if (!equip) continue;
          for (const swPort of equip.getPorts()) {
            if (swPort === rp) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const oid = otherEnd.getEquipmentId();
            if (visited.has(oid)) continue;
            const oe = RouterOSPFIntegration.getByEquipmentId(oid);
            if (oe?.ospfv3Engine) {
              visited.add(oid);
              const currIface = curr.ospfv3Engine?.getInterface(pn);
              queue.push({ peer: oe, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
            }
          }
        }
      }
    }
    return null;
  }

  // ── IPv6 Utility Helpers ──

  private ipv6PrefixMatch(prefix: string, prefLen: number, rangePrefix: string, rangePrefLen: number): boolean {
    if (prefLen < rangePrefLen) return false;
    const norm1 = this.normalizeIPv6(prefix);
    const norm2 = this.normalizeIPv6(rangePrefix);
    const fullBits1 = norm1.split(':').map(h => parseInt(h, 16).toString(2).padStart(16, '0')).join('');
    const fullBits2 = norm2.split(':').map(h => parseInt(h, 16).toString(2).padStart(16, '0')).join('');
    return fullBits1.slice(0, rangePrefLen) === fullBits2.slice(0, rangePrefLen);
  }

  private normalizeIPv6(addr: string): string {
    if (!addr || addr === '::') return '0000:0000:0000:0000:0000:0000:0000:0000';
    let parts = addr.split(':');
    if (addr.includes('::')) {
      const idx = parts.indexOf('');
      const missing = 8 - parts.filter(p => p !== '').length;
      const expanded = Array(missing).fill('0');
      parts = [...parts.slice(0, idx).filter(p => p !== ''), ...expanded, ...parts.slice(idx + 1).filter(p => p !== '')];
    }
    return parts.map(p => (p || '0').padStart(4, '0')).join(':');
  }

  // ════════════════════════════════════════════════════════════════
  // Advanced OSPF Routes & Installation
  // ════════════════════════════════════════════════════════════════

  /**
   * Compute advanced OSPF routes: external (redistribute, default-info),
   * inter-area (ABR summarization, virtual links), stub area defaults, NSSA.
   */
  private computeAdvancedRoutes(allPeers: RouterOSPFIntegration[]): any[] {
    if (!this.ospfEngine) return [];
    const routes: any[] = [];
    const extra = this.extraConfig;
    const myAreas = new Set(this.ospfEngine.getConfig().areas.keys());
    const isABR = myAreas.size > 1;

    // External routes (default-information originate, redistribute
    // static/connected/rip) are no longer fabricated here — every router
    // self-originates real Type-5/Type-7 LSAs in originateRedistributedRoutes()
    // (called from exchangeAndCompute() before SPF), and OSPFEngine's own
    // processExternalRoutes()/getRoutes() derive every router's E1/E2 route
    // from those LSAs, same as it would for a real ASBR. NSSA Type-7→Type-5
    // translation likewise happens for real, via installLSA() on the ABR.

    // Inter-area routes (O IA) are no longer fabricated here either: every
    // ABR already self-originates real Type-3/Type-4 Summary LSAs from
    // originateSummariesAsABR() (called automatically inside its own
    // runSPF() whenever isABR()), area ranges included — the CLI's
    // `area <id> range` handler calls the engine's own addAreaRange()
    // directly (CiscoOspfCommands.ts). Every router derives its own O IA
    // route from those real LSAs via buildRoutesFromTree(), same as a real ABR.

    // ── Virtual link: propagate routes through transit area ──
    for (const peer of allPeers) {
      if (peer === this || !peer.ospfEngine) continue;
      const rExtra = peer.extraConfig;
      if (rExtra.virtualLinks.size === 0) continue;

      for (const [transitAreaId, peerRid] of rExtra.virtualLinks) {
        const vlPeer = allPeers.find(p => p.ospfEngine?.getRouterId() === peerRid);
        if (!vlPeer?.ospfEngine) continue;
        if (!vlPeer.extraConfig.virtualLinks.has(transitAreaId)) continue;

        const nhToR = this.findNextHopTo(peer);
        if (!nhToR) continue;

        const peerRoutes = vlPeer.ospfEngine.getRoutes();
        for (const prt of peerRoutes) {
          const alreadyHave = routes.some(rt => rt.network === prt.network && rt.mask === prt.mask);
          if (alreadyHave) continue;
          routes.push({
            network: prt.network, mask: prt.mask,
            nextHop: nhToR.nextHop, iface: nhToR.iface,
            cost: prt.cost + (nhToR.cost || 0),
            routeType: 'inter-area', areaId: prt.areaId,
            advertisingRouter: vlPeer.ospfEngine.getRouterId(),
          });
        }

        for (const farPeer of allPeers) {
          if (farPeer === this || !farPeer.ospfEngine) continue;
          const nhToFar = this.findNextHopTo(farPeer);
          if (!nhToFar) continue;
          const farRoutes = farPeer.ospfEngine.getRoutes();
          for (const frt of farRoutes) {
            if (myAreas.has(frt.areaId)) continue;
            const alreadyHave = routes.some(rt => rt.network === frt.network && rt.mask === frt.mask);
            if (alreadyHave) continue;
            routes.push({
              network: frt.network, mask: frt.mask,
              nextHop: nhToFar.nextHop, iface: nhToFar.iface,
              cost: frt.cost + (nhToFar.cost || 0),
              routeType: 'inter-area', areaId: frt.areaId,
              advertisingRouter: farPeer.ospfEngine.getRouterId(),
            });
          }
        }
      }
    }

    // ── Stub area default route ──
    for (const [areaId, area] of this.ospfEngine.getConfig().areas) {
      if (area.type !== 'stub' && area.type !== 'totally-stubby') continue;
      for (const peer of allPeers) {
        if (peer === this || !peer.ospfEngine) continue;
        const rAreas = peer.ospfEngine.getConfig().areas;
        if (!rAreas.has(areaId)) continue;
        if (rAreas.size <= 1) continue;
        const nh = this.findNextHopTo(peer);
        if (nh) {
          routes.push({
            network: '0.0.0.0', mask: '0.0.0.0',
            nextHop: nh.nextHop, iface: nh.iface,
            cost: (nh.cost || 0) + 1,
            routeType: 'inter-area', areaId,
            advertisingRouter: peer.ospfEngine.getRouterId(),
            _isDefault: true, _isStubDefault: true,
          });
        }
      }

      if (area.type === 'totally-stubby' && !isABR) {
        const filtered = routes.filter(rt => {
          if (rt.routeType === 'inter-area' && !rt._isStubDefault) return false;
          return true;
        });
        routes.length = 0;
        routes.push(...filtered);
      }
    }

    // NSSA Type-7→Type-5 conversion is handled for real by installLSA() on
    // the ABR (see originateRedistributedRoutes()); nothing to fabricate here.

    return routes;
  }

  /**
   * `filter-policy { <acl> | ip-prefix <name> } { import | export }`
   * (Huawei) — evaluated against a candidate route's network/mask.
   * `import` gates installRoutes() (routes learned via OSPF into the RIB);
   * `export` gates originateRedistributedRoutes() (routes redistributed
   * from another source into OSPF). No per-protocol scoping: one filter
   * applies to every redistributed source, matching the single-value
   * `distributeList` config shape.
   */
  private isFilteredByDistributeList(network: string, mask: string, direction: 'in' | 'out'): boolean {
    const distList = this.extraConfig.distributeList;
    if (!distList || distList.direction !== direction) return false;

    if (distList.prefixListName) {
      const list = this.ctx.getIpPrefixListStore?.()?.get(distList.prefixListName, 'ipv4');
      if (!list) return false;
      // No matching entry is an implicit deny, same as a real ip-prefix list.
      return list.evaluate(network, new SubnetMask(mask).toCIDR()) !== 'permit';
    }

    if (distList.aclId) {
      const acl = this.ctx.getACLEngine().getAccessListsInternal().find(
        (a: any) => a.id === parseInt(distList.aclId ?? '', 10) || a.name === distList.aclId
      );
      if (!acl) return false;
      let matched = false;
      let action: 'permit' | 'deny' = 'deny';
      for (const entry of acl.entries) {
        const srcIP = entry.srcIP?.toString() || '0.0.0.0';
        const srcWild = entry.srcWildcard?.toString() || '255.255.255.255';
        if (srcIP === 'any' || (srcIP === '0.0.0.0' && srcWild === '255.255.255.255')) {
          action = entry.action; matched = true; break;
        }
        const netNum = this.ipToNum(network);
        const aclNum = this.ipToNum(srcIP);
        const wildNum = this.ipToNum(srcWild);
        if ((netNum & ~wildNum) === (aclNum & ~wildNum)) {
          action = entry.action; matched = true; break;
        }
      }
      return !matched || action === 'deny';
    }

    return false;
  }

  /**
   * Self-originate real Type-5/Type-7 LSAs for this router's own
   * redistribution config (`redistribute static/connected/rip`,
   * `default-information originate`). OSPFEngine.redistributeExternalRoute()
   * already picks Type-7 vs Type-5 per area (RFC 3101 §2.4); every other
   * router then derives its own E1/E2 route from the flooded LSA via the
   * engine's normal SPF/processExternalRoutes() path — no cross-router
   * object introspection needed.
   */
  private originateRedistributedRoutes(): void {
    if (!this.ospfEngine) return;
    // No active interfaces yet (e.g. `redistribute` typed before any
    // `network` statement matched one): redistributeExternalRoute() would
    // fall back to an area-less Type-5, which then never gets superseded
    // once the router actually joins an NSSA area. Nothing meaningful to
    // redistribute onto yet — the next autoConverge (post-`network`) retries.
    if (this.ospfEngine.getInterfaces().size === 0) return;
    const extra = this.extraConfig;

    if (this.ospfEngine.getConfig().defaultInformationOriginate) {
      const hasDefault = extra.defaultInfoAlways === true
        || this.ctx.getRoutingTable().some(rt =>
          rt.type === 'default' || (rt.type === 'static' &&
            rt.network.toString() === '0.0.0.0' && rt.mask.toString() === '0.0.0.0'));
      if (hasDefault) {
        const metricType = (extra.defaultInfoMetricType ?? 2) as 1 | 2;
        this.ospfEngine.redistributeExternalRoute('0.0.0.0', '0.0.0.0', 1, metricType);
      }
    }

    if (extra.redistributeStatic) {
      const metricType = (extra.redistributeStatic.metricType ?? 2) as 1 | 2;
      for (const rt of this.ctx.getRoutingTable()) {
        if (rt.type !== 'static') continue;
        if (rt.network.toString() === '0.0.0.0') continue;
        if (this.isFilteredByDistributeList(rt.network.toString(), rt.mask.toString(), 'out')) continue;
        this.ospfEngine.redistributeExternalRoute(rt.network.toString(), rt.mask.toString(), 20, metricType);
      }
    }

    if (extra.redistributeRip) {
      const metricType = (extra.redistributeRip.metricType ?? 2) as 1 | 2;
      const metric = extra.redistributeRip.metric ?? 20;
      for (const rt of this.ctx.getRoutingTable()) {
        if (rt.type !== 'rip') continue;
        if (this.isFilteredByDistributeList(rt.network.toString(), rt.mask.toString(), 'out')) continue;
        this.ospfEngine.redistributeExternalRoute(rt.network.toString(), rt.mask.toString(), metric, metricType);
      }
    }

    if (extra.redistributeConnected) {
      for (const rt of this.ctx.getRoutingTable()) {
        if (rt.type !== 'connected') continue;
        if (this.ospfEngine.getInterface(rt.iface)) continue; // already an OSPF interface
        if (this.isFilteredByDistributeList(rt.network.toString(), rt.mask.toString(), 'out')) continue;
        this.ospfEngine.redistributeExternalRoute(rt.network.toString(), rt.mask.toString(), 20, 2);
      }
    }
  }

  // ── Next-Hop Resolution ──

  /** Find the next hop and interface to reach a target OSPF peer */
  private findNextHopTo(target: RouterOSPFIntegration): { nextHop: string; iface: string; cost: number } | null {
    if (!this.ospfEngine) return null;

    // Direct neighbor? — transparently crosses any number of switches/hubs.
    for (const [portName, port] of this.ctx.getPorts()) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;

      const hit = resolveAcrossTransparentDevices(remotePort, e => e.getId() === target.ctx.id)[0];
      if (hit) {
        const remoteIP = hit.port.getIPAddress()?.toString();
        if (remoteIP) {
          const localIface = this.ospfEngine.getInterface(portName);
          return { nextHop: remoteIP, iface: portName, cost: localIface?.cost ?? 1 };
        }
      }
    }

    // Not directly connected — find via SPF routes
    const ospfRoutes = this.ospfEngine.getRoutes();
    for (const [, port] of target.ctx.getPorts()) {
      const ip = port.getIPAddress()?.toString();
      if (!ip) continue;
      for (const rt of ospfRoutes) {
        if (rt.nextHop && this.ipInSubnet(ip, rt.network, rt.mask)) {
          return { nextHop: rt.nextHop, iface: rt.iface, cost: rt.cost };
        }
      }
    }

    // BFS through adjacency chain
    const visited = new Set<string>();
    const queue: Array<{ peer: RouterOSPFIntegration; nextHop: string; iface: string; cost: number }> = [];
    visited.add(this.ctx.id);

    for (const [portName, port] of this.ctx.getPorts()) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;

      const found = resolveAcrossTransparentDevices(
        remotePort, e => !!RouterOSPFIntegration.getByEquipmentId(e.getId()),
      );
      for (const { device, port: viaPort } of found) {
        const peer = RouterOSPFIntegration.getByEquipmentId(device.getId())!;
        if (visited.has(peer.ctx.id) || !peer.ospfEngine) continue;
        const remoteIP = viaPort.getIPAddress()?.toString();
        if (!remoteIP) continue;
        const localIface = this.ospfEngine.getInterface(portName);
        visited.add(peer.ctx.id);
        queue.push({ peer, nextHop: remoteIP, iface: portName, cost: localIface?.cost ?? 1 });
      }
    }

    while (queue.length > 0) {
      const { peer: curr, nextHop, iface, cost } = queue.shift()!;
      if (curr.ctx.id === target.ctx.id) return { nextHop, iface, cost };

      for (const [pn, p] of curr.ctx.getPorts()) {
        const cable = p.getCable();
        if (!cable) continue;
        const rp = cable.getPortA() === p ? cable.getPortB() : cable.getPortA();
        if (!rp) continue;

        const found = resolveAcrossTransparentDevices(
          rp, e => !!RouterOSPFIntegration.getByEquipmentId(e.getId())?.ospfEngine,
        );
        for (const { device } of found) {
          if (visited.has(device.getId())) continue;
          const re = RouterOSPFIntegration.getByEquipmentId(device.getId())!;
          visited.add(device.getId());
          const currIface = curr.ospfEngine?.getInterface(pn);
          queue.push({ peer: re, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
        }
      }
    }

    return null;
  }

  // ── Route Installation ──

  /** Install OSPF-computed routes into the router's RIB */
  private installRoutes(routes: any[]): void {
    // Remove old OSPF routes
    this.ctx.setRoutingTable(this.ctx.getRoutingTable().filter(r => r.type !== 'ospf'));

    for (const route of routes) {
      const network = route.network || route.destination;
      const mask = route.mask;

      if (!network || !mask) continue;

      // Don't install if a connected route already covers it
      const existing = this.ctx.getRoutingTable().find(
        r => r.type === 'connected' &&
             r.network.toString() === network &&
             r.mask.toString() === mask
      );
      if (existing) continue;

      // Apply distribute-list inbound filtering
      if (this.isFilteredByDistributeList(network, mask, 'in')) continue;

      // ECMP: mergeRoutesByDestination() may have computed several
      // equal-cost paths (route.nextHops/route.ifaces, parallel arrays,
      // always including the primary route.nextHop/route.iface at index
      // 0) — install one RIB entry per path instead of collapsing to
      // just the primary, so Router.lookupRoute has more than one to
      // pick from for real multipath forwarding.
      const nextHops: Array<string | undefined> =
        route.nextHops?.length ? route.nextHops : [route.nextHop];
      const ifaces: Array<string | undefined> =
        route.ifaces?.length ? route.ifaces : [route.iface || route.interface || ''];

      // `maximum-paths` / `maximum load-balancing` borne ce que le
      // protocole INSTALLE, pas seulement ce que le plan de données
      // choisit : sans ce plafond ici, `show ip route` listerait quatre
      // chemins sur une machine qui n'en emprunte qu'un, et les deux
      // vues de la même machine se contrediraient.
      const plafondOspf = this.ctx.maximumPathsFor?.('ospf') ?? Infinity;
      const retenus = Math.min(nextHops.length, plafondOspf);
      for (let i = 0; i < retenus; i++) {
        const nextHop = nextHops[i];
        const iface = ifaces[i] ?? ifaces[0] ?? '';
        const entry: any = {
          network: new IPAddress(network),
          mask: new SubnetMask(mask),
          nextHop: nextHop ? new IPAddress(nextHop) : null,
          iface,
          type: 'ospf' as any,
          ad: 110,
          metric: route.cost ?? 0,
        };
        if (route.routeType) entry.routeType = route.routeType;
        if (route._metricType) entry._metricType = route._metricType;
        if (route._isDefault) entry._isDefault = route._isDefault;
        if (route._isStubDefault) entry._isStubDefault = route._isStubDefault;
        this.ctx.pushRoute(entry);
      }
    }
  }

  // ── IP Utility Helpers ──

  private ipInSubnet(ip: string, network: string, mask: string): boolean {
    const ipNum = this.ipToNum(ip);
    const netNum = this.ipToNum(network);
    const maskNum = this.ipToNum(mask);
    return (ipNum & maskNum) === (netNum & maskNum);
  }

  private ipToNum(ip: string): number {
    return new IPAddress(ip).toUint32();
  }
}
