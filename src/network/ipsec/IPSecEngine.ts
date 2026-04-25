/**
 * IPSecEngine — Core IPSec/IKE simulation engine
 *
 * Attached to each Router. Manages:
 *   - IKEv1/IKEv2 SA negotiation (direct engine-to-engine, synchronous)
 *   - ESP encapsulation/decapsulation
 *   - SA database (IKE SA + IPSec SA)
 *   - show crypto commands
 *   - DPD (Dead Peer Detection via link-down events)
 */

import {
  IPAddress, SubnetMask,
  IPv4Packet, ESPPacket, AHPacket, UDPPacket,
  IP_PROTO_ESP, IP_PROTO_AH, IP_PROTO_UDP,
  UDP_PORT_IKE_NAT_T,
  createIPv4Packet, computeIPv4Checksum, nextIPv4Id,
} from '../core/types';
import {
  ISAKMPPolicy, TransformSet, CryptoMapEntry, CryptoMap, DynamicCryptoMap,
  DynamicCryptoMapEntry, IKEv2Proposal, IKEv2Policy, IKEv2Keyring, IKEv2Profile,
  IPSecProfile, TunnelProtection,
  IKE_SA, IKEv2_SA, IPSec_SA, DPDConfig,
  SecurityPolicy, SPDAction, SPDDirection,
  SACryptoKeys, SATrafficSelector, SADscpEcnConfig,
  MulticastIPSecSA,
} from './IPSecTypes';
import { Equipment } from '../equipment/Equipment';
import { Logger } from '../core/Logger';
import type { IProtocolEngine } from '../core/interfaces';
import { IPSEC_CONSTANTS } from '../core/constants';

// Forward reference — resolved at runtime to avoid circular imports
type Router = import('../devices/Router').Router;

/**
 * Generate a random SPI in the valid range [256, 0xFFFFFFFF].
 * SPIs 0-255 are reserved by IANA (RFC 4303 §2.1).
 */
function randomSPI(): number {
  // Use Math.random to produce a 32-bit value, then clamp to [256, 0xFFFFFFFF]
  const raw = (Math.random() * 0xFFFFFF00 + 0x100) >>> 0;
  return raw || 0x100; // ensure never 0
}

function spiHex(spi: number): string {
  return `0x${(spi >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Allocate a Uint32Array bitmap large enough for the given window size. */
function createReplayBitmap(windowSize: number): Uint32Array {
  if (windowSize <= 0) return new Uint32Array(0);
  const words = Math.ceil(windowSize / 32);
  return new Uint32Array(words);
}

/** Maximum sequence number before overflow (2^32 - 1). */
const SEQ_NUM_MAX = IPSEC_CONSTANTS.SEQ_NUM_MAX;

/** Default Path MTU (Ethernet). */
const DEFAULT_PATH_MTU = IPSEC_CONSTANTS.DEFAULT_PATH_MTU;

/** ESP overhead: SPI(4) + SeqNum(4) + padding(max 255) + padLen(1) + nextHdr(1) + ICV(typical 12-32) */
const ESP_OVERHEAD_BASE = IPSEC_CONSTANTS.ESP_OVERHEAD_BASE;
/** AH overhead: NextHdr(1) + PayloadLen(1) + Reserved(2) + SPI(4) + SeqNum(4) + ICV(12-32) */
const AH_OVERHEAD_BASE = 24;

/**
 * Generate a random hex key of the specified bit length.
 * Used to simulate IKE-derived KEYMAT for SA keying material.
 */
function generateSimulatedKey(bits: number): string {
  const bytes = bits / 8;
  const hex: string[] = [];
  for (let i = 0; i < bytes; i++) {
    hex.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Derive key lengths and algorithm names from a transform set's transforms array.
 * Returns a SACryptoKeys structure with simulated key material.
 */
function deriveCryptoKeys(transforms: string[]): SACryptoKeys {
  let espEncAlgorithm = 'null';
  let espEncKeyLength = 0;
  let espAuthAlgorithm = 'none';
  let espAuthKeyLength = 0;
  let ahAuthAlgorithm = 'none';
  let ahAuthKeyLength = 0;

  for (const t of transforms) {
    // ESP encryption algorithms
    if (t === 'esp-aes' || t === 'esp-aes-128') {
      espEncAlgorithm = 'aes-cbc-128'; espEncKeyLength = 128;
    } else if (t === 'esp-aes-192' || t === 'esp-aes 192') {
      espEncAlgorithm = 'aes-cbc-192'; espEncKeyLength = 192;
    } else if (t === 'esp-aes-256' || t === 'esp-aes 256') {
      espEncAlgorithm = 'aes-cbc-256'; espEncKeyLength = 256;
    } else if (t === 'esp-3des') {
      espEncAlgorithm = '3des-cbc'; espEncKeyLength = 192;
    } else if (t === 'esp-des') {
      espEncAlgorithm = 'des-cbc'; espEncKeyLength = 64;
    } else if (t === 'esp-gcm' || t === 'esp-gcm-128') {
      espEncAlgorithm = 'aes-gcm-128'; espEncKeyLength = 128; espAuthAlgorithm = 'aes-gcm'; espAuthKeyLength = 0;
    } else if (t === 'esp-gcm-256') {
      espEncAlgorithm = 'aes-gcm-256'; espEncKeyLength = 256; espAuthAlgorithm = 'aes-gcm'; espAuthKeyLength = 0;
    } else if (t === 'esp-null') {
      espEncAlgorithm = 'null'; espEncKeyLength = 0;
    }
    // ESP authentication algorithms
    else if (t === 'esp-sha-hmac' || t === 'esp-sha1-hmac') {
      espAuthAlgorithm = 'hmac-sha-1'; espAuthKeyLength = 160;
    } else if (t === 'esp-sha256-hmac' || t === 'esp-sha-256-hmac') {
      espAuthAlgorithm = 'hmac-sha-256'; espAuthKeyLength = 256;
    } else if (t === 'esp-sha384-hmac') {
      espAuthAlgorithm = 'hmac-sha-384'; espAuthKeyLength = 384;
    } else if (t === 'esp-sha512-hmac') {
      espAuthAlgorithm = 'hmac-sha-512'; espAuthKeyLength = 512;
    } else if (t === 'esp-md5-hmac') {
      espAuthAlgorithm = 'hmac-md5'; espAuthKeyLength = 128;
    }
    // AH authentication algorithms
    else if (t === 'ah-sha-hmac' || t === 'ah-sha1-hmac') {
      ahAuthAlgorithm = 'hmac-sha-1'; ahAuthKeyLength = 160;
    } else if (t === 'ah-sha256-hmac' || t === 'ah-sha-256-hmac') {
      ahAuthAlgorithm = 'hmac-sha-256'; ahAuthKeyLength = 256;
    } else if (t === 'ah-sha384-hmac') {
      ahAuthAlgorithm = 'hmac-sha-384'; ahAuthKeyLength = 384;
    } else if (t === 'ah-sha512-hmac') {
      ahAuthAlgorithm = 'hmac-sha-512'; ahAuthKeyLength = 512;
    } else if (t === 'ah-md5-hmac') {
      ahAuthAlgorithm = 'hmac-md5'; ahAuthKeyLength = 128;
    }
  }

  return {
    espEncAlgorithm,
    espEncKey: espEncKeyLength > 0 ? generateSimulatedKey(espEncKeyLength) : '',
    espEncKeyLength,
    espAuthAlgorithm,
    espAuthKey: espAuthKeyLength > 0 ? generateSimulatedKey(espAuthKeyLength) : '',
    espAuthKeyLength,
    ahAuthAlgorithm,
    ahAuthKey: ahAuthKeyLength > 0 ? generateSimulatedKey(ahAuthKeyLength) : '',
    ahAuthKeyLength,
  };
}

/** Compute overhead for ESP/AH encapsulation to derive ipMTU from pathMTU. */
function computeIPSecOverhead(hasESP: boolean, hasAH: boolean): number {
  let overhead = 20; // outer IP header
  if (hasESP) overhead += ESP_OVERHEAD_BASE;
  if (hasAH) overhead += AH_OVERHEAD_BASE;
  return overhead;
}

/** Create default DSCP/ECN config per RFC 4301 §5.1.2 defaults. */
function defaultDscpEcnConfig(): SADscpEcnConfig {
  return {
    dscpMode: 'copy',
    dscpValue: 0,
    dscpMap: new Map(),
    ecnEnabled: true, // RFC 6040 recommends ECN support
  };
}

// ─── Fragment Reassembly Buffer (RFC 4301 §7) ────────────────────────

/** Minimum IPv4 MTU per RFC 791 — never fragment below this. */
const MIN_IPV4_MTU = 576;
/** Fragment reassembly timeout in milliseconds (RFC 791 recommends 15-120s). */
const FRAG_REASSEMBLY_TIMEOUT_MS = 30_000;
/** Maximum number of fragment groups tracked (memory guard). */
const MAX_FRAG_GROUPS = 256;

/** A single buffered fragment awaiting reassembly. */
interface FragmentEntry {
  /** The fragment packet */
  packet: IPv4Packet;
  /** Fragment offset in bytes (fragmentOffset * 8) */
  offsetBytes: number;
  /** Data length = totalLength - ihl*4 */
  dataLength: number;
  /** True if MF (More Fragments) flag is clear → this is the last fragment. */
  isLast: boolean;
}

/** Key for grouping fragments: srcIP|dstIP|identification|protocol */
function fragGroupKey(pkt: IPv4Packet): string {
  return `${pkt.sourceIP}|${pkt.destinationIP}|${pkt.identification}|${pkt.protocol}`;
}

/**
 * Fragment an IPv4 packet into pieces that fit within the given MTU.
 * RFC 791 §2.3: fragment offset is in units of 8 bytes.
 * Returns the array of fragment packets, or the original packet if no
 * fragmentation is needed.
 */
function fragmentIPv4Packet(pkt: IPv4Packet, mtu: number): IPv4Packet[] {
  if (pkt.totalLength <= mtu) return [pkt];

  const headerLen = pkt.ihl * 4; // typically 20
  const maxPayloadPerFrag = Math.floor((mtu - headerLen) / 8) * 8; // must be multiple of 8
  if (maxPayloadPerFrag <= 0) return [pkt]; // MTU too small, cannot fragment

  const totalPayload = pkt.totalLength - headerLen;
  const fragments: IPv4Packet[] = [];
  let offset = 0;

  while (offset < totalPayload) {
    const remaining = totalPayload - offset;
    const isLast = remaining <= maxPayloadPerFrag;
    const fragPayloadSize = isLast ? remaining : maxPayloadPerFrag;

    // Build fragment flags: preserve reserved bit, set MF if not last
    const fragFlags = isLast
      ? (pkt.flags & ~0b100) // clear MF for last fragment
      : (pkt.flags | 0b100); // set MF for non-last fragments

    const frag: IPv4Packet = {
      ...pkt,
      identification: pkt.identification,
      flags: fragFlags,
      fragmentOffset: (pkt.fragmentOffset * 8 + offset) / 8, // in 8-byte units
      totalLength: headerLen + fragPayloadSize,
      headerChecksum: 0,
    };
    // Only the first fragment carries the real payload; subsequent fragments
    // carry a simulated "fragment payload" marker.
    if (offset > 0) {
      frag.payload = { type: 'fragment', offset, size: fragPayloadSize } as any;
    }
    frag.headerChecksum = computeIPv4Checksum(frag);
    fragments.push(frag);

    offset += fragPayloadSize;
  }

  return fragments;
}

/** Create default traffic selectors (any/any). */
function defaultTrafficSelectors(): SATrafficSelector {
  return {
    srcAddress: '', srcWildcard: '',
    dstAddress: '', dstWildcard: '',
    protocol: 0, srcPort: 0, dstPort: 0,
  };
}

/**
 * RFC 5771: Check if an IPv4 address is a multicast address (224.0.0.0/4).
 * Multicast range: 224.0.0.0 – 239.255.255.255 (first octet 224-239).
 */
function isMulticastAddress(ip: string): boolean {
  const firstOctet = parseInt(ip.split('.')[0], 10);
  return firstOctet >= 224 && firstOctet <= 239;
}

/**
 * Build a lookup key for multicast SA: (SPI, group address).
 * Per RFC 4301 §4.1, multicast SAs are identified by (SPI, dest group, protocol).
 */
function multicastSAKey(spi: number, groupAddress: string): string {
  return `${spi}|${groupAddress}`;
}

export class IPSecEngine implements IProtocolEngine {
  private readonly router: Router;
  private running = false;

  // ── IKEv1 Configuration ──────────────────────────────────────────
  private isakmpPolicies: Map<number, ISAKMPPolicy> = new Map();
  /** peer IP → PSK (use '0.0.0.0' for wildcard) */
  private preSharedKeys: Map<string, string> = new Map();
  private transformSets: Map<string, TransformSet> = new Map();
  private cryptoMaps: Map<string, CryptoMap> = new Map();
  private dynamicCryptoMaps: Map<string, DynamicCryptoMap> = new Map();
  /** interface name → crypto map name */
  private ifaceCryptoMap: Map<string, string> = new Map();
  private natKeepaliveInterval: number = 0;
  private dpdConfig: DPDConfig | null = null;
  private globalSALifetimeSeconds: number = 3600;
  private globalSALifetimeKB: number = 4608000; // 4608000 KB default
  private replayWindowSize: number = 64;       // RFC 4303 default
  private debugIsakmp: boolean = false;
  private debugIpsec: boolean = false;
  private debugIkev2: boolean = false;

  // ── IKEv2 Configuration ──────────────────────────────────────────
  private ikev2Proposals: Map<string, IKEv2Proposal> = new Map();
  private ikev2Policies: Map<string, IKEv2Policy> = new Map();
  private ikev2Keyrings: Map<string, IKEv2Keyring> = new Map();
  private ikev2Profiles: Map<string, IKEv2Profile> = new Map();

  // ── IPSec Profiles (GRE/tunnel protection) ───────────────────────
  private ipsecProfiles: Map<string, IPSecProfile> = new Map();
  private tunnelProtection: Map<string, TunnelProtection> = new Map();

  // ── SPD (Security Policy Database) — RFC 4301 §4.4.1 ───────────
  private spd: SecurityPolicy[] = [];
  private spdNextId: number = 1;

  // ── SA Database ──────────────────────────────────────────────────
  /** peerIP → IKE_SA */
  private ikeSADB: Map<string, IKE_SA> = new Map();
  /** peerIP → IKEv2_SA */
  private ikev2SADB: Map<string, IKEv2_SA> = new Map();
  /** peerIP → IPSec_SA[] */
  private ipsecSADB: Map<string, IPSec_SA[]> = new Map();
  /** inbound SPI → IPSec_SA (for fast lookup during decryption) */
  private spiToSA: Map<number, IPSec_SA> = new Map();

  // ── Multicast SA Database (RFC 4301 §4.1) ─────────────────────────
  /**
   * Multicast SAs keyed by "SPI|groupAddress".
   * Per RFC 4301 §4.1, multicast SAs are unidirectional and identified
   * by (SPI, destination group address, protocol).
   */
  private multicastSADB: Map<string, MulticastIPSecSA> = new Map();
  /** groupAddress → list of multicast SA keys for fast lookup by group */
  private multicastGroupIndex: Map<string, string[]> = new Map();

  // ── Fragment Reassembly Buffer (RFC 4301 §7) ─────────────────────
  /**
   * Pre-IPsec fragment reassembly buffer for tunnel mode.
   * Key: fragGroupKey(srcIP|dstIP|identification|protocol)
   * Value: { fragments, totalLength (if known), timer, created }
   */
  private fragBuffer: Map<string, {
    fragments: FragmentEntry[];
    totalDataLength: number; // -1 until last fragment received
    timer: ReturnType<typeof setTimeout>;
    created: number;
  }> = new Map();

  /**
   * After encapsulate() returns null due to MTU exceeded with DF set,
   * this field holds the info needed to generate ICMP Fragmentation Needed.
   * The caller (Router) should check this and send the ICMP error.
   */
  lastEncapICMP: { mtu: number; originalPkt: IPv4Packet } | null = null;

  constructor(router: Router) {
    this.router = router;
  }

  // ─── IProtocolEngine ──────────────────────────────────────────────

  start(): void {
    this.running = true;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    // Clear fragment reassembly timers
    for (const [, frag] of this.fragBuffer) {
      clearTimeout(frag.timer);
    }
    this.fragBuffer.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ══════════════════════════════════════════════════════════════════
  // Configuration setters
  // ══════════════════════════════════════════════════════════════════

  addISAKMPPolicy(priority: number, policy: Omit<ISAKMPPolicy, 'priority'>): void {
    this.isakmpPolicies.set(priority, { priority, ...policy });
  }

  getOrCreateISAKMPPolicy(priority: number): ISAKMPPolicy {
    if (!this.isakmpPolicies.has(priority)) {
      this.isakmpPolicies.set(priority, {
        priority,
        encryption: 'des',
        hash: 'sha',
        auth: 'pre-share',
        group: 1,
        lifetime: 86400,
      });
    }
    return this.isakmpPolicies.get(priority)!;
  }

  addPreSharedKey(address: string, key: string): void {
    this.preSharedKeys.set(address, key);
  }

  setNATKeepalive(interval: number): void {
    this.natKeepaliveInterval = interval;
  }

  setDPD(interval: number, retries: number, mode: 'periodic' | 'on-demand'): void {
    this.dpdConfig = { interval, retries, mode };
  }

  getDPDConfig(): DPDConfig | null {
    return this.dpdConfig;
  }

  setGlobalSALifetime(seconds: number): void {
    this.globalSALifetimeSeconds = seconds;
  }

  setGlobalSALifetimeKB(kb: number): void {
    this.globalSALifetimeKB = kb;
  }

  setReplayWindowSize(size: number): void {
    this.replayWindowSize = size;
  }

  setDebug(type: 'isakmp' | 'ipsec' | 'ikev2', enabled: boolean): void {
    if (type === 'isakmp') this.debugIsakmp = enabled;
    else if (type === 'ipsec') this.debugIpsec = enabled;
    else if (type === 'ikev2') this.debugIkev2 = enabled;
  }

  isDebugEnabled(type: 'isakmp' | 'ipsec' | 'ikev2'): boolean {
    if (type === 'isakmp') return this.debugIsakmp;
    if (type === 'ipsec') return this.debugIpsec;
    if (type === 'ikev2') return this.debugIkev2;
    return false;
  }

  addTransformSet(name: string, transforms: string[], mode: 'tunnel' | 'transport' = 'tunnel'): void {
    this.transformSets.set(name, { name, transforms, mode });
  }

  getOrCreateTransformSet(name: string, transforms: string[]): TransformSet {
    if (!this.transformSets.has(name)) {
      this.transformSets.set(name, { name, transforms, mode: 'tunnel' });
    }
    return this.transformSets.get(name)!;
  }

  setTransformSetMode(name: string, mode: 'tunnel' | 'transport'): void {
    const ts = this.transformSets.get(name);
    if (ts) ts.mode = mode;
  }

  getOrCreateCryptoMap(mapName: string): CryptoMap {
    if (!this.cryptoMaps.has(mapName)) {
      this.cryptoMaps.set(mapName, {
        name: mapName,
        staticEntries: new Map(),
        dynamicEntries: new Map(),
      });
    }
    return this.cryptoMaps.get(mapName)!;
  }

  getOrCreateCryptoMapEntry(mapName: string, seq: number): CryptoMapEntry {
    const map = this.getOrCreateCryptoMap(mapName);
    if (!map.staticEntries.has(seq)) {
      map.staticEntries.set(seq, {
        seq,
        type: 'ipsec-isakmp',
        peers: [],
        transformSets: [],
        aclName: '',
      });
    }
    return map.staticEntries.get(seq)!;
  }

  getOrCreateDynamicMapEntry(dynMapName: string, seq: number): DynamicCryptoMapEntry {
    if (!this.dynamicCryptoMaps.has(dynMapName)) {
      this.dynamicCryptoMaps.set(dynMapName, { name: dynMapName, entries: new Map() });
    }
    const dm = this.dynamicCryptoMaps.get(dynMapName)!;
    if (!dm.entries.has(seq)) {
      dm.entries.set(seq, { seq, transformSets: [] });
    }
    return dm.entries.get(seq)!;
  }

  addDynamicRefToCryptoMap(staticMapName: string, seq: number, dynMapName: string): void {
    const map = this.getOrCreateCryptoMap(staticMapName);
    map.dynamicEntries.set(seq, dynMapName);
  }

  applyCryptoMapToInterface(ifName: string, mapName: string): void {
    this.ifaceCryptoMap.set(ifName, mapName);
  }

  removeCryptoMapFromInterface(ifName: string): void {
    this.ifaceCryptoMap.delete(ifName);
  }

  // IKEv2
  getOrCreateIKEv2Proposal(name: string): IKEv2Proposal {
    if (!this.ikev2Proposals.has(name)) {
      this.ikev2Proposals.set(name, { name, encryption: [], integrity: [], dhGroup: [] });
    }
    return this.ikev2Proposals.get(name)!;
  }

  getOrCreateIKEv2Policy(name: string | number): IKEv2Policy {
    const key = String(name);
    if (!this.ikev2Policies.has(key)) {
      this.ikev2Policies.set(key, { priority: name, proposalNames: [] });
    }
    return this.ikev2Policies.get(key)!;
  }

  getOrCreateIKEv2Keyring(name: string): IKEv2Keyring {
    if (!this.ikev2Keyrings.has(name)) {
      this.ikev2Keyrings.set(name, { name, peers: new Map() });
    }
    return this.ikev2Keyrings.get(name)!;
  }

  getOrCreateIKEv2Profile(name: string): IKEv2Profile {
    if (!this.ikev2Profiles.has(name)) {
      this.ikev2Profiles.set(name, {
        name, authLocal: 'pre-share', authRemote: 'pre-share',
      });
    }
    return this.ikev2Profiles.get(name)!;
  }

  getOrCreateIPSecProfile(name: string): IPSecProfile {
    if (!this.ipsecProfiles.has(name)) {
      this.ipsecProfiles.set(name, { name, transformSetName: '', mode: 'tunnel' });
    }
    return this.ipsecProfiles.get(name)!;
  }

  setTunnelProtection(ifName: string, profileName: string, shared: boolean = false): void {
    this.tunnelProtection.set(ifName, { profileName, shared });
  }

  // ── SPD Configuration (RFC 4301 §4.4.1) ─────────────────────────

  /**
   * Add a security policy to the SPD.
   * Policies are evaluated in order of ascending id (lower = higher priority).
   */
  addSecurityPolicy(policy: Omit<SecurityPolicy, 'id'>): SecurityPolicy {
    const sp: SecurityPolicy = { id: this.spdNextId++, ...policy };
    this.spd.push(sp);
    this.spd.sort((a, b) => a.id - b.id);
    return sp;
  }

  removeSecurityPolicy(id: number): void {
    this.spd = this.spd.filter(p => p.id !== id);
  }

  removeSecurityPolicyByName(name: string): void {
    this.spd = this.spd.filter(p => p.name !== name);
  }

  clearSecurityPolicies(): void {
    this.spd = [];
  }

  getSecurityPolicies(): ReadonlyArray<SecurityPolicy> {
    return this.spd;
  }

  /**
   * Evaluate the SPD for a given packet + direction.
   * Returns the matching action (PROTECT / BYPASS / DISCARD).
   * If no explicit policy matches, returns null (caller decides default).
   */
  evaluateSPD(pkt: IPv4Packet, direction: SPDDirection): { action: SPDAction; policy: SecurityPolicy } | null {
    const srcIP = pkt.sourceIP.toString();
    const dstIP = pkt.destinationIP.toString();
    const proto = pkt.protocol;

    for (const sp of this.spd) {
      if (sp.direction !== direction) continue;
      if (!this.spdSelectorMatch(sp, srcIP, dstIP, proto)) continue;
      return { action: sp.action, policy: sp };
    }
    return null;
  }

  private spdSelectorMatch(sp: SecurityPolicy, srcIP: string, dstIP: string, proto: number): boolean {
    // Protocol check
    if (sp.protocol !== 0 && sp.protocol !== proto) return false;
    // Source address check
    if (sp.srcAddress && !this.ipMatchesWithWildcard(srcIP, sp.srcAddress, sp.srcWildcard)) return false;
    // Destination address check
    if (sp.dstAddress && !this.ipMatchesWithWildcard(dstIP, sp.dstAddress, sp.dstWildcard)) return false;
    return true;
  }

  /**
   * Check if `ip` falls within `baseIP` + wildcard mask (Cisco-style).
   * e.g. ip=10.0.0.5, base=10.0.0.0, wildcard=0.0.0.255 → true
   */
  private ipMatchesWithWildcard(ip: string, baseIP: string, wildcard: string): boolean {
    if (!baseIP || baseIP === 'any') return true;
    if (baseIP === 'host') return ip === wildcard; // special case: 'host' + actual IP
    const ipParts = ip.split('.').map(Number);
    const baseParts = baseIP.split('.').map(Number);
    const wcParts = wildcard ? wildcard.split('.').map(Number) : [0, 0, 0, 0];
    if (ipParts.length !== 4 || baseParts.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
      if ((ipParts[i] & ~wcParts[i]) !== (baseParts[i] & ~wcParts[i])) return false;
    }
    return true;
  }

  // ══════════════════════════════════════════════════════════════════
  // Configuration removal
  // ══════════════════════════════════════════════════════════════════

  removeISAKMPPolicy(priority: number): void {
    this.isakmpPolicies.delete(priority);
  }

  removePreSharedKey(address: string): void {
    this.preSharedKeys.delete(address);
  }

  removeTransformSet(name: string): void {
    this.transformSets.delete(name);
  }

  removeCryptoMap(mapName: string): void {
    this.cryptoMaps.delete(mapName);
    // Also remove interface associations
    for (const [iface, name] of this.ifaceCryptoMap) {
      if (name === mapName) this.ifaceCryptoMap.delete(iface);
    }
  }

  removeCryptoMapEntry(mapName: string, seq: number): void {
    const cmap = this.cryptoMaps.get(mapName);
    if (cmap) {
      cmap.staticEntries.delete(seq);
      cmap.dynamicEntries.delete(seq);
    }
  }

  removeDynamicCryptoMap(name: string): void {
    this.dynamicCryptoMaps.delete(name);
  }

  removeIKEv2Proposal(name: string): void {
    this.ikev2Proposals.delete(name);
  }

  removeIKEv2Policy(name: string): void {
    this.ikev2Policies.delete(String(name));
  }

  removeIKEv2Keyring(name: string): void {
    this.ikev2Keyrings.delete(name);
  }

  removeIKEv2Profile(name: string): void {
    this.ikev2Profiles.delete(name);
  }

  removeIPSecProfile(name: string): void {
    this.ipsecProfiles.delete(name);
    // Also remove tunnel protection refs
    for (const [iface, tp] of this.tunnelProtection) {
      if (tp.profileName === name) this.tunnelProtection.delete(iface);
    }
  }

  removeTunnelProtection(ifName: string): void {
    this.tunnelProtection.delete(ifName);
  }

  // ══════════════════════════════════════════════════════════════════
  // ── Aggressive Mode IKEv1 ──────────────────────────────────────

  private aggressiveMode: boolean = false;

  setAggressiveMode(enabled: boolean): void {
    this.aggressiveMode = enabled;
  }

  isAggressiveMode(): boolean {
    return this.aggressiveMode;
  }

  // ── Extended Sequence Numbers (RFC 4303 §2.2.1) ────────────────

  private esnDefault: boolean = false;

  /** Enable or disable ESN for newly created SAs */
  setESN(enabled: boolean): void {
    this.esnDefault = enabled;
  }

  isESNEnabled(): boolean {
    return this.esnDefault;
  }

  // ── DPD Simulation (RFC 3706) ────────────────────────────────────
  // In a real implementation, R-U-THERE / R-U-THERE-ACK messages are
  // sent over IKE. Here we simulate this by checking peer reachability.

  /**
   * Simulate DPD check for all IKE SAs. Called periodically by the
   * simulation tick or explicitly by the user.
   *
   * For each SA with DPD enabled, checks:
   *  - periodic mode: peer reachability every `interval` seconds
   *  - on-demand mode: only when traffic is expected but none received
   *
   * If a peer fails `retries` consecutive checks, clear its SAs.
   */
  runDPDCheck(): string[] {
    const events: string[] = [];
    if (!this.dpdConfig) return events;

    const now = Date.now();
    const intervalMs = this.dpdConfig.interval * 1000;

    for (const [peerIP, ikeSA] of this.ikeSADB) {
      if (!ikeSA.dpdEnabled || ikeSA.status !== 'QM_IDLE') continue;

      // Initialize DPD tracking on first check
      if (ikeSA.lastDPDActivity === undefined) {
        ikeSA.lastDPDActivity = now;
        ikeSA.dpdTimeouts = 0;
        continue;
      }

      // Check if it's time for a DPD probe
      if (now - ikeSA.lastDPDActivity < intervalMs) continue;

      // In on-demand mode, only probe if there are active IPsec SAs
      if (this.dpdConfig.mode === 'on-demand') {
        const sas = this.ipsecSADB.get(peerIP);
        if (!sas || sas.length === 0) {
          ikeSA.lastDPDActivity = now;
          continue;
        }
      }

      // Simulate R-U-THERE: check if peer router is reachable
      const peerRouter = IPSecEngine.findRouterByIP(peerIP);
      if (peerRouter) {
        const peerEngine = (peerRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
        if (peerEngine && peerEngine.ikeSADB.has(ikeSA.localIP)) {
          // Peer responded — R-U-THERE-ACK
          ikeSA.lastDPDActivity = now;
          ikeSA.dpdTimeouts = 0;
          if (this.debugIsakmp) {
            Logger.info(this.router.id, 'debug:isakmp',
              `ISAKMP: DPD R-U-THERE-ACK received from ${peerIP}`);
          }
          continue;
        }
      }

      // Peer unreachable — increment timeout counter
      ikeSA.dpdTimeouts = (ikeSA.dpdTimeouts || 0) + 1;
      ikeSA.lastDPDActivity = now;

      if (this.debugIsakmp) {
        Logger.info(this.router.id, 'debug:isakmp',
          `ISAKMP: DPD R-U-THERE timeout ${ikeSA.dpdTimeouts}/${this.dpdConfig.retries} for peer ${peerIP}`);
      }

      if (ikeSA.dpdTimeouts >= this.dpdConfig.retries) {
        events.push(`DPD: peer ${peerIP} declared dead after ${ikeSA.dpdTimeouts} timeouts`);
        Logger.info(this.router.id, 'ipsec:dpd-dead',
          `${this.router.name}: DPD declared peer ${peerIP} dead — clearing SAs`);
        this.clearSAsForPeer(peerIP);
      }
    }

    return events;
  }

  // ── IKE SA Rekeying (RFC 7296 §2.8) ─────────────────────────────

  /**
   * Check all IKE SAs for lifetime expiration and rekey if needed.
   * In a real implementation, CREATE_CHILD_SA exchange is used.
   * Here we simply create a new IKE SA and migrate Child SAs.
   */
  recheckIKESALifetimes(): void {
    const now = Date.now();
    const toRekey: string[] = [];

    for (const [peerIP, ikeSA] of this.ikeSADB) {
      if (ikeSA.status !== 'QM_IDLE') continue;
      const elapsedSec = Math.floor((now - ikeSA.created) / 1000);
      if (elapsedSec >= ikeSA.lifetime) {
        toRekey.push(peerIP);
      }
    }

    for (const peerIP of toRekey) {
      this.rekeyIKESA(peerIP);
    }
  }

  private rekeyIKESA(peerIP: string): void {
    const oldSA = this.ikeSADB.get(peerIP);
    if (!oldSA) return;

    if (this.debugIsakmp) {
      Logger.info(this.router.id, 'debug:isakmp',
        `ISAKMP: IKE SA with ${peerIP} expired (lifetime ${oldSA.lifetime}s) — rekeying`);
    }

    // Create new IKE SA with same parameters but fresh SPI and timestamp
    const newSA: IKE_SA = {
      ...oldSA,
      spi: spiHex(randomSPI()),
      created: Date.now(),
      lastDPDActivity: Date.now(),
      dpdTimeouts: 0,
    };
    this.ikeSADB.set(peerIP, newSA);

    // Rekey on peer side too
    const peerRouter = IPSecEngine.findRouterByIP(peerIP);
    if (peerRouter) {
      const peerEngine = (peerRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
      const peerSA = peerEngine?.ikeSADB.get(oldSA.localIP);
      if (peerEngine && peerSA) {
        const newPeerSA: IKE_SA = {
          ...peerSA,
          spi: spiHex(randomSPI()),
          created: Date.now(),
          lastDPDActivity: Date.now(),
          dpdTimeouts: 0,
        };
        peerEngine.ikeSADB.set(oldSA.localIP, newPeerSA);
      }
    }

    Logger.info(this.router.id, 'ipsec:rekey-ike',
      `${this.router.name}: IKE SA with ${peerIP} rekeyed successfully`);
  }

  // Port link-down handler (DPD simulation)
  // ══════════════════════════════════════════════════════════════════

  onPortDown(portName: string): void {
    // Find all SAs whose peer was reached via this port and clear them
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    const port = ports.get(portName);
    if (!port) return;

    // Clear SAs for all peers
    const toDelete: string[] = [];
    for (const [peerIP] of this.ikeSADB) {
      // Check if we'd reach this peer via the downed port
      try {
        const route = (this.router as any).lookupRoute(new IPAddress(peerIP));
        if (route && route.iface === portName) {
          toDelete.push(peerIP);
        }
      } catch { toDelete.push(peerIP); }
    }
    for (const ip of toDelete) {
      this.clearSAsForPeer(ip);
    }
  }

  clearSAsForPeer(peerIP: string): void {
    const ikeSA = this.ikeSADB.get(peerIP);
    if (ikeSA) { ikeSA.status = 'MM_NO_STATE'; this.ikeSADB.delete(peerIP); }
    this.ikev2SADB.delete(peerIP);

    const sas = this.ipsecSADB.get(peerIP) || [];
    for (const sa of sas) {
      this.spiToSA.delete(sa.spiIn);
    }
    this.ipsecSADB.delete(peerIP);
  }

  /** Clear all SAs associated with a given interface (called when interface goes down) */
  clearSAsForInterface(ifName: string): void {
    // Clear IPSec SAs with matching outbound interface
    for (const [peerIP, sas] of this.ipsecSADB) {
      const matching = sas.filter(sa => sa.outIface === ifName);
      if (matching.length > 0) {
        for (const sa of matching) {
          this.spiToSA.delete(sa.spiIn);
        }
        const remaining = sas.filter(sa => sa.outIface !== ifName);
        if (remaining.length > 0) {
          this.ipsecSADB.set(peerIP, remaining);
        } else {
          this.ipsecSADB.delete(peerIP);
          // Also clear the IKE SA for this peer
          this.ikeSADB.delete(peerIP);
          this.ikev2SADB.delete(peerIP);
        }
      }
    }
  }

  clearAllSAs(): void {
    this.ikeSADB.clear();
    this.ikev2SADB.clear();
    this.ipsecSADB.clear();
    this.spiToSA.clear();
    this.multicastSADB.clear();
    this.multicastGroupIndex.clear();
  }

  // ══════════════════════════════════════════════════════════════════
  // Multicast IPsec SA Management (RFC 4301 §4.1)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Create a multicast Group SA.
   *
   * Per RFC 4301 §4.1:
   * - Multicast SAs are unidirectional: one sender, multiple receivers
   * - Identified by (SPI, destination group address, protocol)
   * - Anti-replay is NOT RECOMMENDED for multicast
   * - All group members share the same keying material
   *
   * @param groupAddress - Multicast destination address (224.0.0.0/4)
   * @param senderAddress - IP of the single authorized sender
   * @param transforms - Transform set (e.g. ['esp-aes', 'esp-sha-hmac'])
   * @param mode - Tunnel or Transport
   * @param lifetime - SA lifetime in seconds
   * @returns The created MulticastIPSecSA, or null if groupAddress is invalid
   */
  createMulticastSA(
    groupAddress: string,
    senderAddress: string,
    transforms: string[],
    mode: 'Tunnel' | 'Transport' = 'Tunnel',
    lifetime: number = 3600,
  ): MulticastIPSecSA | null {
    if (!isMulticastAddress(groupAddress)) {
      Logger.warn(this.router.id, 'ipsec:mcast-invalid',
        `${this.router.name}: ${groupAddress} is not a valid multicast address`);
      return null;
    }

    const spi = randomSPI();
    const hasESP = transforms.some(t => t.startsWith('esp'));
    const hasAH = transforms.some(t => t.startsWith('ah'));
    const cryptoKeys = deriveCryptoKeys(transforms);

    const msa: MulticastIPSecSA = {
      groupAddress,
      senderAddress,
      spi,
      protocol: hasESP ? 'esp' : 'ah',
      transforms,
      mode,
      cryptoKeys,
      outboundSeqNum: 0,
      created: Date.now(),
      lifetime,
      pktsEncaps: 0,
      pktsDecaps: 0,
      sendErrors: 0,
      recvErrors: 0,
      bytesEncaps: 0,
      bytesDecaps: 0,
      antiReplayEnabled: false, // RFC 4301 §4.1: NOT RECOMMENDED for multicast
      receivers: [],
      hasESP,
      hasAH,
    };

    const key = multicastSAKey(spi, groupAddress);
    this.multicastSADB.set(key, msa);

    // Update group index
    const groupKeys = this.multicastGroupIndex.get(groupAddress) || [];
    groupKeys.push(key);
    this.multicastGroupIndex.set(groupAddress, groupKeys);

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC: multicast SA created for group ${groupAddress}, sender=${senderAddress}, spi=${spiHex(spi)}`);
    }

    Logger.info(this.router.id, 'ipsec:mcast-sa-up',
      `${this.router.name}: Multicast IPSec SA UP for group ${groupAddress} [${transforms.join(',')}]`);

    return msa;
  }

  /**
   * Add a receiver to a multicast Group SA.
   * The receiver's engine will also get a copy of the SA for decapsulation.
   */
  addMulticastReceiver(groupAddress: string, receiverIP: string): boolean {
    const keys = this.multicastGroupIndex.get(groupAddress);
    if (!keys || keys.length === 0) {
      Logger.warn(this.router.id, 'ipsec:mcast-no-sa',
        `${this.router.name}: No multicast SA for group ${groupAddress}`);
      return false;
    }

    for (const key of keys) {
      const msa = this.multicastSADB.get(key);
      if (!msa) continue;
      if (!msa.receivers.includes(receiverIP)) {
        msa.receivers.push(receiverIP);
      }

      // Install the SA on the receiver's engine so it can decapsulate
      const receiverRouter = IPSecEngine.findRouterByIP(receiverIP);
      if (receiverRouter) {
        const receiverEngine = (receiverRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
        if (receiverEngine) {
          receiverEngine.installMulticastReceiverSA(msa);
        }
      }
    }

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC: multicast receiver ${receiverIP} added to group ${groupAddress}`);
    }
    return true;
  }

  /**
   * Remove a receiver from a multicast Group SA.
   */
  removeMulticastReceiver(groupAddress: string, receiverIP: string): boolean {
    const keys = this.multicastGroupIndex.get(groupAddress);
    if (!keys) return false;

    for (const key of keys) {
      const msa = this.multicastSADB.get(key);
      if (!msa) continue;
      msa.receivers = msa.receivers.filter(r => r !== receiverIP);

      // Remove from receiver's engine
      const receiverRouter = IPSecEngine.findRouterByIP(receiverIP);
      if (receiverRouter) {
        const receiverEngine = (receiverRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
        if (receiverEngine) {
          receiverEngine.removeMulticastReceiverSA(msa.spi, groupAddress);
        }
      }
    }
    return true;
  }

  /**
   * Install a multicast SA on a receiver (called by the sender's engine).
   * The receiver stores it in its own multicastSADB for inbound lookup.
   */
  private installMulticastReceiverSA(senderMSA: MulticastIPSecSA): void {
    const key = multicastSAKey(senderMSA.spi, senderMSA.groupAddress);
    // Clone the SA for the receiver (shared keying material)
    const receiverMSA: MulticastIPSecSA = {
      ...senderMSA,
      // Receiver has its own stats
      pktsEncaps: 0,
      pktsDecaps: 0,
      sendErrors: 0,
      recvErrors: 0,
      bytesEncaps: 0,
      bytesDecaps: 0,
    };
    this.multicastSADB.set(key, receiverMSA);

    const groupKeys = this.multicastGroupIndex.get(senderMSA.groupAddress) || [];
    if (!groupKeys.includes(key)) {
      groupKeys.push(key);
      this.multicastGroupIndex.set(senderMSA.groupAddress, groupKeys);
    }
  }

  /**
   * Remove a multicast SA from a receiver.
   */
  private removeMulticastReceiverSA(spi: number, groupAddress: string): void {
    const key = multicastSAKey(spi, groupAddress);
    this.multicastSADB.delete(key);

    const groupKeys = this.multicastGroupIndex.get(groupAddress);
    if (groupKeys) {
      const idx = groupKeys.indexOf(key);
      if (idx >= 0) groupKeys.splice(idx, 1);
      if (groupKeys.length === 0) this.multicastGroupIndex.delete(groupAddress);
    }
  }

  /**
   * Delete a multicast SA entirely (sender-side).
   * Also removes it from all receivers.
   */
  deleteMulticastSA(groupAddress: string): void {
    const keys = this.multicastGroupIndex.get(groupAddress);
    if (!keys) return;

    for (const key of [...keys]) {
      const msa = this.multicastSADB.get(key);
      if (!msa) continue;

      // Remove from all receivers
      for (const receiverIP of msa.receivers) {
        const receiverRouter = IPSecEngine.findRouterByIP(receiverIP);
        if (receiverRouter) {
          const receiverEngine = (receiverRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
          if (receiverEngine) {
            receiverEngine.removeMulticastReceiverSA(msa.spi, groupAddress);
          }
        }
      }

      this.multicastSADB.delete(key);
    }
    this.multicastGroupIndex.delete(groupAddress);

    Logger.info(this.router.id, 'ipsec:mcast-sa-down',
      `${this.router.name}: Multicast IPSec SA deleted for group ${groupAddress}`);
  }

  /**
   * Find a multicast SA for outbound encapsulation (sender side).
   * Looks up by destination group address and verifies we are the authorized sender.
   */
  findMulticastSAForOutbound(groupAddress: string): MulticastIPSecSA | null {
    const keys = this.multicastGroupIndex.get(groupAddress);
    if (!keys) return null;

    const localIPs = this.getAllLocalIPs();

    for (const key of keys) {
      const msa = this.multicastSADB.get(key);
      if (!msa) continue;
      // Only the authorized sender can encrypt
      if (localIPs.includes(msa.senderAddress)) {
        // Check lifetime
        const elapsedSec = Math.floor((Date.now() - msa.created) / 1000);
        if (elapsedSec >= msa.lifetime) continue; // expired
        return msa;
      }
    }
    return null;
  }

  /**
   * Find a multicast SA for inbound decapsulation (receiver side).
   * Uses (SPI, group address) as the lookup key per RFC 4301 §4.1.
   */
  findMulticastSAForInbound(spi: number, groupAddress: string): MulticastIPSecSA | null {
    const key = multicastSAKey(spi, groupAddress);
    return this.multicastSADB.get(key) || null;
  }

  /** Get all local IP addresses on this router. */
  private getAllLocalIPs(): string[] {
    const ips: string[] = [];
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    for (const [, port] of ports) {
      const ip = port.getIPAddress?.();
      if (ip) ips.push(ip.toString());
    }
    return ips;
  }

  /** Get all multicast SAs (for show commands). */
  getMulticastSAs(): ReadonlyMap<string, MulticastIPSecSA> {
    return this.multicastSADB;
  }

  // ══════════════════════════════════════════════════════════════════
  // Multicast Data Plane (RFC 4301 §4.1)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Process an outbound packet destined for a multicast group.
   * Only the authorized sender can encapsulate.
   * Returns the encapsulated packet or null if no matching SA.
   */
  processMulticastOutbound(pkt: IPv4Packet, egressIface: string): IPv4Packet | null {
    const dstIP = pkt.destinationIP.toString();
    if (!isMulticastAddress(dstIP)) return null;

    const msa = this.findMulticastSAForOutbound(dstIP);
    if (!msa) return null;

    // Increment sequence number
    msa.outboundSeqNum++;
    msa.pktsEncaps++;
    msa.bytesEncaps += pkt.totalLength;

    // Determine local IP on egress interface
    const localIP = this.getLocalIP(egressIface);
    if (!localIP) {
      msa.sendErrors++;
      return null;
    }

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC(o): multicast encaps, group=${dstIP}, spi=${spiHex(msa.spi)}, seqnum=${msa.outboundSeqNum}`);
    }

    // Build outer packet — destination is the multicast group address
    const srcAddr = new IPAddress(localIP);
    const dstAddr = new IPAddress(dstIP);

    if (msa.hasESP) {
      const espPayload: ESPPacket = {
        type: 'esp',
        spi: msa.spi,
        sequenceNumber: msa.outboundSeqNum,
        innerPacket: pkt,
      };
      const outerSize = 20 + 8 + pkt.totalLength;
      const outerPkt = createIPv4Packet(srcAddr, dstAddr, IP_PROTO_ESP, 64, espPayload, outerSize);
      outerPkt.headerChecksum = computeIPv4Checksum(outerPkt);
      return outerPkt;
    } else if (msa.hasAH) {
      const ahPayload: AHPacket = {
        type: 'ah',
        spi: msa.spi,
        sequenceNumber: msa.outboundSeqNum,
        innerPacket: pkt,
      };
      const outerSize = 20 + 12 + pkt.totalLength;
      const outerPkt = createIPv4Packet(srcAddr, dstAddr, IP_PROTO_AH, 64, ahPayload, outerSize);
      outerPkt.headerChecksum = computeIPv4Checksum(outerPkt);
      return outerPkt;
    }

    msa.sendErrors++;
    return null;
  }

  /**
   * Process an inbound ESP packet that has a multicast destination.
   * Uses (SPI, group address) to find the correct multicast SA.
   */
  processMulticastInboundESP(outerPkt: IPv4Packet): IPv4Packet | null {
    const esp = outerPkt.payload as ESPPacket;
    if (!esp || esp.type !== 'esp') return null;

    const groupAddr = outerPkt.destinationIP.toString();
    const msa = this.findMulticastSAForInbound(esp.spi, groupAddr);
    if (!msa) {
      Logger.warn(this.router.id, 'ipsec:mcast-unknown-spi',
        `${this.router.name}: Unknown multicast ESP SPI ${spiHex(esp.spi)} for group ${groupAddr}`);
      return null;
    }

    msa.pktsDecaps++;
    msa.bytesDecaps += (esp.innerPacket?.totalLength || 0);

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC(i): multicast decaps ok, group=${groupAddr}, spi=${spiHex(esp.spi)}, seqnum=${esp.sequenceNumber}`);
    }

    return esp.innerPacket;
  }

  /**
   * Process an inbound AH packet that has a multicast destination.
   */
  processMulticastInboundAH(outerPkt: IPv4Packet): IPv4Packet | null {
    const ah = outerPkt.payload as AHPacket;
    if (!ah || ah.type !== 'ah') return null;

    const groupAddr = outerPkt.destinationIP.toString();
    const msa = this.findMulticastSAForInbound(ah.spi, groupAddr);
    if (!msa) return null;

    msa.pktsDecaps++;
    msa.bytesDecaps += (ah.innerPacket?.totalLength || 0);

    return ah.innerPacket;
  }

  /**
   * Check if a packet's destination is multicast and we have an SA for it.
   * Used by the forwarding pipeline to decide if multicast IPsec applies.
   */
  hasMulticastSA(groupAddress: string): boolean {
    return this.multicastGroupIndex.has(groupAddress);
  }

  /**
   * Check if a destination IP is a multicast address.
   */
  isMulticast(ip: string): boolean {
    return isMulticastAddress(ip);
  }

  // ══════════════════════════════════════════════════════════════════
  // Data plane: outbound packet processing
  // ══════════════════════════════════════════════════════════════════

  /**
   * Check if a packet leaving via `egressIface` should be encrypted.
   * Returns the matching CryptoMapEntry (or null if no match).
   */
  findMatchingCryptoEntry(pkt: IPv4Packet, egressIface: string): CryptoMapEntry | null {
    // Already-encapsulated IPSec packets must not be re-encrypted (mirrors real IOS behavior)
    if (pkt.protocol === IP_PROTO_ESP || pkt.protocol === IP_PROTO_AH) return null;

    const mapName = this.ifaceCryptoMap.get(egressIface);
    if (!mapName) {
      // Check tunnel protection
      const tp = this.tunnelProtection.get(egressIface);
      if (tp) return this.buildTunnelProtectionEntry(egressIface, tp);
      return null;
    }
    const cmap = this.cryptoMaps.get(mapName);
    if (!cmap) return null;

    // Check static entries first (lowest seq wins)
    const seqs = [...cmap.staticEntries.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const entry = cmap.staticEntries.get(seq)!;
      if (entry.aclName && this.matchACL(entry.aclName, pkt)) {
        return entry;
      }
    }

    // Check dynamic map entries
    const dynSeqs = [...cmap.dynamicEntries.keys()].sort((a, b) => a - b);
    for (const seq of dynSeqs) {
      const dynMapName = cmap.dynamicEntries.get(seq)!;
      const dynMap = this.dynamicCryptoMaps.get(dynMapName);
      if (!dynMap) continue;
      for (const [, dynEntry] of dynMap.entries) {
        if (!dynEntry.aclName || this.matchACL(dynEntry.aclName, pkt)) {
          // Build a synthetic CryptoMapEntry for the dynamic case
          return {
            seq: -1,
            type: 'ipsec-isakmp',
            peers: ['0.0.0.0'],   // any peer
            transformSets: dynEntry.transformSets,
            aclName: dynEntry.aclName || '',
            pfsGroup: dynEntry.pfsGroup,
          };
        }
      }
    }
    return null;
  }

  private buildTunnelProtectionEntry(ifName: string, tp: TunnelProtection): CryptoMapEntry | null {
    const profile = this.ipsecProfiles.get(tp.profileName);
    if (!profile) return null;
    return {
      seq: 1,
      type: 'ipsec-isakmp',
      peers: [],   // determined by tunnel destination
      transformSets: [profile.transformSetName],
      aclName: '',
      saLifetimeSeconds: profile.saLifetimeSeconds,
    };
  }

  /**
   * Process an outbound packet: negotiate SA if needed, then wrap in ESP/AH.
   * Returns the outer IPv4 packet(s) (ESP-encapsulated) or null if failed.
   * May return multiple packets when post-encapsulation fragmentation is needed.
   */
  processOutbound(pkt: IPv4Packet, egressIface: string, entry: CryptoMapEntry): IPv4Packet[] | null {
    // Check if egress port is actually up (cable connected)
    // Skip this check for virtual interfaces (Tunnel, Loopback, Serial sub-if) which have no cable
    const isVirtualIface = /^(Tunnel|Loopback)/i.test(egressIface);
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    const outPort = ports.get(egressIface);
    if (!isVirtualIface && outPort && typeof outPort.isConnected === 'function' && !outPort.isConnected()) {
      // Port is down — trigger DPD-like SA clearing for any peer on this interface
      const peerIP = this.determinePeer(entry, egressIface, pkt);
      if (peerIP) {
        // Clear existing SAs for this unreachable peer (DPD on-demand behavior)
        this.clearSAsForPeer(peerIP);
      }
      return null;
    }

    // Determine peer IP
    let peerIP = this.determinePeer(entry, egressIface, pkt);
    if (!peerIP) return null;

    // Get or establish SA
    let sa = this.getBestIPSecSA(peerIP);

    // Check if SA has expired (lifetime-based rekeying) or sequence overflow
    // ESN SAs only overflow when both high and low 32 bits are exhausted
    const seqOverflow = sa ? (sa.esnEnabled
      ? (sa.outboundSeqNum >= SEQ_NUM_MAX && sa.outboundSeqNumHigh >= SEQ_NUM_MAX)
      : sa.outboundSeqNum >= SEQ_NUM_MAX) : false;
    if (sa && (this.isSAExpired(sa) || seqOverflow)) {
      if (this.debugIpsec) {
        const reason = seqOverflow ? 'sequence number overflow' : 'lifetime expired';
        Logger.info(this.router.id, 'debug:ipsec',
          `IPSEC: SA with ${peerIP} ${reason}, initiating rekey`);
      }
      this.clearSAsForPeer(peerIP);
      sa = null;
    }

    if (!sa) {
      const ok = this.negotiateTunnel(peerIP, entry, egressIface);
      if (!ok) return null;
      sa = this.getBestIPSecSA(peerIP);
      if (!sa) return null;
    }

    // Wrap in ESP (or AH for AH-only)
    const outerPkt = this.encapsulate(pkt, sa, egressIface);
    if (!outerPkt) return null;

    // ── RFC 4301 §8.2: Post-encapsulation fragmentation ──
    // If the outer packet exceeds the path MTU and DF is NOT set in the
    // outer header, fragment the outer (encapsulated) packet.
    if (outerPkt.totalLength > sa.pathMTU && (outerPkt.flags & 0b010) === 0) {
      const fragments = fragmentIPv4Packet(outerPkt, sa.pathMTU);
      if (this.debugIpsec) {
        Logger.info(this.router.id, 'debug:ipsec',
          `IPSEC: post-encap fragmentation: ${outerPkt.totalLength} > MTU ${sa.pathMTU}, ${fragments.length} fragments`);
      }
      return fragments;
    }

    return [outerPkt];
  }

  /**
   * Check if an SA has expired based on time or kilobyte lifetime.
   */
  private isSAExpired(sa: IPSec_SA): boolean {
    // Time-based expiration
    const elapsedSec = Math.floor((Date.now() - sa.created) / 1000);
    if (elapsedSec >= sa.lifetime) return true;

    // Volume-based expiration (kilobytes)
    if (sa.lifetimeKB > 0) {
      const usedKB = Math.floor((sa.bytesEncaps + sa.bytesDecaps) / 1024);
      if (usedKB >= sa.lifetimeKB) return true;
    }

    return false;
  }

  private determinePeer(entry: CryptoMapEntry, egressIface: string, pkt: IPv4Packet): string | null {
    if (entry.peers.length > 0 && entry.peers[0] !== '0.0.0.0') {
      // Try primary peer first, then backup peers — check reachability
      for (const peerIP of entry.peers) {
        const peerRouter = IPSecEngine.findRouterByIP(peerIP);
        if (!peerRouter) continue;
        // Verify we can actually reach this peer (route via connected interface)
        try {
          const peerAddr = new IPAddress(peerIP);
          const route = (this.router as any).lookupRoute?.(peerAddr);
          if (route) return peerIP;
        } catch {
          // lookupRoute throws or no route — peer unreachable, try next
          continue;
        }
      }
      // If none reachable, return first peer (will fail gracefully)
      return entry.peers[0];
    }
    // Tunnel protection: peer is the tunnel destination (from config)
    const extraConfig = (this.router as any).ospfExtraConfig?.pendingIfConfig;
    if (extraConfig) {
      const tunCfg = extraConfig.get(egressIface);
      if (tunCfg?.tunnelDest) return tunCfg.tunnelDest;
    }
    // Fallback: check port method
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    const port = ports.get(egressIface);
    if (port) {
      const tunnelDst = port.getTunnelDestination?.();
      if (tunnelDst) return tunnelDst.toString();
    }
    // Dynamic crypto map: use routing table next-hop as peer
    try {
      const route = (this.router as any).lookupRoute?.(pkt.destinationIP);
      if (route && route.nextHop) return route.nextHop.toString();
    } catch { /* ignore */ }
    // Last resort: packet destination
    return pkt.destinationIP.toString();
  }

  private getBestIPSecSA(peerIP: string): IPSec_SA | null {
    const sas = this.ipsecSADB.get(peerIP);
    return sas && sas.length > 0 ? sas[0] : null;
  }

  private encapsulate(innerPkt: IPv4Packet, sa: IPSec_SA, egressIface: string): IPv4Packet | null {
    // Determine local IP on egress interface
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    let localIP: IPAddress | null = null;
    for (const [name, port] of ports) {
      if (name === egressIface) {
        localIP = port.getIPAddress?.() || null;
        break;
      }
    }
    if (!localIP) return null;

    // ── RFC 4301 §7: Stateful Fragment Checking ──
    // In tunnel mode, fragments should be reassembled before IPsec processing.
    // Check if the inner packet is a fragment (MF set or offset > 0).
    // MF = bit 2 of flags field (0b100 = 0x4).
    if (sa.statefulFragCheck && sa.mode === 'Tunnel') {
      const mfSet = (innerPkt.flags & 0b100) !== 0; // MF flag = bit 2
      const isFragment = mfSet || innerPkt.fragmentOffset !== 0;
      if (isFragment) {
        // Buffer the fragment for reassembly
        const reassembled = this.bufferFragment(innerPkt);
        if (reassembled) {
          // All fragments received — continue with reassembled packet
          innerPkt = reassembled;
          if (this.debugIpsec) {
            Logger.info(this.router.id, 'debug:ipsec',
              `IPSEC: fragments reassembled for SA ${spiHex(sa.spiOut)}, total=${reassembled.totalLength}`);
          }
        } else {
          // Still waiting for more fragments — do not encapsulate yet
          if (this.debugIpsec) {
            Logger.info(this.router.id, 'debug:ipsec',
              `IPSEC: fragment buffered for SA ${spiHex(sa.spiOut)}, awaiting reassembly`);
          }
          return null;
        }
      }
    }

    // ── RFC 4301 §8.2: Path MTU Check ──
    // After encapsulation, the outer packet must not exceed the path MTU.
    this.lastEncapICMP = null; // reset
    const overhead = computeIPSecOverhead(sa.hasESP, sa.hasAH);
    const estimatedOuterSize = innerPkt.totalLength + overhead;
    if (estimatedOuterSize > sa.pathMTU) {
      // Check inner packet DF bit (bit 1 = 0b010)
      const innerDF = (innerPkt.flags & 0b010) !== 0;
      if (innerDF && sa.dfBitPolicy !== 'clear') {
        // RFC 4301 §8.1: MUST send ICMP Fragmentation Needed (Type 3, Code 4)
        // with Next-Hop MTU = pathMTU - overhead (the maximum inner size)
        if (this.debugIpsec) {
          Logger.info(this.router.id, 'debug:ipsec',
            `IPSEC: packet too large (${estimatedOuterSize} > MTU ${sa.pathMTU}), DF set, sending ICMP`);
        }
        this.lastEncapICMP = {
          mtu: sa.ipMTU, // inner MTU the sender should use
          originalPkt: innerPkt,
        };
        sa.sendErrors++;
        return null;
      }
      // If DF is clear or dfBitPolicy='clear', fragmentation happens post-encapsulation (below)
    }

    // ── RFC 4303 §3.3.3 / §2.2.1: Sequence Number Overflow Handling ──
    if (sa.outboundSeqNum >= SEQ_NUM_MAX) {
      if (sa.esnEnabled) {
        // ESN: roll over low 32 bits, increment high 32 bits
        sa.outboundSeqNumHigh++;
        sa.outboundSeqNum = 0;
        if (sa.outboundSeqNumHigh >= SEQ_NUM_MAX) {
          // Full 64-bit space exhausted — must rekey
          if (this.debugIpsec) {
            Logger.info(this.router.id, 'debug:ipsec',
              `IPSEC: ESN 64-bit sequence number overflow on SA with ${sa.peerIP}, triggering rekey`);
          }
          if (sa.seqOverflowFlag) {
            sa.sendErrors++;
            return null;
          }
        }
      } else {
        // Standard 32-bit: RFC 4301 says MUST generate auditable event
        if (this.debugIpsec) {
          Logger.info(this.router.id, 'debug:ipsec',
            `IPSEC: sequence number overflow on SA with ${sa.peerIP}, triggering rekey`);
        }
        if (sa.seqOverflowFlag) {
          sa.sendErrors++;
          return null;
        }
      }
    }

    sa.pktsEncaps++;
    sa.outboundSeqNum++;
    sa.bytesEncaps += innerPkt.totalLength;

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC(o): sa created, (sa) sa_dest=${sa.peerIP}, spi=${spiHex(sa.spiOut)}, seqnum=${sa.outboundSeqNum}`);
    }

    // ── RFC 4301 §5.1.2: Compute outer header TOS (DSCP+ECN) ──
    const outerTos = this.computeOuterTos(innerPkt, sa);

    // ── RFC 4301 §8.1: Compute outer DF bit ──
    const outerFlags = this.computeOuterFlags(innerPkt, sa);

    /** Helper: create outer IP packet with SA-derived TOS and flags. */
    const makeOuterPkt = (proto: number, payload: ESPPacket | AHPacket, size: number): IPv4Packet => {
      const pkt = createIPv4Packet(localIP!, new IPAddress(sa.peerIP), proto, 64, payload, size);
      pkt.tos = outerTos;
      pkt.flags = outerFlags;
      pkt.headerChecksum = computeIPv4Checksum(pkt);
      return pkt;
    };

    // SA Bundle (RFC 4301 §4.5): when both AH and ESP are present,
    // apply ESP first (encryption), then AH (integrity of outer header).
    // Order: inner → ESP encapsulation → AH authentication
    if (sa.hasESP && sa.hasAH) {
      // Step 1: ESP encapsulate
      const espPayload: ESPPacket = {
        type: 'esp',
        spi: sa.spiOut,
        sequenceNumber: sa.outboundSeqNum,
        innerPacket: innerPkt,
      };
      const espSize = 20 + 8 + innerPkt.totalLength;
      const espPkt = makeOuterPkt(IP_PROTO_ESP, espPayload, espSize);
      // Step 2: AH wrap the ESP packet
      const ahPayload: AHPacket = {
        type: 'ah',
        spi: sa.spiOut,
        sequenceNumber: sa.outboundSeqNum,
        innerPacket: espPkt,
      };
      const outerSize = 20 + 12 + espSize;
      return makeOuterPkt(IP_PROTO_AH, ahPayload, outerSize);
    } else if (sa.hasESP) {
      const espPayload: ESPPacket = {
        type: 'esp',
        spi: sa.spiOut,
        sequenceNumber: sa.outboundSeqNum,
        innerPacket: innerPkt,
      };
      // NAT-T: wrap ESP in UDP 4500 (RFC 3948)
      if (sa.natT) {
        const udpPayload: UDPPacket = {
          type: 'udp',
          sourcePort: UDP_PORT_IKE_NAT_T,
          destinationPort: UDP_PORT_IKE_NAT_T,
          length: 8 + 8 + innerPkt.totalLength, // UDP header + ESP header + inner
          checksum: 0,
          payload: espPayload,
        };
        const outerSize = 20 + 8 + 8 + innerPkt.totalLength; // IP + UDP + ESP + inner
        return makeOuterPkt(IP_PROTO_UDP, udpPayload, outerSize);
      }
      const outerSize = 20 + 8 + innerPkt.totalLength; // IP + ESP header + inner
      return makeOuterPkt(IP_PROTO_ESP, espPayload, outerSize);
    } else if (sa.hasAH) {
      const ahPayload: AHPacket = {
        type: 'ah',
        spi: sa.spiOut,
        sequenceNumber: sa.outboundSeqNum,
        innerPacket: innerPkt,
      };
      const outerSize = 20 + 12 + innerPkt.totalLength;
      return makeOuterPkt(IP_PROTO_AH, ahPayload, outerSize);
    }
    return null;
  }

  // ── RFC 4301 §5.1.2: DSCP/ECN handling for tunnel header ──────────

  /**
   * Compute the TOS byte for the outer tunnel header per RFC 4301 §5.1.2.
   *   - DSCP (bits 7-2): controlled by SA's dscpEcnConfig
   *   - ECN  (bits 1-0): per RFC 6040
   */
  private computeOuterTos(innerPkt: IPv4Packet, sa: IPSec_SA): number {
    const innerDscp = (innerPkt.tos >> 2) & 0x3f; // bits 7-2
    const innerEcn  = innerPkt.tos & 0x03;         // bits 1-0

    let outerDscp: number;
    switch (sa.dscpEcnConfig.dscpMode) {
      case 'copy':
        outerDscp = innerDscp;
        break;
      case 'set':
        outerDscp = sa.dscpEcnConfig.dscpValue & 0x3f;
        break;
      case 'map':
        outerDscp = sa.dscpEcnConfig.dscpMap.get(innerDscp) ?? innerDscp;
        break;
      default:
        outerDscp = innerDscp;
    }

    // RFC 6040: copy ECN if enabled, otherwise clear
    const outerEcn = sa.dscpEcnConfig.ecnEnabled ? innerEcn : 0;

    return (outerDscp << 2) | outerEcn;
  }

  /**
   * After inbound decapsulation (tunnel mode), propagate ECN marks
   * from the outer header to the inner header per RFC 6040 §4.
   */
  private propagateEcnOnDecap(outerPkt: IPv4Packet, innerPkt: IPv4Packet, sa: IPSec_SA): void {
    if (!sa.dscpEcnConfig.ecnEnabled) return;
    if (sa.mode !== 'Tunnel') return;

    const outerEcn = outerPkt.tos & 0x03;
    // RFC 6040: if outer has CE (Congestion Experienced = 0b11), set inner CE too
    if (outerEcn === 0b11) {
      innerPkt.tos = (innerPkt.tos & 0xfc) | 0b11;
    }
  }

  // ── RFC 4301 §8.1: DF bit policy for outer header ─────────────────

  /**
   * Compute the flags field for the outer tunnel header.
   * Controls the DF bit per the SA's dfBitPolicy.
   */
  private computeOuterFlags(innerPkt: IPv4Packet, sa: IPSec_SA): number {
    switch (sa.dfBitPolicy) {
      case 'copy':
        return innerPkt.flags; // preserve DF from inner
      case 'set':
        return innerPkt.flags | 0b010; // force DF on
      case 'clear':
        return innerPkt.flags & ~0b010; // force DF off
      default:
        return innerPkt.flags;
    }
  }

  // ── RFC 4301 §8.2: Path MTU management ─────────────────────────────

  /**
   * Update the path MTU for an SA, typically called when an ICMP
   * "Fragmentation Needed" (type 3, code 4) is received referencing
   * this SA's outer packets. Per RFC 1191 §6.3.
   */
  updatePathMTU(spi: number, newMTU: number): void {
    const sa = this.spiToSA.get(spi);
    if (!sa) return;

    if (newMTU < 576) newMTU = 576; // RFC 791 minimum
    if (newMTU > 65535) return;

    sa.pathMTU = newMTU;
    const overhead = computeIPSecOverhead(sa.hasESP, sa.hasAH);
    sa.ipMTU = Math.max(0, newMTU - overhead);
    sa.pathMTULastUpdated = Date.now();

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC: Path MTU updated for SA ${spiHex(spi)}: pathMTU=${sa.pathMTU} ipMTU=${sa.ipMTU}`);
    }
  }

  /**
   * Age Path MTU values (RFC 1191 §6.3: increase PMTU after timeout).
   * Call periodically (e.g. every 10 minutes). If a PMTU value is older
   * than ageThresholdMs, reset it to DEFAULT_PATH_MTU.
   */
  agePathMTU(ageThresholdMs: number = 600000): void {
    const now = Date.now();
    for (const [, sas] of this.ipsecSADB) {
      for (const sa of sas) {
        if (sa.pathMTU < DEFAULT_PATH_MTU && (now - sa.pathMTULastUpdated) > ageThresholdMs) {
          sa.pathMTU = DEFAULT_PATH_MTU;
          const overhead = computeIPSecOverhead(sa.hasESP, sa.hasAH);
          sa.ipMTU = DEFAULT_PATH_MTU - overhead;
          sa.pathMTULastUpdated = now;
        }
      }
    }
  }

  // ── RFC 4301 §7: Fragment Reassembly ─────────────────────────────

  /**
   * Buffer an IP fragment for pre-IPsec reassembly (RFC 4301 §7).
   * In tunnel mode with stateful fragment checking enabled, IP fragments
   * destined for IPsec processing are reassembled BEFORE encryption.
   *
   * Returns the reassembled packet when all fragments are collected,
   * or null if still waiting for more fragments.
   */
  private bufferFragment(pkt: IPv4Packet): IPv4Packet | null {
    const key = fragGroupKey(pkt);
    const mfSet = (pkt.flags & 0b100) !== 0;
    const offsetBytes = pkt.fragmentOffset * 8;
    const headerLen = pkt.ihl * 4;
    const dataLength = pkt.totalLength - headerLen;

    const entry: FragmentEntry = {
      packet: pkt,
      offsetBytes,
      dataLength,
      isLast: !mfSet,
    };

    let group = this.fragBuffer.get(key);
    if (!group) {
      // Enforce maximum tracked fragment groups
      if (this.fragBuffer.size >= MAX_FRAG_GROUPS) {
        // Evict oldest group
        const oldestKey = this.fragBuffer.keys().next().value;
        if (oldestKey !== undefined) {
          const oldest = this.fragBuffer.get(oldestKey);
          if (oldest) clearTimeout(oldest.timer);
          this.fragBuffer.delete(oldestKey);
        }
      }

      // Start reassembly timer
      const timer = setTimeout(() => {
        this.fragBuffer.delete(key);
        if (this.debugIpsec) {
          Logger.info(this.router.id, 'debug:ipsec',
            `IPSEC: fragment reassembly timeout for group ${key}`);
        }
      }, FRAG_REASSEMBLY_TIMEOUT_MS);

      group = {
        fragments: [],
        totalDataLength: -1,
        timer,
        created: Date.now(),
      };
      this.fragBuffer.set(key, group);
    }

    // Add fragment (avoid duplicates by offset)
    const exists = group.fragments.some(f => f.offsetBytes === offsetBytes);
    if (!exists) {
      group.fragments.push(entry);
    }

    // If this is the last fragment, we now know the total data length
    if (entry.isLast) {
      group.totalDataLength = offsetBytes + dataLength;
    }

    // Check if reassembly is complete
    if (group.totalDataLength < 0) return null; // don't know total yet

    // Sort fragments by offset and check for contiguous coverage
    const sorted = [...group.fragments].sort((a, b) => a.offsetBytes - b.offsetBytes);
    let covered = 0;
    for (const frag of sorted) {
      if (frag.offsetBytes > covered) return null; // gap
      covered = Math.max(covered, frag.offsetBytes + frag.dataLength);
    }

    if (covered < group.totalDataLength) return null; // still incomplete

    // ── Reassembly complete ──
    clearTimeout(group.timer);
    this.fragBuffer.delete(key);

    // Use the first fragment's header (offset=0) as the reassembled packet header
    const firstFrag = sorted.find(f => f.offsetBytes === 0);
    if (!firstFrag) return null; // missing first fragment header

    // Build the reassembled packet from the first fragment
    const reassembled: IPv4Packet = {
      ...firstFrag.packet,
      flags: firstFrag.packet.flags & ~0b100, // clear MF
      fragmentOffset: 0,
      totalLength: headerLen + group.totalDataLength,
      headerChecksum: 0,
    };
    reassembled.headerChecksum = computeIPv4Checksum(reassembled);

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC: reassembled ${sorted.length} fragments, total=${reassembled.totalLength} bytes`);
    }

    return reassembled;
  }

  /**
   * Clear all fragment reassembly state (called on SA teardown or engine reset).
   */
  clearFragmentBuffer(): void {
    for (const [, group] of this.fragBuffer) {
      clearTimeout(group.timer);
    }
    this.fragBuffer.clear();
  }

  // ══════════════════════════════════════════════════════════════════
  // Data plane: inbound ESP/AH decapsulation
  // ══════════════════════════════════════════════════════════════════

  processInboundESP(outerPkt: IPv4Packet): IPv4Packet | null {
    const esp = outerPkt.payload as ESPPacket;
    if (!esp || esp.type !== 'esp') return null;

    const sa = this.spiToSA.get(esp.spi);
    if (!sa) {
      Logger.warn(this.router.id, 'ipsec:unknown-spi',
        `${this.router.name}: Unknown inbound ESP SPI ${spiHex(esp.spi)}, dropping`);
      return null;
    }

    // Anti-replay check (RFC 4303)
    if (!this.checkAntiReplay(sa, esp.sequenceNumber)) {
      sa.pktsReplay++;
      sa.recvErrors++;
      if (this.debugIpsec) {
        Logger.info(this.router.id, 'debug:ipsec',
          `IPSEC(i): anti-replay check FAILED, spi=${spiHex(esp.spi)}, seq=${esp.sequenceNumber}`);
      }
      return null;
    }

    sa.pktsDecaps++;
    sa.bytesDecaps += (esp.innerPacket?.totalLength || 0);

    // RFC 6040: propagate ECN congestion marks from outer to inner
    if (esp.innerPacket) {
      this.propagateEcnOnDecap(outerPkt, esp.innerPacket, sa);
    }

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC(i): decaps ok, spi=${spiHex(esp.spi)}, seqnum=${esp.sequenceNumber}`);
    }
    return esp.innerPacket;
  }

  processInboundAH(outerPkt: IPv4Packet): IPv4Packet | null {
    const ah = outerPkt.payload as AHPacket;
    if (!ah || ah.type !== 'ah') return null;

    const sa = this.spiToSA.get(ah.spi);
    if (!sa) return null;

    // Anti-replay check
    if (!this.checkAntiReplay(sa, ah.sequenceNumber)) {
      sa.pktsReplay++;
      sa.recvErrors++;
      return null;
    }

    sa.pktsDecaps++;
    sa.bytesDecaps += (ah.innerPacket?.totalLength || 0);

    // SA bundle (RFC 4301 §4.5): combined AH+ESP — unwrap both layers here
    // to avoid double anti-replay check on the inner ESP (same SA, same seq num)
    if (ah.innerPacket && ah.innerPacket.protocol === IP_PROTO_ESP) {
      const esp = ah.innerPacket.payload as ESPPacket;
      if (esp && esp.type === 'esp') {
        sa.pktsDecaps++;
        sa.bytesDecaps += (esp.innerPacket?.totalLength || 0);
        if (esp.innerPacket) {
          this.propagateEcnOnDecap(outerPkt, esp.innerPacket, sa);
        }
        return esp.innerPacket;
      }
    }

    // RFC 6040: propagate ECN congestion marks from outer to inner
    if (ah.innerPacket) {
      this.propagateEcnOnDecap(outerPkt, ah.innerPacket, sa);
    }

    return ah.innerPacket;
  }

  /**
   * RFC 4303 anti-replay window check.
   * Supports window sizes up to 1024 bits using a Uint32Array bitmap.
   * Returns true if the packet is acceptable, false if it's a replay.
   */
  private checkAntiReplay(sa: IPSec_SA, seqNum: number): boolean {
    if (sa.replayWindowSize === 0) return true; // anti-replay disabled
    if (seqNum === 0) return false; // seq 0 is invalid per RFC 4303

    // RFC 4303 §3.4.3: ESN anti-replay uses 64-bit sequence space.
    // The received packet only carries the low 32 bits; the receiver
    // infers the high 32 bits from context (current window position).
    if (sa.esnEnabled) {
      return this.checkAntiReplayESN(sa, seqNum);
    }

    const windowSize = sa.replayWindowSize;
    const bitmap = sa.replayBitmap;
    const lastSeq = sa.replayWindowLastSeq;

    if (seqNum > lastSeq) {
      // New packet ahead of window — slide bitmap forward
      const shift = seqNum - lastSeq;
      if (shift < windowSize) {
        this.bitmapShiftLeft(bitmap, shift);
        this.bitmapSetBit(bitmap, 0); // mark current position
      } else {
        // Completely new window — clear and set bit 0
        bitmap.fill(0);
        this.bitmapSetBit(bitmap, 0);
      }
      sa.replayWindowLastSeq = seqNum;
      return true;
    }

    const diff = lastSeq - seqNum;
    if (diff >= windowSize) {
      // Too old, falls outside the window
      return false;
    }

    // Check if already seen
    if (this.bitmapGetBit(bitmap, diff)) {
      return false; // duplicate
    }

    // Mark as seen
    this.bitmapSetBit(bitmap, diff);
    return true;
  }

  /**
   * RFC 4303 §3.4.3 Appendix A: ESN anti-replay check.
   * The receiver reconstructs the full 64-bit sequence number from the
   * 32-bit value in the packet and the locally tracked high-order bits.
   */
  private checkAntiReplayESN(sa: IPSec_SA, seqLow: number): boolean {
    const windowSize = sa.replayWindowSize;
    const bitmap = sa.replayBitmap;
    const lastSeqLow = sa.replayWindowLastSeq;
    const lastSeqHigh = sa.replayWindowLastSeqHigh;

    // Reconstruct full 64-bit sequence: determine the high 32 bits
    let seqHigh: number;
    if (seqLow >= lastSeqLow) {
      // Same high-order epoch — no wraparound
      seqHigh = lastSeqHigh;
    } else {
      // Low bits wrapped around — the high bits incremented
      seqHigh = lastSeqHigh + 1;
    }

    // Compare 64-bit values using (high, low) tuple
    const isAhead = seqHigh > lastSeqHigh ||
      (seqHigh === lastSeqHigh && seqLow > lastSeqLow);

    if (isAhead) {
      // Advance window — compute shift in 32-bit space (simplified for simulator)
      const shift = seqHigh === lastSeqHigh
        ? seqLow - lastSeqLow
        : seqLow + (SEQ_NUM_MAX - lastSeqLow) + 1;

      if (shift < windowSize) {
        this.bitmapShiftLeft(bitmap, shift);
        this.bitmapSetBit(bitmap, 0);
      } else {
        bitmap.fill(0);
        this.bitmapSetBit(bitmap, 0);
      }
      sa.replayWindowLastSeq = seqLow;
      sa.replayWindowLastSeqHigh = seqHigh;
      return true;
    }

    // Packet is within or behind the window — compute position
    const diff = seqHigh === lastSeqHigh
      ? lastSeqLow - seqLow
      : lastSeqLow + (SEQ_NUM_MAX - seqLow) + 1;

    if (diff >= windowSize) {
      return false; // too old
    }
    if (this.bitmapGetBit(bitmap, diff)) {
      return false; // duplicate
    }
    this.bitmapSetBit(bitmap, diff);
    return true;
  }

  // ── Bitmap helpers for Uint32Array-based anti-replay window ─────

  private bitmapSetBit(bitmap: Uint32Array, bit: number): void {
    const wordIdx = bit >>> 5;     // bit / 32
    const bitIdx  = bit & 0x1f;    // bit % 32
    if (wordIdx < bitmap.length) {
      bitmap[wordIdx] |= (1 << bitIdx);
    }
  }

  private bitmapGetBit(bitmap: Uint32Array, bit: number): boolean {
    const wordIdx = bit >>> 5;
    const bitIdx  = bit & 0x1f;
    if (wordIdx >= bitmap.length) return false;
    return (bitmap[wordIdx] & (1 << bitIdx)) !== 0;
  }

  /**
   * Shift the entire bitmap left by `count` bits (higher indices → lower).
   * Equivalent to sliding the replay window forward.
   */
  private bitmapShiftLeft(bitmap: Uint32Array, count: number): void {
    if (count <= 0) return;
    if (count >= bitmap.length * 32) {
      bitmap.fill(0);
      return;
    }
    const wordShift = count >>> 5;
    const bitShift  = count & 0x1f;

    if (wordShift > 0) {
      // Shift whole words
      for (let i = bitmap.length - 1; i >= 0; i--) {
        bitmap[i] = i >= wordShift ? bitmap[i - wordShift] : 0;
      }
    }
    if (bitShift > 0) {
      // Shift remaining bits within words (MSB direction)
      for (let i = bitmap.length - 1; i >= 0; i--) {
        bitmap[i] = (bitmap[i] << bitShift) | (i > 0 ? (bitmap[i - 1] >>> (32 - bitShift)) : 0);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // IKE Negotiation (synchronous, direct engine-to-engine)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Initiate IKEv1/IKEv2 tunnel establishment with a peer.
   * Synchronous — completes immediately by directly calling the peer's engine.
   */
  private negotiateTunnel(peerIP: string, entry: CryptoMapEntry, egressIface: string): boolean {
    // Check if egress port is actually up (cable connected)
    // Skip this check for virtual interfaces (Tunnel, Loopback) which have no cable
    const isVirtualIface = /^(Tunnel|Loopback)/i.test(egressIface);
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    const outPort = ports.get(egressIface);
    if (!isVirtualIface && outPort && typeof outPort.isConnected === 'function' && !outPort.isConnected()) {
      Logger.info(this.router.id, 'ipsec:port-down',
        `${this.router.name}: IKE negotiation failed — interface ${egressIface} is down`);
      this.createFailedIKESA(peerIP, egressIface, 'Interface down');
      return false;
    }

    // Find peer router (may be directly reachable or behind NAT)
    let peerRouter = IPSecEngine.findRouterByIP(peerIP);
    let forceNatT = false;

    // NAT-T: if peerIP is not a Router, check if it's a NAT device with DNAT rules
    if (!peerRouter) {
      const natResult = IPSecEngine.findRouterBehindNAT(peerIP);
      if (natResult) {
        peerRouter = natResult.router;
        forceNatT = true; // Peer is behind NAT — force NAT-T
      }
    }

    if (!peerRouter) {
      Logger.info(this.router.id, 'ipsec:no-peer',
        `${this.router.name}: IKE peer ${peerIP} unreachable`);
      // Create stub IKE SA in failed state for display purposes
      this.createFailedIKESA(peerIP, egressIface, 'Peer unreachable');
      return false;
    }

    const peerEngine = (peerRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
    if (!peerEngine) return false;

    // Peer must have a crypto map applied to at least one interface (or tunnel protection)
    // to act as an IKE responder — just like a real Cisco router
    if (peerEngine.ifaceCryptoMap.size === 0 && peerEngine.tunnelProtection.size === 0) {
      Logger.info(this.router.id, 'ipsec:no-peer-crypto',
        `${this.router.name}: Peer ${peerIP} has no crypto map applied`);
      this.createFailedIKESA(peerIP, egressIface, 'Peer no crypto map');
      return false;
    }

    // Determine my local IP (on egress interface)
    const localIP = this.getLocalIP(egressIface) || '';
    // Compute apparent source IP (may differ if NAT is on path)
    const apparentSrcIP = this.getApparentSourceIP(localIP, peerIP);

    // Check IKEv2 profile
    const useIKEv2 = entry.ikev2ProfileName
      ? this.ikev2Profiles.has(entry.ikev2ProfileName)
      : this.ikev2Policies.size > 0 && this.ikev2Keyrings.size > 0 && this.ikev2Profiles.size > 0;

    if (useIKEv2) {
      return this.negotiateIKEv2(peerIP, peerEngine, entry, localIP, apparentSrcIP, egressIface, forceNatT);
    }
    return this.negotiateIKEv1(peerIP, peerEngine, entry, localIP, apparentSrcIP, egressIface, forceNatT);
  }

  // ── IKEv1 ──────────────────────────────────────────────────────

  private negotiateIKEv1(
    peerIP: string, peerEngine: IPSecEngine, entry: CryptoMapEntry,
    localIP: string, apparentSrcIP: string, egressIface: string,
    forceNatT: boolean = false,
  ): boolean {
    // Phase 1: find matching ISAKMP policy
    const myPolicies = [...this.isakmpPolicies.values()].sort((a, b) => a.priority - b.priority);
    const peerPolicies = [...peerEngine.isakmpPolicies.values()].sort((a, b) => a.priority - b.priority);

    let matchedPolicy: ISAKMPPolicy | null = null;
    let matchedPeerPolicy: ISAKMPPolicy | null = null;
    for (const mp of myPolicies) {
      for (const pp of peerPolicies) {
        if (this.policiesCompatible(mp, pp)) { matchedPolicy = mp; matchedPeerPolicy = pp; break; }
      }
      if (matchedPolicy) break;
    }

    // Determine exchange mode: aggressive if either side has it enabled
    const useAggressive = this.aggressiveMode || peerEngine.aggressiveMode;
    const modeName = useAggressive ? 'Aggressive' : 'Main';

    if (this.debugIsakmp) {
      Logger.info(this.router.id, 'debug:isakmp',
        `ISAKMP: begin IKE ${modeName} Mode exchange with ${peerIP}`);
      for (const mp of myPolicies) {
        Logger.info(this.router.id, 'debug:isakmp',
          `ISAKMP: sending policy ${mp.priority} enc=${mp.encryption} hash=${mp.hash} auth=${mp.auth} group=${mp.group}`);
      }
    }

    if (!matchedPolicy) {
      if (this.debugIsakmp) {
        Logger.info(this.router.id, 'debug:isakmp',
          `ISAKMP: (0:0): phase 1 SA policy not acceptable! (local:${myPolicies.length} remote:${peerPolicies.length})`);
      }
      Logger.info(this.router.id, 'ipsec:no-policy', `${this.router.name}: No common IKE policy with ${peerIP}`);
      this.createFailedIKESA(peerIP, egressIface, 'No matching policy');
      peerEngine.createFailedIKESA(apparentSrcIP, '', 'No matching policy');
      return false;
    }

    // Verify PSK
    const myPSK = this.preSharedKeys.get(peerIP) || this.preSharedKeys.get('0.0.0.0');
    const peerPSK = peerEngine.preSharedKeys.get(apparentSrcIP) || peerEngine.preSharedKeys.get('0.0.0.0');

    if (!myPSK || !peerPSK || myPSK !== peerPSK) {
      if (this.debugIsakmp) {
        Logger.info(this.router.id, 'debug:isakmp',
          `ISAKMP: (0:0): pre-shared key authentication FAILED with ${peerIP}`);
      }
      Logger.info(this.router.id, 'ipsec:psk-fail', `${this.router.name}: PSK mismatch with ${peerIP}`);
      this.createFailedIKESA(peerIP, egressIface, 'PSK mismatch');
      peerEngine.createFailedIKESA(apparentSrcIP, '', 'PSK mismatch');
      return false;
    }

    if (this.debugIsakmp) {
      Logger.info(this.router.id, 'debug:isakmp',
        `ISAKMP: (${spiHex(0)}:0): SA matched policy ${matchedPolicy.priority}, enc=${matchedPolicy.encryption} hash=${matchedPolicy.hash} group=${matchedPolicy.group}`);
      Logger.info(this.router.id, 'debug:isakmp',
        `ISAKMP: (${spiHex(0)}:0): pre-shared key authentication passed with ${peerIP}`);
    }

    const natT = forceNatT || ((this.natKeepaliveInterval > 0 || peerEngine.natKeepaliveInterval > 0)
      && apparentSrcIP !== localIP);

    // Create IKE SA on both sides
    // RFC 2409 §5.5: negotiate IKE lifetime as min(initiator, responder)
    const negotiatedIKELifetime = Math.min(
      matchedPolicy.lifetime,
      matchedPeerPolicy!.lifetime,
    );

    const spi = randomSPI();
    const now = Date.now();
    const ikeSA: IKE_SA = {
      peerIP, localIP,
      status: useAggressive ? 'AM_ACTIVE' : 'QM_IDLE',
      encryption: matchedPolicy.encryption,
      hash: matchedPolicy.hash,
      group: matchedPolicy.group,
      lifetime: negotiatedIKELifetime,
      created: now,
      spi: spiHex(spi),
      role: 'initiator',
      natT,
      dpdEnabled: this.dpdConfig !== null,
      lastDPDActivity: now,
      dpdTimeouts: 0,
      exchangeMode: useAggressive ? 'aggressive' : 'main',
    };
    // Aggressive mode transitions immediately to QM_IDLE after 3 messages (vs 6 in main)
    if (useAggressive) {
      ikeSA.status = 'QM_IDLE';
      if (this.debugIsakmp) {
        Logger.info(this.router.id, 'debug:isakmp',
          `ISAKMP: Aggressive Mode completed in 3 exchanges (vs 6 for Main Mode)`);
      }
    }
    this.ikeSADB.set(peerIP, ikeSA);

    const peerLocalIP = peerEngine.getLocalIP('') || peerIP;
    const peerIkeSA: IKE_SA = {
      peerIP: apparentSrcIP, localIP: peerLocalIP,
      status: 'QM_IDLE',
      encryption: matchedPolicy.encryption,
      hash: matchedPolicy.hash,
      group: matchedPolicy.group,
      lifetime: negotiatedIKELifetime,
      created: now,
      spi: spiHex(randomSPI()),
      role: 'responder',
      natT,
      dpdEnabled: peerEngine.dpdConfig !== null,
      lastDPDActivity: now,
      dpdTimeouts: 0,
      exchangeMode: useAggressive ? 'aggressive' : 'main',
    };
    peerEngine.ikeSADB.set(apparentSrcIP, peerIkeSA);

    // Phase 2: find matching transform set
    return this.negotiateIPSecSA(peerIP, peerEngine, entry, apparentSrcIP, egressIface, natT);
  }

  private negotiateIPSecSA(
    peerIP: string, peerEngine: IPSecEngine, entry: CryptoMapEntry,
    apparentSrcIP: string, egressIface: string, natT: boolean,
  ): boolean {
    const myTSets = entry.transformSets
      .map(n => this.transformSets.get(n))
      .filter(Boolean) as TransformSet[];

    // Find peer's crypto map entry that matches
    const peerEntry = peerEngine.findEntryForPeer(
      apparentSrcIP,
      (peerEngine as any).router._getPortsInternal?.(),
    );

    const peerTSets = peerEntry
      ? peerEntry.transformSets.map(n => peerEngine.transformSets.get(n)).filter(Boolean) as TransformSet[]
      : [...peerEngine.transformSets.values()];

    let chosenTs: TransformSet | null = null;
    for (const mts of myTSets) {
      for (const pts of peerTSets) {
        if (this.transformSetsCompatible(mts, pts)) { chosenTs = mts; break; }
      }
      if (chosenTs) break;
    }

    if (!chosenTs) {
      Logger.info(this.router.id, 'ipsec:no-transform',
        `${this.router.name}: No common transform set with ${peerIP}`);
      return false;
    }

    // Check PFS compatibility
    // PFS mismatch blocks negotiation when the responder already has an existing
    // IPSec SA for this peer (re-establishment after one-sided clear/rekey).
    // On fresh initial negotiation the initiator's PFS group is used.
    if (entry.pfsGroup && peerEntry?.pfsGroup && entry.pfsGroup !== peerEntry.pfsGroup) {
      const responderHasIPSecSA = (peerEngine.ipsecSADB.get(apparentSrcIP)?.length ?? 0) > 0;
      if (responderHasIPSecSA) {
        Logger.info(this.router.id, 'ipsec:pfs-mismatch',
          `${this.router.name}: PFS group mismatch with ${peerIP} (${entry.pfsGroup} vs ${peerEntry.pfsGroup})`);
        return false;
      }
      Logger.info(this.router.id, 'ipsec:pfs-mismatch-warn',
        `${this.router.name}: PFS group mismatch with ${peerIP} (${entry.pfsGroup} vs ${peerEntry.pfsGroup}), using initiator group for initial SA`);
    }

    // RFC 2409 §5.5 / RFC 7296 §2.8: negotiate lifetime as min(initiator, responder)
    const myLifetime = entry.saLifetimeSeconds ?? this.globalSALifetimeSeconds;
    const peerLifetime = peerEntry?.saLifetimeSeconds ?? peerEngine.globalSALifetimeSeconds;
    const lifetime = Math.min(myLifetime, peerLifetime);

    const myLifetimeKB = this.globalSALifetimeKB;
    const peerLifetimeKB = peerEngine.globalSALifetimeKB;
    const lifetimeKB = Math.min(myLifetimeKB, peerLifetimeKB);

    const spiInitIn  = randomSPI(); // initiator's inbound SPI (what responder will use as outbound)
    const spiRespIn  = randomSPI(); // responder's inbound SPI (what initiator will use as outbound)

    const hasESP = chosenTs.transforms.some(t => t.startsWith('esp'));
    const hasAH  = chosenTs.transforms.some(t => t.startsWith('ah'));

    const localIP = this.getLocalIP(egressIface) || '';

    // Derive cryptographic key material from negotiated transforms (RFC 4301 §4.4.2 fields #7-9)
    const cryptoKeys = deriveCryptoKeys(chosenTs.transforms);
    // Peer gets its own independent KEYMAT (simulated)
    const peerCryptoKeys = deriveCryptoKeys(chosenTs.transforms);

    // Build traffic selectors from the ACL (RFC 4301 §4.4.2 field #12)
    const trafficSelectors = this.buildTrafficSelectorsFromACL(entry.aclName);

    // Compute Path MTU and inner IP MTU (RFC 4301 §8.2)
    const saMode = chosenTs.mode === 'transport' ? 'Transport' : 'Tunnel';
    const overhead = saMode === 'Tunnel' ? computeIPSecOverhead(hasESP, hasAH) : (hasESP ? ESP_OVERHEAD_BASE : 0) + (hasAH ? AH_OVERHEAD_BASE : 0);
    const pathMTU = DEFAULT_PATH_MTU;
    const ipMTU = pathMTU - overhead;

    const now = Date.now();

    // Initiator SA
    const sa: IPSec_SA = {
      peerIP, localIP,
      spiIn: spiInitIn,
      spiOut: spiRespIn,
      outboundSeqNum: 0,
      seqOverflowFlag: true,  // RFC 4301 MUST prevent overflow by default
      replayWindowSize: this.replayWindowSize,
      replayBitmap: createReplayBitmap(this.replayWindowSize),
      replayWindowLastSeq: 0,
      esnEnabled: this.esnDefault,
      outboundSeqNumHigh: 0,
      replayWindowLastSeqHigh: 0,
      cryptoKeys,
      created: now,
      lifetime,
      lifetimeKB,
      mode: saMode,
      trafficSelectors,
      statefulFragCheck: saMode === 'Tunnel',  // RFC 4301 §7: enabled for tunnel mode
      dfBitPolicy: 'copy',    // RFC 4301 §8.1 default
      dscpEcnConfig: defaultDscpEcnConfig(),
      pathMTU,
      ipMTU,
      pathMTULastUpdated: now,
      transforms: chosenTs.transforms,
      aclName: entry.aclName,
      pktsEncaps: 0, pktsDecaps: 0,
      sendErrors: 0, recvErrors: 0,
      pktsReplay: 0,
      bytesEncaps: 0, bytesDecaps: 0,
      pfsGroup: entry.pfsGroup,
      natT,
      outIface: egressIface,
      hasESP, hasAH,
    };
    // Replace any existing SAs for this peer (re-establishment after clear/rekey)
    const existing = this.ipsecSADB.get(peerIP) || [];
    for (const oldSa of existing) this.spiToSA.delete(oldSa.spiIn);
    this.ipsecSADB.set(peerIP, [sa]);
    this.spiToSA.set(spiInitIn, sa);

    // Responder SA (on peer engine)
    const peerLocalIP = peerEngine.getLocalIP(peerEntry?.aclName ? '' : '') || peerIP;
    // Find peer's egress interface for this SA
    const peerEgressIface = peerEngine.findInterfaceForPeer(apparentSrcIP) || '';
    const peerTrafficSelectors = peerEngine.buildTrafficSelectorsFromACL(peerEntry?.aclName || entry.aclName);
    const peerSA: IPSec_SA = {
      peerIP: apparentSrcIP,
      localIP: peerLocalIP,
      spiIn: spiRespIn,
      spiOut: spiInitIn,
      outboundSeqNum: 0,
      seqOverflowFlag: true,
      replayWindowSize: peerEngine.replayWindowSize,
      replayBitmap: createReplayBitmap(peerEngine.replayWindowSize),
      replayWindowLastSeq: 0,
      esnEnabled: peerEngine.esnDefault,
      outboundSeqNumHigh: 0,
      replayWindowLastSeqHigh: 0,
      cryptoKeys: peerCryptoKeys,
      created: now,
      lifetime,
      lifetimeKB,
      mode: saMode,
      trafficSelectors: peerTrafficSelectors,
      statefulFragCheck: saMode === 'Tunnel',
      dfBitPolicy: 'copy',
      dscpEcnConfig: defaultDscpEcnConfig(),
      pathMTU,
      ipMTU,
      pathMTULastUpdated: now,
      transforms: chosenTs.transforms,
      aclName: peerEntry?.aclName || entry.aclName,
      pktsEncaps: 0, pktsDecaps: 0,
      sendErrors: 0, recvErrors: 0,
      pktsReplay: 0,
      bytesEncaps: 0, bytesDecaps: 0,
      pfsGroup: entry.pfsGroup,
      natT,
      outIface: peerEgressIface,
      hasESP, hasAH,
    };
    // Replace any existing SAs for this peer on responder (re-establishment)
    const peerExisting = peerEngine.ipsecSADB.get(apparentSrcIP) || [];
    for (const oldSa of peerExisting) peerEngine.spiToSA.delete(oldSa.spiIn);
    peerEngine.ipsecSADB.set(apparentSrcIP, [peerSA]);
    peerEngine.spiToSA.set(spiRespIn, peerSA);

    if (this.debugIpsec) {
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC(key_engine): got a queue event with 1 KMI message(s)`);
      Logger.info(this.router.id, 'debug:ipsec',
        `IPSEC(spi): obtained new SPI for SA, spi_in=${spiHex(spiInitIn)} spi_out=${spiHex(spiRespIn)}`);
    }

    Logger.info(this.router.id, 'ipsec:sa-up',
      `${this.router.name}: IPSec SA UP with ${peerIP} [${chosenTs.transforms.join(',')}]`);
    return true;
  }

  // ── IKEv2 ──────────────────────────────────────────────────────

  private negotiateIKEv2(
    peerIP: string, peerEngine: IPSecEngine, entry: CryptoMapEntry,
    localIP: string, apparentSrcIP: string, egressIface: string,
    forceNatT: boolean = false,
  ): boolean {
    // Find common IKEv2 proposal
    const myProposals = [...this.ikev2Proposals.values()];
    const peerProposals = [...peerEngine.ikev2Proposals.values()];

    let chosen: { enc: string; int: string; grp: number; propName: string } | null = null;
    outer: for (const mp of myProposals) {
      for (const pp of peerProposals) {
        const enc = mp.encryption.find(e => pp.encryption.includes(e));
        const int_ = mp.integrity.find(i => pp.integrity.includes(i));
        const grp = mp.dhGroup.find(g => pp.dhGroup.includes(g));
        if (enc && int_ && grp) {
          chosen = { enc, int: int_, grp, propName: mp.name };
          break outer;
        }
      }
    }
    if (!chosen) return false;

    // Find PSK via keyring
    const myPSK = this.findIKEv2PSK(peerIP);
    const peerPSK = peerEngine.findIKEv2PSK(apparentSrcIP);
    if (!myPSK || !peerPSK || myPSK !== peerPSK) return false;

    const natT = forceNatT || ((this.natKeepaliveInterval > 0 || peerEngine.natKeepaliveInterval > 0)
      && apparentSrcIP !== localIP);
    const spiL = spiHex(randomSPI());
    const spiR = spiHex(randomSPI());

    const ikev2SA: IKEv2_SA = {
      peerIP, localIP,
      status: 'READY',
      spiLocal: spiL,
      spiRemote: spiR,
      role: 'Initiator',
      proposalUsed: chosen.propName,
      encryptionUsed: chosen.enc,
      integrityUsed: chosen.int,
      dhGroupUsed: chosen.grp,
      created: Date.now(),
      natT,
    };
    this.ikev2SADB.set(peerIP, ikev2SA);

    const peerLocalIP = peerEngine.getLocalIP('') || peerIP;
    peerEngine.ikev2SADB.set(apparentSrcIP, {
      peerIP: apparentSrcIP, localIP: peerLocalIP,
      status: 'READY',
      spiLocal: spiR,
      spiRemote: spiL,
      role: 'Responder',
      proposalUsed: chosen.propName,
      encryptionUsed: chosen.enc,
      integrityUsed: chosen.int,
      dhGroupUsed: chosen.grp,
      created: Date.now(),
      natT,
    });

    // Also create IPSec SA (IKEv2 combines IKE_SA + CHILD_SA)
    return this.negotiateIPSecSA(peerIP, peerEngine, entry, apparentSrcIP, egressIface, natT);
  }

  private findIKEv2PSK(peerIP: string): string | null {
    for (const kr of this.ikev2Keyrings.values()) {
      for (const peer of kr.peers.values()) {
        if (peer.address === peerIP || peer.address === '0.0.0.0') {
          return peer.preSharedKey;
        }
      }
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────────────

  private policiesCompatible(a: ISAKMPPolicy, b: ISAKMPPolicy): boolean {
    return a.encryption === b.encryption
      && a.hash === b.hash
      && a.auth === b.auth
      && a.group === b.group;
  }

  private transformSetsCompatible(a: TransformSet, b: TransformSet): boolean {
    if (a.mode !== b.mode) return false;
    // transforms must be the same set (order-independent)
    const setA = new Set(a.transforms);
    const setB = new Set(b.transforms);
    if (setA.size !== setB.size) return false;
    for (const t of setA) if (!setB.has(t)) return false;
    return true;
  }

  private matchACL(aclName: string, pkt: IPv4Packet): boolean {
    return (this.router as any).evaluateACLByName?.(aclName, pkt) === 'permit';
  }

  private getLocalIP(egressIface: string): string | null {
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    if (egressIface) {
      const port = ports.get(egressIface);
      return port?.getIPAddress?.()?.toString() || null;
    }
    for (const [, port] of ports) {
      const ip = port.getIPAddress?.();
      if (ip) return ip.toString();
    }
    return null;
  }

  private findEntryForPeer(peerApparentIP: string, _ports: any): CryptoMapEntry | null {
    for (const cmap of this.cryptoMaps.values()) {
      for (const [, entry] of cmap.staticEntries) {
        if (entry.peers.includes(peerApparentIP) || entry.peers.includes('0.0.0.0')) {
          return entry;
        }
      }
    }
    return null;
  }

  private createFailedIKESA(peerIP: string, _iface: string, _reason: string): void {
    if (this.ikeSADB.has(peerIP)) return;
    this.ikeSADB.set(peerIP, {
      peerIP, localIP: '',
      status: 'MM_NO_STATE',
      encryption: '', hash: '', group: 0, lifetime: 0,
      created: Date.now(),
      spi: spiHex(randomSPI()),
      role: 'initiator',
      natT: false,
      dpdEnabled: false,
    });
  }

  // ── NAT path detection ─────────────────────────────────────────

  /**
   * Compute the apparent source IP that the peer would see after NAT/MASQUERADE.
   */
  private getApparentSourceIP(localIP: string, peerIP: string): string {
    try {
      const route = (this.router as any).lookupRoute(new IPAddress(peerIP));
      if (!route?.nextHop) return localIP;

      const nextHopStr = route.nextHop.toString();
      // If next hop IS the peer, no NAT
      if (nextHopStr === peerIP) return localIP;

      // Check if the next hop is a non-Router device (potential NAT)
      const nextHopEquip = IPSecEngine.findEquipmentByIP(nextHopStr);
      if (!nextHopEquip) return localIP;

      // If it IS a Router, no NAT between us
      if ((nextHopEquip as any)._getIPSecEngineInternal) return localIP;

      // Non-router — check masquerade
      const masqIP: string | null = (nextHopEquip as any).getOutgoingMasqueradeIP?.(peerIP) || null;
      if (masqIP) return masqIP;
    } catch { /* ignore */ }
    return localIP;
  }

  // ── Static helpers ─────────────────────────────────────────────

  static findRouterByIP(ip: string): Router | null {
    for (const equip of Equipment.getAllEquipment()) {
      if (!(equip as any)._getIPSecEngineInternal) continue; // not a Router
      const ports = (equip as any)._getPortsInternal?.();
      if (!ports) continue;
      for (const [, port] of ports) {
        if (port.getIPAddress?.()?.toString() === ip) return equip as Router;
      }
    }
    return null;
  }

  static findEquipmentByIP(ip: string): Equipment | null {
    for (const equip of Equipment.getAllEquipment()) {
      const ports = (equip as any)._getPortsInternal?.() || (equip as any).getPorts?.();
      if (!ports) continue;
      for (const [, port] of (ports instanceof Map ? ports : new Map())) {
        if ((port as any).getIPAddress?.()?.toString() === ip) return equip;
      }
      // For EndHosts, ports may be iterable differently
      if ((equip as any).ports instanceof Map) {
        for (const [, port] of (equip as any).ports) {
          if ((port as any).getIPAddress?.()?.toString() === ip) return equip;
        }
      }
    }
    return null;
  }

  /**
   * NAT-T: Find a Router behind a NAT device.
   * When a peer IP belongs to a non-Router device (e.g. LinuxPC acting as NAT),
   * check its iptables PREROUTING DNAT rules for UDP 500 to discover the real Router.
   */
  static findRouterBehindNAT(natIP: string): { router: Router; realPeerIP: string } | null {
    const natDevice = IPSecEngine.findEquipmentByIP(natIP);
    if (!natDevice) return null;
    // If it IS a Router already, skip
    if ((natDevice as any)._getIPSecEngineInternal) return null;

    // Check for iptables DNAT rules targeting UDP 500 (IKE)
    const iptables = (natDevice as any).executor?.iptables || (natDevice as any).iptables;
    if (iptables && typeof iptables.evaluateNat === 'function') {
      // Find which interface on the NAT device has this IP
      let inIface = '';
      const devPorts = (natDevice as any).ports;
      if (devPorts instanceof Map) {
        for (const [name, port] of devPorts) {
          if ((port as any).getIPAddress?.()?.toString() === natIP) {
            inIface = name;
            break;
          }
        }
      }
      // Simulate an inbound UDP 500 packet to see if DNAT applies
      const testPkt = {
        direction: 'in' as const,
        protocol: 17,  // UDP
        srcIP: '0.0.0.0',
        dstIP: natIP,
        srcPort: 500,
        dstPort: 500,
        iface: inIface,
      };
      const natResult = iptables.evaluateNat(testPkt, 'PREROUTING');
      if (natResult && natResult.action === 'DNAT' && natResult.address) {
        const realIP = natResult.address.split(':')[0];
        const realRouter = IPSecEngine.findRouterByIP(realIP);
        if (realRouter) {
          return { router: realRouter, realPeerIP: realIP };
        }
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  // Show commands
  // ══════════════════════════════════════════════════════════════════

  showCryptoISAKMPSA(): string {
    if (this.ikeSADB.size === 0) {
      return 'IPv4 Crypto ISAKMP SA\ndst             src             state          conn-id status\n\nThere are no IKEv1 SAs (no SA established)';
    }
    const lines = ['IPv4 Crypto ISAKMP SA', 'dst             src             state          conn-id status'];
    for (const [, sa] of this.ikeSADB) {
      lines.push(
        `${sa.peerIP.padEnd(16)}${sa.localIP.padEnd(16)}${sa.status.padEnd(15)}${String(1).padEnd(8)}ACTIVE`,
      );
    }
    return lines.join('\n');
  }

  showCryptoISAKMPSADetail(): string {
    const base = this.showCryptoISAKMPSA();
    const extra: string[] = [];
    for (const [, sa] of this.ikeSADB) {
      extra.push('');
      extra.push(`Crypto ISAKMP SA towards ${sa.peerIP}`);
      extra.push(`   Status: ${sa.status}, role: ${sa.role}`);
      extra.push(`   Exchange mode: ${sa.exchangeMode || 'main'}`);
      extra.push(`   Encryption: ${sa.encryption}, Hash: ${sa.hash}, DH Group: ${sa.group}`);
      extra.push(`   Lifetime: ${sa.lifetime}s, created ${Math.floor((Date.now() - sa.created) / 1000)}s ago`);
      if (sa.natT) {
        extra.push(`   NAT-T: enabled, port 4500`);
        extra.push(`   NAT-T keepalive interval: ${this.natKeepaliveInterval}s`);
      }
      if (sa.dpdEnabled && this.dpdConfig) {
        extra.push(`   DPD: keepalive ${this.dpdConfig.interval} ${this.dpdConfig.retries} ${this.dpdConfig.mode}`);
        if (sa.dpdTimeouts !== undefined && sa.dpdTimeouts > 0) {
          extra.push(`   DPD: ${sa.dpdTimeouts} consecutive timeout(s)`);
        }
      }
    }
    return base + extra.join('\n');
  }

  showCryptoISAKMP(): string {
    const lines: string[] = [];
    if (this.natKeepaliveInterval > 0) {
      lines.push(`IKE Keepalive: nat keepalive ${this.natKeepaliveInterval}`);
    }
    if (this.dpdConfig) {
      lines.push(`IKE Keepalive: keepalive ${this.dpdConfig.interval} ${this.dpdConfig.retries} ${this.dpdConfig.mode}`);
    }
    if (this.aggressiveMode) {
      lines.push('IKE Exchange Mode: Aggressive');
    }
    if (lines.length === 0) lines.push('IKE global config:');
    return lines.join('\n');
  }

  showCryptoISAKMPPolicy(): string {
    const lines: string[] = ['Global IKE policy'];
    for (const [, p] of [...this.isakmpPolicies.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`Protection suite of priority ${p.priority}`);
      lines.push(`\tencryption algorithm:   ${this.formatEncForPolicy(p.encryption)}`);
      lines.push(`\thash algorithm:         ${this.formatHashForPolicy(p.hash)}`);
      lines.push(`\tauthentication method:  ${p.auth === 'pre-share' ? 'Pre-Shared Key' : p.auth}`);
      lines.push(`\tDiffie-Hellman group:   #${p.group} (${this.dhGroupBits(p.group)} bit)`);
      lines.push(`\tlifetime:               ${p.lifetime} seconds, no volume limit`);
    }
    lines.push(`Default protection suite`);
    lines.push(`\tencryption algorithm:   DES - Data Encryption Standard (56 bit keys).`);
    lines.push(`\thash algorithm:         Secure Hash Standard`);
    lines.push(`\tauthentication method:  Rivest-Shamir-Adleman Signature`);
    lines.push(`\tDiffie-Hellman group:   #1 (768 bit)`);
    lines.push(`\tlifetime:               86400 seconds, no volume limit`);
    return lines.join('\n');
  }

  private dhGroupBits(group: number): number {
    const map: Record<number, number> = {
      1: 768, 2: 1024, 5: 1536, 14: 2048, 15: 3072, 16: 4096,
      19: 256, 20: 384, 21: 521, 24: 2048,
    };
    return map[group] || group * 256;
  }

  private formatEncForPolicy(enc: string): string {
    if (enc === 'aes 256') return 'AES - Advanced Encryption Standard (256 bit keys).';
    if (enc === 'aes 192') return 'AES - Advanced Encryption Standard (192 bit keys).';
    if (enc === 'aes') return 'AES - Advanced Encryption Standard (128 bit keys).';
    if (enc === '3des') return 'Three key triple DES';
    return enc.toUpperCase();
  }

  private formatHashForPolicy(hash: string): string {
    const map: Record<string, string> = {
      sha: 'Secure Hash Standard',
      sha256: 'Secure Hash Standard 2 (256 bit)',
      sha384: 'Secure Hash Standard 2 (384 bit)',
      sha512: 'Secure Hash Standard 2 (512 bit)',
      md5: 'Message Digest 5',
    };
    return map[hash] || hash.toUpperCase();
  }

  showCryptoIPSecSA(): string {
    const lines: string[] = [];
    for (const [peerIP, sas] of this.ipsecSADB) {
      for (const sa of sas) {
        const iface = sa.outIface || this.findInterfaceForPeer(peerIP) || 'GigabitEthernet0/1';
        const mapName = this.ifaceCryptoMap.get(iface) || this.findCryptoMapName() || 'CMAP';
        lines.push('');
        lines.push(`interface: ${iface}`);
        lines.push(`    Crypto map tag: ${mapName}, local addr ${sa.localIP}`);
        lines.push('');
        lines.push(`   protected vrf: (none)`);
        lines.push(`   local  ident (addr/mask/prot/port): (${this.getACLSrc(sa.aclName)})`);
        lines.push(`   remote ident (addr/mask/prot/port): (${this.getACLDst(sa.aclName)})`);
        const port = sa.natT ? '4500' : '500';
        lines.push(`   current_peer ${peerIP} port ${port}`);
        lines.push(`    PERMIT, flags={origin_is_acl,}`);
        lines.push(`   #pkts encaps: ${sa.pktsEncaps}, #pkts encrypt: ${sa.pktsEncaps}, #pkts digest: ${sa.pktsEncaps}`);
        lines.push(`   #pkts decaps: ${sa.pktsDecaps}, #pkts decrypt: ${sa.pktsDecaps}, #pkts verify: ${sa.pktsDecaps}`);
        lines.push(`   #pkts compressed: 0, #pkts decompressed: 0`);
        lines.push(`   #pkts not compressed: 0, #pkts compr. failed: 0`);
        lines.push(`   #pkts not decompressed: 0, #pkts decompress failed: 0`);
        lines.push(`   #pkts replay: ${sa.pktsReplay}`);
        lines.push(`   #send errors ${sa.sendErrors}, #recv errors ${sa.recvErrors}`);
        lines.push('');
        lines.push(`    local crypto endpt.: ${sa.localIP} remote crypto endpt.: ${peerIP}`);
        lines.push(`    plaintext mtu ${sa.ipMTU}, path mtu ${sa.pathMTU}, ip mtu ${sa.pathMTU}, ip mtu idb ${iface}`);
        lines.push(`    current outbound spi: ${spiHex(sa.spiOut)}(${sa.spiOut})`);
        if (sa.natT) {
          lines.push(`    UDP encap: src port 4500, dst port 4500`);
        }
        lines.push('');
        if (sa.hasESP) {
          lines.push(`    inbound esp sas:`);
          lines.push(`     spi: ${spiHex(sa.spiIn)}(${sa.spiIn})`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms.filter(t => t.startsWith('esp')))} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
          lines.push(`       ...`);
          lines.push(`    outbound esp sas:`);
          lines.push(`     spi: ${spiHex(sa.spiOut)}(${sa.spiOut})`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms.filter(t => t.startsWith('esp')))} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
        }
        if (sa.hasAH) {
          lines.push(`    inbound ah sas:`);
          lines.push(`     spi: ${spiHex(sa.spiIn)}(${sa.spiIn}) (ah)`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms.filter(t => t.startsWith('ah')))} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
          lines.push(`    outbound ah sas:`);
          lines.push(`     spi: ${spiHex(sa.spiOut)}(${sa.spiOut}) (ah)`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms.filter(t => t.startsWith('ah')))} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
        }
      }
    }
    return lines.length ? lines.join('\n') : 'No IPSec SAs established.';
  }

  showCryptoIPSecSADetail(): string {
    const base = this.showCryptoIPSecSA();
    if (base === 'No IPSec SAs established.') return base;
    const extra: string[] = [];
    for (const [, sas] of this.ipsecSADB) {
      for (const sa of sas) {
        const elapsedSec = Math.floor((Date.now() - sa.created) / 1000);
        const remainingSec = Math.max(0, sa.lifetime - elapsedSec);
        const usedKB = Math.floor((sa.bytesEncaps + sa.bytesDecaps) / 1024);
        const remainingKB = Math.max(0, sa.lifetimeKB - usedKB);
        extra.push('');
        extra.push(`   sa timing: remaining key lifetime (k/sec): (${remainingKB}/${remainingSec})`);
        extra.push(`   SA lifetime: ${sa.lifetime} seconds, ${sa.lifetimeKB} kilobytes`);
        extra.push(`   Replay window size: ${sa.replayWindowSize}`);
        if (sa.esnEnabled) {
          extra.push(`   Extended Sequence Number (ESN): Y`);
          extra.push(`   Outbound sequence number: ${sa.outboundSeqNumHigh}:${sa.outboundSeqNum}`);
        } else {
          extra.push(`   Extended Sequence Number (ESN): N`);
          extra.push(`   Outbound sequence number: ${sa.outboundSeqNum}`);
        }
        extra.push(`   Sequence Counter Overflow flag: ${sa.seqOverflowFlag ? 'Y' : 'N'}`);
        if (sa.pfsGroup) {
          extra.push(`   PFS (Y/N): Y, DH group: ${sa.pfsGroup}`);
        } else {
          extra.push(`   PFS (Y/N): N`);
        }
        // Cryptographic keys (simulated)
        const ck = sa.cryptoKeys;
        if (ck.espEncAlgorithm !== 'null') {
          extra.push(`   ESP encryption: ${ck.espEncAlgorithm} (${ck.espEncKeyLength}-bit key)`);
        }
        if (ck.espAuthAlgorithm !== 'none' && ck.espAuthAlgorithm !== 'aes-gcm') {
          extra.push(`   ESP authentication: ${ck.espAuthAlgorithm} (${ck.espAuthKeyLength}-bit key)`);
        }
        if (ck.ahAuthAlgorithm !== 'none') {
          extra.push(`   AH authentication: ${ck.ahAuthAlgorithm} (${ck.ahAuthKeyLength}-bit key)`);
        }
        // DF bit, DSCP/ECN, fragment checking
        extra.push(`   DF bit policy: ${sa.dfBitPolicy}`);
        extra.push(`   DSCP mode: ${sa.dscpEcnConfig.dscpMode}${sa.dscpEcnConfig.dscpMode === 'set' ? ' (value=' + sa.dscpEcnConfig.dscpValue + ')' : ''}`);
        extra.push(`   ECN support: ${sa.dscpEcnConfig.ecnEnabled ? 'Y' : 'N'}`);
        extra.push(`   Stateful fragment checking: ${sa.statefulFragCheck ? 'Y' : 'N'}`);
        extra.push(`   Path MTU: ${sa.pathMTU}, IP MTU: ${sa.ipMTU}`);
        // Traffic selectors
        const ts = sa.trafficSelectors;
        if (ts.srcAddress || ts.dstAddress) {
          extra.push(`   Traffic selectors: src=${ts.srcAddress || 'any'}/${ts.srcWildcard || '0'} dst=${ts.dstAddress || 'any'}/${ts.dstWildcard || '0'} proto=${ts.protocol || 'any'}`);
        }
      }
    }
    return base + extra.join('\n');
  }

  showCryptoIPSecProfile(): string {
    if (this.ipsecProfiles.size === 0) return 'No IPSec profiles configured.';
    const lines: string[] = [];
    for (const [, prof] of this.ipsecProfiles) {
      lines.push(`IPsec Profile "${prof.name}"`);
      lines.push(`  Transform sets: { ${prof.transformSetName}: { ${this.transformSets.get(prof.transformSetName)?.transforms.join(' ') || ''} } }`);
      lines.push(`  Mode: ${prof.mode}`);
    }
    return lines.join('\n');
  }

  showCryptoDynamicMap(): string {
    if (this.dynamicCryptoMaps.size === 0) return 'No dynamic crypto maps configured.';
    const lines: string[] = [];
    for (const [, dmap] of this.dynamicCryptoMaps) {
      for (const [, entry] of dmap.entries) {
        lines.push(`Crypto Dynamic Map "${dmap.name}" ${entry.seq}`);
        lines.push(`\tTransform sets={`);
        for (const ts of entry.transformSets) {
          lines.push(`\t\t${ts}: { ${this.transformSets.get(ts)?.transforms.join(' ') || ''} },`);
        }
        lines.push(`\t}`);
      }
    }
    return lines.join('\n');
  }

  private findInterfaceForPeer(peerIP: string): string | null {
    try {
      const route = (this.router as any).lookupRoute(new IPAddress(peerIP));
      if (route?.iface) return route.iface;
    } catch { /* ignore */ }
    return null;
  }

  private findCryptoMapName(): string | null {
    for (const [, name] of this.ifaceCryptoMap) return name;
    return null;
  }

  private getACLSrc(aclName: string): string {
    const acl = (this.router as any)._getAccessListsInternal?.()?.find((a: any) =>
      (a.name === aclName || String(a.id) === aclName));
    if (acl?.entries?.[0]) {
      const e = acl.entries[0];
      return `${e.srcIP}/${this.wildcardToMask(e.srcWildcard)}/0/0`;
    }
    return '0.0.0.0/0.0.0.0/0/0';
  }

  private getACLDst(aclName: string): string {
    const acl = (this.router as any)._getAccessListsInternal?.()?.find((a: any) =>
      (a.name === aclName || String(a.id) === aclName));
    if (acl?.entries?.[0]) {
      const e = acl.entries[0];
      if (e.dstIP) return `${e.dstIP}/${this.wildcardToMask(e.dstWildcard || { getOctets: () => [0,0,0,0] })}/0/0`;
    }
    return '0.0.0.0/0.0.0.0/0/0';
  }

  private wildcardToMask(wc: any): string {
    if (!wc?.getOctets) return '255.255.255.255';
    const octets = wc.getOctets().map((o: number) => (~o & 0xff));
    return octets.join('.');
  }

  /**
   * Build SA traffic selectors from an ACL (RFC 4301 §4.4.2 field #12).
   * Extracts the first matching ACE's source/destination selectors.
   */
  buildTrafficSelectorsFromACL(aclName: string): SATrafficSelector {
    const acl = (this.router as any)._getAccessListsInternal?.()?.find((a: any) =>
      a.name === aclName || String(a.id) === aclName);
    if (acl?.entries?.[0]) {
      const e = acl.entries[0];
      return {
        srcAddress: e.srcIP?.toString?.() || '',
        srcWildcard: e.srcWildcard?.toString?.() || '',
        dstAddress: e.dstIP?.toString?.() || '',
        dstWildcard: e.dstWildcard?.toString?.() || '',
        protocol: typeof e.protocol === 'number' ? e.protocol : 0,
        srcPort: e.srcPort || 0,
        dstPort: e.dstPort || 0,
      };
    }
    return defaultTrafficSelectors();
  }

  showCryptoIPSecTransformSet(): string {
    if (this.transformSets.size === 0) return 'No transform sets defined.';
    const lines: string[] = [];
    for (const [, ts] of this.transformSets) {
      lines.push(`Transform set ${ts.name}: { ${ts.transforms.join(' ')} }`);
      lines.push(`   will negotiate = { ${ts.mode === 'transport' ? 'Transport' : 'Tunnel'}, },`);
    }
    return lines.join('\n');
  }

  showCryptoMap(): string {
    const lines: string[] = [];
    for (const [, cmap] of this.cryptoMaps) {
      for (const [, entry] of [...cmap.staticEntries.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`Crypto Map "${cmap.name}" ${entry.seq} ipsec-isakmp`);
        lines.push(`\tPeer = ${entry.peers.join(', ')}`);
        lines.push(`\tExtended IP access list ${entry.aclName}`);
        lines.push(`\tSecurity association lifetime: 4608000 kilobytes/${entry.saLifetimeSeconds || this.globalSALifetimeSeconds} seconds`);
        if (entry.pfsGroup) {
          lines.push(`\tPFS (Y/N): Y`);
          lines.push(`\tDH group: ${entry.pfsGroup}`);
        } else {
          lines.push(`\tPFS (Y/N): N`);
        }
        lines.push(`\tTransform sets={`);
        for (const ts of entry.transformSets) {
          lines.push(`\t\t${ts}: { ${this.transformSets.get(ts)?.transforms.join(' ') || ''} },`);
        }
        lines.push(`\t}`);
        const appliedOn: string[] = [];
        for (const [iface, mapName] of this.ifaceCryptoMap) {
          if (mapName === cmap.name) appliedOn.push(iface);
        }
        lines.push(`\tInterfaces using crypto map ${cmap.name}:`);
        for (const iface of appliedOn) lines.push(`\t\t${iface}`);
      }
      for (const [seq, dynMapName] of cmap.dynamicEntries) {
        lines.push(`Crypto Map "${cmap.name}" ${seq} ipsec-isakmp dynamic ${dynMapName}`);
      }
    }
    return lines.length ? lines.join('\n') : 'No crypto maps configured.';
  }

  showCryptoIKEv2SA(): string {
    if (this.ikev2SADB.size === 0) return 'There are no IKEv2 SAs.';
    const lines = [
      'IPv4 Crypto IKEv2 SA',
      '',
      `Tunnel-id Local                 Remote                fvrf/ivrf            Status       Role`,
    ];
    let tid = 1;
    for (const [, sa] of this.ikev2SADB) {
      lines.push(`${String(tid++).padEnd(10)}${sa.localIP.padEnd(22)}${sa.peerIP.padEnd(22)}none/none            ${sa.status.padEnd(13)}${sa.role}`);
    }
    return lines.join('\n');
  }

  showCryptoIKEv2SADetail(): string {
    const base = this.showCryptoIKEv2SA();
    const extra: string[] = [];
    for (const [peerIP, sa] of this.ikev2SADB) {
      const childCount = (this.ipsecSADB.get(peerIP) || []).length;
      extra.push('');
      extra.push(`IKEv2 SA Details for ${sa.peerIP}`);
      extra.push(`  Role: ${sa.role}`);
      extra.push(`  Local SPI  : ${sa.spiLocal.replace('0x', '').padStart(16, '0')}`);
      extra.push(`  Remote SPI : ${sa.spiRemote.replace('0x', '').padStart(16, '0')}`);
      extra.push(`  Encryption : ${this.formatIKEv2Algo(sa.encryptionUsed)}`);
      extra.push(`  Integrity  : ${sa.integrityUsed.toUpperCase()}`);
      extra.push(`  DH group ${sa.dhGroupUsed}`);
      extra.push(`  Status     : ${sa.status}`);
      extra.push(`  Auth method: pre-share`);
      if (sa.natT) extra.push(`  NAT-T      : enabled (port 4500)`);
      extra.push(`  Child SA count: ${childCount}`);
    }
    return base + '\n' + extra.join('\n');
  }

  private formatIKEv2Algo(algo: string): string {
    return algo.toUpperCase();
  }

  showCryptoSession(): string {
    const lines: string[] = [];
    for (const [peerIP, sas] of this.ipsecSADB) {
      if (sas.length === 0) continue;
      const sa = sas[0];
      lines.push(`Crypto session current status`);
      lines.push('');
      lines.push(`Interface: ${sa.outIface || 'GigabitEthernet0/1'}`);
      lines.push(`Session status: UP-ACTIVE`);
      lines.push(`Peer: ${peerIP} port ${sa.natT ? '4500' : '500'}`);
      lines.push(`  Session ID: 1`);
      lines.push(`  IKEv1 SA: local ${sa.localIP}/500 remote ${peerIP}/500 Active`);
      lines.push(`  IPSEC FLOW: permit ip ${this.getACLSrcNet(sa.aclName)} ${this.getACLDstNet(sa.aclName)}`);
      lines.push(`        Active SAs: ${sas.length * 2}, origin: crypto map`);
    }
    return lines.length ? lines.join('\n') : 'No active crypto sessions.';
  }

  private getACLSrcNet(aclName: string): string {
    const acl = (this.router as any)._getAccessListsInternal?.()?.find((a: any) =>
      a.name === aclName || String(a.id) === aclName);
    if (acl?.entries?.[0]) {
      const e = acl.entries[0];
      return `${e.srcIP} ${e.srcWildcard}`;
    }
    return '0.0.0.0 255.255.255.255';
  }

  private getACLDstNet(aclName: string): string {
    const acl = (this.router as any)._getAccessListsInternal?.()?.find((a: any) =>
      a.name === aclName || String(a.id) === aclName);
    if (acl?.entries?.[0]) {
      const e = acl.entries[0];
      if (e.dstIP) return `${e.dstIP} ${e.dstWildcard}`;
    }
    return '0.0.0.0 255.255.255.255';
  }

  private formatTransforms(transforms: string[]): string {
    // Convert CLI names to Cisco IOS display names
    return transforms.map(t => {
      const map: Record<string, string> = {
        'esp-aes': 'esp-aes',
        'esp-aes 256': 'esp-256-aes',
        'esp-aes 192': 'esp-192-aes',
        'esp-3des': 'esp-3des',
        'esp-sha-hmac': 'esp-sha-hmac',
        'esp-sha256-hmac': 'esp-sha256-hmac',
        'esp-sha384-hmac': 'esp-sha384-hmac',
        'esp-sha512-hmac': 'esp-sha512-hmac',
        'esp-md5-hmac': 'esp-md5-hmac',
        'esp-gcm 256': 'esp-gcm-256',
        'esp-gcm': 'esp-gcm',
        'ah-sha256-hmac': 'ah-sha256-hmac',
        'ah-sha-hmac': 'ah-sha-hmac',
      };
      return map[t] || t;
    }).join(' ');
  }

  showCryptoEngineBrief(): string {
    const lines: string[] = [
      'crypto engine name:  Cisco Software Crypto Engine',
      `crypto engine type:  software`,
      `State: Enabled`,
    ];
    let totalSAs = 0;
    for (const [, sas] of this.ipsecSADB) totalSAs += sas.length;
    lines.push(`Number of IPSec SAs: ${totalSAs}`);
    lines.push(`Number of IKEv1 SAs: ${this.ikeSADB.size}`);
    lines.push(`Number of IKEv2 SAs: ${this.ikev2SADB.size}`);
    if (this.multicastSADB.size > 0) {
      lines.push(`Number of Multicast SAs: ${this.multicastSADB.size}`);
    }
    return lines.join('\n');
  }

  showCryptoEngineConfiguration(): string {
    const lines: string[] = [
      'crypto engine name:  Cisco Software Crypto Engine',
      `Crypto engine state: Enabled`,
      ``,
      `IPSec global SA lifetime: ${this.globalSALifetimeSeconds} seconds`,
      `IPSec global SA lifetime: ${this.globalSALifetimeKB} kilobytes`,
      `Anti-replay window size: ${this.replayWindowSize}`,
    ];
    if (this.debugIsakmp) lines.push('debug crypto isakmp: ENABLED');
    if (this.debugIpsec) lines.push('debug crypto ipsec: ENABLED');
    if (this.debugIkev2) lines.push('debug crypto ikev2: ENABLED');
    return lines.join('\n');
  }

  showSecurityPolicy(): string {
    if (this.spd.length === 0) return 'No security policies configured (SPD empty).';
    const lines: string[] = ['Security Policy Database (SPD) — RFC 4301', ''];
    lines.push('ID    Direction  Action    Source                Destination           Proto');
    lines.push('─'.repeat(85));
    for (const sp of this.spd) {
      const src = sp.srcAddress ? `${sp.srcAddress}/${sp.srcWildcard || '0.0.0.0'}` : 'any';
      const dst = sp.dstAddress ? `${sp.dstAddress}/${sp.dstWildcard || '0.0.0.0'}` : 'any';
      const proto = sp.protocol === 0 ? 'any' : String(sp.protocol);
      lines.push(
        `${String(sp.id).padEnd(6)}${sp.direction.padEnd(11)}${sp.action.padEnd(10)}${src.padEnd(22)}${dst.padEnd(22)}${proto}`
      );
    }
    return lines.join('\n');
  }

  showCryptoIKEv2Proposal(): string {
    if (this.ikev2Proposals.size === 0) return 'No IKEv2 proposals configured.';
    const lines: string[] = [];
    for (const [name, prop] of this.ikev2Proposals) {
      lines.push(`IKEv2 Proposal: ${name}`);
      lines.push(`  Encryption  : ${prop.encryption.length > 0 ? prop.encryption.join(', ') : '(none)'}`);
      lines.push(`  Integrity   : ${prop.integrity.length > 0 ? prop.integrity.join(', ') : '(none)'}`);
      lines.push(`  DH Group    : ${prop.dhGroup.length > 0 ? prop.dhGroup.join(', ') : '(none)'}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  showCryptoIKEv2Policy(): string {
    if (this.ikev2Policies.size === 0) return 'No IKEv2 policies configured.';
    const lines: string[] = [];
    for (const [key, pol] of this.ikev2Policies) {
      lines.push(`IKEv2 Policy : ${key}`);
      lines.push(`  Match fvrf  : any`);
      lines.push(`  Proposals   : ${pol.proposalNames.length > 0 ? pol.proposalNames.join(', ') : '(none)'}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  showCryptoIKEv2Profile(): string {
    if (this.ikev2Profiles.size === 0) return 'No IKEv2 profiles configured.';
    const lines: string[] = [];
    for (const [name, prof] of this.ikev2Profiles) {
      lines.push(`IKEv2 Profile: ${name}`);
      const matchId = prof.matchIdentityRemoteAddress
        ? `address ${prof.matchIdentityRemoteAddress}`
        : (prof.matchIdentityRemoteAny ? 'any' : 'any');
      lines.push(`  Match identity : ${matchId}`);
      lines.push(`  Local auth     : ${prof.authLocal || 'pre-share'}`);
      lines.push(`  Remote auth    : ${prof.authRemote || 'pre-share'}`);
      if (prof.keyringName) lines.push(`  Keyring        : ${prof.keyringName}`);
      if (prof.keyringLocalName) lines.push(`  Keyring local  : ${prof.keyringLocalName}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  showCryptoIKEv2Keyring(): string {
    if (this.ikev2Keyrings.size === 0) return 'No IKEv2 keyrings configured.';
    const lines: string[] = [];
    for (const [name, kr] of this.ikev2Keyrings) {
      lines.push(`Keyring: ${name}`);
      for (const [peerName, peer] of kr.peers) {
        lines.push(`  Peer: ${peerName}`);
        if (peer.address) lines.push(`    Address: ${peer.address}`);
        if (peer.preSharedKey) lines.push(`    Pre-shared key: ${'*'.repeat(8)}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  showCryptoISAKMPKey(): string {
    if (this.preSharedKeys.size === 0) return 'No pre-shared keys configured.';
    const lines: string[] = ['Keychain  Hostname / Address   Preshared Key'];
    for (const [addr, key] of this.preSharedKeys) {
      lines.push(`default   ${addr.padEnd(21)}${key.replace(/./g, '*')}`);
    }
    return lines.join('\n');
  }

  // ── Multicast SA Show Commands (RFC 4301 §4.1) ──────────────────────

  showCryptoIPSecMulticastSA(): string {
    if (this.multicastSADB.size === 0) return 'No multicast IPSec SAs established.';

    const lines: string[] = ['Multicast IPSec Security Associations', ''];
    const localIPs = this.getAllLocalIPs();

    for (const [, msa] of this.multicastSADB) {
      const isSender = localIPs.includes(msa.senderAddress);
      const role = isSender ? 'Sender' : 'Receiver';

      lines.push(`  Group: ${msa.groupAddress}`);
      lines.push(`    Sender: ${msa.senderAddress}`);
      lines.push(`    SPI: ${spiHex(msa.spi)} (${msa.spi})`);
      lines.push(`    Protocol: ${msa.protocol.toUpperCase()}`);
      lines.push(`    Transform: ${msa.transforms.join(' ')}`);
      lines.push(`    Mode: ${msa.mode}`);
      lines.push(`    Role: ${role}`);
      lines.push(`    Anti-replay: ${msa.antiReplayEnabled ? 'Enabled' : 'Disabled (RFC 4301 §4.1 recommendation)'}`);
      lines.push(`    Receivers: ${msa.receivers.length > 0 ? msa.receivers.join(', ') : '(none)'}`);
      lines.push(`    #pkts encaps: ${msa.pktsEncaps}, #pkts decaps: ${msa.pktsDecaps}`);
      lines.push(`    #send errors: ${msa.sendErrors}, #recv errors: ${msa.recvErrors}`);

      const elapsedSec = Math.floor((Date.now() - msa.created) / 1000);
      const remainingSec = Math.max(0, msa.lifetime - elapsedSec);
      lines.push(`    SA lifetime: ${msa.lifetime}s, remaining: ${remainingSec}s`);
      lines.push(`    Outbound sequence number: ${msa.outboundSeqNum}`);

      // Show crypto keys info
      const ck = msa.cryptoKeys;
      if (ck.espEncAlgorithm !== 'null') {
        lines.push(`    ESP encryption: ${ck.espEncAlgorithm} (${ck.espEncKeyLength}-bit key)`);
      }
      if (ck.espAuthAlgorithm !== 'none' && ck.espAuthAlgorithm !== 'aes-gcm') {
        lines.push(`    ESP authentication: ${ck.espAuthAlgorithm} (${ck.espAuthKeyLength}-bit key)`);
      }
      if (ck.ahAuthAlgorithm !== 'none') {
        lines.push(`    AH authentication: ${ck.ahAuthAlgorithm} (${ck.ahAuthKeyLength}-bit key)`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  showRunningConfig(): string[] {
    const lines: string[] = [];

    // Global IPSec settings
    if (this.globalSALifetimeSeconds !== 3600) {
      lines.push(`crypto ipsec security-association lifetime seconds ${this.globalSALifetimeSeconds}`);
    }
    if (this.globalSALifetimeKB !== 4608000) {
      lines.push(`crypto ipsec security-association lifetime kilobytes ${this.globalSALifetimeKB}`);
    }
    if (this.replayWindowSize !== 64) {
      lines.push(`crypto ipsec security-association replay window-size ${this.replayWindowSize}`);
    }
    if (this.aggressiveMode) {
      lines.push(`no crypto isakmp aggressive-mode disable`);
    }
    if (this.esnDefault) {
      lines.push(`crypto ipsec security-association esn`);
    }

    // ISAKMP policies
    for (const [, p] of [...this.isakmpPolicies.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push('!');
      lines.push(`crypto isakmp policy ${p.priority}`);
      lines.push(` encryption ${p.encryption}`);
      lines.push(` hash ${p.hash}`);
      lines.push(` authentication ${p.auth}`);
      lines.push(` group ${p.group}`);
      if (p.lifetime !== 86400) lines.push(` lifetime ${p.lifetime}`);
    }
    // PSKs
    for (const [addr, key] of this.preSharedKeys) {
      lines.push(`crypto isakmp key ${key} address ${addr}`);
    }
    if (this.natKeepaliveInterval > 0) {
      lines.push(`crypto isakmp nat keepalive ${this.natKeepaliveInterval}`);
    }
    if (this.dpdConfig) {
      lines.push(`crypto isakmp keepalive ${this.dpdConfig.interval} ${this.dpdConfig.retries} ${this.dpdConfig.mode}`);
    }

    // Transform sets
    for (const [, ts] of this.transformSets) {
      lines.push('!');
      lines.push(`crypto ipsec transform-set ${ts.name} ${ts.transforms.join(' ')}`);
      lines.push(` mode ${ts.mode}`);
    }

    // Crypto maps
    for (const [, cmap] of this.cryptoMaps) {
      for (const [, entry] of [...cmap.staticEntries.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push('!');
        lines.push(`crypto map ${cmap.name} ${entry.seq} ipsec-isakmp`);
        for (const peer of entry.peers) lines.push(` set peer ${peer}`);
        for (const ts of entry.transformSets) lines.push(` set transform-set ${ts}`);
        if (entry.aclName) lines.push(` match address ${entry.aclName}`);
        if (entry.pfsGroup) lines.push(` set pfs ${entry.pfsGroup}`);
        if (entry.saLifetimeSeconds) lines.push(` set security-association lifetime seconds ${entry.saLifetimeSeconds}`);
        if (entry.ikev2ProfileName) lines.push(` set ikev2-profile ${entry.ikev2ProfileName}`);
      }
      for (const [seq, dynName] of cmap.dynamicEntries) {
        lines.push('!');
        lines.push(`crypto map ${cmap.name} ${seq} ipsec-isakmp dynamic ${dynName}`);
      }
    }

    // IKEv2
    for (const [, prop] of this.ikev2Proposals) {
      lines.push('!');
      lines.push(`crypto ikev2 proposal ${prop.name}`);
      if (prop.encryption.length) lines.push(` encryption ${prop.encryption.join(' ')}`);
      if (prop.integrity.length) lines.push(` integrity ${prop.integrity.join(' ')}`);
      if (prop.dhGroup.length) lines.push(` group ${prop.dhGroup.join(' ')}`);
    }
    for (const [, pol] of this.ikev2Policies) {
      lines.push('!');
      lines.push(`crypto ikev2 policy ${pol.priority}`);
      for (const p of pol.proposalNames) lines.push(` proposal ${p}`);
    }
    for (const [, kr] of this.ikev2Keyrings) {
      lines.push('!');
      lines.push(`crypto ikev2 keyring ${kr.name}`);
      for (const [, peer] of kr.peers) {
        lines.push(` peer ${peer.name}`);
        lines.push(`  address ${peer.address}`);
        lines.push(`  pre-shared-key ${peer.preSharedKey}`);
      }
    }
    for (const [, prof] of this.ikev2Profiles) {
      lines.push('!');
      lines.push(`crypto ikev2 profile ${prof.name}`);
      if (prof.matchIdentityRemoteAddress) lines.push(` match identity remote address ${prof.matchIdentityRemoteAddress} 255.255.255.255`);
      lines.push(` authentication local ${prof.authLocal}`);
      lines.push(` authentication remote ${prof.authRemote}`);
      if (prof.keyringName) lines.push(` keyring local ${prof.keyringName}`);
      if (prof.keyringLocalName) lines.push(` keyring local ${prof.keyringLocalName}`);
    }

    return lines;
  }

  showRunningConfigInterface(ifName: string): string[] {
    const lines: string[] = [];
    const mapName = this.ifaceCryptoMap.get(ifName);
    if (mapName) lines.push(` crypto map ${mapName}`);
    const tp = this.tunnelProtection.get(ifName);
    if (tp) lines.push(` tunnel protection ipsec profile ${tp.profileName}${tp.shared ? ' shared' : ''}`);
    return lines;
  }
}
