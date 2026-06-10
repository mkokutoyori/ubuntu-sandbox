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
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type {
  NeighborFsmState, RibRoute, RoutingPeer,
} from '../routing/types';
import {
  selectBestPath, BGP_DEFAULT_LOCAL_PREF,
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
  const num = (s: string) => {
    const p = s.split('.').map(Number);
    return p.length === 4 ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : -1;
  };
  const bits = new SubnetMask(am).toCIDR();
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (num(a) & mask) === (num(b) & mask);
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

    const candidatesByPrefix = new Map<string, BgpPathCandidate[]>();
    for (const [ip, cfg] of this.config.neighbors) {
      const { state, peer, peerEng } = this.sessionState(ip, peers);
      if (state !== 'Established' || !peer || !peerEng) continue;
      const isEbgp = (cfg.remoteAs ?? peerEng.asn) !== this.config.asn;
      const ad = isEbgp ? EBGP_AD : IBGP_AD;
      // 1-hop model: an eBGP peer prepends its own AS when advertising
      // (RFC 4271 §5.1.2); iBGP re-advertises with an empty path.
      const asPath = isEbgp ? [peerEng.asn] : [];
      const peerCfg = peerEng.getConfig();
      for (const pre of peerEng.originatedPrefixes()) {
        const key = `${pre.network}/${pre.mask}`;
        if (ownNetworks.has(key)) continue;
        const candidate: BgpPathCandidate = {
          route: {
            network: pre.network, mask: pre.mask,
            nextHop: peer.remoteIp, iface: peer.localIface,
            protocol: 'bgp', adminDistance: ad, metric: 0,
          },
          weight: cfg.weight ?? 0,
          // LOCAL_PREF only travels inside the AS (RFC 4271 §5.1.5);
          // eBGP paths compete with the local default.
          localPref: isEbgp
            ? this.config.defaultLocalPref
            : peerCfg.defaultLocalPref,
          locallyOriginated: false,
          asPath,
          origin: 'igp',                 // `network` statements are IGP
          med: 0,
          isEbgp,
          peerRouterId: peerCfg.routerId ?? ip,
          peerIp: ip,
        };
        const group = candidatesByPrefix.get(key);
        if (group) group.push(candidate);
        else candidatesByPrefix.set(key, [candidate]);
      }
    }

    const routes: RibRoute[] = [];
    for (const group of candidatesByPrefix.values()) {
      const best = selectBestPath(group);
      if (best) routes.push(best.route);
    }
    return routes;
  }
}
