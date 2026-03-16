/**
 * IPSecTypes — Data structures for IPSec/IKE simulation
 *
 * Covers IKEv1 (ISAKMP), IKEv2, ESP/AH, transform sets,
 * crypto maps, dynamic maps, and SA databases.
 */

// ─── SPD (Security Policy Database) — RFC 4301 §4.4.1 ───────────────

/**
 * SPD action per RFC 4301: every packet is evaluated against the SPD
 * and one of three actions is taken.
 *   PROTECT — apply IPsec (encrypt/authenticate via SA)
 *   BYPASS  — allow in cleartext (e.g. IKE, OSPF, ICMP)
 *   DISCARD — silently drop
 */
export type SPDAction = 'PROTECT' | 'BYPASS' | 'DISCARD';

/** Traffic direction to which a security policy applies. */
export type SPDDirection = 'in' | 'out';

/**
 * A single entry in the Security Policy Database (SPD).
 * Selectors follow RFC 4301 §4.4.1.1 (simplified for the simulator).
 */
export interface SecurityPolicy {
  /** Unique numeric ID for ordering (lower = higher priority) */
  id: number;
  /** Human-readable name / label */
  name: string;
  /** Direction: inbound or outbound */
  direction: SPDDirection;
  /** Action to apply */
  action: SPDAction;
  /** Selector: source IP / CIDR ('' = any) */
  srcAddress: string;
  /** Selector: source wildcard mask (Cisco-style, '' = host) */
  srcWildcard: string;
  /** Selector: destination IP / CIDR ('' = any) */
  dstAddress: string;
  /** Selector: destination wildcard mask ('' = host) */
  dstWildcard: string;
  /** Selector: IP protocol number (0 = any) */
  protocol: number;
  /** Selector: source port (0 = any, TCP/UDP only) */
  srcPort: number;
  /** Selector: destination port (0 = any, TCP/UDP only) */
  dstPort: number;
  /**
   * For PROTECT: name of the crypto map / IPsec profile to use.
   * Ignored for BYPASS / DISCARD.
   */
  cryptoMapName?: string;
}

// ─── IKEv1 Configuration ─────────────────────────────────────────────

export interface ISAKMPPolicy {
  priority: number;
  encryption: string;  // 'aes', 'aes 256', '3des', 'des'
  hash: string;        // 'sha', 'sha256', 'sha384', 'sha512', 'md5'
  auth: string;        // 'pre-share', 'rsa-sig'
  group: number;       // DH group number
  lifetime: number;    // seconds (default 86400)
}

export interface TransformSet {
  name: string;
  transforms: string[];              // e.g. ['esp-aes', 'esp-sha-hmac']
  mode: 'tunnel' | 'transport';
}

export interface CryptoMapEntry {
  seq: number;
  type: 'ipsec-isakmp';
  peers: string[];                   // configured peer IP addresses
  transformSets: string[];           // transform set names
  aclName: string;
  pfsGroup?: string;                 // e.g. 'group14'
  saLifetimeSeconds?: number;
  ikev2ProfileName?: string;
}

export interface DynamicCryptoMapEntry {
  seq: number;
  transformSets: string[];
  aclName?: string;
  pfsGroup?: string;
}

export interface CryptoMap {
  name: string;
  /** Static entries: seq → entry */
  staticEntries: Map<number, CryptoMapEntry>;
  /** Dynamic map references: seq → dynamic map name */
  dynamicEntries: Map<number, string>;
}

export interface DynamicCryptoMap {
  name: string;
  entries: Map<number, DynamicCryptoMapEntry>;
}

// ─── IKEv2 Configuration ─────────────────────────────────────────────

export interface IKEv2Proposal {
  name: string;
  encryption: string[];  // e.g. ['aes-cbc-128', 'aes-cbc-256', '3des']
  integrity: string[];   // e.g. ['sha256', 'sha384', 'sha512']
  dhGroup: number[];     // e.g. [14, 19, 20]
}

export interface IKEv2Policy {
  priority: string | number;
  proposalNames: string[];
  matchAddressLocal?: string;
}

export interface IKEv2KeyringPeer {
  name: string;
  address: string;       // IP address or 0.0.0.0 for wildcard
  preSharedKey: string;
}

export interface IKEv2Keyring {
  name: string;
  peers: Map<string, IKEv2KeyringPeer>;  // key: peer name
}

export interface IKEv2Profile {
  name: string;
  matchIdentityRemoteAddress?: string;  // IP to match
  matchIdentityRemoteAny?: boolean;
  authLocal: string;   // 'pre-share'
  authRemote: string;  // 'pre-share'
  keyringName?: string;
  keyringLocalName?: string;
}

// ─── IPSec Profile (for GRE over IPSec) ─────────────────────────────

export interface IPSecProfile {
  name: string;
  transformSetName: string;
  mode: 'tunnel' | 'transport';
  saLifetimeSeconds?: number;
}

// ─── IKE SA Database ─────────────────────────────────────────────────

export type IKESAStatus =
  | 'MM_NO_STATE'
  | 'MM_SA_SETUP'
  | 'MM_KEY_EXCH'
  | 'MM_KEY_AUTH'
  | 'QM_IDLE'
  | 'AM_ACTIVE';

export interface IKE_SA {
  peerIP: string;
  localIP: string;
  status: IKESAStatus;
  encryption: string;
  hash: string;
  group: number;
  lifetime: number;
  created: number;       // timestamp ms
  spi: string;           // hex string e.g. '0x1234ABCD'
  role: 'initiator' | 'responder';
  natT: boolean;         // NAT-T detected
  dpdEnabled: boolean;
  /** Timestamp of last DPD activity (sent or received) */
  lastDPDActivity?: number;
  /** Number of consecutive DPD timeouts */
  dpdTimeouts?: number;
  /** IKE exchange mode: main (default) or aggressive */
  exchangeMode?: 'main' | 'aggressive';
}

export interface IKEv2_SA {
  peerIP: string;
  localIP: string;
  status: 'READY' | 'DELETED';
  spiLocal: string;
  spiRemote: string;
  role: 'Initiator' | 'Responder';
  proposalUsed: string;
  encryptionUsed: string;
  integrityUsed: string;
  dhGroupUsed: number;
  created: number;
  natT: boolean;
}

// ─── SA Traffic Selectors (RFC 4301 §4.4.2.1) ────────────────────────

/**
 * Traffic selectors cached inside each SA.
 * These record the negotiated selectors from the SPD policy that
 * triggered SA creation, as required by RFC 4301 §4.4.2 field #12.
 */
export interface SATrafficSelector {
  /** Source IP range — CIDR or single address ('' = any) */
  srcAddress: string;
  /** Source wildcard mask (Cisco-style, '' = host) */
  srcWildcard: string;
  /** Destination IP range ('' = any) */
  dstAddress: string;
  /** Destination wildcard mask ('' = host) */
  dstWildcard: string;
  /** IP protocol number (0 = any) */
  protocol: number;
  /** Source port (0 = any) */
  srcPort: number;
  /** Destination port (0 = any) */
  dstPort: number;
}

// ─── Cryptographic Key Material (RFC 4301 §4.4.2 fields #7-9) ────────

/**
 * Simulated cryptographic key material for an SA.
 * In a real implementation these would hold the actual keying material
 * derived from IKE (KEYMAT). In this simulator the keys are generated
 * as random hex strings of the correct length for the algorithm.
 * No real encryption/decryption is performed, but the structure is
 * complete per RFC 4301 §4.4.2.
 */
export interface SACryptoKeys {
  // ── ESP keys (RFC 4303) ──
  /** ESP encryption algorithm name (e.g. 'aes-cbc-128', '3des', 'null') */
  espEncAlgorithm: string;
  /** ESP encryption key — hex string of appropriate length */
  espEncKey: string;
  /** ESP encryption key length in bits */
  espEncKeyLength: number;
  /** ESP authentication (integrity) algorithm (e.g. 'hmac-sha-256', 'hmac-sha-1') */
  espAuthAlgorithm: string;
  /** ESP authentication key — hex string */
  espAuthKey: string;
  /** ESP authentication key length in bits */
  espAuthKeyLength: number;

  // ── AH keys (RFC 4302) ──
  /** AH authentication algorithm (e.g. 'hmac-sha-256', 'hmac-md5') */
  ahAuthAlgorithm: string;
  /** AH authentication key — hex string */
  ahAuthKey: string;
  /** AH authentication key length in bits */
  ahAuthKeyLength: number;
}

// ─── DSCP / ECN Mapping (RFC 4301 §4.4.2 fields #14-15) ──────────────

/**
 * Determines how DSCP and ECN bits in the inner header are handled
 * when constructing the outer (tunnel) header, per RFC 4301 §5.1.2.
 */
export interface SADscpEcnConfig {
  /**
   * How to set the DSCP field in the outer tunnel header:
   *   - 'copy'  : copy inner DSCP to outer (RFC 4301 default)
   *   - 'set'   : use a fixed DSCP value (dscpValue)
   *   - 'map'   : apply a mapping table (dscpMap)
   */
  dscpMode: 'copy' | 'set' | 'map';
  /** Fixed DSCP value when mode='set' (0-63) */
  dscpValue: number;
  /** DSCP mapping table inner→outer when mode='map' */
  dscpMap: Map<number, number>;
  /**
   * ECN handling per RFC 6040:
   *   - true  : copy ECN bits from inner to outer on encap;
   *             on decap, propagate CE marks from outer to inner
   *   - false : clear ECN in outer header
   */
  ecnEnabled: boolean;
}

// ─── IPSec SA Database (RFC 4301 §4.4.2) ─────────────────────────────

export interface IPSec_SA {
  peerIP: string;
  localIP: string;

  // ── Field #1: SPI (RFC 4301 §4.4.2) ──
  spiIn: number;           // SPI for inbound packets (from peer to me)
  spiOut: number;          // SPI for outbound packets (from me to peer)

  // ── Field #2: Sequence Number Counter (RFC 4301 §4.4.2) ──
  outboundSeqNum: number;          // next outbound sequence number (low 32 bits)

  // ── Field #3: Sequence Counter Overflow (RFC 4301 §4.4.2) ──
  /**
   * RFC 4301: "The flag indicating whether overflow of the sequence
   * number counter should generate an auditable event and prevent
   * transmission of additional packets on the SA."
   *
   * When true (default), an SA MUST NOT transmit further packets once
   * the sequence number reaches 2^32−1 (or 2^64−1 with ESN) and
   * MUST trigger a rekey. When false, wrapping is allowed (violates RFC).
   */
  seqOverflowFlag: boolean;

  // ── Field #4: Anti-Replay Window (RFC 4303 §3.4.3) ──
  replayWindowSize: number;        // default 64, max 1024
  replayBitmap: Uint32Array;       // bitmap for replay window (ceil(windowSize/32) words)
  replayWindowLastSeq: number;     // highest sequence number seen

  // ── Field #5: Extended Sequence Numbers (RFC 4303 §2.2.1) ──
  esnEnabled: boolean;             // true if 64-bit sequence numbers are in use
  outboundSeqNumHigh: number;      // high 32 bits of outbound sequence counter
  replayWindowLastSeqHigh: number; // high 32 bits of last received sequence

  // ── Fields #6-9: Cryptographic Keys (RFC 4301 §4.4.2) ──
  /**
   * Simulated key material for ESP/AH algorithms.
   * Keys are random hex strings of the correct length for the negotiated
   * algorithms. No real crypto operations are performed.
   */
  cryptoKeys: SACryptoKeys;

  // ── Field #10: Lifetime (RFC 4301 §4.4.2) ──
  created: number;
  lifetime: number;        // seconds
  lifetimeKB: number;      // kilobytes (0 = unlimited, default 4608000)

  // ── Field #11: IPsec Protocol Mode (RFC 4301 §4.4.2) ──
  mode: 'Tunnel' | 'Transport';

  // ── Field #12: SA Traffic Selectors (RFC 4301 §4.4.2) ──
  trafficSelectors: SATrafficSelector;

  // ── Field #13: Stateful Fragment Checking (RFC 4301 §7) ──
  /**
   * RFC 4301 §7: "Stateful fragment checking — a flag that indicates
   * whether or not stateful fragment checking applies to this SA."
   * When enabled, the system reassembles fragments before applying
   * IPsec processing (tunnel mode) and tracks fragment state.
   */
  statefulFragCheck: boolean;

  // ── Field #14: Bypass DF bit (RFC 4301 §8.1) ──
  /**
   * Controls the DF (Don't Fragment) bit in the outer tunnel header:
   *   - 'copy'  : copy DF from inner packet to outer (default)
   *   - 'set'   : always set DF in outer header
   *   - 'clear' : always clear DF in outer header
   */
  dfBitPolicy: 'copy' | 'set' | 'clear';

  // ── Field #15: DSCP / ECN (RFC 4301 §5.1.2 / RFC 6040) ──
  dscpEcnConfig: SADscpEcnConfig;

  // ── Field #16: Path MTU (RFC 4301 §8.2) ──
  /**
   * Discovered Path MTU for this SA. Used to determine whether
   * post-encapsulation fragmentation or ICMP "too big" is needed.
   * Updated dynamically when ICMP "Fragmentation Needed" is received.
   */
  pathMTU: number;
  /** Maximum inner payload size = pathMTU minus ESP/AH overhead */
  ipMTU: number;
  /** Timestamp of last Path MTU update (for aging, RFC 1191 §6.3) */
  pathMTULastUpdated: number;

  // ── Existing operational fields ──
  transforms: string[];
  aclName: string;
  pktsEncaps: number;      // packets encrypted (outbound)
  pktsDecaps: number;      // packets decrypted (inbound)
  sendErrors: number;
  recvErrors: number;
  pktsReplay: number;      // anti-replay drops
  bytesEncaps: number;     // bytes encrypted (for kilobyte lifetime)
  bytesDecaps: number;     // bytes decrypted
  pfsGroup?: string;
  natT: boolean;
  outIface: string;        // outgoing interface name
  hasESP: boolean;
  hasAH: boolean;
}

// ─── Multicast IPsec SA (RFC 4301 §4.1) ──────────────────────────────

/**
 * RFC 4301 §4.1: Multicast SAs are fundamentally different from unicast SAs.
 *   - They are UNIDIRECTIONAL (one sender → multiple receivers)
 *   - The SA is identified by (SPI, destination group address, protocol)
 *     rather than just SPI
 *   - A Group SA (GSA) shares key material among all group members
 *   - Anti-replay is typically not used for multicast (RFC 4301 §4.1)
 *
 * This type extends the unicast SA concept for multicast scenarios
 * such as encrypted OSPF, multicast VPN, or GDOI (Group Domain of
 * Interpretation, RFC 6407).
 */
export interface MulticastIPSecSA {
  /** Multicast group address (e.g. 224.0.0.5 for OSPF) */
  groupAddress: string;
  /** Sender IP — the single source that can encrypt on this SA */
  senderAddress: string;
  /** SPI for the group SA (combined with groupAddress for lookup) */
  spi: number;
  /** IPsec protocol: ESP or AH */
  protocol: 'esp' | 'ah';
  /** Transform used (e.g. ['esp-aes', 'esp-sha-hmac']) */
  transforms: string[];
  /** Tunnel or Transport mode */
  mode: 'Tunnel' | 'Transport';
  /** Cryptographic key material (shared among all group members) */
  cryptoKeys: SACryptoKeys;
  /** Sequence number counter (sender only) */
  outboundSeqNum: number;
  /** SA creation timestamp */
  created: number;
  /** SA lifetime in seconds */
  lifetime: number;
  /** Packets encrypted by sender */
  pktsEncaps: number;
  /** Packets decrypted by receivers */
  pktsDecaps: number;
  /** Send errors */
  sendErrors: number;
  /** Receive errors */
  recvErrors: number;
  /** Bytes encrypted */
  bytesEncaps: number;
  /** Bytes decrypted */
  bytesDecaps: number;
  /**
   * RFC 4301 §4.1: Anti-replay is generally NOT RECOMMENDED for multicast
   * because receivers may get packets out of order from different paths.
   * When false (default for multicast), anti-replay checking is disabled.
   */
  antiReplayEnabled: boolean;
  /** List of receiver IPs that have joined this group SA */
  receivers: string[];
  /** Whether this SA has ESP */
  hasESP: boolean;
  /** Whether this SA has AH */
  hasAH: boolean;
}

// ─── DPD / NAT-T Config ──────────────────────────────────────────────

export interface DPDConfig {
  interval: number;    // seconds
  retries: number;
  mode: 'periodic' | 'on-demand';
}

// ─── Tunnel Protection (for GRE over IPSec) ──────────────────────────

export interface TunnelProtection {
  profileName: string;
  shared: boolean;
}
