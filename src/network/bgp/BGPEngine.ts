/**
 * BGPEngine — a real, lightweight BGP engine on the shared routing
 * foundation. Real config-driven: a session reaches Established only
 * when the configured `neighbor` IP is a genuinely cabled peer that
 * runs BGP and has a reciprocal neighbor pointing back (correct ASes).
 * Otherwise the session is Idle (no peer) or Active (peer present but
 * not reciprocally configured) — the true protocol state, never a
 * fabricated "up". Learned routes are the peer's really-originated
 * networks via the real link (eBGP AD 20 / iBGP AD 200).
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
  selectBestPath, BGP_DEFAULT_LOCAL_PREF, BGP_WEIGHT_LOCAL,
  type BgpPathCandidate,
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
        && !ownNetworks.has(`${e.route.network}/${e.route.mask}`))
      .map((e) => e.route);
  }

  /**
   * Local BGP RIB (Loc-RIB) — originated prefixes plus routes learned
   * transitively from Established peers, reduced to the single best
   * path per prefix.
   *
   * RFC 4271 semantics implemented here:
   *  - §6.3 loop prevention: an advertisement whose AS_PATH already
   *    contains our own ASN is rejected on receipt.
   *  - §9.1.1 decision process: candidates for the same prefix compete
   *    through the full attribute ladder (weight, LOCAL_PREF, local
   *    origination, AS_PATH length, origin, MED, eBGP>iBGP, router-id,
   *    peer IP) via `selectBestPath`.
   *  - iBGP split-horizon (§9.2.1.1): routes learned from an iBGP peer are
   *    not re-advertised to other iBGP peers (full-mesh assumption).
   *
   * `visited` keeps the engine-graph walk linear and guards iBGP cycles,
   * which empty AS_PATHs cannot break on their own.
   */
  private collectRib(peers: RoutingPeer[], visited: Set<BGPEngine>): BgpRibEntry[] {
    if (visited.has(this)) return [];
    visited.add(this);

    const byPrefix = new Map<string, BgpRibEntry[]>();
    const consider = (entry: BgpRibEntry): void => {
      const key = `${entry.route.network}/${entry.route.mask}`;
      const group = byPrefix.get(key);
      if (group) group.push(entry);
      else byPrefix.set(key, [entry]);
    };

    for (const pre of this.originatedPrefixes()) {
      consider({
        route: {
          network: pre.network, mask: pre.mask,
          nextHop: null, iface: '',
          protocol: 'bgp', adminDistance: EBGP_AD, metric: 0,
        },
        source: 'originated',
        weight: BGP_WEIGHT_LOCAL, localPref: this.config.defaultLocalPref,
        locallyOriginated: true, asPath: [], origin: 'igp', med: 0,
        isEbgp: false,
        peerRouterId: this.config.routerId ?? '0.0.0.0', peerIp: '0.0.0.0',
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
          route: {
            network: adv.network, mask: adv.mask,
            nextHop: peer.remoteIp, iface: peer.localIface,
            protocol: 'bgp',
            adminDistance: isEbgp ? EBGP_AD : IBGP_AD, metric: 0,
          },
          source: isEbgp ? 'ebgp' : 'ibgp',
          weight: cfg.weight ?? 0,
          // LOCAL_PREF only travels inside the AS (RFC 4271 §5.1.5);
          // eBGP paths compete with the local default.
          localPref: isEbgp
            ? this.config.defaultLocalPref
            : peerCfg.defaultLocalPref,
          locallyOriginated: false,
          asPath: adv.asPath,
          origin: 'igp',                 // `network` statements are IGP
          med: 0,
          isEbgp,
          peerRouterId: peerCfg.routerId ?? ip,
          peerIp: ip,
        });
      }
    }

    const best: BgpRibEntry[] = [];
    for (const group of byPrefix.values()) {
      const winner = selectBestPath(group);
      if (winner) best.push(winner as BgpRibEntry);
    }
    return best;
  }

  /**
   * Routes this router advertises to a peer in `receiverAsn` — only the
   * best path per prefix (§9.1.3), with the AS_PATH the receiver would
   * see: prepended with our ASN for eBGP, unchanged for iBGP (§5.1.2).
   */
  private advertisedTo(receiverAsn: number, visited: Set<BGPEngine>): BgpAdvertisedRoute[] {
    const ibgpReceiver = receiverAsn === this.config.asn;
    const out: BgpAdvertisedRoute[] = [];
    for (const entry of this.collectRib(this.locatePeers(), visited)) {
      if (ibgpReceiver && entry.source === 'ibgp') continue; // split-horizon
      out.push({
        network: entry.route.network, mask: entry.route.mask,
        asPath: ibgpReceiver
          ? [...entry.asPath]
          : [this.config.asn, ...entry.asPath],
      });
    }
    return out;
  }

  /** BGP table rows for `show ip bgp` — real paths, no fabrication. */
  getBgpTable(): BgpTableRow[] {
    if (!this.isEnabled()) return [];
    return this.collectRib(this.locatePeers(), new Set()).map((e) => ({
      network: e.route.network, mask: e.route.mask,
      nextHop: e.route.nextHop,
      asPath: [...e.asPath],
      weight: e.weight,
      origin: 'i' as const,
    })).sort((a, b) => String(a.network).localeCompare(String(b.network)));
  }
}

/** A route as advertised on the wire to a given receiver. */
export interface BgpAdvertisedRoute {
  network: IPAddress;
  mask: SubnetMask;
  asPath: number[];
}

/** One row of the local BGP table (for `show ip bgp`). */
export interface BgpTableRow {
  network: IPAddress;
  mask: SubnetMask;
  nextHop: IPAddress | null;
  asPath: number[];
  weight: number;
  origin: 'i';
}

/** A best-path candidate annotated with where it came from. */
interface BgpRibEntry extends BgpPathCandidate {
  source: 'originated' | 'ebgp' | 'ibgp';
}
