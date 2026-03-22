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
  ETHERTYPE_IPV4,
  createIPv4Packet,
} from '../../core/types';
import { Equipment } from '../../equipment/Equipment';
import { Logger } from '../../core/Logger';
import { OSPFEngine } from '../../ospf/OSPFEngine';
import { OSPFv3Engine } from '../../ospf/OSPFv3Engine';
import type { OSPFNeighbor, OSPFPacket, OSPFInterface } from '../../ospf/types';
import type { ACLEngine } from './ACLEngine';
import type { IPv6DataPlane } from './IPv6DataPlane';
import type { RouteEntry } from '../Router';

// ─── OSPF Extra Config Type ─────────────────────────────────────

/** Advanced OSPF configuration not stored in OSPFEngine itself */
export interface OSPFExtraConfig {
  spfThrottle?: { initial: number; hold: number; max: number };
  maxLsa?: number;
  gracefulRestart?: { enabled: boolean; gracePeriod: number };
  bfdAllInterfaces?: boolean;
  redistributeStatic?: { subnets: boolean; metricType: number };
  redistributeConnected?: { subnets: boolean };
  areaRanges: Map<string, Array<{ network: string; mask: string }>>;
  virtualLinks: Map<string, string>;
  distributeList?: { aclId: string; direction: 'in' | 'out' };
  defaultInfoMetricType?: number;
  pendingIfConfig: Map<string, {
    cost?: number; priority?: number;
    helloInterval?: number; deadInterval?: number;
    authType?: number; authKey?: string;
    demandCircuit?: boolean; networkType?: string;
    mtuIgnore?: boolean; retransmitInterval?: number; transmitDelay?: number;
  }>;
  pendingV3IfConfig: Map<string, {
    cost?: number; priority?: number;
    networkType?: string; ipsecAuth?: boolean;
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
  getIPv6AccessLists(): any[] | undefined;
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
  private ospfv3Engine: OSPFv3Engine | null = null;

  // ── Extra config (advanced features not in OSPFEngine) ──
  private extraConfig: OSPFExtraConfig = {
    areaRanges: new Map(),
    virtualLinks: new Map(),
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

  /** Enable OSPF and create the engine with the given process ID */
  enableOSPF(processId: number = 1): void {
    if (this.ospfEngine) return;
    this.ospfEngine = new OSPFEngine(processId);

    // Auto-detect Router ID: highest interface IP
    let highestIP = '0.0.0.0';
    let highestNum = 0;
    for (const [, port] of this.ctx.getPorts()) {
      const ip = port.getIPAddress();
      if (ip) {
        const num = ip.toUint32();
        if (num > highestNum) {
          highestNum = num;
          highestIP = ip.toString();
        }
      }
    }
    if (highestIP !== '0.0.0.0') {
      this.ospfEngine.setRouterId(highestIP);
    }

    // Set up send callback for OSPF packets
    this.ospfEngine.setSendCallback((iface, packet, destIP) => {
      this.sendPacket(iface, packet, destIP);
    });

    Logger.info(this.ctx.id, 'ospf:enabled',
      `${this.ctx.name}: OSPFv2 process ${processId} enabled, Router ID ${highestIP}`);
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
      89, // OSPF protocol number
      1,  // TTL=1 (link-local)
      ospfPkt,
      64,
    );

    // Determine destination MAC
    let dstMAC: MACAddress;
    if (destIP === '224.0.0.5' || destIP === '224.0.0.6') {
      // Multicast: 01:00:5e + lower 23 bits of IP
      const ipOctets = new IPAddress(destIP).getOctets();
      dstMAC = new MACAddress(
        `01:00:5e:${(ipOctets[1] & 0x7f).toString(16).padStart(2, '0')}:` +
        `${ipOctets[2].toString(16).padStart(2, '0')}:${ipOctets[3].toString(16).padStart(2, '0')}`
      );
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

  /**
   * Deliver an OSPF packet from a local interface to the correct remote
   * OSPFEngine(s). Follows the physical cable topology:
   *   - Direct P2P link → single remote router
   *   - Through a switch/hub → all routers connected to that segment
   */
  private deliverPacket(localIfaceName: string, packet: OSPFPacket, _destIP: string): void {
    const port = this.ctx.getPorts().get(localIfaceName);
    if (!port) return;

    const cable = port.getCable();
    if (!cable) return;

    const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
    if (!remotePort) return;

    const srcIP = port.getIPAddress()?.toString() ?? '0.0.0.0';
    const remoteEquipId = remotePort.getEquipmentId();
    const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteEquipId);

    if (remoteOSPF && remoteOSPF.ospfEngine) {
      remoteOSPF.ospfEngine.processPacket(remotePort.getName(), srcIP, packet);
    } else {
      // Switch / Hub — deliver to all other connected routers on the segment
      const remoteEquip = Equipment.getById(remoteEquipId);
      if (!remoteEquip) return;
      for (const swPort of remoteEquip.getPorts()) {
        if (swPort === remotePort) continue;
        const swCable = swPort.getCable();
        if (!swCable) continue;
        const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
        if (!otherEnd) continue;
        const otherOSPF = RouterOSPFIntegration.getByEquipmentId(otherEnd.getEquipmentId());
        if (otherOSPF?.ospfEngine) {
          otherOSPF.ospfEngine.processPacket(otherEnd.getName(), srcIP, packet);
        }
      }
    }
  }

  /**
   * Wire every OSPFEngine in the domain with a sendCallback that calls
   * deliverPacket, enabling real DD/LSR/LSU/LSAck packet exchange.
   */
  private setupSendCallbacks(allPeers: RouterOSPFIntegration[], useDelay = false): void {
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      peer.ospfEngine.setSendCallback((ifaceName, packet, destIP) => {
        if (!useDelay) {
          peer.deliverPacket(ifaceName, packet, destIP);
          return;
        }
        const iface = peer.ospfEngine!.getInterface(ifaceName);
        const delay = iface?.propagationDelayMs ?? 0;
        if (delay > 0) {
          setTimeout(() => peer.deliverPacket(ifaceName, packet, destIP), delay);
        } else {
          peer.deliverPacket(ifaceName, packet, destIP);
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

  /**
   * Drive the OSPF neighbor state machine for all routers in the domain.
   * Simulates full RFC 2328 §10.3 sequence:
   *   Down → Init → 2-Way → ExStart → Exchange → Loading → Full
   */
  private driveStateMachine(allPeers: RouterOSPFIntegration[]): void {
    // Phase A: HelloReceived — Down → Init
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.passive) continue;
        for (const [, neighbor] of iface.neighbors) {
          if (neighbor.state === 'Down') {
            peer.ospfEngine.neighborEvent(iface, neighbor, 'HelloReceived');
          }
        }
      }
    }

    // Phase B: TwoWayReceived — Init → 2-Way or ExStart
    type BEntry = { peer: RouterOSPFIntegration; iface: OSPFInterface; neighbor: OSPFNeighbor };
    const p2pInit: BEntry[] = [];
    const broadcastInit: BEntry[] = [];

    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.passive) continue;
        for (const [, neighbor] of iface.neighbors) {
          if (neighbor.state !== 'Init') continue;
          const bucket = (iface.networkType === 'broadcast' || iface.networkType === 'nbma')
            ? broadcastInit : p2pInit;
          bucket.push({ peer, iface, neighbor });
        }
      }
    }

    // P2P: slaves first — when master fires startDDExchange, slave is in ExStart
    p2pInit.sort((a, b) => {
      const aIsSlave = a.peer.ospfEngine!.getRouterId() < a.neighbor.routerId ? 0 : 1;
      const bIsSlave = b.peer.ospfEngine!.getRouterId() < b.neighbor.routerId ? 0 : 1;
      return aIsSlave - bIsSlave;
    });
    for (const { peer, iface, neighbor } of p2pInit) {
      if (peer.ospfEngine && neighbor.state === 'Init') {
        peer.ospfEngine.neighborEvent(iface, neighbor, 'TwoWayReceived');
      }
    }

    // Broadcast: TwoWayReceived → 2-Way (ExStart deferred to Phase C via AdjOK)
    for (const { peer, iface, neighbor } of broadcastInit) {
      if (peer.ospfEngine && neighbor.state === 'Init') {
        peer.ospfEngine.neighborEvent(iface, neighbor, 'TwoWayReceived');
      }
    }

    // Phase C: DR election — broadcast/NBMA interfaces
    for (const peer of allPeers) {
      if (!peer.ospfEngine) continue;
      for (const [, iface] of peer.ospfEngine.getInterfaces()) {
        if (iface.networkType === 'broadcast' || iface.networkType === 'nbma') {
          iface.dr = '0.0.0.0';
          iface.bdr = '0.0.0.0';
          peer.ospfEngine.drElection(iface);
        }
      }
    }

    // Phase D: Re-trigger — masters whose slave was not yet in ExStart
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
      if (ip && mask) {
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

    // Step 2: Discover neighbors via cables (direct or through switches)
    for (const [portName, port] of this.ctx.getPorts()) {
      const cable = port.getCable();
      if (!cable) continue;

      const localIface = this.ospfEngine.getInterface(portName);
      if (!localIface) continue;
      if (localIface.passive) continue;

      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;

      // Collect candidate neighbor routers
      const candidates = this.collectCandidateRouters(remotePort);

      for (const { ospf: remoteOSPF, port: rPort } of candidates) {
        if (!remoteOSPF.ospfEngine) continue;

        // Trigger auto-activate on remote side too
        this.activateRemoteInterfaces(remoteOSPF);

        const remoteIface = remoteOSPF.ospfEngine.getInterface(rPort.getName());
        if (!remoteIface) continue;
        if (remoteIface.passive) continue;

        // Check authentication compatibility
        const localAuth = localIface.authType ?? 0;
        const remoteAuth = remoteIface.authType ?? 0;
        if (localAuth !== remoteAuth) continue;
        if (localAuth !== 0 && localIface.authKey !== remoteIface.authKey) continue;

        // Check hello/dead interval match
        if (localIface.helloInterval !== remoteIface.helloInterval) continue;
        if (localIface.deadInterval !== remoteIface.deadInterval) continue;

        // Form bidirectional adjacency
        const localRid = this.ospfEngine.getRouterId();
        const remoteRid = remoteOSPF.ospfEngine.getRouterId();

        this.formAdjacency(this.ospfEngine, localIface, remoteIface, remoteRid, rPort);
        remoteOSPF.formAdjacency(remoteOSPF.ospfEngine, remoteIface, localIface, localRid, port);
      }
    }

    // Step 3: Exchange LSAs between adjacent routers and compute routes
    this.exchangeAndCompute();

    // Step 4: OSPFv3 convergence for IPv6
    this.v3AutoConverge();
  }

  /** Collect candidate OSPF routers connected to a remote port (direct or via switch) */
  private collectCandidateRouters(remotePort: Port): Array<{ ospf: RouterOSPFIntegration; port: Port }> {
    const candidates: Array<{ ospf: RouterOSPFIntegration; port: Port }> = [];
    const remoteEquipId = remotePort.getEquipmentId();
    const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteEquipId);

    if (remoteOSPF) {
      candidates.push({ ospf: remoteOSPF, port: remotePort });
    } else {
      // Remote device is a Switch/Hub - find all other routers connected to it
      const remoteEquip = Equipment.getById(remoteEquipId);
      if (!remoteEquip) return candidates;
      for (const swPort of remoteEquip.getPorts()) {
        if (swPort === remotePort) continue;
        const swCable = swPort.getCable();
        if (!swCable) continue;
        const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
        if (!otherEnd) continue;
        const otherOSPF = RouterOSPFIntegration.getByEquipmentId(otherEnd.getEquipmentId());
        if (otherOSPF) {
          candidates.push({ ospf: otherOSPF, port: otherEnd });
        }
      }
    }
    return candidates;
  }

  /** Activate interfaces on a remote OSPF peer that match its network statements */
  private activateRemoteInterfaces(remote: RouterOSPFIntegration): void {
    if (!remote.ospfEngine) return;
    const remoteIfaces: Array<{ name: string; ip: string; mask: string }> = [];
    for (const [rp, rPortInner] of remote.ctx.getPorts()) {
      const rIp = rPortInner.getIPAddress();
      const rMask = rPortInner.getSubnetMask();
      if (rIp && rMask) remoteIfaces.push({ name: rp, ip: rIp.toString(), mask: rMask.toString() });
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

    // Form adjacencies between all directly connected routers
    for (const peer1 of allPeers) {
      if (!peer1.ospfEngine) continue;
      for (const [portName, port] of peer1.ctx.getPorts()) {
        const cable = port.getCable();
        if (!cable) continue;
        const localIface = peer1.ospfEngine.getInterface(portName);
        if (!localIface) continue;
        if (localIface.passive) continue;

        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        const candidates = this.collectCandidateRouters(remotePort);
        for (const { ospf: peer2, port: rPort } of candidates) {
          if (!peer2.ospfEngine) continue;
          const remoteIface = peer2.ospfEngine.getInterface(rPort.getName());
          if (!remoteIface) continue;
          if (remoteIface.passive) continue;

          // Check auth and timer compatibility
          const localAuth = localIface.authType ?? 0;
          const remoteAuth = remoteIface.authType ?? 0;
          if (localAuth !== remoteAuth) continue;
          if (localAuth !== 0 && localIface.authKey !== remoteIface.authKey) continue;
          if (localIface.helloInterval !== remoteIface.helloInterval) continue;
          if (localIface.deadInterval !== remoteIface.deadInterval) continue;

          const localRid = peer1.ospfEngine.getRouterId();
          const remoteRid = peer2.ospfEngine.getRouterId();
          peer1.formAdjacency(peer1.ospfEngine, localIface, remoteIface, remoteRid, rPort);
          peer2.formAdjacency(peer2.ospfEngine, remoteIface, localIface, localRid, port);
        }
      }
    }

    // Form adjacencies over GRE tunnels
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

    // Wire sendCallbacks for packet delivery
    this.setupSendCallbacks(allPeers);

    // Drive the OSPF neighbor state machine
    this.driveStateMachine(allPeers);

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
    }
  }

  /** Collect all OSPF routers in the domain via BFS through cables/switches */
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
        const remoteId = remotePort.getEquipmentId();

        if (visited.has(remoteId)) continue;
        const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteId);
        if (remoteOSPF?.ospfEngine) {
          visited.add(remoteId);
          queue.push(remoteOSPF);
        } else {
          // Switch/Hub — find all other routers connected to it
          const remoteEquip = Equipment.getById(remoteId);
          if (!remoteEquip) continue;
          for (const swPort of remoteEquip.getPorts()) {
            if (swPort === remotePort) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const otherId = otherEnd.getEquipmentId();
            if (visited.has(otherId)) continue;
            const otherOSPF = RouterOSPFIntegration.getByEquipmentId(otherId);
            if (otherOSPF?.ospfEngine) {
              visited.add(otherId);
              queue.push(otherOSPF);
            }
          }
        }
      }
    }
    return allPeers;
  }

  // ════════════════════════════════════════════════════════════════
  // OSPFv3 Auto-Convergence & IPv6 Route Computation
  // ════════════════════════════════════════════════════════════════

  /** OSPFv3 auto-convergence: discover IPv6 neighbors and compute IPv6 routes */
  private v3AutoConverge(): void {
    if (!this.ospfv3Engine) return;

    // Collect all OSPFv3 routers via BFS
    const allPeers = this.collectOSPFv3Domain();

    // Form adjacencies between all directly connected v3 routers
    for (const peer1 of allPeers) {
      if (!peer1.ospfv3Engine) continue;
      for (const [portName, port] of peer1.ctx.getPorts()) {
        const cable = port.getCable();
        if (!cable) continue;
        const localIface = peer1.ospfv3Engine.getInterface(portName);
        if (!localIface) continue;
        if (localIface.passive) continue;

        const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
        if (!remotePort) continue;

        const candidates = this.collectV3CandidateRouters(remotePort);

        for (const { ospf: peer2, port: rPort } of candidates) {
          if (!peer2.ospfv3Engine) continue;
          const remoteIface = peer2.ospfv3Engine.getInterface(rPort.getName());
          if (!remoteIface) continue;
          if (remoteIface.passive) continue;

          // Timer match check
          if (localIface.helloInterval !== remoteIface.helloInterval) continue;
          if (localIface.deadInterval !== remoteIface.deadInterval) continue;

          // IPsec auth check
          const localV3Cfg = peer1.extraConfig.pendingV3IfConfig.get(portName);
          const remoteV3Cfg = peer2.extraConfig.pendingV3IfConfig.get(rPort.getName());
          const localHasIpsec = !!localV3Cfg?.ipsecAuth;
          const remoteHasIpsec = !!remoteV3Cfg?.ipsecAuth;
          if (localHasIpsec !== remoteHasIpsec) continue;

          const localRid = peer1.ospfv3Engine.getRouterId();
          const remoteRid = peer2.ospfv3Engine.getRouterId();
          peer1.v3FormAdjacency(peer1.ospfv3Engine, localIface, remoteRid, rPort);
          peer2.v3FormAdjacency(peer2.ospfv3Engine, remoteIface, localRid, port);
        }
      }
    }

    // Compute and install IPv6 routes from OSPFv3
    this.v3ComputeRoutes(allPeers);
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
        const remoteId = remotePort.getEquipmentId();
        if (visited.has(remoteId)) continue;

        const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteId);
        if (remoteOSPF?.ospfv3Engine) {
          visited.add(remoteId);
          queue.push(remoteOSPF);
        } else {
          const remoteEquip = Equipment.getById(remoteId);
          if (!remoteEquip) continue;
          for (const swPort of remoteEquip.getPorts()) {
            if (swPort === remotePort) continue;
            const swCable = swPort.getCable();
            if (!swCable) continue;
            const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
            if (!otherEnd) continue;
            const otherId = otherEnd.getEquipmentId();
            if (visited.has(otherId)) continue;
            const otherOSPF = RouterOSPFIntegration.getByEquipmentId(otherId);
            if (otherOSPF?.ospfv3Engine) {
              visited.add(otherId);
              queue.push(otherOSPF);
            }
          }
        }
      }
    }
    return allPeers;
  }

  /** Collect candidate OSPFv3 routers connected to a remote port */
  private collectV3CandidateRouters(remotePort: Port): Array<{ ospf: RouterOSPFIntegration; port: Port }> {
    const candidates: Array<{ ospf: RouterOSPFIntegration; port: Port }> = [];
    const remoteEquipId = remotePort.getEquipmentId();
    const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteEquipId);

    if (remoteOSPF?.ospfv3Engine) {
      candidates.push({ ospf: remoteOSPF, port: remotePort });
    } else {
      const remoteEquip = Equipment.getById(remoteEquipId);
      if (!remoteEquip) return candidates;
      for (const swPort of remoteEquip.getPorts()) {
        if (swPort === remotePort) continue;
        const swCable = swPort.getCable();
        if (!swCable) continue;
        const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
        if (!otherEnd) continue;
        const otherOSPF = RouterOSPFIntegration.getByEquipmentId(otherEnd.getEquipmentId());
        if (otherOSPF?.ospfv3Engine) {
          candidates.push({ ospf: otherOSPF, port: otherEnd });
        }
      }
    }
    return candidates;
  }

  /** Form OSPFv3 neighbor adjacency */
  private v3FormAdjacency(engine: any, localIface: any, remoteRid: string, remotePort: Port): void {
    if (localIface.neighbors.has(remoteRid)) return;

    const remoteIPv6Addrs = remotePort.getIPv6Addresses?.();
    const linkLocal = remoteIPv6Addrs?.find((a: any) => a.origin === 'link-local');
    const globalAddr = remoteIPv6Addrs?.find((a: any) => a.origin !== 'link-local');
    const remoteIP = linkLocal?.address?.toString() || globalAddr?.address?.toString() || '::';

    const neighbor: any = {
      routerId: remoteRid,
      ipAddress: remoteIP,
      state: 'Full',
      priority: localIface.priority ?? 1,
      neighborDR: '0.0.0.0',
      neighborBDR: '0.0.0.0',
      deadTimer: null,
      iface: localIface.name,
      lsRequestList: [],
      lsRetransmissionList: [],
      dbSummaryList: [],
      ddSeqNumber: 0,
      options: 0x13,
      lastHelloReceived: Date.now(),
    };

    localIface.neighbors.set(remoteRid, neighbor);

    // DR/BDR election for broadcast
    if (localIface.networkType === 'broadcast') {
      const localRid = engine.getRouterId();
      const candidates: Array<{ rid: string; priority: number }> = [];
      candidates.push({ rid: localRid, priority: localIface.priority ?? 1 });
      for (const [rid, n] of localIface.neighbors) {
        candidates.push({ rid, priority: (n as any).priority ?? 1 });
      }
      candidates.sort((a: any, b: any) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        const aNum = a.rid.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0);
        const bNum = b.rid.split('.').reduce((acc: number, o: string) => (acc << 8) + parseInt(o), 0);
        return bNum - aNum;
      });

      localIface.dr = candidates[0]?.rid || '0.0.0.0';
      localIface.bdr = candidates[1]?.rid || '0.0.0.0';

      if (localIface.dr === localRid) localIface.state = 'DR';
      else if (localIface.bdr === localRid) localIface.state = 'Backup';
      else localIface.state = 'DROther';
    }
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
              prefix: { toString: () => '::' },
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
              prefix: { toString: () => '::' },
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
                prefix: { toString: () => rangePrefix },
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

    // Distribute-list filtering for OSPFv3
    if (this.extraConfig.v3DistributeList) {
      const aclName = this.extraConfig.v3DistributeList.aclId;
      const v3Acl = this.ctx.getIPv6AccessLists()?.find((a: any) => a.name === aclName);
      if (v3Acl) {
        ipv6Engine.setRoutingTable(ipv6Engine.getRoutingTableInternal().filter((rt: any) => {
          if (rt.type !== 'ospf') return true;
          const prefStr = rt.prefix?.toString() || '';
          const prefLen = rt.prefixLength ?? 64;
          for (const entry of v3Acl.entries) {
            if (entry.prefix && this.ipv6PrefixMatch(prefStr, prefLen, entry.prefix, entry.prefixLength)) {
              return entry.action === 'permit';
            }
          }
          return true;
        }));
      }
    }
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
        const remoteEquip = Equipment.getById(remoteEquipId);
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
      const remoteEquip = Equipment.getById(remoteEquipId);

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
          const equip = Equipment.getById(rid);
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

    // ── External routes (default-information originate, redistribute static/connected) ──
    for (const peer of allPeers) {
      if (peer === this || !peer.ospfEngine) continue;
      const rExtra = peer.extraConfig;

      // default-information originate → inject default route as external
      if (peer.ospfEngine.getConfig().defaultInformationOriginate) {
        const hasDefault = peer.ctx.getRoutingTable().some(rt =>
          rt.type === 'default' || (rt.type === 'static' &&
            rt.network.toString() === '0.0.0.0' && rt.mask.toString() === '0.0.0.0'));
        if (hasDefault) {
          const nh = this.findNextHopTo(peer);
          if (nh) {
            const metricType = rExtra.defaultInfoMetricType ?? 2;
            const cost = metricType === 1 ? 1 + (nh.cost || 0) : 1;
            routes.push({
              network: '0.0.0.0', mask: '0.0.0.0',
              nextHop: nh.nextHop, iface: nh.iface,
              cost, routeType: metricType === 1 ? 'type1-external' : 'type2-external',
              areaId: '0', advertisingRouter: peer.ospfEngine.getRouterId(),
              _metricType: metricType, _isDefault: true,
            });
          }
        }
      }

      // redistribute static → inject static routes as external
      if (rExtra.redistributeStatic) {
        for (const rt of peer.ctx.getRoutingTable()) {
          if (rt.type !== 'static') continue;
          if (rt.network.toString() === '0.0.0.0') continue;
          const nh = this.findNextHopTo(peer);
          if (nh) {
            const metricType = rExtra.redistributeStatic.metricType ?? 2;
            const cost = metricType === 1 ? 20 + (nh.cost || 0) : 20;
            routes.push({
              network: rt.network.toString(), mask: rt.mask.toString(),
              nextHop: nh.nextHop, iface: nh.iface,
              cost, routeType: metricType === 1 ? 'type1-external' : 'type2-external',
              areaId: '0', advertisingRouter: peer.ospfEngine.getRouterId(),
              _metricType: metricType,
            });
          }
        }
      }

      // redistribute connected → inject connected routes as external
      if (rExtra.redistributeConnected) {
        for (const rt of peer.ctx.getRoutingTable()) {
          if (rt.type !== 'connected') continue;
          const ospfIface = peer.ospfEngine.getInterface(rt.iface);
          if (ospfIface) continue;
          const nh = this.findNextHopTo(peer);
          if (nh) {
            routes.push({
              network: rt.network.toString(), mask: rt.mask.toString(),
              nextHop: nh.nextHop, iface: nh.iface,
              cost: 20, routeType: 'type2-external',
              areaId: '0', advertisingRouter: peer.ospfEngine.getRouterId(),
              _metricType: 2,
            });
          }
        }
      }
    }

    // ── Inter-area routes (O IA) ──
    for (const peer of allPeers) {
      if (peer === this || !peer.ospfEngine) continue;
      const rAreas = new Set(peer.ospfEngine.getConfig().areas.keys());
      const rIsABR = rAreas.size > 1;

      if (rIsABR) {
        const rRoutes = peer.ospfEngine.getRoutes();
        const rExtra = peer.extraConfig;
        for (const rt of rRoutes) {
          if (myAreas.has(rt.areaId)) continue;
          const nh = this.findNextHopTo(peer);
          if (!nh) continue;

          let shouldAdvertise = true;
          if (rExtra.areaRanges.has(rt.areaId)) {
            const ranges = rExtra.areaRanges.get(rt.areaId)!;
            for (const range of ranges) {
              if (this.ipInSubnet(rt.network, range.network, range.mask)) {
                shouldAdvertise = false;
              }
            }
          }
          if (!shouldAdvertise) continue;

          routes.push({
            network: rt.network, mask: rt.mask,
            nextHop: nh.nextHop, iface: nh.iface,
            cost: rt.cost + (nh.cost || 0),
            routeType: 'inter-area', areaId: rt.areaId,
            advertisingRouter: peer.ospfEngine.getRouterId(),
          });
        }

        // Advertise summarized ranges
        if (rExtra.areaRanges) {
          for (const [areaId, ranges] of rExtra.areaRanges) {
            if (myAreas.has(areaId)) continue;
            const rRoutes2 = peer.ospfEngine.getRoutes();
            for (const range of ranges) {
              const hasMatch = rRoutes2.some(
                rt => rt.areaId === areaId && this.ipInSubnet(rt.network, range.network, range.mask)
              );
              if (hasMatch) {
                const nh = this.findNextHopTo(peer);
                if (nh) {
                  routes.push({
                    network: range.network, mask: range.mask,
                    nextHop: nh.nextHop, iface: nh.iface,
                    cost: (nh.cost || 0) + 1,
                    routeType: 'inter-area', areaId,
                    advertisingRouter: peer.ospfEngine.getRouterId(),
                  });
                }
              }
            }
          }
        }
      }
    }

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

    // ── NSSA: Convert external routes from NSSA ASBR to Type 5 for backbone ──
    for (const peer of allPeers) {
      if (peer === this || !peer.ospfEngine) continue;
      const rExtra = peer.extraConfig;
      const rAreas = peer.ospfEngine.getConfig().areas;

      for (const [areaId, area] of rAreas) {
        if (area.type !== 'nssa') continue;
        if (!rExtra.redistributeStatic) continue;

        for (const abr of allPeers) {
          if (!abr.ospfEngine) continue;
          const abrAreas = abr.ospfEngine.getConfig().areas;
          if (!abrAreas.has(areaId) || abrAreas.size <= 1) continue;
          if (!myAreas.has('0') && !myAreas.has('0.0.0.0')) continue;

          for (const rt of peer.ctx.getRoutingTable()) {
            if (rt.type !== 'static') continue;
            if (rt.network.toString() === '0.0.0.0') continue;
            const nh = this.findNextHopTo(abr);
            if (nh) {
              routes.push({
                network: rt.network.toString(), mask: rt.mask.toString(),
                nextHop: nh.nextHop, iface: nh.iface,
                cost: 20, routeType: 'type2-external',
                areaId: '0', advertisingRouter: peer.ospfEngine.getRouterId(),
                _metricType: 2,
              });
            }
          }
        }
      }
    }

    return routes;
  }

  // ── Next-Hop Resolution ──

  /** Find the next hop and interface to reach a target OSPF peer */
  private findNextHopTo(target: RouterOSPFIntegration): { nextHop: string; iface: string; cost: number } | null {
    if (!this.ospfEngine) return null;

    // Direct neighbor?
    for (const [portName, port] of this.ctx.getPorts()) {
      const cable = port.getCable();
      if (!cable) continue;
      const remotePort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
      if (!remotePort) continue;
      const remoteEquipId = remotePort.getEquipmentId();

      if (remoteEquipId === target.ctx.id) {
        const remoteIP = remotePort.getIPAddress()?.toString();
        if (remoteIP) {
          const localIface = this.ospfEngine.getInterface(portName);
          return { nextHop: remoteIP, iface: portName, cost: localIface?.cost ?? 1 };
        }
      }

      // Check through switch
      if (!RouterOSPFIntegration.getByEquipmentId(remoteEquipId)) {
        const remoteEquip = Equipment.getById(remoteEquipId);
        if (!remoteEquip) continue;
        for (const swPort of remoteEquip.getPorts()) {
          if (swPort === remotePort) continue;
          const swCable = swPort.getCable();
          if (!swCable) continue;
          const otherEnd = swCable.getPortA() === swPort ? swCable.getPortB() : swCable.getPortA();
          if (!otherEnd) continue;
          if (otherEnd.getEquipmentId() === target.ctx.id) {
            const remoteIP = otherEnd.getIPAddress()?.toString();
            if (remoteIP) {
              const localIface = this.ospfEngine.getInterface(portName);
              return { nextHop: remoteIP, iface: portName, cost: localIface?.cost ?? 1 };
            }
          }
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
      const remoteEquipId = remotePort.getEquipmentId();

      const tryAdd = (peer: RouterOSPFIntegration, rPort: Port) => {
        if (visited.has(peer.ctx.id) || !peer.ospfEngine) return;
        const remoteIP = rPort.getIPAddress()?.toString();
        if (!remoteIP) return;
        const localIface = this.ospfEngine!.getInterface(portName);
        visited.add(peer.ctx.id);
        queue.push({ peer, nextHop: remoteIP, iface: portName, cost: localIface?.cost ?? 1 });
      };

      const remoteOSPF = RouterOSPFIntegration.getByEquipmentId(remoteEquipId);
      if (remoteOSPF) {
        tryAdd(remoteOSPF, remotePort);
      } else {
        const remoteEquip = Equipment.getById(remoteEquipId);
        if (!remoteEquip) continue;
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
        if (re?.ospfEngine) {
          visited.add(rid);
          const currIface = curr.ospfEngine?.getInterface(pn);
          queue.push({ peer: re, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
        } else {
          const equip = Equipment.getById(rid);
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
            if (oe?.ospfEngine) {
              visited.add(oid);
              const currIface = curr.ospfEngine?.getInterface(pn);
              queue.push({ peer: oe, nextHop, iface, cost: cost + (currIface?.cost ?? 1) });
            }
          }
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

    const distList = this.extraConfig.distributeList;

    for (const route of routes) {
      const network = route.network || route.destination;
      const mask = route.mask;
      const iface = route.iface || route.interface || '';
      const nextHop = route.nextHop;

      if (!network || !mask) continue;

      // Don't install if a connected route already covers it
      const existing = this.ctx.getRoutingTable().find(
        r => r.type === 'connected' &&
             r.network.toString() === network &&
             r.mask.toString() === mask
      );
      if (existing) continue;

      // Apply distribute-list inbound filtering
      if (distList && distList.direction === 'in') {
        const acl = this.ctx.getACLEngine().getAccessListsInternal().find(
          (a: any) => a.id === parseInt(distList.aclId) || a.name === distList.aclId
        );
        if (acl) {
          let matched = false;
          let action: 'permit' | 'deny' = 'deny';
          for (const entry of acl.entries) {
            const srcIP = entry.srcIP?.toString() || '0.0.0.0';
            const srcWild = entry.srcWildcard?.toString() || '255.255.255.255';
            if (srcIP === 'any' || srcIP === '0.0.0.0' && srcWild === '255.255.255.255') {
              action = entry.action;
              matched = true;
              break;
            }
            const netNum = this.ipToNum(network);
            const aclNum = this.ipToNum(srcIP);
            const wildNum = this.ipToNum(srcWild);
            if ((netNum & ~wildNum) === (aclNum & ~wildNum)) {
              action = entry.action;
              matched = true;
              break;
            }
          }
          if (matched && action === 'deny') continue;
          if (!matched) continue;
        }
      }

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

  // ── IP Utility Helpers ──

  private ipInSubnet(ip: string, network: string, mask: string): boolean {
    const ipNum = this.ipToNum(ip);
    const netNum = this.ipToNum(network);
    const maskNum = this.ipToNum(mask);
    return (ipNum & maskNum) === (netNum & maskNum);
  }

  private ipToNum(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }
}
