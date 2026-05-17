/**
 * EIGRPEngine — a real, lightweight EIGRP engine on the shared
 * routing foundation. Real config-driven: a neighbour forms only with
 * a genuinely cabled peer running EIGRP in the SAME autonomous system;
 * learned routes are the peer's really-originated connected networks
 * (DUAL-style successor) reached via the real link. A lone device has
 * no neighbour and contributes nothing — the true state.
 */
import { IPAddress, SubnetMask } from '../core/types';
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type { RibRoute, RoutingPeer } from '../routing/types';

export interface EigrpNetworkStmt {
  /** Network address as configured (classful base). */
  network: string;
  /** Optional wildcard mask (e.g. 0.0.255.255). */
  wildcard?: string;
}

export interface EIGRPConfig {
  asn: number;
  routerId?: string;
  networks: EigrpNetworkStmt[];
  passive: Set<string>;
  autoSummary: boolean;
  variance: number;
  maximumPaths: number;
  redistribute: string[];
}

/** EIGRP administrative distance for internal routes. */
const EIGRP_INTERNAL_AD = 90;

function toNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => n >= 0 && n <= 255)
    ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
    : -1;
}

function classfulMaskBits(ip: string): number {
  const first = Number(ip.split('.')[0]);
  if (first < 128) return 8;
  if (first < 192) return 16;
  return 24;
}

/** True if `localIp` is covered by a `network [wildcard]` statement. */
function statementCovers(stmt: EigrpNetworkStmt, localIp: string): boolean {
  const netNum = toNum(stmt.network);
  const ipNum = toNum(localIp);
  if (netNum < 0 || ipNum < 0) return false;
  let bits: number;
  if (stmt.wildcard) {
    const w = toNum(stmt.wildcard);
    const mask = (~w) >>> 0;
    return (ipNum & mask) === (netNum & mask);
  }
  bits = classfulMaskBits(stmt.network);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

export class EIGRPEngine extends AbstractRoutingProtocolEngine<EIGRPConfig> {
  readonly protocol = 'eigrp';

  protected defaultConfig(): EIGRPConfig {
    return {
      asn: 0, networks: [], passive: new Set(), autoSummary: true,
      variance: 1, maximumPaths: 4, redistribute: [],
    };
  }

  get asn(): number { return this.config.asn; }

  /** Connected networks this device really originates into EIGRP. */
  originatedPrefixes(): Array<{ network: IPAddress; mask: SubnetMask }> {
    const out: Array<{ network: IPAddress; mask: SubnetMask }> = [];
    for (const c of this.deviceCtx.connectedNetworks()) {
      if (this.config.passive.has(c.iface)) continue;
      const activated = this.config.networks.some((s) =>
        statementCovers(s, String(c.localIp)));
      if (activated) out.push({ network: c.network, mask: c.mask });
    }
    return out;
  }

  protected computeNeighbors(peers: RoutingPeer[]): void {
    const keep = new Set<string>();
    for (const p of peers) {
      if (this.config.passive.has(p.localIface)) continue;
      const peerEng = p.peerEngineFor('eigrp') as EIGRPEngine | null;
      if (!peerEng || !peerEng.isEnabled()) continue;
      if (peerEng.asn !== this.config.asn) continue;   // AS must match
      keep.add(p.deviceId);
      this.neighbors.upsert(
        p.deviceId,
        p.remoteIp ? String(p.remoteIp) : p.hostname,
        p.localIface, 'Up',
        peerEng.getConfig().routerId,
      );
    }
    this.neighbors.retainOnly(keep);
  }

  protected computeRoutes(peers: RoutingPeer[]): RibRoute[] {
    const routes: RibRoute[] = [];
    const seen = new Set<string>();
    for (const p of peers) {
      const peerEng = p.peerEngineFor('eigrp') as EIGRPEngine | null;
      if (!peerEng || !peerEng.isEnabled() || peerEng.asn !== this.config.asn) {
        continue;
      }
      for (const pre of peerEng.originatedPrefixes()) {
        const key = `${pre.network}/${pre.mask}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({
          network: pre.network,
          mask: pre.mask,
          nextHop: p.remoteIp,
          iface: p.localIface,
          protocol: 'eigrp',
          adminDistance: EIGRP_INTERNAL_AD,
          metric: 1,
        });
      }
    }
    return routes;
  }
}
