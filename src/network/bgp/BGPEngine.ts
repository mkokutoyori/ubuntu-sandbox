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

export interface BgpNetworkStmt { network: string; mask: string; }
export interface BgpNeighborCfg {
  ip: string;
  remoteAs?: number;
  activated: boolean;
}
export interface BGPConfig {
  asn: number;
  routerId?: string;
  networks: BgpNetworkStmt[];
  neighbors: Map<string, BgpNeighborCfg>;
  redistribute: string[];
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
    return { asn: 0, networks: [], neighbors: new Map(), redistribute: [] };
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
    const routes: RibRoute[] = [];
    const seen = new Set<string>();
    for (const [ip, cfg] of this.config.neighbors) {
      const { state, peer, peerEng } = this.sessionState(ip, peers);
      if (state !== 'Established' || !peer || !peerEng) continue;
      const ad = (cfg.remoteAs ?? peerEng.asn) === this.config.asn
        ? IBGP_AD : EBGP_AD;
      for (const pre of peerEng.originatedPrefixes()) {
        const key = `${pre.network}/${pre.mask}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({
          network: pre.network, mask: pre.mask,
          nextHop: peer.remoteIp, iface: peer.localIface,
          protocol: 'bgp', adminDistance: ad, metric: 0,
        });
      }
    }
    return routes;
  }
}
