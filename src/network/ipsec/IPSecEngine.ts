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
  IPv4Packet, ESPPacket, AHPacket,
  IP_PROTO_ESP, IP_PROTO_AH,
  createIPv4Packet, computeIPv4Checksum,
} from '../core/types';
import {
  ISAKMPPolicy, TransformSet, CryptoMapEntry, CryptoMap, DynamicCryptoMap,
  DynamicCryptoMapEntry, IKEv2Proposal, IKEv2Policy, IKEv2Keyring, IKEv2Profile,
  IPSecProfile, TunnelProtection,
  IKE_SA, IKEv2_SA, IPSec_SA, DPDConfig,
} from './IPSecTypes';
import { Equipment } from '../equipment/Equipment';
import { Logger } from '../core/Logger';

// Forward reference — resolved at runtime to avoid circular imports
type Router = import('../devices/Router').Router;

let spiCounter = 0x1000;
function nextSPI(): number {
  spiCounter = (spiCounter + 1) & 0xffffffff;
  return spiCounter;
}
function spiHex(spi: number): string {
  return `0x${spi.toString(16).toUpperCase().padStart(8, '0')}`;
}

export class IPSecEngine {
  private readonly router: Router;

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

  // ── IKEv2 Configuration ──────────────────────────────────────────
  private ikev2Proposals: Map<string, IKEv2Proposal> = new Map();
  private ikev2Policies: Map<string, IKEv2Policy> = new Map();
  private ikev2Keyrings: Map<string, IKEv2Keyring> = new Map();
  private ikev2Profiles: Map<string, IKEv2Profile> = new Map();

  // ── IPSec Profiles (GRE/tunnel protection) ───────────────────────
  private ipsecProfiles: Map<string, IPSecProfile> = new Map();
  private tunnelProtection: Map<string, TunnelProtection> = new Map();

  // ── SA Database ──────────────────────────────────────────────────
  /** peerIP → IKE_SA */
  private ikeSADB: Map<string, IKE_SA> = new Map();
  /** peerIP → IKEv2_SA */
  private ikev2SADB: Map<string, IKEv2_SA> = new Map();
  /** peerIP → IPSec_SA[] */
  private ipsecSADB: Map<string, IPSec_SA[]> = new Map();
  /** inbound SPI → IPSec_SA (for fast lookup during decryption) */
  private spiToSA: Map<number, IPSec_SA> = new Map();

  constructor(router: Router) {
    this.router = router;
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

  // ══════════════════════════════════════════════════════════════════
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

  clearAllSAs(): void {
    this.ikeSADB.clear();
    this.ikev2SADB.clear();
    this.ipsecSADB.clear();
    this.spiToSA.clear();
  }

  // ══════════════════════════════════════════════════════════════════
  // Data plane: outbound packet processing
  // ══════════════════════════════════════════════════════════════════

  /**
   * Check if a packet leaving via `egressIface` should be encrypted.
   * Returns the matching CryptoMapEntry (or null if no match).
   */
  findMatchingCryptoEntry(pkt: IPv4Packet, egressIface: string): CryptoMapEntry | null {
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
   * Returns the outer IPv4 packet (ESP-encapsulated) or null if failed.
   */
  processOutbound(pkt: IPv4Packet, egressIface: string, entry: CryptoMapEntry): IPv4Packet | null {
    // Determine peer IP
    let peerIP = this.determinePeer(entry, egressIface, pkt);
    if (!peerIP) return null;

    // Get or establish SA
    let sa = this.getBestIPSecSA(peerIP);
    if (!sa) {
      const ok = this.negotiateTunnel(peerIP, entry, egressIface);
      if (!ok) return null;
      sa = this.getBestIPSecSA(peerIP);
      if (!sa) return null;
    }

    // Wrap in ESP (or AH for AH-only)
    return this.encapsulate(pkt, sa, egressIface);
  }

  private determinePeer(entry: CryptoMapEntry, egressIface: string, pkt: IPv4Packet): string | null {
    if (entry.peers.length > 0 && entry.peers[0] !== '0.0.0.0') {
      return entry.peers[0];
    }
    // Tunnel protection: peer is the tunnel destination
    const ports = (this.router as any)._getPortsInternal() as Map<string, any>;
    const port = ports.get(egressIface);
    if (port) {
      const tunnelDst = port.getTunnelDestination?.();
      if (tunnelDst) return tunnelDst.toString();
    }
    // Dynamic: peer = packet destination
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

    sa.pktsEncaps++;

    if (sa.hasESP) {
      const espPayload: ESPPacket = {
        type: 'esp',
        spi: sa.spiOut,
        sequenceNumber: sa.pktsEncaps,
        innerPacket: innerPkt,
      };
      const outerSize = 20 + 8 + innerPkt.totalLength; // IP + ESP header + inner
      return createIPv4Packet(
        localIP,
        new IPAddress(sa.peerIP),
        IP_PROTO_ESP,
        64,
        espPayload,
        outerSize,
      );
    } else if (sa.hasAH) {
      const ahPayload: AHPacket = {
        type: 'ah',
        spi: sa.spiOut,
        sequenceNumber: sa.pktsEncaps,
        innerPacket: innerPkt,
      };
      const outerSize = 20 + 12 + innerPkt.totalLength;
      return createIPv4Packet(
        localIP,
        new IPAddress(sa.peerIP),
        IP_PROTO_AH,
        64,
        ahPayload,
        outerSize,
      );
    }
    return null;
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

    sa.pktsDecaps++;
    return esp.innerPacket;
  }

  processInboundAH(outerPkt: IPv4Packet): IPv4Packet | null {
    const ah = outerPkt.payload as AHPacket;
    if (!ah || ah.type !== 'ah') return null;

    const sa = this.spiToSA.get(ah.spi);
    if (!sa) return null;

    sa.pktsDecaps++;
    return ah.innerPacket;
  }

  // ══════════════════════════════════════════════════════════════════
  // IKE Negotiation (synchronous, direct engine-to-engine)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Initiate IKEv1/IKEv2 tunnel establishment with a peer.
   * Synchronous — completes immediately by directly calling the peer's engine.
   */
  private negotiateTunnel(peerIP: string, entry: CryptoMapEntry, egressIface: string): boolean {
    // Find peer router
    const peerRouter = IPSecEngine.findRouterByIP(peerIP);
    if (!peerRouter) {
      Logger.info(this.router.id, 'ipsec:no-peer',
        `${this.router.name}: IKE peer ${peerIP} unreachable`);
      // Create stub IKE SA in failed state for display purposes
      this.createFailedIKESA(peerIP, egressIface, 'Peer unreachable');
      return false;
    }

    const peerEngine = (peerRouter as any)._getIPSecEngineInternal?.() as IPSecEngine | null;
    if (!peerEngine) return false;

    // Determine my local IP (on egress interface)
    const localIP = this.getLocalIP(egressIface) || '';
    // Compute apparent source IP (may differ if NAT is on path)
    const apparentSrcIP = this.getApparentSourceIP(localIP, peerIP);

    // Check IKEv2 profile
    const useIKEv2 = entry.ikev2ProfileName
      ? this.ikev2Profiles.has(entry.ikev2ProfileName)
      : this.ikev2Policies.size > 0 && this.ikev2Keyrings.size > 0 && this.ikev2Profiles.size > 0;

    if (useIKEv2) {
      return this.negotiateIKEv2(peerIP, peerEngine, entry, localIP, apparentSrcIP, egressIface);
    }
    return this.negotiateIKEv1(peerIP, peerEngine, entry, localIP, apparentSrcIP, egressIface);
  }

  // ── IKEv1 ──────────────────────────────────────────────────────

  private negotiateIKEv1(
    peerIP: string, peerEngine: IPSecEngine, entry: CryptoMapEntry,
    localIP: string, apparentSrcIP: string, egressIface: string,
  ): boolean {
    // Phase 1: find matching ISAKMP policy
    const myPolicies = [...this.isakmpPolicies.values()].sort((a, b) => a.priority - b.priority);
    const peerPolicies = [...peerEngine.isakmpPolicies.values()].sort((a, b) => a.priority - b.priority);

    let matchedPolicy: ISAKMPPolicy | null = null;
    for (const mp of myPolicies) {
      for (const pp of peerPolicies) {
        if (this.policiesCompatible(mp, pp)) { matchedPolicy = mp; break; }
      }
      if (matchedPolicy) break;
    }

    if (!matchedPolicy) {
      Logger.info(this.router.id, 'ipsec:no-policy', `${this.router.name}: No common IKE policy with ${peerIP}`);
      this.createFailedIKESA(peerIP, egressIface, 'No matching policy');
      peerEngine.createFailedIKESA(apparentSrcIP, '', 'No matching policy');
      return false;
    }

    // Verify PSK
    const myPSK = this.preSharedKeys.get(peerIP) || this.preSharedKeys.get('0.0.0.0');
    const peerPSK = peerEngine.preSharedKeys.get(apparentSrcIP) || peerEngine.preSharedKeys.get('0.0.0.0');

    if (!myPSK || !peerPSK || myPSK !== peerPSK) {
      Logger.info(this.router.id, 'ipsec:psk-fail', `${this.router.name}: PSK mismatch with ${peerIP}`);
      this.createFailedIKESA(peerIP, egressIface, 'PSK mismatch');
      peerEngine.createFailedIKESA(apparentSrcIP, '', 'PSK mismatch');
      return false;
    }

    const natT = (this.natKeepaliveInterval > 0 || peerEngine.natKeepaliveInterval > 0)
      && apparentSrcIP !== localIP;

    // Create IKE SA on both sides
    const spi = nextSPI();
    const ikeSA: IKE_SA = {
      peerIP, localIP,
      status: 'QM_IDLE',
      encryption: matchedPolicy.encryption,
      hash: matchedPolicy.hash,
      group: matchedPolicy.group,
      lifetime: matchedPolicy.lifetime,
      created: Date.now(),
      spi: spiHex(spi),
      role: 'initiator',
      natT,
      dpdEnabled: this.dpdConfig !== null,
    };
    this.ikeSADB.set(peerIP, ikeSA);

    const peerLocalIP = peerEngine.getLocalIP('') || peerIP;
    const peerIkeSA: IKE_SA = {
      peerIP: apparentSrcIP, localIP: peerLocalIP,
      status: 'QM_IDLE',
      encryption: matchedPolicy.encryption,
      hash: matchedPolicy.hash,
      group: matchedPolicy.group,
      lifetime: matchedPolicy.lifetime,
      created: Date.now(),
      spi: spiHex(nextSPI()),
      role: 'responder',
      natT,
      dpdEnabled: peerEngine.dpdConfig !== null,
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

    const lifetime = entry.saLifetimeSeconds ?? 3600;
    const spiInitIn  = nextSPI(); // initiator's inbound SPI (what responder will use as outbound)
    const spiRespIn  = nextSPI(); // responder's inbound SPI (what initiator will use as outbound)

    const hasESP = chosenTs.transforms.some(t => t.startsWith('esp'));
    const hasAH  = chosenTs.transforms.some(t => t.startsWith('ah'));

    const localIP = this.getLocalIP(egressIface) || '';

    // Initiator SA
    const sa: IPSec_SA = {
      peerIP, localIP,
      spiIn: spiInitIn,
      spiOut: spiRespIn,
      transforms: chosenTs.transforms,
      mode: chosenTs.mode === 'transport' ? 'Transport' : 'Tunnel',
      aclName: entry.aclName,
      pktsEncaps: 0, pktsDecaps: 0,
      sendErrors: 0, recvErrors: 0,
      created: Date.now(),
      lifetime,
      pfsGroup: entry.pfsGroup,
      natT,
      outIface: egressIface,
      hasESP, hasAH,
    };
    const existing = this.ipsecSADB.get(peerIP) || [];
    existing.push(sa);
    this.ipsecSADB.set(peerIP, existing);
    this.spiToSA.set(spiInitIn, sa);

    // Responder SA (on peer engine)
    const peerLocalIP = peerEngine.getLocalIP(peerEntry?.aclName ? '' : '') || peerIP;
    const peerSA: IPSec_SA = {
      peerIP: apparentSrcIP,
      localIP: peerLocalIP,
      spiIn: spiRespIn,
      spiOut: spiInitIn,
      transforms: chosenTs.transforms,
      mode: chosenTs.mode === 'transport' ? 'Transport' : 'Tunnel',
      aclName: peerEntry?.aclName || entry.aclName,
      pktsEncaps: 0, pktsDecaps: 0,
      sendErrors: 0, recvErrors: 0,
      created: Date.now(),
      lifetime,
      pfsGroup: entry.pfsGroup,
      natT,
      outIface: '',
      hasESP, hasAH,
    };
    const peerExisting = peerEngine.ipsecSADB.get(apparentSrcIP) || [];
    peerExisting.push(peerSA);
    peerEngine.ipsecSADB.set(apparentSrcIP, peerExisting);
    peerEngine.spiToSA.set(spiRespIn, peerSA);

    Logger.info(this.router.id, 'ipsec:sa-up',
      `${this.router.name}: IPSec SA UP with ${peerIP} [${chosenTs.transforms.join(',')}]`);
    return true;
  }

  // ── IKEv2 ──────────────────────────────────────────────────────

  private negotiateIKEv2(
    peerIP: string, peerEngine: IPSecEngine, entry: CryptoMapEntry,
    localIP: string, apparentSrcIP: string, egressIface: string,
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

    const natT = (this.natKeepaliveInterval > 0 || peerEngine.natKeepaliveInterval > 0)
      && apparentSrcIP !== localIP;
    const spiL = spiHex(nextSPI());
    const spiR = spiHex(nextSPI());

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
      spi: spiHex(nextSPI()),
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

  // ══════════════════════════════════════════════════════════════════
  // Show commands
  // ══════════════════════════════════════════════════════════════════

  showCryptoISAKMPSA(): string {
    if (this.ikeSADB.size === 0) {
      return 'IPv4 Crypto ISAKMP SA\ndst             src             state          conn-id status\n';
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
      extra.push(`   Encryption: ${sa.encryption}, Hash: ${sa.hash}, DH Group: ${sa.group}`);
      extra.push(`   Lifetime: ${sa.lifetime}s, created ${Math.floor((Date.now() - sa.created) / 1000)}s ago`);
      if (sa.natT) {
        extra.push(`   NAT-T: enabled, port 4500`);
        extra.push(`   NAT-T keepalive interval: ${this.natKeepaliveInterval}s`);
      }
      if (sa.dpdEnabled && this.dpdConfig) {
        extra.push(`   DPD: keepalive ${this.dpdConfig.interval} ${this.dpdConfig.retries} ${this.dpdConfig.mode}`);
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
    if (lines.length === 0) lines.push('IKE global config:');
    return lines.join('\n');
  }

  showCryptoISAKMPPolicy(): string {
    if (this.isakmpPolicies.size === 0) {
      return 'Default protection suite of priority 65507\n\tencryption algorithm:   DES - Data Encryption Standard (56 bit keys).\n\thash algorithm:         Secure Hash Standard\n\tauthentication method:  Rivest-Shamir-Adleman Signature\n\tDiffie-Hellman group:  #1 (768 bit)\n\tlifetime:               86400 seconds, no volume limit';
    }
    const lines: string[] = [];
    for (const [, p] of [...this.isakmpPolicies.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`Protection suite of priority ${p.priority}`);
      lines.push(`\tencryption algorithm:   ${this.formatEncForPolicy(p.encryption)}`);
      lines.push(`\thash algorithm:         ${this.formatHashForPolicy(p.hash)}`);
      lines.push(`\tauthentication method:  ${p.auth === 'pre-share' ? 'Pre-Shared Key' : p.auth}`);
      lines.push(`\tDiffie-Hellman group:  #${p.group}`);
      lines.push(`\tlifetime:               ${p.lifetime} seconds, no volume limit`);
    }
    return lines.join('\n');
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
        lines.push('');
        lines.push(`interface: ${sa.outIface || 'GigabitEthernet0/1'}`);
        lines.push(`    Crypto map tag: CMAP, local addr ${sa.localIP}`);
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
        lines.push(`   #send errors ${sa.sendErrors}, #recv errors ${sa.recvErrors}`);
        lines.push('');
        lines.push(`    local crypto endpt.: ${sa.localIP} remote crypto endpt.: ${peerIP}`);
        lines.push(`    path mtu 1500, ip mtu 1500, ip mtu idb GigabitEthernet0/1`);
        if (sa.natT) {
          lines.push(`    current outbound spi: ${spiHex(sa.spiOut)}(${sa.spiOut})`);
          lines.push(`    UDP encap: src port 4500, dst port 4500`);
        } else {
          lines.push(`    current outbound spi: ${spiHex(sa.spiOut)}(${sa.spiOut})`);
        }
        lines.push('');
        if (sa.hasESP) {
          lines.push(`    inbound esp sas:`);
          lines.push(`     spi: ${spiHex(sa.spiIn)}(${sa.spiIn})`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms)} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
          lines.push(`       ...`);
          lines.push(`    outbound esp sas:`);
          lines.push(`     spi: ${spiHex(sa.spiOut)}(${sa.spiOut})`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms)} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
        }
        if (sa.hasAH) {
          lines.push(`    inbound ah sas:`);
          lines.push(`     spi: ${spiHex(sa.spiIn)}(${sa.spiIn})`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms.filter(t => t.startsWith('ah')))} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
          lines.push(`    outbound ah sas:`);
          lines.push(`     spi: ${spiHex(sa.spiOut)}(${sa.spiOut})`);
          lines.push(`       transform: ${this.formatTransforms(sa.transforms.filter(t => t.startsWith('ah')))} ,`);
          lines.push(`       in use settings ={${sa.mode}, }`);
        }
      }
    }
    return lines.length ? lines.join('\n') : 'No IPSec SAs established.';
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

  showCryptoIPSecTransformSet(): string {
    if (this.transformSets.size === 0) return 'No transform sets defined.';
    const lines: string[] = [];
    for (const [, ts] of this.transformSets) {
      lines.push(`Transform set default: { ${ts.transforms.join(' ')} }`);
      lines.push(`   will negotiate = { ${ts.mode === 'transport' ? 'Transport' : 'Tunnel'}, },`);
      lines.push('');
      lines.push(`Transform set ${ts.name}: { ${ts.transforms.join(' ')} }`);
      lines.push(`   will negotiate = { ${ts.mode === 'transport' ? 'Transport' : 'Tunnel'}, },`);
    }
    return lines.join('\n');
  }

  showCryptoMap(): string {
    const lines: string[] = [];
    for (const [, cmap] of this.cryptoMaps) {
      for (const [, entry] of [...cmap.staticEntries.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`Crypto Map IPv4 "${cmap.name}" ${entry.seq} ipsec-isakmp`);
        lines.push(`\tPeer = ${entry.peers.join(', ')}`);
        lines.push(`\tExtended IP access list ${entry.aclName}`);
        lines.push(`\tSecurity association lifetime: 4608000 kilobytes/${entry.saLifetimeSeconds || 3600} seconds`);
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
        lines.push(`Crypto Map IPv4 "${cmap.name}" ${seq} ipsec-isakmp dynamic ${dynMapName}`);
      }
    }
    return lines.length ? lines.join('\n') : 'No crypto maps configured.';
  }

  showCryptoIKEv2SA(): string {
    if (this.ikev2SADB.size === 0) return 'There are no IKEv2 SAs.';
    const lines = [
      'IPv4 Crypto IKEv2 SA',
      '',
      `Tunnel-id Local                 Remote                fvrf/ivrf            Status`,
    ];
    let tid = 1;
    for (const [, sa] of this.ikev2SADB) {
      lines.push(`${String(tid++).padEnd(10)}${sa.localIP.padEnd(22)}${sa.peerIP.padEnd(22)}none/none            ${sa.status}`);
    }
    return lines.join('\n');
  }

  showCryptoIKEv2SADetail(): string {
    const base = this.showCryptoIKEv2SA();
    const extra: string[] = [];
    for (const [, sa] of this.ikev2SADB) {
      extra.push('');
      extra.push(`IKEv2 SA Details for ${sa.peerIP}`);
      extra.push(`  Role: ${sa.role}`);
      extra.push(`  Local SPI  : ${sa.spiLocal}`);
      extra.push(`  Remote SPI : ${sa.spiRemote}`);
      extra.push(`  Encryption : ${sa.encryptionUsed}`);
      extra.push(`  Integrity  : ${sa.integrityUsed}`);
      extra.push(`  DH Group   : ${sa.dhGroupUsed}`);
      extra.push(`  Status     : ${sa.status}`);
      if (sa.natT) extra.push(`  NAT-T      : enabled (port 4500)`);
    }
    return base + '\n' + extra.join('\n');
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
    // Convert CLI names to display names
    return transforms.map(t => {
      const map: Record<string, string> = {
        'esp-aes': 'esp-128-aes',
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

  showRunningConfig(): string[] {
    const lines: string[] = [];

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
