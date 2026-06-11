/**
 * BGPEngine — a real, lightweight BGP engine on the shared routing
 * foundation. Real config-driven: a session reaches Established only
 * when the configured `neighbor` IP is a genuinely cabled peer that
 * runs BGP and has a reciprocal neighbor pointing back (correct ASes).
 * Otherwise the session is Idle (no peer) or Active (peer present but
 * not reciprocally configured) — the true protocol state, never a
 * fabricated "up". Learned routes propagate transitively with real
 * AS_PATHs (eBGP AD 20 / iBGP AD 200) and are arbitrated per prefix
 * by the full RFC 4271 §9.1.1 best-path comparison (bestPath.ts).
 */
import { IPAddress, SubnetMask } from '../core/types';
import { tryIpToUint32, prefixLengthToMaskUint32 } from '../core/ip';
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type {
  NeighborFsmState, RibRoute, RoutingPeer,
} from '../routing/types';
import {
  compareBgpPaths, BGP_DEFAULT_LOCAL_PREF, BGP_WEIGHT_LOCAL,
  type BgpPathCandidate, type BgpOrigin,
} from './bestPath';

export interface BgpNetworkStmt { network: string; mask: string; }
export interface BgpNeighborCfg {
  ip: string;
  remoteAs?: number;
  activated: boolean;
  /** Cisco `neighbor <ip> weight <n>` — local preference knob. */
  weight?: number;
}
export interface BGPConfig {
  asn: number;
  routerId?: string;
  networks: BgpNetworkStmt[];
  neighbors: Map<string, BgpNeighborCfg>;
  redistribute: string[];
  /** `bgp default local-preference <n>` (RFC 4271 LOCAL_PREF seed). */
  defaultLocalPref: number;
}

const EBGP_AD = 20;
const IBGP_AD = 200;

function sameNet(a: string, am: string, b: string): boolean {
  const aNum = tryIpToUint32(a);
  const bNum = tryIpToUint32(b);
  if (aNum === null || bNum === null) return false;
  const mask = prefixLengthToMaskUint32(new SubnetMask(am).toCIDR());
  return (aNum & mask) === (bNum & mask);
}

export class BGPEngine extends AbstractRoutingProtocolEngine<BGPConfig> {
  readonly protocol = 'bgp';

  protected defaultConfig(): BGPConfig {
    return {
      asn: 0, networks: [], neighbors: new Map(), redistribute: [],
      defaultLocalPref: BGP_DEFAULT_LOCAL_PREF,
    };
  }

  get asn(): number { return this.config.asn; }
  hasNeighbor(ip: string): BgpNeighborCfg | undefined {
    return this.config.neighbors.get(ip);
  }

  /** Prefixes really originated: a `network` stmt backed by a real
   *  connected network (BGP advertises only present routes). */
  originatedPrefixes(): Array<{ network: IPAddress; mask: SubnetMask }> {
    const conn = this.deviceCtx.connectedNetworks();
    const out: Array<{ network: IPAddress; mask: SubnetMask }> = [];
    for (const s of this.config.networks) {
      const match = conn.some((c) =>
        sameNet(s.network, s.mask, String(c.network)));
      if (match) {
        out.push({ network: new IPAddress(s.network), mask: new SubnetMask(s.mask) });
      }
    }
    return out;
  }

  /** Resolve the session state for a configured neighbour IP. */
  private sessionState(ip: string, peers: RoutingPeer[]): {
    state: NeighborFsmState; peer?: RoutingPeer; peerEng?: BGPEngine;
  } {
    const peer = peers.find((p) => p.remoteIp && String(p.remoteIp) === ip);
    if (!peer) return { state: 'Idle' };          // no TCP path: true
    const peerEng = peer.peerEngineFor('bgp') as BGPEngine | null;
    if (!peerEng || !peerEng.isEnabled()) return { state: 'Active', peer };
    // Reciprocal check: peer must point back at our link IP with our AS.
    const back = peer.localIp ? peerEng.hasNeighbor(String(peer.localIp)) : undefined;
    if (!back) return { state: 'Active', peer, peerEng };
    if (back.remoteAs !== undefined && back.remoteAs !== this.config.asn) {
      return { state: 'OpenSent', peer, peerEng };   // AS mismatch: never up
    }
    return { state: 'Established', peer, peerEng };
  }

  protected computeNeighbors(peers: RoutingPeer[]): void {
    const keep = new Set<string>();
    for (const [ip, cfg] of this.config.neighbors) {
      const { state, peerEng } = this.sessionState(ip, peers);
      keep.add(ip);
      const prev = this.neighbors.view().find((n) => n.id === ip);
      this.neighbors.upsert(ip, ip, peerEng ? 'session' : 'unresolved',
        state, cfg.remoteAs !== undefined ? `AS${cfg.remoteAs}` : undefined);
      if (prev?.state !== state) {
        this.publishNeighborState(ip, prev?.state, state, cfg.remoteAs);
      }
    }
    this.neighbors.retainOnly(keep);
  }

  private publishNeighborState(
    ip: string, oldState: string | undefined, newState: string, remoteAs?: number,
  ): void {
    this.bus?.publish({
      topic: 'bgp.neighbor.state-changed',
      payload: {
        deviceId: this.deviceId,
        neighborIp: ip,
        oldState: oldState ?? 'Idle',
        newState,
        remoteAs: remoteAs ?? null,
      },
    } as never);
  }

  protected computeRoutes(peers: RoutingPeer[]): RibRoute[] {
    // Real BGP never installs a learned path for a prefix it already
    // has connected (the local route always wins in the RIB).
    const ownNetworks = new Set(this.deviceCtx.connectedNetworks()
      .map((c) => `${c.network}/${c.mask}`));
    return this.collectRib(peers, new Set())
      .filter((e) => e.source !== 'originated'
        && !ownNetworks.has(`${e.network}/${e.mask}`))
      .map((e) => this.toRibRoute(e));
  }

  private toRibRoute(e: BgpRibEntry): RibRoute {
    return {
      network: e.network, mask: e.mask,
      nextHop: e.nextHop, iface: e.iface,
      protocol: 'bgp',
      adminDistance: e.source === 'ibgp' ? IBGP_AD : EBGP_AD,
      metric: 0,
    };
  }

  private toCandidate(e: BgpRibEntry): BgpPathCandidate {
    return {
      route: this.toRibRoute(e),
      weight: e.weight,
      localPref: e.localPref,
      locallyOriginated: e.source === 'originated',
      asPath: e.asPath,
      origin: e.origin,
      med: e.med,
      isEbgp: e.source === 'ebgp',
      peerRouterId: e.peerRouterId,
      peerIp: e.peerIp,
    };
  }

  /**
   * Local BGP RIB with path information — originated prefixes plus routes
   * learned transitively from Established peers.
   *
   * RFC 4271 semantics implemented here:
   *  - §6.3 loop prevention: an advertisement whose AS_PATH already
   *    contains our own ASN is rejected on receipt.
   *  - §9.1.1 decision process: for the same prefix, candidates are
   *    arbitrated by the full best-path comparison (weight, LOCAL_PREF,
   *    locally-originated, AS_PATH length, origin, MED, eBGP>iBGP,
   *    router-id, peer IP — see bestPath.ts).
   *  - §5.1.5 LOCAL_PREF scope: carried on iBGP sessions, reset to the
   *    local default when a path is received over eBGP.
   *  - iBGP split-horizon (§9.2.1.1): routes learned from an iBGP peer are
   *    not re-advertised to other iBGP peers (full-mesh assumption).
   *
   * `visited` keeps the engine-graph walk linear and guards iBGP cycles,
   * which empty AS_PATHs cannot break on their own.
   */
  private collectRib(peers: RoutingPeer[], visited: Set<BGPEngine>): BgpRibEntry[] {
    if (visited.has(this)) return [];
    visited.add(this);

    const byPrefix = new Map<string, BgpRibEntry>();
    const consider = (entry: BgpRibEntry): void => {
      const key = `${entry.network}/${entry.mask}`;
      const current = byPrefix.get(key);
      if (!current || compareBgpPaths(
        this.toCandidate(entry), this.toCandidate(current)) < 0) {
        byPrefix.set(key, entry);
      }
    };

    for (const pre of this.originatedPrefixes()) {
      consider({
        network: pre.network, mask: pre.mask,
        asPath: [], source: 'originated', nextHop: null, iface: '',
        weight: BGP_WEIGHT_LOCAL,
        localPref: this.config.defaultLocalPref,
        origin: 'igp',                 // `network` statements are IGP
        med: 0,
        peerRouterId: this.config.routerId ?? '0.0.0.0',
        peerIp: '0.0.0.0',
      });
    }
    for (const [ip, cfg] of this.config.neighbors) {
      const { state, peer, peerEng } = this.sessionState(ip, peers);
      if (state !== 'Established' || !peer || !peerEng) continue;
      const isEbgp = (cfg.remoteAs ?? peerEng.asn) !== this.config.asn;
      const peerCfg = peerEng.getConfig();
      // Each peer branch gets its own copy of the walk: `visited` must
      // prevent cycles along a single advertisement path, not prune
      // legitimate alternative paths through sibling neighbors.
      for (const adv of peerEng.advertisedTo(this.config.asn, new Set(visited))) {
        if (adv.asPath.includes(this.config.asn)) continue; // §6.3 loop check
        consider({
          network: adv.network, mask: adv.mask, asPath: adv.asPath,
          source: isEbgp ? 'ebgp' : 'ibgp',
          nextHop: peer.remoteIp, iface: peer.localIface,
          weight: cfg.weight ?? 0,
          // LOCAL_PREF only travels inside the AS (RFC 4271 §5.1.5);
          // eBGP paths compete with the local default.
          localPref: isEbgp ? this.config.defaultLocalPref : adv.localPref,
          origin: adv.origin,
          med: adv.med,
          peerRouterId: peerCfg.routerId ?? ip,
          peerIp: ip,
        });
      }
    }
    return [...byPrefix.values()];
  }

  /**
   * Routes this router advertises to a peer in `receiverAsn`, with the
   * AS_PATH the receiver would see: prepended with our ASN for eBGP,
   * unchanged for iBGP (RFC 4271 §5.1.2). Path attributes ride along so
   * iBGP receivers can honour the originator's LOCAL_PREF.
   */
  private advertisedTo(receiverAsn: number, visited: Set<BGPEngine>): BgpAdvertisedRoute[] {
    const ibgpReceiver = receiverAsn === this.config.asn;
    const out: BgpAdvertisedRoute[] = [];
    for (const entry of this.collectRib(this.locatePeers(), visited)) {
      if (ibgpReceiver && entry.source === 'ibgp') continue; // split-horizon
      out.push({
        network: entry.network, mask: entry.mask,
        asPath: ibgpReceiver ? entry.asPath : [this.config.asn, ...entry.asPath],
        localPref: entry.localPref,
        origin: entry.origin,
        med: entry.med,
      });
    }
    return out;
  }

  /** BGP table rows for `show ip bgp` — real paths, no fabrication. */
  getBgpTable(): BgpTableRow[] {
    if (!this.isEnabled()) return [];
    return this.collectRib(this.locatePeers(), new Set()).map((e) => ({
      network: e.network, mask: e.mask,
      nextHop: e.nextHop,
      asPath: e.asPath,
      weight: e.weight,
      localPref: e.localPref,
      origin: 'i' as const,
    })).sort((a, b) => String(a.network).localeCompare(String(b.network)));
  }
}

/** A route as advertised on the wire to a given receiver. */
export interface BgpAdvertisedRoute {
  network: IPAddress;
  mask: SubnetMask;
  asPath: number[];
  /** Meaningful to iBGP receivers only (RFC 4271 §5.1.5). */
  localPref: number;
  origin: BgpOrigin;
  med: number;
}

/** One row of the local BGP table (for `show ip bgp`). */
export interface BgpTableRow {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress | null;
  asPath: number[];
  weight: number;
  localPref: number;
  origin: 'i';
}

interface BgpRibEntry {
  network: IPAddress;
  mask: SubnetMask;
  asPath: number[];
  source: 'originated' | 'ebgp' | 'ibgp';
  nextHop: IPAddress | null;
  iface: string;
  weight: number;
  localPref: number;
  origin: BgpOrigin;
  med: number;
  peerRouterId: string;
  peerIp: string;
}
