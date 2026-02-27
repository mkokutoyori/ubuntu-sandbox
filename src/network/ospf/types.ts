/**
 * OSPF Types - RFC 2328 (OSPFv2) and RFC 5340 (OSPFv3)
 *
 * Core data structures for OSPF protocol simulation:
 *   - Neighbor state machine (RFC 2328 §10.1)
 *   - LSA types and Link State Database
 *   - SPF (Dijkstra) algorithm data structures
 *   - Area configuration
 *   - Hello/DD/LSR/LSU/LSAck packet types
 *
 * OSPF operates directly over IP (protocol 89).
 * Multicast addresses:
 *   - 224.0.0.5 (AllSPFRouters) — all OSPF routers
 *   - 224.0.0.6 (AllDRouters) — DR and BDR only
 *   - ff02::5 (OSPFv3 AllSPFRouters)
 *   - ff02::6 (OSPFv3 AllDRouters)
 */

import { IPAddress, SubnetMask, IPv6Address } from '../core/types';

// ─── OSPF Constants ──────────────────────────────────────────────────

export const OSPF_PROTOCOL_NUMBER = 89;
export const OSPF_VERSION_2 = 2;
export const OSPF_VERSION_3 = 3;

/** Multicast addresses */
export const OSPF_ALL_SPF_ROUTERS = new IPAddress('224.0.0.5');
export const OSPF_ALL_DR_ROUTERS = new IPAddress('224.0.0.6');

/** Default timers (seconds) */
export const OSPF_DEFAULT_HELLO_INTERVAL = 10;
export const OSPF_DEFAULT_DEAD_INTERVAL = 40;
export const OSPF_DEFAULT_RETRANSMIT_INTERVAL = 5;
export const OSPF_DEFAULT_TRANSMIT_DELAY = 1;

/** LSA ages */
export const OSPF_MAX_AGE = 3600;      // 1 hour
export const OSPF_LS_REFRESH_TIME = 1800; // 30 minutes
export const OSPF_MIN_LS_INTERVAL = 5;
export const OSPF_MIN_LS_ARRIVAL = 1;

/** SPF scheduling */
export const OSPF_SPF_DELAY = 200;  // ms initial delay
export const OSPF_SPF_HOLD = 1000;  // ms hold interval

/** Administrative distances */
export const OSPF_AD_INTRA_AREA = 110;
export const OSPF_AD_INTER_AREA = 110;
export const OSPF_AD_EXTERNAL = 110;

/** Metric */
export const OSPF_DEFAULT_REFERENCE_BANDWIDTH = 100_000_000; // 100 Mbps (in bps)
export const OSPF_INFINITY_METRIC = 0xFFFF;

// ─── Area Types ──────────────────────────────────────────────────────

export type OSPFAreaType = 'normal' | 'stub' | 'totally-stubby' | 'nssa';

export interface OSPFArea {
  /** Area ID (e.g., "0.0.0.0" for backbone) */
  areaId: string;
  /** Area type */
  type: OSPFAreaType;
  /** Interfaces in this area */
  interfaces: string[];
  /** Is this the backbone area? */
  isBackbone: boolean;
}

export const OSPF_BACKBONE_AREA = '0.0.0.0';

// ─── Neighbor State Machine (RFC 2328 §10.1) ────────────────────────

export type OSPFNeighborState =
  | 'Down'
  | 'Attempt'
  | 'Init'
  | 'TwoWay'
  | 'ExStart'
  | 'Exchange'
  | 'Loading'
  | 'Full';

export type OSPFNeighborEvent =
  | 'HelloReceived'
  | 'Start'
  | 'TwoWayReceived'
  | 'NegotiationDone'
  | 'ExchangeDone'
  | 'BadLSReq'
  | 'LoadingDone'
  | 'AdjOK'
  | 'SeqNumberMismatch'
  | 'OneWay'
  | 'KillNbr'
  | 'InactivityTimer'
  | 'LLDown';

export interface OSPFNeighbor {
  /** Neighbor's Router ID */
  routerId: string;
  /** Neighbor's IP address (source of Hello) */
  ipAddress: string;
  /** Interface on which we see this neighbor */
  iface: string;
  /** Current state */
  state: OSPFNeighborState;
  /** Neighbor's priority */
  priority: number;
  /** Neighbor's Designated Router */
  neighborDR: string;
  /** Neighbor's Backup Designated Router */
  neighborBDR: string;
  /** Dead timer handle */
  deadTimer: ReturnType<typeof setTimeout> | null;
  /** DD sequence number */
  ddSeqNumber: number;
  /** Is this neighbor the master in DD exchange? */
  isMaster: boolean;
  /** Link State Request list (LSAs we need from this neighbor) */
  lsRequestList: LSAHeader[];
  /** Link State Retransmission list */
  lsRetransmissionList: LSA[];
  /** Database Description summary list */
  dbSummaryList: LSAHeader[];
  /** Timestamp of last hello received */
  lastHelloReceived: number;
  /** Options field from Hello */
  options: number;
  /** DD retransmission timer handle (RFC 2328 §10.6) */
  ddRetransmitTimer: ReturnType<typeof setTimeout> | null;
  /** LSR retransmission timer handle (RFC 2328 §10.9) */
  lsrRetransmitTimer: ReturnType<typeof setTimeout> | null;
  /** Last DD packet sent (for retransmission on timeout) */
  lastSentDD: OSPFDDPacket | null;
}

// ─── Interface State Machine (RFC 2328 §9.1) ────────────────────────

export type OSPFInterfaceState =
  | 'Down'
  | 'Loopback'
  | 'Waiting'
  | 'PointToPoint'
  | 'DROther'
  | 'Backup'
  | 'DR';

export type OSPFNetworkType =
  | 'broadcast'
  | 'point-to-point'
  | 'nbma'
  | 'point-to-multipoint';

export interface OSPFInterface {
  /** Interface name (e.g., GigabitEthernet0/0) */
  name: string;
  /** IP address of the interface */
  ipAddress: string;
  /** Subnet mask */
  mask: string;
  /** Area ID this interface belongs to */
  areaId: string;
  /** Current interface state */
  state: OSPFInterfaceState;
  /** Network type */
  networkType: OSPFNetworkType;
  /** Hello interval (seconds) */
  helloInterval: number;
  /** Dead interval (seconds) */
  deadInterval: number;
  /** Retransmit interval (seconds) */
  retransmitInterval: number;
  /** Transmit delay (seconds) */
  transmitDelay: number;
  /** Router priority (0 = never become DR) */
  priority: number;
  /** Designated Router IP address (or "0.0.0.0" if none) */
  dr: string;
  /** Backup Designated Router IP address (or "0.0.0.0" if none) */
  bdr: string;
  /** OSPF cost (metric) */
  cost: number;
  /** Hello timer handle */
  helloTimer: ReturnType<typeof setInterval> | null;
  /** Wait timer handle (for DR election) */
  waitTimer: ReturnType<typeof setTimeout> | null;
  /** Neighbors seen on this interface */
  neighbors: Map<string, OSPFNeighbor>;
  /** Is this interface passive (no hellos sent)? */
  passive: boolean;
  /** Authentication type: 0=none, 1=simple, 2=MD5 */
  authType: number;
  /** Authentication key */
  authKey: string;
}

// ─── LSA Types (RFC 2328 §12) ───────────────────────────────────────

export type LSAType =
  | 1   // Router-LSA
  | 2   // Network-LSA
  | 3   // Summary-LSA (IP network)
  | 4   // Summary-LSA (ASBR)
  | 5;  // AS-External-LSA

export interface LSAHeader {
  /** LSA Age (seconds, 0-3600) */
  lsAge: number;
  /** Options field */
  options: number;
  /** LSA Type (1-5) */
  lsType: LSAType;
  /** Link State ID */
  linkStateId: string;
  /** Advertising Router (Router ID) */
  advertisingRouter: string;
  /** Sequence number (for LSA comparison) */
  lsSequenceNumber: number;
  /** Checksum */
  checksum: number;
  /** Length in bytes */
  length: number;
}

/** Router-LSA Link Types (RFC 2328 §12.4.1.1) */
export type RouterLinkType =
  | 1  // Point-to-point connection to another router
  | 2  // Connection to a transit network
  | 3  // Connection to a stub network
  | 4; // Virtual link

export interface RouterLSALink {
  /** Link ID (meaning depends on type) */
  linkId: string;
  /** Link Data (meaning depends on type) */
  linkData: string;
  /** Link type */
  type: RouterLinkType;
  /** Number of TOS metrics */
  numTOS: number;
  /** Metric for this link */
  metric: number;
}

/** Type 1: Router-LSA */
export interface RouterLSA extends LSAHeader {
  lsType: 1;
  /** Flags: V=virtual link endpoint, E=ASBR, B=ABR */
  flags: number;
  /** Number of links */
  numLinks: number;
  /** Links described by this router */
  links: RouterLSALink[];
}

/** Type 2: Network-LSA */
export interface NetworkLSA extends LSAHeader {
  lsType: 2;
  /** Network mask */
  networkMask: string;
  /** Attached routers (Router IDs) */
  attachedRouters: string[];
}

/** Type 3: Summary-LSA (network) */
export interface SummaryLSA extends LSAHeader {
  lsType: 3;
  /** Network mask */
  networkMask: string;
  /** Metric */
  metric: number;
}

/** Type 4: Summary-LSA (ASBR) */
export interface ASBRSummaryLSA extends LSAHeader {
  lsType: 4;
  /** Network mask (0.0.0.0 for ASBR) */
  networkMask: string;
  /** Metric to reach ASBR */
  metric: number;
}

/** Type 5: AS-External-LSA */
export interface ExternalLSA extends LSAHeader {
  lsType: 5;
  /** Network mask */
  networkMask: string;
  /** Metric type: 1=comparable to internal, 2=larger than any internal */
  metricType: 1 | 2;
  /** External metric */
  metric: number;
  /** Forwarding address ("0.0.0.0" = use advertising router) */
  forwardingAddress: string;
  /** External route tag */
  externalRouteTag: number;
}

export type LSA = RouterLSA | NetworkLSA | SummaryLSA | ASBRSummaryLSA | ExternalLSA;

// ─── Link State Database ─────────────────────────────────────────────

/** Key for LSDB: "type:linkStateId:advertisingRouter" */
export type LSDBKey = string;

export function makeLSDBKey(lsType: number, linkStateId: string, advertisingRouter: string): LSDBKey {
  return `${lsType}:${linkStateId}:${advertisingRouter}`;
}

export interface LSDB {
  /** Per-area databases */
  areas: Map<string, Map<LSDBKey, LSA>>;
  /** AS-external LSAs (type 5, not area-specific) */
  external: Map<LSDBKey, ExternalLSA>;
}

export function createEmptyLSDB(): LSDB {
  return {
    areas: new Map(),
    external: new Map(),
  };
}

// ─── OSPF Packet Types (RFC 2328 §A.3) ─────────────────────────────

export type OSPFPacketType = 1 | 2 | 3 | 4 | 5;
// 1 = Hello, 2 = Database Description, 3 = Link State Request,
// 4 = Link State Update, 5 = Link State Acknowledgment

export interface OSPFPacketHeader {
  type: 'ospf';
  /** OSPF version (2 or 3) */
  version: number;
  /** Packet type (1-5) */
  packetType: OSPFPacketType;
  /** Router ID of the sender */
  routerId: string;
  /** Area ID */
  areaId: string;
  /** Authentication type (v2 only) */
  authType?: number;
}

/** Type 1: Hello Packet (RFC 2328 §A.3.2) */
export interface OSPFHelloPacket extends OSPFPacketHeader {
  packetType: 1;
  /** Network mask of the interface */
  networkMask: string;
  /** Hello interval (seconds) */
  helloInterval: number;
  /** Options field */
  options: number;
  /** Router priority */
  priority: number;
  /** Dead interval (seconds) */
  deadInterval: number;
  /** Designated Router */
  designatedRouter: string;
  /** Backup Designated Router */
  backupDesignatedRouter: string;
  /** List of neighbor Router IDs seen in recent Hellos */
  neighbors: string[];
}

/** Type 2: Database Description Packet */
export interface OSPFDDPacket extends OSPFPacketHeader {
  packetType: 2;
  /** Interface MTU */
  interfaceMTU: number;
  /** Options */
  options: number;
  /** Flags: I=Init, M=More, MS=Master/Slave */
  flags: number;
  /** DD sequence number */
  ddSequenceNumber: number;
  /** LSA headers */
  lsaHeaders: LSAHeader[];
}

/** DD Flags */
export const DD_FLAG_INIT = 0x04;
export const DD_FLAG_MORE = 0x02;
export const DD_FLAG_MASTER = 0x01;

/** Type 3: Link State Request Packet */
export interface OSPFLSRequestPacket extends OSPFPacketHeader {
  packetType: 3;
  /** Requested LSAs */
  requests: Array<{
    lsType: LSAType;
    linkStateId: string;
    advertisingRouter: string;
  }>;
}

/** Type 4: Link State Update Packet */
export interface OSPFLSUpdatePacket extends OSPFPacketHeader {
  packetType: 4;
  /** Number of LSAs */
  numLSAs: number;
  /** LSAs */
  lsas: LSA[];
}

/** Type 5: Link State Acknowledgment Packet */
export interface OSPFLSAckPacket extends OSPFPacketHeader {
  packetType: 5;
  /** Acknowledged LSA headers */
  lsaHeaders: LSAHeader[];
}

export type OSPFPacket =
  | OSPFHelloPacket
  | OSPFDDPacket
  | OSPFLSRequestPacket
  | OSPFLSUpdatePacket
  | OSPFLSAckPacket;

// ─── SPF Calculation Structures ──────────────────────────────────────

export interface SPFVertex {
  /** Vertex ID (Router ID or network IP) */
  id: string;
  /** Vertex type */
  type: 'router' | 'network';
  /** Distance from root */
  distance: number;
  /** Parent vertex in SPF tree */
  parent: SPFVertex | null;
  /** Associated LSA */
  lsa: RouterLSA | NetworkLSA;
  /** Next-hop IP address */
  nextHop: string | null;
  /** Outgoing interface */
  outInterface: string | null;
}

// ─── OSPF Configuration ─────────────────────────────────────────────

export interface OSPFConfig {
  /** Our Router ID (usually highest loopback or interface IP) */
  routerId: string;
  /** Process ID (local significance only) */
  processId: number;
  /** Areas configured */
  areas: Map<string, OSPFArea>;
  /** Network statements: which interfaces participate */
  networks: Array<{
    network: string;
    wildcard: string;
    areaId: string;
  }>;
  /** Reference bandwidth for cost calculation (bps) */
  referenceBandwidth: number;
  /** Default information originate */
  defaultInformationOriginate: boolean;
  /** Redistribute connected */
  redistributeConnected: boolean;
  /** Redistribute static */
  redistributeStatic: boolean;
  /** Passive interfaces (no hellos sent) */
  passiveInterfaces: Set<string>;
  /** Log adjacency changes */
  logAdjacencyChanges: boolean;
  /** Auto-cost reference bandwidth (Kbps for Cisco) */
  autoCostReferenceBandwidth: number;
}

export function createDefaultOSPFConfig(processId: number = 1): OSPFConfig {
  return {
    routerId: '0.0.0.0',
    processId,
    areas: new Map(),
    networks: [],
    referenceBandwidth: OSPF_DEFAULT_REFERENCE_BANDWIDTH,
    defaultInformationOriginate: false,
    redistributeConnected: false,
    redistributeStatic: false,
    passiveInterfaces: new Set(),
    logAdjacencyChanges: true,
    autoCostReferenceBandwidth: 100, // 100 Mbps in Mbps
  };
}

// ─── OSPFv3 Extensions (RFC 5340) ────────────────────────────────────

export interface OSPFv3Config extends OSPFConfig {
  /** IPv6 enabled */
  ipv6: true;
}

export interface OSPFv3Interface {
  /** Interface name */
  name: string;
  /** Instance ID (supports multiple instances per link) */
  instanceId: number;
  /** Interface ID (unique per router, used in LSAs) */
  interfaceId: number;
  /** Area ID */
  areaId: string;
  /** Current state */
  state: OSPFInterfaceState;
  /** Network type */
  networkType: OSPFNetworkType;
  /** Hello interval */
  helloInterval: number;
  /** Dead interval */
  deadInterval: number;
  /** Priority */
  priority: number;
  /** Cost */
  cost: number;
  /** DR Router ID */
  dr: string;
  /** BDR Router ID */
  bdr: string;
  /** Neighbors */
  neighbors: Map<string, OSPFNeighbor>;
  /** Hello timer */
  helloTimer: ReturnType<typeof setInterval> | null;
  /** Wait timer */
  waitTimer: ReturnType<typeof setTimeout> | null;
  /** Passive */
  passive: boolean;
}

/** OSPFv3 Hello Packet */
export interface OSPFv3HelloPacket extends OSPFPacketHeader {
  version: 3;
  packetType: 1;
  /** Interface ID of the sender */
  interfaceId: number;
  /** Router priority */
  priority: number;
  /** Options (V6, E, R bits) */
  options: number;
  /** Hello interval */
  helloInterval: number;
  /** Dead interval */
  deadInterval: number;
  /** DR Router ID (not IP like v2) */
  designatedRouter: string;
  /** BDR Router ID */
  backupDesignatedRouter: string;
  /** Neighbor Router IDs */
  neighbors: string[];
}

// ─── OSPF Route Entry ────────────────────────────────────────────────

export type OSPFRouteType = 'intra-area' | 'inter-area' | 'external-type1' | 'external-type2';

export interface OSPFRouteEntry {
  /** Destination network */
  network: string;
  /** Subnet mask */
  mask: string;
  /** Route type */
  routeType: OSPFRouteType;
  /** Area where this route was learned (for intra/inter) */
  areaId: string;
  /** Next-hop IP */
  nextHop: string;
  /** Outgoing interface */
  iface: string;
  /** OSPF metric (cost) */
  cost: number;
  /** For type-2 external: forwarding metric */
  type2Cost?: number;
  /** Advertising Router ID */
  advertisingRouter: string;
}

// ─── Initial LSA Sequence Number ─────────────────────────────────────

export const OSPF_INITIAL_SEQUENCE_NUMBER = 0x80000001;
export const OSPF_MAX_SEQUENCE_NUMBER = 0x7FFFFFFF;
