/**
 * OSPFv3Engine - OSPF for IPv6 (RFC 5340)
 *
 * Key differences from OSPFv2:
 *   - Runs over IPv6 (link-local addresses for neighbor communication)
 *   - Uses Router ID (still 32-bit) but no IP addresses in LSAs
 *   - Interface ID instead of IP address for neighbor identification
 *   - Multiple instances per link (Instance ID)
 *   - New LSA types: Link-LSA (0x0008), Intra-Area-Prefix-LSA (0x2009)
 *   - No authentication in OSPF header (relies on IPsec)
 *   - Addresses removed from Hello/DD packets
 *
 * This engine extends OSPFv2 concepts for IPv6 with separate state
 * while reusing the same neighbor FSM and SPF algorithm.
 */

import {
  OSPFConfig, OSPFNeighbor, OSPFNeighborState, OSPFNeighborEvent,
  OSPFInterfaceState, OSPFAreaType, OSPFNetworkType, OSPFArea,
  LSAHeader, LSAType, RouterLSA, NetworkLSA, RouterLSALink,
  LSA, LSDB, LSDBKey, makeLSDBKey, createEmptyLSDB,
  OSPFPacketHeader, OSPFHelloPacket,
  OSPFv3Interface, OSPFv3HelloPacket,
  OSPFRouteEntry,
  SPFVertex,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  OSPF_DEFAULT_HELLO_INTERVAL, OSPF_DEFAULT_DEAD_INTERVAL,
  OSPF_BACKBONE_AREA, OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_MAX_SEQUENCE_NUMBER,
  OSPF_VERSION_3,
  createDefaultOSPFConfig,
} from './types';

// ─── OSPFv3 LSA Types ───────────────────────────────────────────────

export const OSPFV3_LSA_ROUTER = 0x2001;
export const OSPFV3_LSA_NETWORK = 0x2002;
export const OSPFV3_LSA_INTER_AREA_PREFIX = 0x2003;
export const OSPFV3_LSA_INTER_AREA_ROUTER = 0x2004;
export const OSPFV3_LSA_EXTERNAL = 0x4005;
export const OSPFV3_LSA_LINK = 0x0008;
export const OSPFV3_LSA_INTRA_AREA_PREFIX = 0x2009;

// ─── OSPFv3 Callback ────────────────────────────────────────────────

export type OSPFv3SendCallback = (
  iface: string,
  packet: OSPFPacketHeader,
  destIPv6: string,
) => void;

// ─── OSPFv3 Engine ──────────────────────────────────────────────────

export class OSPFv3Engine {
  private config: OSPFConfig;
  private lsdb: LSDB;
  private interfaces: Map<string, OSPFv3Interface> = new Map();
  private ospfRoutes: OSPFRouteEntry[] = [];
  private sendCallback: OSPFv3SendCallback | null = null;
  private seqNumber: number = OSPF_INITIAL_SEQUENCE_NUMBER;
  private nextInterfaceId: number = 1;
  private eventLog: string[] = [];

  /** SPF scheduling */
  private spfTimer: ReturnType<typeof setTimeout> | null = null;
  private spfPending = false;

  constructor(processId: number = 1) {
    this.config = createDefaultOSPFConfig(processId);
    this.lsdb = createEmptyLSDB();
  }

  // ─── Configuration ─────────────────────────────────────────────

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

  setSendCallback(cb: OSPFv3SendCallback): void {
    this.sendCallback = cb;
  }

  setPassiveInterface(ifName: string): void {
    this.config.passiveInterfaces.add(ifName);
    const iface = this.interfaces.get(ifName);
    if (iface) {
      iface.passive = true;
      if (iface.helloTimer) {
        clearInterval(iface.helloTimer);
        iface.helloTimer = null;
      }
    }
  }

  removePassiveInterface(ifName: string): void {
    this.config.passiveInterfaces.delete(ifName);
    const iface = this.interfaces.get(ifName);
    if (iface) iface.passive = false;
  }

  isPassiveInterface(ifName: string): boolean {
    return this.config.passiveInterfaces.has(ifName);
  }

  setDefaultInformationOriginate(flag: boolean): void {
    (this.config as any).defaultInfoOriginate = flag;
  }

  // ─── Area Management ──────────────────────────────────────────

  addArea(areaId: string, type: OSPFAreaType = 'normal'): void {
    if (!this.config.areas.has(areaId)) {
      this.config.areas.set(areaId, {
        areaId,
        type,
        interfaces: [],
        isBackbone: areaId === OSPF_BACKBONE_AREA || areaId === '0',
      });
    }
    if (!this.lsdb.areas.has(areaId)) {
      this.lsdb.areas.set(areaId, new Map());
    }
  }

  setAreaType(areaId: string, type: OSPFAreaType): void {
    const area = this.config.areas.get(areaId);
    if (area) area.type = type;
  }

  // ─── Interface Management ─────────────────────────────────────

  /**
   * Activate an OSPFv3 interface.
   * In OSPFv3, interfaces are enabled per-interface (not via network statements).
   * Command: `ipv6 ospf <process-id> area <area-id>`
   */
  activateInterface(
    name: string,
    areaId: string,
    options?: {
      cost?: number;
      priority?: number;
      instanceId?: number;
      networkType?: OSPFNetworkType;
      helloInterval?: number;
      deadInterval?: number;
      ipAddress?: string;
    }
  ): OSPFv3Interface {
    this.addArea(areaId);

    const iface: OSPFv3Interface = {
      name,
      instanceId: options?.instanceId ?? 0,
      interfaceId: this.nextInterfaceId++,
      areaId,
      state: 'Down',
      networkType: options?.networkType ?? 'broadcast',
      helloInterval: options?.helloInterval ?? OSPF_DEFAULT_HELLO_INTERVAL,
      deadInterval: options?.deadInterval ?? OSPF_DEFAULT_DEAD_INTERVAL,
      priority: options?.priority ?? 1,
      cost: options?.cost ?? 1,
      dr: '0.0.0.0',
      bdr: '0.0.0.0',
      neighbors: new Map(),
      helloTimer: null,
      waitTimer: null,
      passive: this.config.passiveInterfaces.has(name),
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
      this.clearDeadTimer(neighbor);
      neighbor.state = 'Down';
    }

    if (iface.helloTimer) {
      clearInterval(iface.helloTimer);
      iface.helloTimer = null;
    }
    if (iface.waitTimer) {
      clearTimeout(iface.waitTimer);
      iface.waitTimer = null;
    }

    iface.state = 'Down';
    const area = this.config.areas.get(iface.areaId);
    if (area) {
      area.interfaces = area.interfaces.filter(i => i !== name);
    }

    this.interfaces.delete(name);
  }

  getInterface(name: string): OSPFv3Interface | undefined {
    return this.interfaces.get(name);
  }

  getInterfaces(): Map<string, OSPFv3Interface> {
    return this.interfaces;
  }

  setInterfaceCost(ifName: string, cost: number): void {
    const iface = this.interfaces.get(ifName);
    if (iface) iface.cost = cost;
  }

  setInterfacePriority(ifName: string, priority: number): void {
    const iface = this.interfaces.get(ifName);
    if (iface) iface.priority = priority;
  }

  // ─── Interface State Machine ──────────────────────────────────

  private interfaceUp(name: string): void {
    const iface = this.interfaces.get(name);
    if (!iface) return;

    if (iface.networkType === 'point-to-point') {
      iface.state = 'PointToPoint';
    } else {
      iface.state = 'Waiting';
      iface.waitTimer = setTimeout(() => {
        this.drElection(iface);
      }, iface.deadInterval * 1000);
    }

    if (!iface.passive) {
      this.startHelloTimer(iface);
    }
  }

  private startHelloTimer(iface: OSPFv3Interface): void {
    if (iface.helloTimer) clearInterval(iface.helloTimer);

    this.sendHello(iface);

    iface.helloTimer = setInterval(() => {
      this.sendHello(iface);
    }, iface.helloInterval * 1000);
  }

  // ─── Hello Protocol ───────────────────────────────────────────

  private sendHello(iface: OSPFv3Interface): void {
    if (!this.sendCallback) return;

    const neighborIds = Array.from(iface.neighbors.keys());

    const hello: OSPFv3HelloPacket = {
      type: 'ospf',
      version: OSPF_VERSION_3,
      packetType: 1,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      interfaceId: iface.interfaceId,
      priority: iface.priority,
      options: 0x13, // V6, E, R bits
      helloInterval: iface.helloInterval,
      deadInterval: iface.deadInterval,
      designatedRouter: iface.dr,
      backupDesignatedRouter: iface.bdr,
      neighbors: neighborIds,
    };

    // OSPFv3 uses ff02::5 (AllSPFRouters)
    this.sendCallback(iface.name, hello, 'ff02::5');
  }

  /**
   * Process an incoming OSPFv3 Hello packet.
   */
  processHello(ifaceName: string, srcIP: string, hello: OSPFv3HelloPacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    // Validate timers
    if (hello.helloInterval !== iface.helloInterval) return;
    if (hello.deadInterval !== iface.deadInterval) return;

    const neighborId = hello.routerId;
    let neighbor = iface.neighbors.get(neighborId);

    if (!neighbor) {
      neighbor = this.createNeighbor(neighborId, srcIP, ifaceName, hello);
      iface.neighbors.set(neighborId, neighbor);
    }

    neighbor.ipAddress = srcIP;
    neighbor.priority = hello.priority;
    neighbor.neighborDR = hello.designatedRouter;
    neighbor.neighborBDR = hello.backupDesignatedRouter;
    neighbor.lastHelloReceived = Date.now();
    neighbor.options = hello.options;

    // HelloReceived
    this.resetDeadTimer(iface, neighbor);
    if (neighbor.state === 'Down') {
      neighbor.state = 'Init';
      this.logEvent(`OSPFv3: Neighbor ${neighborId} (${ifaceName}): Down -> Init (HelloReceived)`);
    }

    // TwoWay check
    const seesUs = hello.neighbors.includes(this.config.routerId);
    if (seesUs && neighbor.state === 'Init') {
      if (this.shouldFormAdjacency(iface, neighbor)) {
        neighbor.state = 'ExStart';
        this.logEvent(`OSPFv3: Neighbor ${neighborId} (${ifaceName}): Init -> ExStart (TwoWayReceived)`);
        // In a full implementation, start DD exchange
        // For simulation, fast-track to Full for neighbors that should form adjacency
        neighbor.state = 'Full';
        this.logEvent(`OSPFv3: Neighbor ${neighborId} (${ifaceName}): ExStart -> Full`);
      } else {
        neighbor.state = 'TwoWay';
        this.logEvent(`OSPFv3: Neighbor ${neighborId} (${ifaceName}): Init -> TwoWay (TwoWayReceived)`);
      }
    }

    // DR/BDR handling
    if (iface.state === 'Waiting' && hello.backupDesignatedRouter === hello.routerId) {
      if (iface.waitTimer) {
        clearTimeout(iface.waitTimer);
        iface.waitTimer = null;
      }
      this.drElection(iface);
    }
  }

  private createNeighbor(
    routerId: string,
    ipAddress: string,
    ifaceName: string,
    hello: OSPFv3HelloPacket,
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

  // ─── Dead Timer ───────────────────────────────────────────────

  private resetDeadTimer(iface: OSPFv3Interface, neighbor: OSPFNeighbor): void {
    this.clearDeadTimer(neighbor);
    neighbor.deadTimer = setTimeout(() => {
      const oldState = neighbor.state;
      neighbor.state = 'Down';
      iface.neighbors.delete(neighbor.routerId);
      this.logEvent(`OSPFv3: Neighbor ${neighbor.routerId} (${iface.name}): ${oldState} -> Down (InactivityTimer)`);
    }, iface.deadInterval * 1000);
  }

  private clearDeadTimer(neighbor: OSPFNeighbor): void {
    if (neighbor.deadTimer) {
      clearTimeout(neighbor.deadTimer);
      neighbor.deadTimer = null;
    }
  }

  private shouldFormAdjacency(iface: OSPFv3Interface, neighbor: OSPFNeighbor): boolean {
    if (iface.networkType === 'point-to-point' || iface.networkType === 'point-to-multipoint') {
      return true;
    }
    if (iface.state === 'DR' || iface.state === 'Backup') return true;
    if (neighbor.neighborDR === neighbor.routerId || neighbor.neighborBDR === neighbor.routerId) return true;
    return false;
  }

  // ─── DR/BDR Election ──────────────────────────────────────────

  private drElection(iface: OSPFv3Interface): void {
    if (iface.networkType !== 'broadcast' && iface.networkType !== 'nbma') {
      iface.state = 'PointToPoint';
      return;
    }

    // Simple election: highest priority wins, then highest Router ID
    interface Candidate {
      routerId: string;
      priority: number;
    }

    const candidates: Candidate[] = [];
    if (iface.priority > 0) {
      candidates.push({ routerId: this.config.routerId, priority: iface.priority });
    }
    for (const [, neighbor] of iface.neighbors) {
      if (neighbor.state !== 'Down' && neighbor.state !== 'Init' && neighbor.priority > 0) {
        candidates.push({ routerId: neighbor.routerId, priority: neighbor.priority });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority || b.routerId.localeCompare(a.routerId));

    const dr = candidates[0]?.routerId ?? '0.0.0.0';
    const bdr = candidates[1]?.routerId ?? '0.0.0.0';

    iface.dr = dr;
    iface.bdr = bdr;

    if (dr === this.config.routerId) {
      iface.state = 'DR';
    } else if (bdr === this.config.routerId) {
      iface.state = 'Backup';
    } else {
      iface.state = 'DROther';
    }
  }

  // ─── Neighbor API ─────────────────────────────────────────────

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

  // ─── LSDB ────────────────────────────────────────────────────

  getLSDB(): LSDB {
    return this.lsdb;
  }

  getLSDBCount(): number {
    let count = 0;
    for (const areaDB of this.lsdb.areas.values()) {
      count += areaDB.size;
    }
    count += this.lsdb.external.size;
    return count;
  }

  installLSA(areaId: string, lsa: LSA): void {
    const key = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);
    let areaDB = this.lsdb.areas.get(areaId);
    if (!areaDB) {
      areaDB = new Map();
      this.lsdb.areas.set(areaId, areaDB);
    }
    areaDB.set(key, lsa);
  }

  // ─── Routes ───────────────────────────────────────────────────

  getRoutes(): OSPFRouteEntry[] {
    return [...this.ospfRoutes];
  }

  // ─── Event Log ────────────────────────────────────────────────

  getEventLog(): string[] {
    return [...this.eventLog];
  }

  clearEventLog(): void {
    this.eventLog = [];
  }

  private logEvent(msg: string): void {
    this.eventLog.push(msg);
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  shutdown(): void {
    for (const [, iface] of this.interfaces) {
      if (iface.helloTimer) {
        clearInterval(iface.helloTimer);
        iface.helloTimer = null;
      }
      if (iface.waitTimer) {
        clearTimeout(iface.waitTimer);
        iface.waitTimer = null;
      }
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
}
