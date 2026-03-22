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
  OSPFv3LinkLSA, OSPFv3IntraAreaPrefixLSA, OSPFv3Prefix,
  OSPFRouteEntry,
  SPFVertex,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  OSPF_DEFAULT_HELLO_INTERVAL, OSPF_DEFAULT_DEAD_INTERVAL,
  OSPF_BACKBONE_AREA, OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_MAX_SEQUENCE_NUMBER,
  OSPF_VERSION_3,
  createDefaultOSPFConfig,
} from './types';
import type { IProtocolEngine } from '../core/interfaces';

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

export class OSPFv3Engine implements IProtocolEngine {
  private config: OSPFConfig;
  private lsdb: LSDB;
  private interfaces: Map<string, OSPFv3Interface> = new Map();
  private ospfRoutes: OSPFRouteEntry[] = [];
  private sendCallback: OSPFv3SendCallback | null = null;
  private seqNumber: number = OSPF_INITIAL_SEQUENCE_NUMBER;
  private nextInterfaceId: number = 1;
  private eventLog: string[] = [];
  private running = false;

  /**
   * Storage for OSPFv3-specific LSAs that don't fit in the standard LSDB:
   *   - Link-LSAs (0x0008): link-scoped, one per interface
   *   - Intra-Area-Prefix-LSAs (0x2009): area-scoped
   */
  private linkLSAs: Map<string, OSPFv3LinkLSA> = new Map();          // key: ifaceName
  private intraPrefixLSAs: Map<string, OSPFv3IntraAreaPrefixLSA> = new Map(); // key: areaId

  /** SPF scheduling */
  private spfTimer: ReturnType<typeof setTimeout> | null = null;
  private spfPending = false;

  constructor(processId: number = 1) {
    this.config = createDefaultOSPFConfig(processId);
    this.lsdb = createEmptyLSDB();
  }

  // ─── IProtocolEngine ─────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.shutdown();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Configuration ─────────────────────────────────────────────

  getConfig(): OSPFConfig {
    return this.config;
  }

  getProcessId(): number {
    return this.config.processId;
  }

  /**
   * Set the OSPFv3 Router ID.
   * @throws Error if routerId is '0.0.0.0' (invalid per RFC 2328 §C.1)
   */
  setRouterId(routerId: string): void {
    if (routerId === '0.0.0.0') {
      throw new Error('OSPFv3: Router ID 0.0.0.0 is invalid (RFC 2328 §C.1)');
    }
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

  setDefaultInformationOriginate(flag: boolean | 'always'): void {
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

    // Originate Link-LSA for this interface (RFC 5340 §4.4.1)
    const linkLocalAddr = options?.ipAddress ?? 'fe80::1';
    this.originateLinkLSA(name, linkLocalAddr, []);

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
      ddRetransmitTimer: null,
      lsrRetransmitTimer: null,
      lastSentDD: null,
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

  // ─── OSPFv3 Link-LSA (RFC 5340 §4.4.1) ───────────────────────

  /**
   * Originate a Link-LSA (Type 0x0008) for the given interface.
   * Link-LSAs are link-scoped and carry the link-local address and prefixes.
   * RFC 5340 §4.4.1
   */
  originateLinkLSA(
    ifaceName: string,
    linkLocalAddress: string,
    prefixes: OSPFv3Prefix[] = [],
  ): OSPFv3LinkLSA {
    const iface = this.interfaces.get(ifaceName);
    const interfaceId = iface?.interfaceId ?? this.nextInterfaceId;
    const priority = iface?.priority ?? 1;

    const lsa: OSPFv3LinkLSA = {
      lsAge: 0,
      lsType: OSPFV3_LSA_LINK,
      linkStateId: String(interfaceId),
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.seqNumber++,
      checksum: 0,
      length: 24 + 4 + 16 + prefixes.length * 8, // header + priority/options + addr + prefixes
      priority,
      options: 0x13, // V6, E, R bits
      linkLocalAddress,
      prefixes,
    };

    this.linkLSAs.set(ifaceName, lsa);

    if (this.sendCallback && iface) {
      // Flood Link-LSA on the link
      // (In production would send via the interface to AllSPFRouters)
    }

    return lsa;
  }

  /**
   * Retrieve the Link-LSA for the named interface.
   */
  getLinkLSA(ifaceName: string): OSPFv3LinkLSA | undefined {
    return this.linkLSAs.get(ifaceName);
  }

  // ─── OSPFv3 Intra-Area-Prefix-LSA (RFC 5340 §4.4.3) ──────────

  /**
   * Originate an Intra-Area-Prefix-LSA (Type 0x2009) for the given area.
   * This LSA carries all IPv6 prefixes associated with the router.
   * RFC 5340 §4.4.3
   */
  originateIntraAreaPrefixLSA(
    areaId: string,
    prefixes: OSPFv3Prefix[] = [],
  ): OSPFv3IntraAreaPrefixLSA {
    const lsa: OSPFv3IntraAreaPrefixLSA = {
      lsAge: 0,
      lsType: OSPFV3_LSA_INTRA_AREA_PREFIX,
      linkStateId: '0', // 0 when referencing a Router-LSA
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.seqNumber++,
      checksum: 0,
      length: 24 + 8 + prefixes.length * 8, // header + ref fields + prefixes
      numPrefixes: prefixes.length,
      referencedLSType: 0x2001,   // References Router-LSA
      referencedLSId: '0',        // Router-LSA link state ID = 0
      referencedAdvRouter: this.config.routerId,
      prefixes,
    };

    this.intraPrefixLSAs.set(areaId, lsa);
    return lsa;
  }

  /**
   * Retrieve the Intra-Area-Prefix-LSA for the given area.
   */
  getIntraAreaPrefixLSA(areaId: string): OSPFv3IntraAreaPrefixLSA | undefined {
    return this.intraPrefixLSAs.get(areaId);
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
    this.running = false;
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
    this.linkLSAs.clear();
    this.intraPrefixLSAs.clear();
  }
}
