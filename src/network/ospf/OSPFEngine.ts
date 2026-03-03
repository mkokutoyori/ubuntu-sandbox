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
  OSPFInterfaceState, OSPFArea, OSPFAreaRange, OSPFAreaType, OSPFNetworkType,
  LSA, LSAHeader, LSAType, RouterLSA, NetworkLSA, SummaryLSA, ASBRSummaryLSA,
  ExternalLSA, NSSAExternalLSA,
  RouterLSALink, RouterLinkType,
  LSDB, LSDBKey, makeLSDBKey, createEmptyLSDB,
  OSPFPacket, OSPFHelloPacket, OSPFDDPacket, OSPFLSUpdatePacket, OSPFLSAckPacket,
  OSPFLSRequestPacket,
  SPFVertex, OSPFRouteEntry, OSPFRouteType,
  DD_FLAG_INIT, DD_FLAG_MORE, DD_FLAG_MASTER,
  OSPF_DEFAULT_HELLO_INTERVAL, OSPF_DEFAULT_DEAD_INTERVAL,
  OSPF_DEFAULT_RETRANSMIT_INTERVAL, OSPF_DEFAULT_TRANSMIT_DELAY,
  OSPF_MAX_AGE, OSPF_LS_REFRESH_TIME, OSPF_MIN_LS_INTERVAL, OSPF_MIN_LS_ARRIVAL,
  OSPF_INITIAL_SEQUENCE_NUMBER, OSPF_MAX_SEQUENCE_NUMBER,
  OSPF_BACKBONE_AREA, OSPF_ALL_SPF_ROUTERS, OSPF_ALL_DR_ROUTERS,
  OSPF_AD_INTRA_AREA, OSPF_AD_INTER_AREA, OSPF_AD_EXTERNAL,
  OSPF_INFINITY_METRIC,
  OSPF_VERSION_2,
  createDefaultOSPFConfig,
} from './types';

// ─── LSA Checksum: Fletcher-16 (RFC 2328 Appendix C.1) ─────────────

/**
 * Convert a dotted-decimal IP string to a 4-byte array.
 * Returns [0,0,0,0] for invalid input.
 */
function ipToBytes(ip: string): number[] {
  const parts = ip.split('.');
  if (parts.length !== 4) return [0, 0, 0, 0];
  return parts.map(n => parseInt(n, 10) & 0xFF);
}

/**
 * Serialize an LSA to a byte array starting from offset 2 of the LSA header
 * (i.e. skipping the 2-byte lsAge field), with the checksum field zeroed.
 * This is the byte sequence over which Fletcher-16 is computed.
 */
function serializeLSAForChecksum(lsa: LSA): number[] {
  const bytes: number[] = [];

  // --- LSA common header (from byte 2, skipping lsAge) ---
  bytes.push(lsa.options & 0xFF);                             // options: 1 byte
  bytes.push(lsa.lsType & 0xFF);                              // lsType: 1 byte
  bytes.push(...ipToBytes(lsa.linkStateId));                  // linkStateId: 4 bytes
  bytes.push(...ipToBytes(lsa.advertisingRouter));            // advertisingRouter: 4 bytes

  const seq = lsa.lsSequenceNumber >>> 0;
  bytes.push(
    (seq >>> 24) & 0xFF, (seq >>> 16) & 0xFF,
    (seq >>> 8)  & 0xFF,  seq         & 0xFF,
  );                                                          // seqNumber: 4 bytes

  bytes.push(0, 0);                                           // checksum: 2 bytes (zeroed)

  const len = lsa.length ?? 24;
  bytes.push((len >>> 8) & 0xFF, len & 0xFF);                 // length: 2 bytes

  // --- LSA type-specific body ---
  if (lsa.lsType === 1) {
    const r = lsa as RouterLSA;
    bytes.push(r.flags & 0xFF, 0);                            // flags + padding: 2 bytes
    bytes.push((r.numLinks >>> 8) & 0xFF, r.numLinks & 0xFF); // numLinks: 2 bytes
    for (const link of r.links) {
      bytes.push(...ipToBytes(link.linkId));
      bytes.push(...ipToBytes(link.linkData));
      bytes.push(link.type & 0xFF, link.numTOS & 0xFF);
      bytes.push((link.metric >>> 8) & 0xFF, link.metric & 0xFF);
    }
  } else if (lsa.lsType === 2) {
    const n = lsa as NetworkLSA;
    bytes.push(...ipToBytes(n.networkMask));
    for (const r of n.attachedRouters) {
      bytes.push(...ipToBytes(r));
    }
  } else if (lsa.lsType === 3 || lsa.lsType === 4) {
    const s = lsa as SummaryLSA;
    bytes.push(...ipToBytes(s.networkMask));
    bytes.push(0); // padding
    bytes.push((s.metric >>> 16) & 0xFF, (s.metric >>> 8) & 0xFF, s.metric & 0xFF);
  } else if (lsa.lsType === 5 || lsa.lsType === 7) {
    const e = lsa as ExternalLSA | NSSAExternalLSA;
    bytes.push(...ipToBytes(e.networkMask));
    bytes.push(e.metricType === 2 ? 0x80 : 0x00);
    bytes.push((e.metric >>> 16) & 0xFF, (e.metric >>> 8) & 0xFF, e.metric & 0xFF);
    bytes.push(...ipToBytes(e.forwardingAddress));
    const tag = e.externalRouteTag >>> 0;
    bytes.push((tag >>> 24) & 0xFF, (tag >>> 16) & 0xFF, (tag >>> 8) & 0xFF, tag & 0xFF);
  }

  return bytes;
}

/**
 * Compute the Fletcher-16 checksum of an LSA (RFC 2328 §12.4.7).
 * The lsAge field is excluded; the checksum field is treated as zero.
 * Returns the 16-bit checksum as (C0 << 8) | C1.
 */
export function computeOSPFLSAChecksum(lsa: LSA): number {
  const bytes = serializeLSAForChecksum(lsa);
  let c0 = 0, c1 = 0;
  for (const b of bytes) {
    c0 = (c0 + b) % 255;
    c1 = (c1 + c0) % 255;
  }
  const result = ((c0 & 0xFF) << 8) | (c1 & 0xFF);
  // Avoid returning 0x0000 (treated as "unset") — remap to a sentinel
  return result !== 0 ? result : 0xFFFF;
}

/**
 * Verify the stored checksum of an LSA matches the computed value.
 * An LSA with checksum 0 is always considered invalid (not yet computed).
 */
export function verifyOSPFLSAChecksum(lsa: LSA): boolean {
  if (lsa.checksum === 0) return false;
  return lsa.checksum === computeOSPFLSAChecksum(lsa);
}

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

  /** LSA aging timer (fires every 1 second) */
  private lsAgeTimer: ReturnType<typeof setInterval> | null = null;

  /** MinLSInterval: last flood timestamp (ms) per LSA key, for self-originated LSAs */
  private lastFloodTime: Map<string, number> = new Map();

  /** MinLSArrival: last install timestamp (ms) per LSA key, for received LSAs */
  private lsArrivalTimes: Map<string, number> = new Map();

  /** SPF throttle — configurable via setThrottleSPF() */
  private spfThrottleInitial = 200;    // ms: initial delay before first SPF
  private spfThrottleHold = 1_000;     // ms: base hold interval
  private spfThrottleMax = 10_000;     // ms: maximum hold interval
  private spfCurrentHold = 1_000;      // ms: current hold (doubles on each rapid re-schedule)
  private spfLastRunAt = 0;            // timestamp (ms) when SPF last ran

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
   * Re-deliver the stored lastSentDD for a master ExStart neighbor.
   * Called by the Router simulation after all drElections have run, to kick
   * off DD negotiation for pairs where the remote was still in Init/TwoWay
   * when the master first fired startDDExchange (RFC 2328 §10.6 retransmit).
   */
  triggerDDRetransmit(ifaceName: string, neighborRid: string): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;
    const neighbor = iface.neighbors.get(neighborRid);
    if (!neighbor || neighbor.state !== 'ExStart' || !neighbor.isMaster) return;
    if (!neighbor.lastSentDD) return;
    this.sendCallback?.(iface.name, neighbor.lastSentDD, neighbor.ipAddress);
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
    let area = this.config.areas.get(areaId);
    if (!area) {
      area = {
        areaId,
        type: 'normal',
        interfaces: [],
        isBackbone: areaId === OSPF_BACKBONE_AREA || areaId === '0',
      };
      this.config.areas.set(areaId, area);
      if (!this.lsdb.areas.has(areaId)) {
        this.lsdb.areas.set(areaId, new Map());
      }
    }
    area.type = type;
  }

  /**
   * Configure NSSA-specific options for an area.
   * Cisco equivalents: `area X nssa no-summary` / `area X nssa default-information-originate`
   * Sets area type to 'nssa' and applies the given options.
   */
  configureNSSA(
    areaId: string,
    options: { noSummary?: boolean; defaultInfoOriginate?: boolean } = {},
  ): void {
    this.setAreaType(areaId, 'nssa');
    const area = this.config.areas.get(areaId)!;
    if (options.noSummary !== undefined) area.nssaNoSummary = options.noSummary;
    if (options.defaultInfoOriginate !== undefined) area.nssaDefaultInfoOriginate = options.defaultInfoOriginate;
  }

  /**
   * Add (or replace) an area range for route summarization at this ABR.
   * Cisco: `area X range <network> <mask> [not-advertise]`
   * RFC 2328 §12.4.3.1
   */
  addAreaRange(areaId: string, network: string, mask: string, advertise = true): void {
    let area = this.config.areas.get(areaId);
    if (!area) {
      area = {
        areaId,
        type: 'normal',
        interfaces: [],
        isBackbone: areaId === OSPF_BACKBONE_AREA || areaId === '0',
      };
      this.config.areas.set(areaId, area);
    }
    if (!area.ranges) area.ranges = [];
    // Replace any existing entry with the same network/mask
    area.ranges = area.ranges.filter(r => r.network !== network || r.mask !== mask);
    area.ranges.push({ network, mask, advertise });
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
      /** Interface MTU in bytes (default 1500) */
      mtu?: number;
      /** One-way propagation delay in ms (default 0 = synchronous) */
      propagationDelayMs?: number;
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
      mtu: options?.mtu ?? 1500,
      propagationDelayMs: options?.propagationDelayMs ?? 0,
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
        iface.waitTimer = null;
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

    const isNewNeighbor = !neighbor;
    if (!neighbor) {
      // New neighbor discovered
      neighbor = this.createNeighbor(neighborId, srcIP, ifaceName, hello);
      iface.neighbors.set(neighborId, neighbor);
    }

    // Snapshot previous declarations for NbrChange detection
    const prevPriority = neighbor.priority;
    const prevDR = neighbor.neighborDR;
    const prevBDR = neighbor.neighborBDR;

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

    // Check for DR/BDR changes (RFC 2328 §9.4)
    if (iface.state === 'Waiting') {
      // BackupSeen case 1: neighbor declares itself BDR
      if (hello.backupDesignatedRouter === srcIP) {
        if (iface.waitTimer) { clearTimeout(iface.waitTimer); iface.waitTimer = null; }
        this.drElection(iface);
      }
      // BackupSeen case 2: neighbor declares itself DR with no BDR
      else if (hello.designatedRouter === srcIP && hello.backupDesignatedRouter === '0.0.0.0') {
        if (iface.waitTimer) { clearTimeout(iface.waitTimer); iface.waitTimer = null; }
        this.drElection(iface);
      }
    } else if (iface.networkType === 'broadcast' || iface.networkType === 'nbma') {
      // NbrChange: new neighbor or changed priority/DR/BDR declaration → re-run election
      const nbrChange = isNewNeighbor
        || prevPriority !== hello.priority
        || prevDR !== hello.designatedRouter
        || prevBDR !== hello.backupDesignatedRouter;
      if (nbrChange) {
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
      ddRetransmitTimer: null,
      lsrRetransmitTimer: null,
      lastSentDD: null,
    };
  }

  // ─── Neighbor State Machine (RFC 2328 §10.1) ──────────────────

  neighborEvent(iface: OSPFInterface, neighbor: OSPFNeighbor, event: OSPFNeighborEvent): void {
    const oldState = neighbor.state;

    switch (event) {
      // RFC 2328 §10.3: Start event — used for NBMA networks (Attempt state)
      case 'Start':
        if (neighbor.state === 'Down') {
          neighbor.state = 'Attempt';
          // On NBMA, send a Hello directly to the configured neighbor
          this.sendHelloTo(iface, neighbor.ipAddress);
        }
        break;

      case 'HelloReceived':
        this.resetDeadTimer(iface, neighbor);
        if (neighbor.state === 'Down' || neighbor.state === 'Attempt') {
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
          // Cancel DD retransmission timer — negotiation complete
          this.cancelDDRetransmitTimer(neighbor);
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
          // Cancel LSR retransmission timer — loading complete
          this.cancelLSRRetransmitTimer(neighbor);
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
            this.cancelDDRetransmitTimer(neighbor);
            this.cancelLSRRetransmitTimer(neighbor);
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
          this.cancelDDRetransmitTimer(neighbor);
          this.cancelLSRRetransmitTimer(neighbor);
          neighbor.state = 'ExStart';
          neighbor.lsRequestList = [];
          neighbor.lsRetransmissionList = [];
          neighbor.dbSummaryList = [];
          this.startDDExchange(iface, neighbor);
        }
        break;

      case 'OneWay':
        if (neighbor.state !== 'Down' && neighbor.state !== 'Init') {
          this.cancelDDRetransmitTimer(neighbor);
          this.cancelLSRRetransmitTimer(neighbor);
          neighbor.state = 'Init';
          neighbor.lsRequestList = [];
          neighbor.lsRetransmissionList = [];
          neighbor.dbSummaryList = [];
        }
        break;

      case 'KillNbr':
      case 'LLDown':
        this.clearDeadTimer(neighbor);
        this.cancelDDRetransmitTimer(neighbor);
        this.cancelLSRRetransmitTimer(neighbor);
        neighbor.state = 'Down';
        neighbor.lsRequestList = [];
        neighbor.lsRetransmissionList = [];
        neighbor.dbSummaryList = [];
        break;

      case 'InactivityTimer':
        this.clearDeadTimer(neighbor);
        this.cancelDDRetransmitTimer(neighbor);
        this.cancelLSRRetransmitTimer(neighbor);
        neighbor.state = 'Down';
        neighbor.lsRequestList = [];
        neighbor.lsRetransmissionList = [];
        neighbor.dbSummaryList = [];
        // Remove from interface neighbors
        iface.neighbors.delete(neighbor.routerId);
        // Re-run DR election on broadcast/NBMA when a neighbor departs (RFC 2328 §9.4 NbrChange)
        if ((iface.networkType === 'broadcast' || iface.networkType === 'nbma') &&
            iface.state !== 'Waiting') {
          this.drElection(iface);
        }
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

  /**
   * Called when a neighbor adjacency reaches Full state (RFC 2328 §10.4).
   * Triggers Router-LSA re-origination and schedules SPF.
   */
  private onAdjacencyFull(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    const msg = `OSPF: Adjacency with ${neighbor.routerId} (${iface.name}) is now Full`;
    this.eventLog.push(msg);
    // Router-LSA and SPF are triggered in neighborEvent via the state change check
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
   * Start DD retransmission timer (RFC 2328 §10.6).
   * Resends the last DD packet if no response within RxmtInterval.
   */
  private startDDRetransmitTimer(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    this.cancelDDRetransmitTimer(neighbor);
    neighbor.ddRetransmitTimer = setTimeout(() => {
      neighbor.ddRetransmitTimer = null;
      if (neighbor.state === 'ExStart' && neighbor.lastSentDD) {
        // Retransmit the last DD packet
        this.sendCallback?.(iface.name, neighbor.lastSentDD, neighbor.ipAddress);
        this.startDDRetransmitTimer(iface, neighbor);
      }
    }, iface.retransmitInterval * 1000);
  }

  private cancelDDRetransmitTimer(neighbor: OSPFNeighbor): void {
    if (neighbor.ddRetransmitTimer) {
      clearTimeout(neighbor.ddRetransmitTimer);
      neighbor.ddRetransmitTimer = null;
    }
  }

  /**
   * Start LSR retransmission timer (RFC 2328 §10.9).
   * Resends the LS Request if no LSU response within RxmtInterval.
   */
  private startLSRRetransmitTimer(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    this.cancelLSRRetransmitTimer(neighbor);
    neighbor.lsrRetransmitTimer = setTimeout(() => {
      neighbor.lsrRetransmitTimer = null;
      if (neighbor.state === 'Loading' && neighbor.lsRequestList.length > 0) {
        this.sendLSRequest(iface, neighbor);
      }
    }, iface.retransmitInterval * 1000);
  }

  private cancelLSRRetransmitTimer(neighbor: OSPFNeighbor): void {
    if (neighbor.lsrRetransmitTimer) {
      clearTimeout(neighbor.lsrRetransmitTimer);
      neighbor.lsrRetransmitTimer = null;
    }
  }

  /**
   * Send a Hello directly to a specific IP (for NBMA Attempt state).
   * RFC 2328 §9.5
   */
  private sendHelloTo(iface: OSPFInterface, destIP: string): void {
    if (!this.sendCallback) return;
    const hello: OSPFHelloPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 1,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      networkMask: iface.mask,
      helloInterval: iface.helloInterval,
      options: 0x02,
      priority: iface.priority,
      deadInterval: iface.deadInterval,
      designatedRouter: iface.dr,
      backupDesignatedRouter: iface.bdr,
      neighbors: Array.from(iface.neighbors.keys()),
    };
    this.sendCallback(iface.name, hello, destIP);
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

    const sortCandidates = (pool: typeof candidates) =>
      pool.sort((a, b) => b.priority - a.priority || b.routerId.localeCompare(a.routerId));

    // Step 1: Elect BDR (candidates not declaring themselves as DR)
    const bdrCandidates = candidates.filter(c => c.declaredDR !== c.ipAddress);
    // Among BDR candidates: prefer those declaring themselves BDR, then highest priority, then highest Router ID
    const bdrDeclaring = bdrCandidates.filter(c => c.declaredBDR === c.ipAddress);
    const bdrPool = bdrDeclaring.length > 0 ? bdrDeclaring : bdrCandidates;
    let bdr = bdrPool.length > 0 ? sortCandidates(bdrPool)[0] : null;

    // Step 2: Elect DR (candidates declaring themselves as DR)
    const drDeclaring = candidates.filter(c => c.declaredDR === c.ipAddress);
    const dr = drDeclaring.length > 0 ? sortCandidates(drDeclaring)[0] : bdr;

    // Step 3 (RFC 2328 §9.4 second pass): if BDR was promoted to DR (dr === bdr),
    // re-elect BDR from remaining candidates excluding the new DR.
    if (dr && bdr && dr.routerId === bdr.routerId) {
      const newDRIp = dr.ipAddress;
      const bdrCandidates2 = candidates.filter(c => c.ipAddress !== newDRIp && c.declaredDR !== c.ipAddress);
      const bdrDeclaring2 = bdrCandidates2.filter(c => c.declaredBDR === c.ipAddress);
      const bdrPool2 = bdrDeclaring2.length > 0 ? bdrDeclaring2 : bdrCandidates2;
      bdr = bdrPool2.length > 0 ? sortCandidates(bdrPool2)[0] : null;
    }

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
    // Higher Router ID becomes Master (RFC 2328 §10.6)
    neighbor.isMaster = this.config.routerId > neighbor.routerId;

    // Build DB summary list from our LSDB
    neighbor.dbSummaryList = this.getLSDBHeaders(iface.areaId);

    // Send initial DD with I (Init), M (More), MS (Master if applicable) flags
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

    // Store for potential retransmission (RFC 2328 §10.6)
    neighbor.lastSentDD = dd;
    this.sendCallback?.(iface.name, dd, neighbor.ipAddress);

    // Start retransmission timer in case no response arrives
    this.startDDRetransmitTimer(iface, neighbor);
  }

  /**
   * Process incoming Database Description packet (RFC 2328 §10.6).
   */
  processDD(ifaceName: string, srcIP: string, dd: OSPFDDPacket): void {
    const iface = this.interfaces.get(ifaceName);
    if (!iface) return;

    const neighbor = iface.neighbors.get(dd.routerId);
    if (!neighbor) return;

    if (neighbor.state === 'ExStart') {
      // Negotiation phase: determine Master/Slave
      const isInit = (dd.flags & DD_FLAG_INIT) !== 0;
      const isMaster = (dd.flags & DD_FLAG_MASTER) !== 0;

      if (isInit && isMaster && dd.routerId > this.config.routerId) {
        // Remote is Master (higher RID) — we become Slave
        neighbor.isMaster = false;
        neighbor.ddSeqNumber = dd.ddSequenceNumber;
        // NegotiationDone transitions to Exchange and calls sendDDWithSummary
        this.neighborEvent(iface, neighbor, 'NegotiationDone');
        // After transitioning to Exchange, check if slave has no more headers
        // and master also sent !MORE — fire ExchangeDone if applicable
        if (neighbor.state === 'Exchange' && neighbor.dbSummaryList.length === 0 && !(dd.flags & DD_FLAG_MORE)) {
          // We (slave) have no more to send and master also done: exchange complete
          this.neighborEvent(iface, neighbor, 'ExchangeDone');
        }
      } else if (!isInit && !isMaster && dd.ddSequenceNumber === neighbor.ddSeqNumber) {
        // Remote is Slave acknowledging our sequence number — we are Master
        // Process any LSA headers the Slave included in this first Exchange DD
        for (const header of dd.lsaHeaders) {
          const existing = this.lookupLSA(iface.areaId, header.lsType, header.linkStateId, header.advertisingRouter);
          if (!existing || header.lsSequenceNumber > existing.lsSequenceNumber) {
            neighbor.lsRequestList.push(header);
          }
        }
        neighbor.isMaster = true;
        // NegotiationDone transitions to Exchange and calls sendDDWithSummary
        this.neighborEvent(iface, neighbor, 'NegotiationDone');
        // If Slave sent !MORE (all their headers in one shot) AND we (Master) have no more,
        // then exchange is complete from both sides
        if (neighbor.state === 'Exchange' && neighbor.dbSummaryList.length === 0 && !(dd.flags & DD_FLAG_MORE)) {
          this.neighborEvent(iface, neighbor, 'ExchangeDone');
        }
      }
    } else if (neighbor.state === 'Exchange') {
      // Process LSA headers from the DD
      for (const header of dd.lsaHeaders) {
        const existing = this.lookupLSA(iface.areaId, header.lsType, header.linkStateId, header.advertisingRouter);
        if (!existing || header.lsSequenceNumber > existing.lsSequenceNumber) {
          neighbor.lsRequestList.push(header);
        }
      }

      // Check if exchange is done (no More flag from remote, and we've sent all ours)
      if (!(dd.flags & DD_FLAG_MORE) && neighbor.dbSummaryList.length === 0) {
        this.neighborEvent(iface, neighbor, 'ExchangeDone');
      }
    }
  }

  private sendDDWithSummary(iface: OSPFInterface, neighbor: OSPFNeighbor): void {
    // RFC 2328 §10.6: each DD packet must fit within the interface MTU.
    // DD packet overhead = 24 (OSPF header) + 8 (DD fields) = 32 bytes.
    // Each LSA summary header = 20 bytes.
    const maxHeaders = Math.max(1, Math.floor((iface.mtu - 32) / 20));
    const headers = neighbor.dbSummaryList.splice(0, maxHeaders);
    const hasMore = neighbor.dbSummaryList.length > 0;

    const flags = (hasMore ? DD_FLAG_MORE : 0) | (neighbor.isMaster ? DD_FLAG_MASTER : 0);

    const dd: OSPFDDPacket = {
      type: 'ospf',
      version: OSPF_VERSION_2,
      packetType: 2,
      routerId: this.config.routerId,
      areaId: iface.areaId,
      interfaceMTU: iface.mtu,
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

    // RFC 2328 §10.9: LS Request packet overhead = 24 (OSPF header) bytes.
    // Each request entry = 12 bytes (lsType 4 + linkStateId 4 + advertisingRouter 4).
    const maxRequests = Math.max(1, Math.floor((iface.mtu - 24) / 12));
    const requests = neighbor.lsRequestList.slice(0, maxRequests).map(h => ({
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

    // Start retransmission timer for LSR (RFC 2328 §10.9)
    this.startLSRRetransmitTimer(iface, neighbor);
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

    if (lsas.length === 0) return;

    // RFC 2328 §13.2: fragment the LS Update to stay within interface MTU.
    // LSU overhead = 24 (OSPF header) + 4 (numLSAs field) = 28 bytes.
    // Each LSA's wire size is given by lsa.length (defaulting to 24 for a
    // minimal Router-LSA with zero links).
    const lsuOverhead = 28;
    let batch: LSA[] = [];
    let batchBytes = lsuOverhead;

    const flushBatch = () => {
      if (batch.length === 0) return;
      const lsu: OSPFLSUpdatePacket = {
        type: 'ospf',
        version: OSPF_VERSION_2,
        packetType: 4,
        routerId: this.config.routerId,
        areaId: iface.areaId,
        numLSAs: batch.length,
        lsas: batch,
      };
      this.sendCallback?.(iface.name, lsu, srcIP);
      batch = [];
      batchBytes = lsuOverhead;
    };

    for (const lsa of lsas) {
      const lsaSize = lsa.length ?? 24;
      if (batch.length > 0 && batchBytes + lsaSize > iface.mtu) {
        flushBatch();
      }
      batch.push(lsa);
      batchBytes += lsaSize;
    }
    flushBatch();
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

      // Validate checksum (RFC 2328 §13 step 1) — drop silently if invalid
      if (!verifyOSPFLSAChecksum(lsa)) continue;

      // Skip if LSA is MaxAge and not in DB
      if (lsa.lsAge >= OSPF_MAX_AGE) {
        if (areaDB && !areaDB.has(key)) continue;
      }

      const existing = this.lookupLSA(iface.areaId, lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);

      if (!existing || this.isNewerLSA(lsa, existing)) {
        // MinLSArrival (RFC 2328 §13.1): do not install an LSA instance if the same
        // LSA (same type/linkStateId/advertisingRouter) was installed less than
        // MinLSArrival seconds ago. This prevents flooding storms.
        const arrKey = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);
        const now = Date.now();
        if (this.lsArrivalTimes.has(arrKey)) {
          const lastArrival = this.lsArrivalTimes.get(arrKey)!;
          if (now - lastArrival < OSPF_MIN_LS_ARRIVAL * 1000) {
            continue; // Drop — arrived too quickly (MinLSArrival)
          }
        }
        this.lsArrivalTimes.set(arrKey, now);

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

    // Check if loading is done (RFC 2328 §10.9)
    if (neighbor.state === 'Loading' && neighbor.lsRequestList.length === 0) {
      this.neighborEvent(iface, neighbor, 'LoadingDone');
    } else if (neighbor.state === 'Loading' && neighbor.lsRequestList.length > 0) {
      // More LSAs still needed — send the next batch of LSRs immediately
      // (enables synchronous completion across MTU-fragmented exchanges)
      this.sendLSRequest(iface, neighbor);
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
    // Always (re-)compute the checksum so that locally originated LSAs and
    // test fixtures with arbitrary placeholder values (e.g. 0x1234) carry a
    // valid Fletcher-16 before they are stored or forwarded.
    lsa.checksum = computeOSPFLSAChecksum(lsa);

    const key = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);

    if (lsa.lsType === 5) {
      this.lsdb.external.set(key, lsa as ExternalLSA);
    } else if (lsa.lsType === 7) {
      // Type 7 (NSSA External) is area-scoped — stored in area LSDB
      let areaDB = this.lsdb.areas.get(areaId);
      if (!areaDB) {
        areaDB = new Map();
        this.lsdb.areas.set(areaId, areaDB);
      }
      areaDB.set(key, lsa);

      // ABR auto-translation: if we are an ABR connected to backbone, translate Type 7 → Type 5
      const area = this.config.areas.get(areaId);
      if (area?.type === 'nssa' && this.isABR() && lsa.advertisingRouter !== this.config.routerId) {
        this.translateNSSAtoExternal(lsa as NSSAExternalLSA);
      }
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
        } else if (iface.state === 'Waiting' || iface.state === 'Loopback') {
          // Waiting state (no neighbors yet) or Loopback: advertise as stub
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

  // ─── ABR / ASBR Detection ──────────────────────────────────────

  /**
   * Returns true if this router has interfaces in more than one area (ABR).
   * RFC 2328 §1.2: A router attached to multiple areas is called an ABR.
   */
  isABR(): boolean {
    const areas = new Set<string>();
    for (const [, iface] of this.interfaces) {
      areas.add(iface.areaId);
    }
    return areas.size > 1;
  }

  /**
   * Returns true if redistribution is configured (ASBR).
   * RFC 2328 §1.2: An ASBR imports routes from other protocols.
   */
  isASBR(): boolean {
    return this.config.redistributeConnected ||
           this.config.redistributeStatic ||
           this.config.defaultInformationOriginate;
  }

  /**
   * Configure connected route redistribution.
   */
  setRedistributeConnected(enable: boolean): void {
    this.config.redistributeConnected = enable;
  }

  /**
   * Configure static route redistribution.
   */
  setRedistributeStatic(enable: boolean): void {
    this.config.redistributeStatic = enable;
  }

  // ─── Type 3 Summary LSA (RFC 2328 §12.4.3) ────────────────────

  /**
   * Originate a Summary-LSA (Type 3) for an IP network into the given area.
   * Called by ABR to advertise intra-area routes from one area into another.
   * RFC 2328 §12.4.3
   */
  originateSummaryLSA(intoAreaId: string, network: string, mask: string, metric: number): SummaryLSA {
    const lsa: SummaryLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 3,
      linkStateId: network,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      // 20-byte header + 4 (networkMask) + 4 (TOS count 1B pad + 3B metric) = 28
      length: 28,
      networkMask: mask,
      metric,
    };
    lsa.checksum = this.computeLSAChecksum(lsa);
    this.installLSA(intoAreaId, lsa);
    this.floodLSA(intoAreaId, lsa, null);
    return lsa;
  }

  // ─── Type 4 Summary ASBR LSA (RFC 2328 §12.4.4) ───────────────

  /**
   * Originate a Summary-LSA (Type 4) advertising an ASBR into the given area.
   * Called by ABR when it knows of an ASBR in an adjacent area.
   * RFC 2328 §12.4.4: Link State ID = ASBR Router ID, networkMask = 0.0.0.0.
   */
  originateASBRSummaryLSA(intoAreaId: string, asbrRouterId: string, metric: number): ASBRSummaryLSA {
    const lsa: ASBRSummaryLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 4,
      linkStateId: asbrRouterId,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      length: 28,
      networkMask: '0.0.0.0',
      metric,
    };
    lsa.checksum = this.computeLSAChecksum(lsa);
    this.installLSA(intoAreaId, lsa);
    this.floodLSA(intoAreaId, lsa, null);
    return lsa;
  }

  // ─── Type 7 NSSA External LSA (RFC 3101) ───────────────────────

  /**
   * Originate an NSSA-External-LSA (Type 7) for an external route.
   * Only originated by ASBRs in NSSA areas.
   * RFC 3101 §2.4
   */
  originateNSSAExternalLSA(
    areaId: string,
    network: string,
    mask: string,
    metric: number,
    metricType: 1 | 2 = 2,
    forwardingAddress: string = '0.0.0.0',
  ): NSSAExternalLSA {
    const lsa: NSSAExternalLSA = {
      lsAge: 0,
      // N-bit (0x08) set to indicate NSSA LSA; E-bit also set
      options: 0x08 | 0x02,
      lsType: 7,
      linkStateId: network,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      // Same structure as Type 5: 20-byte header + 16 bytes body = 36
      length: 36,
      networkMask: mask,
      metricType,
      metric,
      forwardingAddress,
      externalRouteTag: 0,
    };
    lsa.checksum = this.computeLSAChecksum(lsa);
    this.installLSA(areaId, lsa);
    this.floodLSA(areaId, lsa, null);
    return lsa;
  }

  /**
   * Translate an NSSA-External-LSA (Type 7) into an AS-External-LSA (Type 5).
   * Called by the ABR with the highest Router ID when it receives a Type 7.
   * RFC 3101 §3.2: The ABR becomes the advertising router of the Type 5.
   */
  translateNSSAtoExternal(nssaLsa: NSSAExternalLSA): ExternalLSA {
    const lsa: ExternalLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 5,
      linkStateId: nssaLsa.linkStateId,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      length: 36,
      networkMask: nssaLsa.networkMask,
      metricType: nssaLsa.metricType,
      metric: nssaLsa.metric,
      forwardingAddress: nssaLsa.forwardingAddress,
      externalRouteTag: nssaLsa.externalRouteTag,
    };
    lsa.checksum = this.computeLSAChecksum(lsa);
    // Type 5 goes directly into external LSDB and is flooded everywhere
    this.lsdb.external.set(makeLSDBKey(5, lsa.linkStateId, lsa.advertisingRouter), lsa);
    this.floodLSA(OSPF_BACKBONE_AREA, lsa, null);
    return lsa;
  }

  /**
   * Originate an AS-External-LSA (Type 5) for a redistributed route.
   * Type 5 LSAs are AS-wide and stored in the external LSDB.
   * RFC 2328 §12.4.5
   */
  originateExternalLSA(
    network: string,
    mask: string,
    metric: number,
    metricType: 1 | 2 = 2,
    forwardingAddress: string = '0.0.0.0',
  ): ExternalLSA {
    const lsa: ExternalLSA = {
      lsAge: 0,
      options: 0x02,
      lsType: 5,
      linkStateId: network,
      advertisingRouter: this.config.routerId,
      lsSequenceNumber: this.nextSeqNumber(),
      checksum: 0,
      length: 36,
      networkMask: mask,
      metricType,
      metric,
      forwardingAddress,
      externalRouteTag: 0,
    };
    lsa.checksum = this.computeLSAChecksum(lsa);
    this.installLSA(OSPF_BACKBONE_AREA, lsa);
    this.floodLSA(OSPF_BACKBONE_AREA, lsa, null);
    return lsa;
  }

  /**
   * Redistribute an external route into OSPF.
   * Automatically chooses Type 7 for NSSA areas and Type 5 for normal/backbone areas.
   * Cisco equivalent: `redistribute <protocol>` on an ASBR.
   * RFC 3101 §2.4, RFC 2328 §12.4.5
   */
  redistributeExternalRoute(
    network: string,
    mask: string,
    metric: number,
    metricType: 1 | 2 = 2,
    forwardingAddress: string = '0.0.0.0',
  ): void {
    // Collect all areas this router has interfaces in
    const usedAreaIds = new Set<string>();
    for (const [, iface] of this.interfaces) {
      usedAreaIds.add(iface.areaId);
    }

    let generatedType5 = false;
    for (const areaId of usedAreaIds) {
      const area = this.config.areas.get(areaId);
      if (area?.type === 'nssa') {
        // NSSA area: originate Type 7 (area-scoped)
        this.originateNSSAExternalLSA(areaId, network, mask, metric, metricType, forwardingAddress);
      } else if (!generatedType5) {
        // Normal/backbone: originate Type 5 once (AS-wide)
        this.originateExternalLSA(network, mask, metric, metricType, forwardingAddress);
        generatedType5 = true;
      }
    }
    // Fallback: no interfaces configured yet — originate Type 5
    if (!generatedType5 && usedAreaIds.size === 0) {
      this.originateExternalLSA(network, mask, metric, metricType, forwardingAddress);
    }
  }

  // ─── LSA Flooding (RFC 2328 §13.3) ─────────────────────────────

  private floodLSA(areaId: string, lsa: LSA, excludeIface: string | null, force = false): void {
    const isSelfOriginated = lsa.advertisingRouter === this.config.routerId;

    // MinLSInterval (RFC 2328 §12.4): self-originated LSAs must not be re-flooded
    // more than once every MinLSInterval seconds.
    // We only record (and check) the last flood time when we actually sent to at
    // least one neighbor — if there are no Full neighbors, the "flood" is a no-op
    // and we do not start the rate-limiting clock.
    if (!force && isSelfOriginated) {
      const key = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);
      if (this.lastFloodTime.has(key)) {
        const lastTime = this.lastFloodTime.get(key)!;
        if (Date.now() - lastTime < OSPF_MIN_LS_INTERVAL * 1000) {
          return; // MinLSInterval not yet elapsed — suppress redundant flood
        }
      }
    }

    let sentToAny = false;
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
          sentToAny = true;
        }
      }
    }

    // Record the flood time only when we actually reached at least one neighbor.
    // This way, calling floodLSA with no neighbors does not start the MinLSInterval
    // clock — the first real flood (with neighbors present) is never suppressed.
    if (isSelfOriginated && sentToAny) {
      const key = makeLSDBKey(lsa.lsType, lsa.linkStateId, lsa.advertisingRouter);
      this.lastFloodTime.set(key, Date.now());
    }
  }

  // ─── SPF Calculation (Dijkstra - RFC 2328 §16) ─────────────────

  scheduleSPF(): void {
    if (this.spfPending) return;
    this.spfPending = true;

    // Exponential back-off (RFC 2328 §16.5 / Cisco 'timers throttle spf'):
    //   - First SPF after a quiet period → use initial delay, reset hold counter
    //   - Rapid re-schedules                → use current hold, double it for next time
    const now = Date.now();
    const timeSinceLastRun = now - this.spfLastRunAt;

    let delay: number;
    if (this.spfLastRunAt === 0 || timeSinceLastRun > this.spfThrottleMax) {
      // First run ever, or quiet period elapsed → reset and use initial delay
      delay = this.spfThrottleInitial;
      this.spfCurrentHold = this.spfThrottleHold;
    } else {
      // Rapid topology change → use current hold, then double it (capped at max)
      delay = this.spfCurrentHold;
      this.spfCurrentHold = Math.min(this.spfCurrentHold * 2, this.spfThrottleMax);
    }

    if (this.spfTimer) clearTimeout(this.spfTimer);
    this.spfTimer = setTimeout(() => {
      this.spfPending = false;
      this.spfTimer = null;
      this.spfLastRunAt = Date.now();
      this.runSPF();
    }, delay);
  }

  /**
   * Configure SPF throttle timers (Cisco: 'timers throttle spf <initial> <hold> <max>').
   * RFC 2328 §16.5: prevents SPF thrashing on rapid topology changes.
   * @param initial  Initial delay before first SPF (ms)
   * @param hold     Base hold interval; doubles on each rapid re-schedule (ms)
   * @param max      Maximum hold interval (ms)
   */
  setThrottleSPF(initial: number, hold: number, max: number): void {
    this.spfThrottleInitial = initial;
    this.spfThrottleHold = hold;
    this.spfThrottleMax = max;
    this.spfCurrentHold = hold;
  }

  getThrottleSPFConfig(): { initial: number; hold: number; max: number } {
    return {
      initial: this.spfThrottleInitial,
      hold: this.spfThrottleHold,
      max: this.spfThrottleMax,
    };
  }

  /**
   * Run Dijkstra's SPF algorithm on the LSDB.
   * RFC 2328 §16.1
   * If this router is an ABR, also originates Type 3/4 Summary LSAs.
   */
  runSPF(): OSPFRouteEntry[] {
    this.ospfRoutes = [];

    // Step 1: Compute intra-area routes for each area
    const intraAreaRoutesByArea = new Map<string, OSPFRouteEntry[]>();
    for (const [areaId] of this.config.areas) {
      const areaRoutes = this.runSPFForArea(areaId);
      intraAreaRoutesByArea.set(areaId, areaRoutes);
      this.ospfRoutes.push(...areaRoutes);
    }

    // Step 2: If ABR, originate Type 3 Summary LSAs for intra-area routes
    //         into other areas, and Type 4 for any ASBRs found
    if (this.isABR()) {
      this.originateSummariesAsABR(intraAreaRoutesByArea);
    }

    return this.ospfRoutes;
  }

  /**
   * ABR summary origination (RFC 2328 §12.4.3 / §12.4.4).
   * For each intra-area route in area A, originate a Type 3 LSA into every
   * other area B connected to this ABR.
   * For each ASBR (Router-LSA with E-bit) found in an area, originate a
   * Type 4 LSA into every other area.
   */
  /**
   * Originate Type 3 / Type 4 Summary LSAs for each intra-area route into all
   * other areas (RFC 2328 §12.4.3).  Handles:
   *  - Totally-stubby and Totally-NSSA areas (skip Type 3; inject Type 3 default)
   *  - NSSA default-information-originate (inject Type 7 default)
   *  - Area ranges (aggregate + suppress individual routes)
   *
   * Exposed as public so unit tests can drive it with hand-crafted route maps
   * without running full SPF.
   */
  originateSummariesAsABR(intraAreaRoutesByArea: Map<string, OSPFRouteEntry[]>): void {
    const myAreas = Array.from(this.config.areas.keys());
    const nssaDefaultsDone = new Set<string>(); // avoid duplicate default per target area

    for (const sourceAreaId of myAreas) {
      const routes = intraAreaRoutesByArea.get(sourceAreaId) ?? [];
      const intraRoutes = routes.filter(r => r.routeType === 'intra-area' && r.network !== '0.0.0.0');

      for (const targetAreaId of myAreas) {
        if (targetAreaId === sourceAreaId) continue;

        const targetArea = this.config.areas.get(targetAreaId);

        // Skip Type 3 into totally-stubby areas
        if (targetArea?.type === 'totally-stubby') continue;

        // Skip Type 3 into Totally NSSA areas (will inject default below)
        if (targetArea?.type === 'nssa' && targetArea.nssaNoSummary) continue;

        // Apply area ranges from the source area
        const { individual, aggregates } = this.applyAreaRanges(sourceAreaId, intraRoutes);

        for (const route of individual) {
          this.originateSummaryLSA(targetAreaId, route.network, route.mask, route.cost);
        }
        for (const [, agg] of aggregates) {
          if (agg.advertise) {
            this.originateSummaryLSA(targetAreaId, agg.network, agg.mask, agg.metric);
          }
        }

        // Type 4 ASBR summaries — do not flood into NSSA (RFC 3101 §3.4)
        if (targetArea?.type !== 'nssa') {
          const sourceDB = this.lsdb.areas.get(sourceAreaId);
          if (sourceDB) {
            for (const [, lsa] of sourceDB) {
              if (lsa.lsType !== 1) continue;
              const rLsa = lsa as RouterLSA;
              if ((rLsa.flags & 0x02) === 0) continue; // E-bit not set
              if (rLsa.advertisingRouter === this.config.routerId) continue;
              const asbrVertex = routes.find(rt => rt.advertisingRouter === rLsa.advertisingRouter);
              const metric = asbrVertex ? asbrVertex.cost : 1;
              this.originateASBRSummaryLSA(targetAreaId, rLsa.advertisingRouter, metric);
            }
          }
        }
      }
    }

    // Post-pass: NSSA-specific defaults (once per target area)
    for (const [areaId, area] of this.config.areas) {
      if (area.type !== 'nssa') continue;
      if (nssaDefaultsDone.has(areaId)) continue;
      nssaDefaultsDone.add(areaId);

      // Totally NSSA: inject Type 3 default (0.0.0.0/0) into the area
      if (area.nssaNoSummary) {
        this.originateSummaryLSA(areaId, '0.0.0.0', '0.0.0.0', 1);
      }

      // nssa default-information-originate: inject Type 7 default
      if (area.nssaDefaultInfoOriginate) {
        this.originateNSSAExternalLSA(areaId, '0.0.0.0', '0.0.0.0', 1);
      }
    }
  }

  // ─── Area Range helpers ─────────────────────────────────────────

  /**
   * Apply area ranges to a list of routes from a given area.
   * Returns individual routes (not covered by any range) and aggregate entries
   * (one per matching range, with metric = max covered route cost).
   */
  private applyAreaRanges(
    areaId: string,
    routes: OSPFRouteEntry[],
  ): {
    individual: OSPFRouteEntry[];
    aggregates: Map<string, { network: string; mask: string; metric: number; advertise: boolean }>;
  } {
    const area = this.config.areas.get(areaId);
    const ranges = area?.ranges ?? [];

    if (ranges.length === 0) {
      return { individual: [...routes], aggregates: new Map() };
    }

    const aggregates = new Map<string, { network: string; mask: string; metric: number; advertise: boolean }>();
    const individual: OSPFRouteEntry[] = [];

    for (const route of routes) {
      const match = ranges.find(r => this.routeInRange(route.network, route.mask, r.network, r.mask));
      if (match) {
        const key = `${match.network}:${match.mask}`;
        const existing = aggregates.get(key);
        if (!existing) {
          aggregates.set(key, { network: match.network, mask: match.mask, metric: route.cost, advertise: match.advertise });
        } else if (route.cost > existing.metric) {
          existing.metric = route.cost;
        }
        // Individual route is suppressed (omitted from `individual`)
      } else {
        individual.push(route);
      }
    }

    return { individual, aggregates };
  }

  /**
   * Returns true when routeNet/routeMask is a subnet of (or equal to) rangeNet/rangeMask.
   * The range mask must be at least as general (shorter prefix) as the route mask.
   */
  private routeInRange(
    routeNet: string, routeMask: string,
    rangeNet: string, rangeMask: string,
  ): boolean {
    const rMask    = this.ipToNum(rangeMask);
    // Use >>> 0 after each & to stay in unsigned territory for comparison
    const rNet     = (this.ipToNum(rangeNet)  & rMask) >>> 0;
    const route    = (this.ipToNum(routeNet)  & rMask) >>> 0;
    const rMaskNum = this.ipToNum(routeMask);
    // The range mask must be at least as long (more specific) as the range mask
    return route === rNet && ((rMaskNum & rMask) >>> 0) === rMask;
  }

  private ipToNum(ip: string): number {
    return ip.split('.').reduce((acc: number, oct: string) => (acc << 8) | parseInt(oct, 10), 0) >>> 0;
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

    // Extract intra-area routes from SPF tree
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

    // Step 2: Process Type 3 Summary LSAs → inter-area routes (RFC 2328 §16.2)
    for (const [, lsa] of areaDB) {
      if (lsa.lsType !== 3) continue;
      const sumLsa = lsa as SummaryLSA;
      if (sumLsa.lsAge >= OSPF_MAX_AGE) continue;
      if (sumLsa.metric >= OSPF_INFINITY_METRIC) continue;
      if (sumLsa.advertisingRouter === this.config.routerId) continue; // own LSA

      // The advertising router must be an ABR reachable from us in the SPF tree
      const abrVertex = tree.get(sumLsa.advertisingRouter);
      if (!abrVertex) continue;

      const totalCost = abrVertex.distance + sumLsa.metric;
      if (totalCost >= OSPF_INFINITY_METRIC) continue;

      const nextHop = abrVertex.nextHop || abrVertex.id;
      const outIface = abrVertex.outInterface || this.findIfaceForNextHop(nextHop);
      if (!outIface) continue;

      routes.push({
        network: sumLsa.linkStateId,
        mask: sumLsa.networkMask,
        routeType: 'inter-area',
        areaId,
        nextHop,
        iface: outIface,
        cost: totalCost,
        advertisingRouter: sumLsa.advertisingRouter,
      });
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

  // ─── LSA Aging (RFC 2328 §14) ──────────────────────────────────

  /**
   * Start the 1-second LSA aging timer.
   * Each tick increments every LSA's lsAge by 1.
   * LSAs reaching MaxAge (3600s) are purged; own LSAs reaching LS_REFRESH_TIME
   * (1800s) are re-originated (seq bumped, age reset).
   */
  startLSAgeTimer(): void {
    if (this.lsAgeTimer) return;
    this.lsAgeTimer = setInterval(() => this.tickLSAge(), 1_000);
  }

  /** Stop the LSA aging timer. */
  stopLSAgeTimer(): void {
    if (this.lsAgeTimer) {
      clearInterval(this.lsAgeTimer);
      this.lsAgeTimer = null;
    }
  }

  /**
   * One aging tick: increment every LSA's lsAge by 1 second.
   *   - If age >= MaxAge (3600): purge from LSDB and trigger SPF.
   *   - If age == LS_REFRESH_TIME (1800) and we are the originator: refresh the
   *     LSA (bump seq, reset age to 0, reflood — bypassing MinLSInterval).
   *
   * Can be called directly in tests instead of relying on setInterval.
   */
  tickLSAge(): void {
    let changed = false;

    for (const [areaId, areaDB] of this.lsdb.areas) {
      const toDelete: string[] = [];
      for (const [key, lsa] of areaDB) {
        lsa.lsAge += 1;
        if (lsa.lsAge >= OSPF_MAX_AGE) {
          toDelete.push(key);
          this.lsArrivalTimes.delete(key);
          changed = true;
        } else if (
          lsa.advertisingRouter === this.config.routerId &&
          lsa.lsAge === OSPF_LS_REFRESH_TIME
        ) {
          this.refreshOwnLSA(areaId, lsa);
        }
      }
      for (const key of toDelete) {
        areaDB.delete(key);
      }
    }

    // Age external LSAs
    const toDeleteExt: string[] = [];
    for (const [key, lsa] of this.lsdb.external) {
      lsa.lsAge += 1;
      if (lsa.lsAge >= OSPF_MAX_AGE) {
        toDeleteExt.push(key);
        this.lsArrivalTimes.delete(key);
        changed = true;
      } else if (
        lsa.advertisingRouter === this.config.routerId &&
        lsa.lsAge === OSPF_LS_REFRESH_TIME
      ) {
        this.refreshOwnLSA(OSPF_BACKBONE_AREA, lsa);
      }
    }
    for (const key of toDeleteExt) {
      this.lsdb.external.delete(key);
    }

    if (changed) {
      this.scheduleSPF();
    }
  }

  /**
   * Refresh a self-originated LSA: bump the sequence number, reset age to 0,
   * recompute the checksum, and reflood (bypassing MinLSInterval since this
   * is a mandatory periodic refresh, not a topology-driven re-origination).
   */
  private refreshOwnLSA(areaId: string, lsa: LSA): void {
    lsa.lsAge = 0;
    lsa.lsSequenceNumber = this.nextSeqNumber();
    lsa.checksum = computeOSPFLSAChecksum(lsa);
    this.floodLSA(areaId, lsa, null, true); // force=true bypasses MinLSInterval
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  shutdown(): void {
    // Stop LSA aging timer
    this.stopLSAgeTimer();

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
    this.lastFloodTime.clear();
    this.lsArrivalTimes.clear();
    this.spfLastRunAt = 0;
    this.spfCurrentHold = this.spfThrottleHold;
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
