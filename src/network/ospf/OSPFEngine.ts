/**
 * OSPFEngine - OSPF v2 (RFC 2328) Protocol Engine
 *
 * Implements the core OSPF protocol logic:
 *   - Neighbor discovery via Hello protocol (§9)
 *   - Neighbor state machine (§10.1)
 *   - DR/BDR election (§9.4)
 *   - Database synchronization (DD/LSR/LSU/LSAck)
 *   - LSA origination and flooding (§12, §13)
 *   - SPF calculation using Dijkstra (§16)
 *   - Route table computation
 *
 * This engine is instantiated per-router and manages all OSPF
 * interfaces, neighbors, and the LSDB for that router.
 */

import {
  OSPFConfig, OSPFInterface, OSPFNeighbor, OSPFNeighborState, OSPFNeighborEvent,
  OSPFInterfaceState, OSPFArea, OSPFAreaType, OSPFNetworkType,
  LSA, LSAHeader, LSAType, RouterLSA, NetworkLSA, SummaryLSA, ExternalLSA,
  RouterLSALink, RouterLinkType,
  LSDB, LSDBKey, makeLSDBKey, createEmptyLSDB,
  OSPFPacket, OSPFHelloPacket, OSPFDDPacket, OSPFLSUpdatePacket, OSPFLSAckPacket,
  OSPFLSRequestPacket,
  SPFVertex, OSPFRouteEntry, OSPFRouteType,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  OSPF_DEFAULT_HELLO_INTERVAL, OSPF_DEFAULT_DEAD_INTERVAL,
  OSPF_DEFAULT_RETRANSMIT_INTERVAL, OSPF_DEFAULT_TRANSMIT_DELAY,
  OSPF_MAX_AGE, OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_MAX_SEQUENCE_NUMBER,
  OSPF_BACKBONE_AREA, OSPF_ALL_SPF_ROUTERS, OSPF_ALL_DR_ROUTERS,
  OSPF_AD_INTRA_AREA, OSPF_AD_INTER_AREA, OSPF_AD_EXTERNAL,
  OSPF_INFINITY_METRIC,
  OSPF_VERSION_2,
  createDefaultOSPFConfig,
} from './types';

// ─── Callback type for sending packets ─────────────────────────────

export type OSPFSendCallback = (
  iface: string,
  packet: OSPFPacket,
  destIP: string,
) => void;

// ─── OSPF Engine ────────────────────────────────────────────────────

export class OSPFEngine {
  private config: OSPFConfig;
  private lsdb: LSDB;
  private interfaces: Map<string, OSPFInterface> = new Map();
  private ospfRoutes: OSPFRouteEntry[] = [];
  private sendCallback: OSPFSendCallback | null = null;

  /** Current LSA sequence number */
  private seqNumber: number = OSPF_INITIAL_SEQUENCE_NUMBER;

  /** SPF scheduling */
  private spfTimer: ReturnType<typeof setTimeout> | null = null;
  private spfPending = false;

  /** Event log for adjacency changes */
  private eventLog: string[] = [];

  constructor(processId: number = 1) {
    this.config = createDefaultOSPFConfig(processId);
    this.lsdb = createEmptyLSDB();
  }

  // ─── Configuration API ─────────────────────────────────────────

  getConfig(): OSPFConfig {
    return this.config;
  }

  getProcessId(): number {
    return this.config.processId;
  }

  setRouterId(routerId: string): void {
    this.config.routerId = routerId;
  }

  getRouterId(): string {
    return this.config.routerId;
  }

  setSendCallback(cb: OSPFSendCallback): void {
    this.sendCallback = cb;
  }

  /**
   * Add a network statement: "network <network> <wildcard> area <areaId>"
   * This determines which interfaces participate in OSPF.
   */
  addNetwork(network: string, wildcard: string, areaId: string): void {
    this.config.networks.push({ network, wildcard, areaId });

    // Ensure area exists
    if (!this.config.areas.has(areaId)) {
      this.config.areas.set(areaId, {
        areaId,
        type: 'normal',
        interfaces: [],
        isBackbone: areaId === OSPF_BACKBONE_AREA || areaId === '0',
      });
    }

    // Ensure LSDB area entry exists
    if (!this.lsdb.areas.has(areaId)) {
      this.lsdb.areas.set(areaId, new Map());
    }
  }

  removeNetwork(network: string, wildcard: string, areaId: string): void {
    this.config.networks = this.config.networks.filter(
      n => !(n.network === network && n.wildcard === wildcard && n.areaId === areaId)
    );
  }

  setAreaType(areaId: string, type: OSPFAreaType): void {
    const area = this.config.areas.get(areaId);
    if (area) {
      area.type = type;
    }
  }

  setPassiveInterface(ifName: string): void {
    this.config.passiveInterfaces.add(ifName);
    const iface = this.interfaces.get(ifName);
    if (iface) {
      iface.passive = true;
      // Stop hello timer on passive interfaces
      if (iface.helloTimer) {
        clearInterval(iface.helloTimer);
        iface.helloTimer = null;
      }
    }
  }

  removePassiveInterface(ifName: string): void {
    this.config.passiveInterfaces.delete(ifName);
    const iface = this.interfaces.get(ifName);
    if (iface) {
      iface.passive = false;
    }
  }

  isPassiveInterface(ifName: string): boolean {
    return this.config.passiveInterfaces.has(ifName);
  }

  setReferenceBandwidth(mbps: number): void {
    this.config.autoCostReferenceBandwidth = mbps;
    this.config.referenceBandwidth = mbps * 1_000_000;
  }

  setDefaultInformationOriginate(enable: boolean): void {
    this.config.defaultInformationOriginate = enable;
  }

  // ─── Interface Management ──────────────────────────────────────

  /**
   * Activate an OSPF interface — called when a router interface
   * matches a configured network statement.
   */
  activateInterface(
    name: string,
    ipAddress: string,
    mask: string,
    areaId: string,
    options?: {
      cost?: number;
      priority?: number;
      networkType?: OSPFNetworkType;
      helloInterval?: number;
      deadInterval?: number;
    }
  ): OSPFInterface {
    const bandwidth = 1_000_000_000; // 1 Gbps default (GigabitEthernet)
    const defaultCost = Math.max(1, Math.floor(this.config.referenceBandwidth / (bandwidth / 1_000_000)));

    const iface: OSPFInterface = {
      name,
      ipAddress,
      mask,
      areaId,
      state: 'Down',
      networkType: options?.networkType ?? 'broadcast',
      helloInterval: options?.helloInterval ?? OSPF_DEFAULT_HELLO_INTERVAL,
      deadInterval: options?.deadInterval ?? OSPF_DEFAULT_DEAD_INTERVAL,
      retransmitInterval: OSPF_DEFAULT_RETRANSMIT_INTERVAL,
      transmitDelay: OSPF_DEFAULT_TRANSMIT_DELAY,
      priority: options?.priority ?? 1,
      dr: '0.0.0.0',
      bdr: '0.0.0.0',
      cost: options?.cost ?? defaultCost,
      helloTimer: null,
      waitTimer: null,
      neighbors: new Map(),
      passive: this.config.passiveInterfaces.has(name),
      authType: 0,
      authKey: '',
    };

    this.interfaces.set(name, iface);

    // Track in area
    const area = this.config.areas.get(areaId);
    if (area && !area.interfaces.includes(name)) {
      area.interfaces.push(name);
    }

    // Bring interface up
    this.interfaceUp(name);

    return iface;
  }

  deactivateInterface(name: string): void {
    const iface = this.interfaces.get(name);
    if (!iface) return;

    // Kill all neighbors
    for (const [, neighbor] of iface.neighbors) {
      this.neighborEvent(iface, neighbor, 'KillNbr');
    }

    // Stop timers
    if (iface.helloTimer) {
      clearInterval(iface.helloTimer);
      iface.helloTimer = null;
    }
    if (iface.waitTimer) {
      clearTimeout(iface.waitTimer);
      iface.waitTimer = null;
    }

    iface.state = 'Down';

    // Remove from area
    const area = this.config.areas.get(iface.areaId);
    if (area) {
      area.interfaces = area.interfaces.filter(i => i !== name);
    }

    this.interfaces.delete(name);
    this.scheduleSPF();
  }

  getInterface(name: string): OSPFInterface | undefined {
    return this.interfaces.get(name);
  }

  getInterfaces(): Map<string, OSPFInterface> {
    return this.interfaces;
  }

  setInterfaceCost(ifName: string, cost: number): void {
    const iface = this.interfaces.get(ifName);
    if (iface) {
      iface.cost = cost;
      this.originateRouterLSA(iface.areaId);
      this.scheduleSPF();
    }
  }

  setInterfacePriority(ifName: string, priority: number): void {
    const iface = this.interfaces.get(ifName);
    if (iface) {
      iface.priority = priority;
    }
  }

  // ─── Interface State Machine ───────────────────────────────────

  private interfaceUp(name: string): void {
    const iface = this.interfaces.get(name);
    if (!iface) return;

    if (iface.networkType === 'point-to-point') {
      iface.state = 'PointToPoint';
    } else {
      // Broadcast or NBMA: enter Waiting state for DR election
      iface.state = 'Waiting';
      iface.waitTimer = setTimeout(() => {
        this.drElection(iface);
      }, iface.deadInterval * 1000);
    }

    // Start sending hellos (unless passive)
    if (!iface.passive) {
      this.startHelloTimer(iface);
    }

    // Originate Router-LSA for this area
    this.originateRouterLSA(iface.areaId);
  }

  private startHelloTimer(iface: OSPFInterface): void {
    if (iface.helloTimer) clearInterval(iface.helloTimer);

    // Send initial hello immediately
    this.sendHello(iface);

    iface.helloTimer = setInterval(() => {
      this.sendHello(iface);
    }, iface.helloInterval * 1000);
  }

  // ─── Hello Protocol (RFC 2328 §9.5) ───────────────────────────

  private sendHello(iface: OSPFInterface): void {
    if (!this.sendCallback) return;

    const neighborIds = Array.from(iface.neighbors.keys());

    const hello: OSPFHelloPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 1,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      networkMask: iface.mask,
      helloInterval: iface.helloInterval,
      options: 0x02, // E-bit (supports external routing)
      priority: iface.priority,
      deadInterval: iface.deadInterval,
      designatedRouter: iface.dr,
      backupDesignatedRouter: iface.bdr,
      neighbors: neighborIds,
    };

    const destIP = iface.networkType === 'point-to-point'
      ? OSPF_ALL_SPF_ROUTERS.toString()
      : OSPF_ALL_SPF_ROUTERS.toString();

    this.sendCallback(iface.name, hello, destIP);
  }

  /**
   * Process an incoming Hello packet (RFC 2328 §10.5)
   */
  processHello(ifaceName: string, srcIP: string, hello: OSPFHelloPacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    // Validate hello parameters
    if (iface.networkType === 'broadcast') {
      if (hello.networkMask !== iface.mask) return;
    }
    if (hello.helloInterval !== iface.helloInterval) return;
    if (hello.deadInterval !== iface.deadInterval) return;

    const neighborId = hello.routerId;
    let neighbor = iface.neighbors.get(neighborId);

    if (!neighbor) {
      // New neighbor discovered
      neighbor = this.createNeighbor(neighborId, srcIP, ifaceName, hello);
      iface.neighbors.set(neighborId, neighbor);
    }

    // Update neighbor fields
    neighbor.ipAddress = srcIP;
    neighbor.priority = hello.priority;
    neighbor.neighborDR = hello.designatedRouter;
    neighbor.neighborBDR = hello.backupDesignatedRouter;
    neighbor.lastHelloReceived = Date.now();
    neighbor.options = hello.options;

    // HelloReceived event (resets dead timer)
    this.neighborEvent(iface, neighbor, 'HelloReceived');

    // Check if we are listed in the neighbor's hello (2-Way check)
    const seesUs = hello.neighbors.includes(this.config.routerId);

    if (seesUs) {
      if (neighbor.state === 'Init') {
        this.neighborEvent(iface, neighbor, 'TwoWayReceived');
      }
    } else {
      if (neighbor.state !== 'Down' && neighbor.state !== 'Init') {
        this.neighborEvent(iface, neighbor, 'OneWay');
      }
    }

    // Check for DR/BDR changes
    if (iface.state === 'Waiting') {
      // Check if this hello triggers end of waiting
      if (hello.designatedRouter === srcIP && hello.backupDesignatedRouter === '0.0.0.0') {
        // Neighbor claims to be DR with no BDR — might trigger election
      }
      if (hello.backupDesignatedRouter === srcIP) {
        // Neighbor claims to be BDR — end wait timer
        if (iface.waitTimer) {
          clearTimeout(iface.waitTimer);
          iface.waitTimer = null;
        }
        this.drElection(iface);
      }
    }
  }

  private createNeighbor(
    routerId: string,
    ipAddress: string,
    ifaceName: string,
    hello: OSPFHelloPacket,
  ): OSPFNeighbor {
    return {
      routerId,
      ipAddress,
      iface: ifaceName,
      state: 'Down',
      priority: hello.priority,
      neighborDR: hello.designatedRouter,
      neighborBDR: hello.backupDesignatedRouter,
      deadTimer: null,
      ddSeqNumber: 0,
      isMaster: false,
      lsRequestList: [],
      lsRetransmissionList: [],
      dbSummaryList: [],
      lastHelloReceived: Date.now(),
      options: hello.options,
    };
  }

  // ─── Neighbor State Machine (RFC 2328 §10.1) ──────────────────

  neighborEvent(iface: OSPFInterface, neighbor: OSPFNeighbor, event: OSPFNeighborEvent): void {
    const oldState = neighbor.state;

    switch (event) {
      case 'HelloReceived':
        this.resetDeadTimer(iface, neighbor);
        if (neighbor.state === 'Down') {
          neighbor.state = 'Init';
        }
        break;

      case 'TwoWayReceived':
        if (neighbor.state === 'Init') {
          if (this.shouldFormAdjacency(iface, neighbor)) {
            neighbor.state = 'ExStart';
            this.startDDExchange(iface, neighbor);
          } else {
            neighbor.state = 'TwoWay';
          }
        }
        break;

      case 'NegotiationDone':
        if (neighbor.state === 'ExStart') {
          neighbor.state = 'Exchange';
          this.sendDDWithSummary(iface, neighbor);
        }
        break;

      case 'ExchangeDone':
        if (neighbor.state === 'Exchange') {
          if (neighbor.lsRequestList.length > 0) {
            neighbor.state = 'Loading';
            this.sendLSRequest(iface, neighbor);
          } else {
            neighbor.state = 'Full';
            this.onAdjacencyFull(iface, neighbor);
          }
        }
        break;

      case 'LoadingDone':
        if (neighbor.state === 'Loading') {
          neighbor.state = 'Full';
          this.onAdjacencyFull(iface, neighbor);
        }
        break;

      case 'AdjOK':
        if (neighbor.state === 'TwoWay') {
          if (this.shouldFormAdjacency(iface, neighbor)) {
            neighbor.state = 'ExStart';
            this.startDDExchange(iface, neighbor);
          }
        } else if (neighbor.state === 'Full' || neighbor.state === 'Exchange' || neighbor.state === 'Loading') {
          if (!this.shouldFormAdjacency(iface, neighbor)) {
            neighbor.state = 'TwoWay';
            neighbor.lsRequestList = [];
            neighbor.lsRetransmissionList = [];
            neighbor.dbSummaryList = [];
          }
        }
        break;

      case 'SeqNumberMismatch':
      case 'BadLSReq':
        if (['Exchange', 'Loading', 'Full'].includes(neighbor.state)) {
          neighbor.state = 'ExStart';
          neighbor.lsRequestList = [];
          neighbor.lsRetransmissionList = [];
          neighbor.dbSummaryList = [];
          this.startDDExchange(iface, neighbor);
        }
        break;

      case 'OneWay':
        if (neighbor.state !== 'Down' && neighbor.state !== 'Init') {
          neighbor.state = 'Init';
          neighbor.lsRequestList = [];
          neighbor.lsRetransmissionList = [];
          neighbor.dbSummaryList = [];
        }
        break;

      case 'KillNbr':
      case 'LLDown':
        this.clearDeadTimer(neighbor);
        neighbor.state = 'Down';
        neighbor.lsRequestList = [];
        neighbor.lsRetransmissionList = [];
        neighbor.dbSummaryList = [];
        break;

      case 'InactivityTimer':
        this.clearDeadTimer(neighbor);
        neighbor.state = 'Down';
        neighbor.lsRequestList = [];
        neighbor.lsRetransmissionList = [];
        neighbor.dbSummaryList = [];
        // Remove from interface neighbors
        iface.neighbors.delete(neighbor.routerId);
        break;
    }

    if (oldState !== neighbor.state) {
      const msg = `OSPF: Neighbor ${neighbor.routerId} (${iface.name}): ${oldState} -> ${neighbor.state} (${event})`;
      this.eventLog.push(msg);
      if (this.config.logAdjacencyChanges) {
        // Log event (could be picked up by syslog)
      }

      // Re-originate Router-LSA on adjacency changes
      if (neighbor.state === 'Full' || oldState === 'Full') {
        this.originateRouterLSA(iface.areaId);
        this.scheduleSPF();
      }
    }
  }

  private resetDeadTimer(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    this.clearDeadTimer(neighbor);
    neighbor.deadTimer = setTimeout(() => {
      this.neighborEvent(iface, neighbor, 'InactivityTimer');
    }, iface.deadInterval * 1000);
  }

  private clearDeadTimer(neighbor: OSPFNeighbor): void {
    if (neighbor.deadTimer) {
      clearTimeout(neighbor.deadTimer);
      neighbor.deadTimer = null;
    }
  }

  /**
   * Determine if we should form a full adjacency with this neighbor.
   * RFC 2328 §10.4: On broadcast/NBMA, only DR/BDR form adjacencies with all.
   * On point-to-point, always form adjacency.
   */
  private shouldFormAdjacency(iface: OSPFInterface, neighbor: OSPFNeighbor): boolean {
    if (iface.networkType === 'point-to-point' || iface.networkType === 'point-to-multipoint') {
      return true;
    }

    // Broadcast/NBMA: form adjacency if we or neighbor are DR/BDR
    if (iface.state === 'DR' || iface.state === 'Backup') return true;
    if (neighbor.neighborDR === neighbor.ipAddress || neighbor.neighborBDR === neighbor.ipAddress) return true;

    return false;
  }

  // ─── DR/BDR Election (RFC 2328 §9.4) ──────────────────────────

  drElection(iface: OSPFInterface): void {
    if (iface.networkType !== 'broadcast' && iface.networkType !== 'nbma') {
      iface.state = 'PointToPoint';
      return;
    }

    interface Candidate {
      routerId: string;
      ipAddress: string;
      priority: number;
      declaredDR: string;
      declaredBDR: string;
    }

    // Build candidate list (us + all neighbors in state >= TwoWay)
    const candidates: Candidate[] = [];

    // Add ourselves
    if (iface.priority > 0) {
      candidates.push({
        routerId: this.config.routerId,
        ipAddress: iface.ipAddress,
        priority: iface.priority,
        declaredDR: iface.dr,
        declaredBDR: iface.bdr,
      });
    }

    // Add eligible neighbors (state >= TwoWay, priority > 0)
    for (const [, neighbor] of iface.neighbors) {
      if (this.neighborStateOrder(neighbor.state) >= this.neighborStateOrder('TwoWay') &&
          neighbor.priority > 0) {
        candidates.push({
          routerId: neighbor.routerId,
          ipAddress: neighbor.ipAddress,
          priority: neighbor.priority,
          declaredDR: neighbor.neighborDR,
          declaredBDR: neighbor.neighborBDR,
        });
      }
    }

    if (candidates.length === 0) {
      iface.dr = '0.0.0.0';
      iface.bdr = '0.0.0.0';
      iface.state = 'DROther';
      return;
    }

    // Step 1: Elect BDR (candidates not declaring themselves as DR)
    const bdrCandidates = candidates.filter(c => c.declaredDR !== c.ipAddress);
    // Among BDR candidates: prefer those declaring themselves BDR, then highest priority, then highest Router ID
    const bdrDeclaring = bdrCandidates.filter(c => c.declaredBDR === c.ipAddress);
    const bdrPool = bdrDeclaring.length > 0 ? bdrDeclaring : bdrCandidates;
    const bdr = bdrPool.length > 0
      ? bdrPool.sort((a, b) => b.priority - a.priority || b.routerId.localeCompare(a.routerId))[0]
      : null;

    // Step 2: Elect DR (candidates declaring themselves as DR)
    const drDeclaring = candidates.filter(c => c.declaredDR === c.ipAddress);
    const dr = drDeclaring.length > 0
      ? drDeclaring.sort((a, b) => b.priority - a.priority || b.routerId.localeCompare(a.routerId))[0]
      : bdr;

    iface.dr = dr?.ipAddress ?? '0.0.0.0';
    iface.bdr = bdr?.ipAddress ?? '0.0.0.0';

    // Update our state
    if (iface.dr === iface.ipAddress) {
      iface.state = 'DR';
    } else if (iface.bdr === iface.ipAddress) {
      iface.state = 'Backup';
    } else {
      iface.state = 'DROther';
    }

    // AdjOK event to all neighbors
    for (const [, neighbor] of iface.neighbors) {
      this.neighborEvent(iface, neighbor, 'AdjOK');
    }

    // Originate Network-LSA if we are DR
    if (iface.state === 'DR') {
      this.originateNetworkLSA(iface);
    }
  }

  private neighborStateOrder(state: OSPFNeighborState): number {
    const order: Record<OSPFNeighborState, number> = {
      'Down': 0, 'Attempt': 1, 'Init': 2, 'TwoWay': 3,
      'ExStart': 4, 'Exchange': 5, 'Loading': 6, 'Full': 7,
    };
    return order[state] ?? 0;
  }

  // ─── DD Exchange (RFC 2328 §10.6-10.8) ─────────────────────────

  private startDDExchange(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    neighbor.ddSeqNumber = Math.floor(Date.now() / 1000) & 0xFFFFFFFF;
    // We start as Master; will resolve in NegotiationDone
    neighbor.isMaster = this.config.routerId > neighbor.routerId;

    // Build DB summary list from our LSDB
    neighbor.dbSummaryList = this.getLSDBHeaders(iface.areaId);

    // Send initial DD with I, M, MS flags
    const flags = DD_FLAG_INIT | DD_FLAG_MORE | (neighbor.isMaster ? DD_FLAG_MASTER : 0);

    const dd: OSPFDDPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 2,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      interfaceMTU: 1500,
      options: 0x02,
      flags,
      ddSequenceNumber: neighbor.ddSeqNumber,
      lsaHeaders: [],
    };

    this.sendCallback?.(iface.name, dd, neighbor.ipAddress);
  }

  /**
   * Process incoming Database Description packet
   */
  processDD(ifaceName: string, srcIP: string, dd: OSPFDDPacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    const neighbor = iface.neighbors.get(dd.routerId);
    if (!neighbor) return;

    if (neighbor.state === 'ExStart') {
      // Negotiation phase
      const isInit = (dd.flags & DD_FLAG_INIT) !== 0;
      const isMaster = (dd.flags & DD_FLAG_MASTER) !== 0;

      if (isInit && isMaster && dd.routerId > this.config.routerId) {
        // They are master
        neighbor.isMaster = false;
        neighbor.ddSeqNumber = dd.ddSequenceNumber;
        this.neighborEvent(iface, neighbor, 'NegotiationDone');
      } else if (!isInit && !isMaster && dd.ddSequenceNumber === neighbor.ddSeqNumber) {
        // We are master and they acknowledged
        neighbor.isMaster = true;
        this.neighborEvent(iface, neighbor, 'NegotiationDone');
      }
    } else if (neighbor.state === 'Exchange') {
      // Process LSA headers from the DD
      for (const header of dd.lsaHeaders) {
        const existing = this.lookupLSA(iface.areaId, header.lsType, header.linkStateId, header.advertisingRouter);
        if (!existing || header.lsSequenceNumber > existing.lsSequenceNumber) {
          neighbor.lsRequestList.push(header);
        }
      }

      // Check if exchange is done (no More flag)
      if (!(dd.flags & DD_FLAG_MORE)) {
        this.neighborEvent(iface, neighbor, 'ExchangeDone');
      }
    }
  }

  private sendDDWithSummary(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    const headers = neighbor.dbSummaryList.splice(0, 10); // Send up to 10 headers at a time
    const hasMore = neighbor.dbSummaryList.length > 0;

    const flags = (hasMore ? DD_FLAG_MORE : 0) | (neighbor.isMaster ? DD_FLAG_MASTER : 0);

    const dd: OSPFDDPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 2,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      interfaceMTU: 1500,
      options: 0x02,
      flags,
      ddSequenceNumber: neighbor.ddSeqNumber,
      lsaHeaders: headers,
    };

    this.sendCallback?.(iface.name, dd, neighbor.ipAddress);
  }

  // ─── LS Request / Update / Ack ─────────────────────────────────

  private sendLSRequest(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    if (neighbor.lsRequestList.length === 0) return;

    const requests = neighbor.lsRequestList.slice(0, 10).map(h => ({
      lsType: h.lsType,
      linkStateId: h.linkStateId,
      advertisingRouter: h.advertisingRouter,
    }));

    const lsr: OSPFLSRequestPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 3,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      requests,
    };

    this.sendCallback?.(iface.name, lsr, neighbor.ipAddress);
  }

  /**
   * Process incoming LS Request
   */
  processLSRequest(ifaceName: string, srcIP: string, lsr: OSPFLSRequestPacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    const lsas: LSA[] = [];
    for (const req of lsr.requests) {
      const lsa = this.lookupLSA(iface.areaId, req.lsType, req.linkStateId, req.advertisingRouter);
      if (lsa) {
        lsas.push(lsa);
      }
    }

    if (lsas.length > 0) {
      const lsu: OSPFLSUpdatePacket = {
        type: 'ospf',
        version: OSPF_VERSION_2,
        packetType: 4,
        routerId: this.config.routerId,
        areaId: iface.areaId,
        numLSAs: lsas.length,
        lsas,
      };

      this.sendCallback?.(iface.name, lsu, srcIP);
    }
  }

  /**
   * Process incoming LS Update (RFC 2328 §13)
   */
  processLSUpdate(ifaceName: string, srcIP: string, lsu: OSPFLSUpdatePacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    const neighbor = this.findNeighborByIP(iface, srcIP);
    if (!neighbor) return;

    const ackedHeaders: LSAHeader[] = [];
    let lsdbChanged = false;

    for (const lsa of lsu.lsas) {
      const key = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);
      const areaDB = this.lsdb.areas.get(iface.areaId);

      // Skip if LSA is MaxAge and not in DB
      if (lsa.lsAge >= OSPF_MAX_AGE) {
        if (areaDB && !areaDB.has(key)) continue;
      }

      const existing = this.lookupLSA(iface.areaId, lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);

      if (!existing || this.isNewerLSA(lsa, existing)) {
        // Install the LSA
        this.installLSA(iface.areaId, lsa);
        lsdbChanged = true;

        // Remove from neighbor's LS request list
        neighbor.lsRequestList = neighbor.lsRequestList.filter(
          h => !(h.lsType === lsa.lsType && h.linkStateId === lsa.linkStateId && h.advertisingRouter === lsa.advertisingRouter)
        );

        // Flood to other neighbors
        this.floodLSA(iface.areaId, lsa, ifaceName);

        // Acknowledge
        ackedHeaders.push(this.extractHeader(lsa));
      }
    }

    // Send LSAck
    if (ackedHeaders.length > 0) {
      const ack: OSPFLSAckPacket = {
        type: 'ospf',
        version: OSPF_VERSION_2,
        packetType: 5,
        routerId: this.config.routerId,
        areaId: iface.areaId,
        lsaHeaders: ackedHeaders,
      };
      this.sendCallback?.(iface.name, ack, srcIP);
    }

    // Check if loading is done
    if (neighbor.state === 'Loading' && neighbor.lsRequestList.length === 0) {
      this.neighborEvent(iface, neighbor, 'LoadingDone');
    }

    // Schedule SPF if LSDB changed
    if (lsdbChanged) {
      this.scheduleSPF();
    }
  }

  /**
   * Process incoming LS Acknowledgment
   */
  processLSAck(ifaceName: string, srcIP: string, ack: OSPFLSAckPacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    const neighbor = this.findNeighborByIP(iface, srcIP);
    if (!neighbor) return;

    // Remove acknowledged LSAs from retransmission list
    for (const header of ack.lsaHeaders) {
      neighbor.lsRetransmissionList = neighbor.lsRetransmissionList.filter(
        lsa => !(lsa.lsType === header.lsType &&
                  lsa.linkStateId === header.linkStateId &&
                  lsa.advertisingRouter === header.advertisingRouter)
      );
    }
  }

  private findNeighborByIP(iface: OSPFInterface, srcIP: string): OSPFNeighbor | null {
    for (const [, neighbor] of iface.neighbors) {
      if (neighbor.ipAddress === srcIP) return neighbor;
    }
    return null;
  }

  // ─── LSA Comparison (RFC 2328 §13.1) ──────────────────────────

  private isNewerLSA(a: LSA, b: LSA): boolean {
    if (a.lsSequenceNumber !== b.lsSequenceNumber) {
      return a.lsSequenceNumber > b.lsSequenceNumber;
    }
    if (a.checksum !== b.checksum) {
      return a.checksum > b.checksum;
    }
    if (a.lsAge === OSPF_MAX_AGE && b.lsAge !== OSPF_MAX_AGE) return true;
    if (b.lsAge === OSPF_MAX_AGE && a.lsAge !== OSPF_MAX_AGE) return false;
    if (Math.abs(a.lsAge - b.lsAge) > 900) {
      return a.lsAge < b.lsAge; // Younger (lower age) is newer
    }
    return false; // Same
  }

  // ─── LSDB Management ──────────────────────────────────────────

  installLSA(areaId: string, lsa: LSA): void {
    const key = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);

    if (lsa.lsType === 5) {
      this.lsdb.external.set(key, lsa as ExternalLSA);
    } else {
      let areaDB = this.lsdb.areas.get(areaId);
      if (!areaDB) {
        areaDB = new Map();
        this.lsdb.areas.set(areaId, areaDB);
      }
      areaDB.set(key, lsa);
    }
  }

  lookupLSA(areaId: string, lsType: LSAType, linkStateId: string, advertisingRouter: string): LSA | undefined {
    const key = makeLSDBKey(lsType, linkStateId, advertisingRouter);

    if (lsType === 5) {
      return this.lsdb.external.get(key);
    }

    const areaDB = this.lsdb.areas.get(areaId);
    return areaDB?.get(key);
  }

  getLSDB(): LSDB {
    return this.lsdb;
  }

  getAreaLSDB(areaId: string): Map<LSDBKey, LSA> | undefined {
    return this.lsdb.areas.get(areaId);
  }

  getLSDBHeaders(areaId: string): LSAHeader[] {
    const headers: LSAHeader[] = [];
    const areaDB = this.lsdb.areas.get(areaId);
    if (areaDB) {
      for (const lsa of areaDB.values()) {
        headers.push(this.extractHeader(lsa));
      }
    }
    // Include external LSAs
    for (const lsa of this.lsdb.external.values()) {
      headers.push(this.extractHeader(lsa));
    }
    return headers;
  }

  getLSDBCount(): number {
    let count = 0;
    for (const areaDB of this.lsdb.areas.values()) {
      count += areaDB.size;
    }
    count += this.lsdb.external.size;
    return count;
  }

  private extractHeader(lsa: LSA): LSAHeader {
    return {
      lsAge: lsa.lsAge,
      options: lsa.options,
      lsType: lsa.lsType,
      linkStateId: lsa.linkStateId,
      advertisingRouter: lsa.advertisingRouter,
      lsSequenceNumber: lsa.lsSequenceNumber,
      checksum: lsa.checksum,
      length: lsa.length,
    };
  }

  // ─── LSA Origination ──────────────────────────────────────────

  /**
   * Originate a Router-LSA (Type 1) for the given area.
   * RFC 2328 §12.4.1
   */
  originateRouterLSA(areaId: string): RouterLSA {
    const links: RouterLSALink[] = [];
    let flags = 0;

    // Check if we're an ABR (interfaces in multiple areas)
    const areas = new Set<string>();
    for (const [, iface] of this.interfaces) {
      areas.add(iface.areaId);
    }
    if (areas.size > 1) flags |= 0x01; // B-bit: ABR

    // Generate links for each interface in this area
    for (const [, iface] of this.interfaces) {
      if (iface.areaId !== areaId) continue;
      if (iface.state === 'Down') continue;

      if (iface.networkType === 'point-to-point') {
        // Add point-to-point link for each Full neighbor
        for (const [, neighbor] of iface.neighbors) {
          if (neighbor.state === 'Full') {
            links.push({
              linkId: neighbor.routerId,
              linkData: iface.ipAddress,
              type: 1, // Point-to-point
              numTOS: 0,
              metric: iface.cost,
            });
          }
        }
        // Stub network for the interface subnet
        const networkAddr = this.computeNetwork(iface.ipAddress, iface.mask);
        links.push({
          linkId: networkAddr,
          linkData: iface.mask,
          type: 3, // Stub network
          numTOS: 0,
          metric: iface.cost,
        });
      } else {
        // Broadcast: Transit or Stub
        if (iface.state === 'DR' || iface.state === 'Backup' || iface.state === 'DROther') {
          const hasFullNeighbor = this.hasFullNeighborOnInterface(iface);
          if (hasFullNeighbor && iface.dr !== '0.0.0.0') {
            // Transit network
            links.push({
              linkId: iface.dr,
              linkData: iface.ipAddress,
              type: 2, // Transit network
              numTOS: 0,
              metric: iface.cost,
            });
          } else {
            // Stub network
            const networkAddr = this.computeNetwork(iface.ipAddress, iface.mask);
            links.push({
              linkId: networkAddr,
              linkData: iface.mask,
              type: 3, // Stub network
              numTOS: 0,
              metric: iface.cost,
            });
          }
        }
      }
    }

    const lsa: RouterLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 1,
      linkStateId: this.config.routerId,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      length: 24 + links.length * 12,
      flags,
      numLinks: links.length,
      links,
    };

    // Compute a simple checksum
    lsa.checksum = this.computeLSAChecksum(lsa);

    this.installLSA(areaId, lsa);
    this.floodLSA(areaId, lsa, null);

    return lsa;
  }

  /**
   * Originate a Network-LSA (Type 2) — only if we are the DR.
   * RFC 2328 §12.4.2
   */
  originateNetworkLSA(iface: OSPFInterface): NetworkLSA | null {
    if (iface.state !== 'DR') return null;

    const attachedRouters: string[] = [this.config.routerId];

    for (const [, neighbor] of iface.neighbors) {
      if (neighbor.state === 'Full') {
        attachedRouters.push(neighbor.routerId);
      }
    }

    if (attachedRouters.length < 2) return null;

    const lsa: NetworkLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 2,
      linkStateId: iface.ipAddress,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      length: 24 + attachedRouters.length * 4,
      networkMask: iface.mask,
      attachedRouters,
    };

    lsa.checksum = this.computeLSAChecksum(lsa);

    this.installLSA(iface.areaId, lsa);
    this.floodLSA(iface.areaId, lsa, null);

    return lsa;
  }

  private hasFullNeighborOnInterface(iface: OSPFInterface): boolean {
    for (const [, neighbor] of iface.neighbors) {
      if (neighbor.state === 'Full') return true;
    }
    return false;
  }

  // ─── LSA Flooding (RFC 2328 §13.3) ─────────────────────────────

  private floodLSA(areaId: string, lsa: LSA, excludeIface: string | null): void {
    for (const [ifName, iface] of this.interfaces) {
      if (ifName === excludeIface) continue;
      if (iface.areaId !== areaId && lsa.lsType !== 5) continue;
      if (iface.passive) continue;

      for (const [, neighbor] of iface.neighbors) {
        if (neighbor.state === 'Full' || neighbor.state === 'Exchange' || neighbor.state === 'Loading') {
          neighbor.lsRetransmissionList.push(lsa);

          const lsu: OSPFLSUpdatePacket = {
            type: 'ospf',
            version: OSPF_VERSION_2,
            packetType: 4,
            routerId: this.config.routerId,
            areaId,
            numLSAs: 1,
            lsas: [lsa],
          };

          // Send to DR/BDR on broadcast, or directly on P2P
          const destIP = iface.networkType === 'broadcast'
            ? OSPF_ALL_SPF_ROUTERS.toString()
            : neighbor.ipAddress;

          this.sendCallback?.(iface.name, lsu, destIP);
        }
      }
    }
  }

  // ─── SPF Calculation (Dijkstra - RFC 2328 §16) ─────────────────

  scheduleSPF(): void {
    if (this.spfPending) return;
    this.spfPending = true;

    if (this.spfTimer) clearTimeout(this.spfTimer);
    this.spfTimer = setTimeout(() => {
      this.spfPending = false;
      this.spfTimer = null;
      this.runSPF();
    }, 200); // 200ms delay
  }

  /**
   * Run Dijkstra's SPF algorithm on the LSDB.
   * RFC 2328 §16.1
   */
  runSPF(): OSPFRouteEntry[] {
    this.ospfRoutes = [];

    for (const [areaId] of this.config.areas) {
      const areaRoutes = this.runSPFForArea(areaId);
      this.ospfRoutes.push(...areaRoutes);
    }

    return this.ospfRoutes;
  }

  private runSPFForArea(areaId: string): OSPFRouteEntry[] {
    const areaDB = this.lsdb.areas.get(areaId);
    if (!areaDB) return [];

    const routes: OSPFRouteEntry[] = [];

    // Candidate list (priority queue) and SPF tree
    const tree: Map<string, SPFVertex> = new Map();
    const candidates: SPFVertex[] = [];

    // Start with our own Router-LSA
    const rootKey = makeLSDBKey(1, this.config.routerId, this.config.routerId);
    const rootLSA = areaDB.get(rootKey) as RouterLSA | undefined;
    if (!rootLSA) return [];

    const rootVertex: SPFVertex = {
      id: this.config.routerId,
      type: 'router',
      distance: 0,
      parent: null,
      lsa: rootLSA,
      nextHop: null,
      outInterface: null,
    };
    tree.set(rootVertex.id, rootVertex);

    // Process root's links
    this.addCandidatesFromVertex(rootVertex, areaId, areaDB, tree, candidates);

    // Dijkstra loop
    while (candidates.length > 0) {
      // Find candidate with minimum distance
      candidates.sort((a, b) => a.distance - b.distance);
      const best = candidates.shift()!;

      // Add to tree
      tree.set(best.id, best);

      // Process this vertex's links
      this.addCandidatesFromVertex(best, areaId, areaDB, tree, candidates);
    }

    // Extract routes from SPF tree
    for (const [id, vertex] of tree) {
      if (id === this.config.routerId) continue; // Skip self

      if (vertex.type === 'router') {
        // Router vertex — add routes to its stub networks
        const rLSA = vertex.lsa as RouterLSA;
        for (const link of rLSA.links) {
          if (link.type === 3) { // Stub network
            const nextHop = vertex.nextHop || vertex.id;
            const outIface = vertex.outInterface || this.findIfaceForNextHop(nextHop);
            if (outIface) {
              routes.push({
                network: link.linkId,
                mask: link.linkData,
                routeType: 'intra-area',
                areaId,
                nextHop,
                iface: outIface,
                cost: vertex.distance + link.metric,
                advertisingRouter: rLSA.advertisingRouter,
              });
            }
          }
        }
      } else if (vertex.type === 'network') {
        // Network vertex — add route to the network
        const nLSA = vertex.lsa as NetworkLSA;
        const nextHop = vertex.nextHop || '';
        const outIface = vertex.outInterface || this.findIfaceForNextHop(nextHop);
        if (outIface) {
          const netAddr = this.computeNetwork(nLSA.linkStateId, nLSA.networkMask);
          routes.push({
            network: netAddr,
            mask: nLSA.networkMask,
            routeType: 'intra-area',
            areaId,
            nextHop,
            iface: outIface,
            cost: vertex.distance,
            advertisingRouter: nLSA.advertisingRouter,
          });
        }
      }
    }

    return routes;
  }

  private addCandidatesFromVertex(
    vertex: SPFVertex,
    areaId: string,
    areaDB: Map<LSDBKey, LSA>,
    tree: Map<string, SPFVertex>,
    candidates: SPFVertex[],
  ): void {
    if (vertex.type === 'router') {
      const rLSA = vertex.lsa as RouterLSA;
      for (const link of rLSA.links) {
        if (link.type === 1) {
          // Point-to-point to another router
          const neighborKey = makeLSDBKey(1, link.linkId, link.linkId);
          const neighborLSA = areaDB.get(neighborKey) as RouterLSA | undefined;
          if (!neighborLSA) continue;
          if (tree.has(link.linkId)) continue;

          const newDist = vertex.distance + link.metric;
          const nextHop = vertex.distance === 0 ? this.getDirectNextHop(link.linkId) : vertex.nextHop;
          const outIface = vertex.distance === 0 ? this.findIfaceForNeighbor(link.linkId) : vertex.outInterface;

          this.addOrUpdateCandidate(candidates, {
            id: link.linkId,
            type: 'router',
            distance: newDist,
            parent: vertex,
            lsa: neighborLSA,
            nextHop: nextHop,
            outInterface: outIface,
          });
        } else if (link.type === 2) {
          // Transit network — look up Network-LSA
          const drIP = link.linkId;
          const networkKey = makeLSDBKey(2, drIP, drIP);
          // Need to find the Network-LSA by link state ID (DR IP)
          let networkLSA: NetworkLSA | undefined;
          for (const [k, lsa] of areaDB) {
            if (lsa.lsType === 2 && lsa.linkStateId === drIP) {
              networkLSA = lsa as NetworkLSA;
              break;
            }
          }
          if (!networkLSA) continue;
          if (tree.has(drIP)) continue;

          const newDist = vertex.distance + link.metric;
          const nextHop = vertex.distance === 0 ? null : vertex.nextHop;
          const outIface = vertex.distance === 0 ? this.findIfaceByIP(link.linkData) : vertex.outInterface;

          this.addOrUpdateCandidate(candidates, {
            id: drIP,
            type: 'network',
            distance: newDist,
            parent: vertex,
            lsa: networkLSA,
            nextHop: nextHop,
            outInterface: outIface,
          });
        }
      }
    } else if (vertex.type === 'network') {
      const nLSA = vertex.lsa as NetworkLSA;
      for (const routerId of nLSA.attachedRouters) {
        if (routerId === this.config.routerId) continue;
        if (tree.has(routerId)) continue;

        const routerKey = makeLSDBKey(1, routerId, routerId);
        const routerLSA = areaDB.get(routerKey) as RouterLSA | undefined;
        if (!routerLSA) continue;

        const newDist = vertex.distance + 0; // Network→Router cost is 0
        const nextHop = vertex.parent?.id === this.config.routerId
          ? this.getNextHopViaNetwork(routerId, nLSA)
          : vertex.nextHop;
        const outIface = vertex.outInterface;

        this.addOrUpdateCandidate(candidates, {
          id: routerId,
          type: 'router',
          distance: newDist,
          parent: vertex,
          lsa: routerLSA,
          nextHop: nextHop,
          outInterface: outIface,
        });
      }
    }
  }

  private addOrUpdateCandidate(candidates: SPFVertex[], newVertex: SPFVertex): void {
    const existing = candidates.find(c => c.id === newVertex.id);
    if (existing) {
      if (newVertex.distance < existing.distance) {
        existing.distance = newVertex.distance;
        existing.parent = newVertex.parent;
        existing.nextHop = newVertex.nextHop;
        existing.outInterface = newVertex.outInterface;
      }
    } else {
      candidates.push(newVertex);
    }
  }

  // ─── Helper methods for SPF ─────────────────────────────────────

  private getDirectNextHop(neighborRouterId: string): string | null {
    for (const [, iface] of this.interfaces) {
      const neighbor = iface.neighbors.get(neighborRouterId);
      if (neighbor && neighbor.state === 'Full') {
        return neighbor.ipAddress;
      }
    }
    return null;
  }

  private getNextHopViaNetwork(routerId: string, networkLSA: NetworkLSA): string | null {
    // The next hop is the router's interface IP on the network
    // We need to find the router's link data for this network
    for (const [, iface] of this.interfaces) {
      const neighbor = iface.neighbors.get(routerId);
      if (neighbor) return neighbor.ipAddress;
    }
    return null;
  }

  private findIfaceForNeighbor(routerId: string): string | null {
    for (const [, iface] of this.interfaces) {
      if (iface.neighbors.has(routerId)) return iface.name;
    }
    return null;
  }

  private findIfaceByIP(ip: string): string | null {
    for (const [, iface] of this.interfaces) {
      if (iface.ipAddress === ip) return iface.name;
    }
    return null;
  }

  private findIfaceForNextHop(nextHop: string): string | null {
    for (const [, iface] of this.interfaces) {
      if (this.isInSameSubnet(nextHop, iface.ipAddress, iface.mask)) {
        return iface.name;
      }
    }
    return null;
  }

  // ─── Route Table ──────────────────────────────────────────────

  getRoutes(): OSPFRouteEntry[] {
    return [...this.ospfRoutes];
  }

  // ─── Event Log ─────────────────────────────────────────────────

  getEventLog(): string[] {
    return [...this.eventLog];
  }

  clearEventLog(): void {
    this.eventLog = [];
  }

  // ─── Neighbors API ─────────────────────────────────────────────

  getNeighbors(): OSPFNeighbor[] {
    const result: OSPFNeighbor[] = [];
    for (const [, iface] of this.interfaces) {
      for (const [, neighbor] of iface.neighbors) {
        result.push(neighbor);
      }
    }
    return result;
  }

  getNeighborCount(): number {
    let count = 0;
    for (const [, iface] of this.interfaces) {
      count += iface.neighbors.size;
    }
    return count;
  }

  getFullNeighborCount(): number {
    let count = 0;
    for (const [, iface] of this.interfaces) {
      for (const [, neighbor] of iface.neighbors) {
        if (neighbor.state === 'Full') count++;
      }
    }
    return count;
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  shutdown(): void {
    // Stop all hello timers
    for (const [, iface] of this.interfaces) {
      if (iface.helloTimer) {
        clearInterval(iface.helloTimer);
        iface.helloTimer = null;
      }
      if (iface.waitTimer) {
        clearTimeout(iface.waitTimer);
        iface.waitTimer = null;
      }
      // Clear all neighbor dead timers
      for (const [, neighbor] of iface.neighbors) {
        this.clearDeadTimer(neighbor);
      }
    }

    if (this.spfTimer) {
      clearTimeout(this.spfTimer);
      this.spfTimer = null;
    }

    this.interfaces.clear();
    this.lsdb = createEmptyLSDB();
    this.ospfRoutes = [];
  }

  // ─── Utility ──────────────────────────────────────────────────

  private nextSeqNumber(): number {
    const seq = this.seqNumber;
    // OSPF uses signed 32-bit sequence numbers (0x80000001 to 0x7FFFFFFF)
    // In JS, these are unsigned, so 0x80000001 (2147483649) > 0x7FFFFFFF (2147483647)
    // We simply increment the counter; wrap-around from max unsigned is unlikely in simulation
    this.seqNumber = seq + 1;
    return seq;
  }

  private computeLSAChecksum(lsa: LSA): number {
    // Simplified checksum (not the real Fletcher-16)
    let sum = lsa.lsType + lsa.lsSequenceNumber;
    sum += this.ipToNumber(lsa.linkStateId);
    sum += this.ipToNumber(lsa.advertisingRouter);
    return (sum & 0xFFFF) ^ ((sum >> 16) & 0xFFFF);
  }

  private computeNetwork(ip: string, mask: string): string {
    const ipNum = this.ipToNumber(ip);
    const maskNum = this.ipToNumber(mask);
    return this.numberToIP(ipNum & maskNum);
  }

  private isInSameSubnet(ip1: string, ip2: string, mask: string): boolean {
    const ip1Num = this.ipToNumber(ip1);
    const ip2Num = this.ipToNumber(ip2);
    const maskNum = this.ipToNumber(mask);
    return (ip1Num & maskNum) === (ip2Num & maskNum);
  }

  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  private numberToIP(num: number): string {
    return [
      (num >>> 24) & 0xFF,
      (num >>> 16) & 0xFF,
      (num >>> 8) & 0xFF,
      num & 0xFF,
    ].join('.');
  }

  /**
   * Dispatch an incoming OSPF packet to the correct handler.
   */
  processPacket(ifaceName: string, srcIP: string, packet: OSPFPacket): void {
    // Validate router ID isn't our own (ignore our own packets)
    if (packet.routerId === this.config.routerId) return;

    switch (packet.packetType) {
      case 1:
        this.processHello(ifaceName, srcIP, packet as OSPFHelloPacket);
        break;
      case 2:
        this.processDD(ifaceName, srcIP, packet as OSPFDDPacket);
        break;
      case 3:
        this.processLSRequest(ifaceName, srcIP, packet as OSPFLSRequestPacket);
        break;
      case 4:
        this.processLSUpdate(ifaceName, srcIP, packet as OSPFLSUpdatePacket);
        break;
      case 5:
        this.processLSAck(ifaceName, srcIP, packet as OSPFLSAckPacket);
        break;
    }
  }

  /**
   * Check which interfaces match configured network statements.
   * Returns matching { interfaceName, areaId } pairs.
   */
  matchInterfaces(routerInterfaces: Array<{ name: string; ip: string; mask: string }>): Array<{ name: string; ip: string; mask: string; areaId: string }> {
    const matches: Array<{ name: string; ip: string; mask: string; areaId: string }> = [];

    for (const ri of routerInterfaces) {
      for (const net of this.config.networks) {
        if (this.wildcardMatch(ri.ip, net.network, net.wildcard)) {
          matches.push({ ...ri, areaId: net.areaId });
          break;
        }
      }
    }

    return matches;
  }

  private wildcardMatch(ip: string, network: string, wildcard: string): boolean {
    const ipNum = this.ipToNumber(ip);
    const netNum = this.ipToNumber(network);
    const wcNum = this.ipToNumber(wildcard);
    // Wildcard: 0 = must match, 1 = don't care (inverse of subnet mask)
    return (ipNum & ~wcNum) === (netNum & ~wcNum);
  }
}
