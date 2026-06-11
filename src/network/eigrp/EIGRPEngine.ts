/**
 * EIGRPEngine — a real, lightweight EIGRP engine on the shared
 * routing foundation. Real config-driven: a neighbour forms only with
 * a genuinely cabled peer running EIGRP in the SAME autonomous system
 * AND matching K values (RFC 7868 §5.4); learned routes are the peer's
 * really-originated connected networks reached via the real link.
 *
 * Path selection follows DUAL's feasibility condition: per prefix the
 * lowest-FD path is the successor; an alternate path is also installed
 * only when its reported distance is below the successor's FD and its
 * own FD fits within `variance × FD(successor)` (classic unequal-cost
 * load sharing), capped by `maximum-paths`. Metrics are the classic
 * 256-scaled composite of min-bandwidth and cumulative delay.
 */
import { IPAddress, SubnetMask } from '../core/types';
import { Logger } from '../core/Logger';
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type { RibRoute, RoutingPeer } from '../routing/types';
import {
  compositeMetric, kValuesMatch,
  EIGRP_DEFAULT_K_VALUES,
  EIGRP_FALLBACK_BANDWIDTH_KBPS, EIGRP_FALLBACK_DELAY_USEC,
  type EigrpKValues,
} from './metric';

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
  /** Composite-metric coefficients (`metric weights 0 k1 k2 k3 k4 k5`). */
  kValues: EigrpKValues;
}

/** A prefix this engine really originates, with its link attributes. */
export interface EigrpOriginatedPrefix {
  network: IPAddress;
  mask: SubnetMask;
  /** Effective bandwidth (kbps) of the originating interface. */
  bandwidthKbps?: number;
  /** Delay (µs) of the originating interface. */
  delayUsec?: number;
}

/** EIGRP administrative distances (internal / redistributed-external). */
export const EIGRP_INTERNAL_AD = 90;
export const EIGRP_EXTERNAL_AD = 170;

/** One candidate path to a prefix, with DUAL's two distances. */
interface PathCandidate {
  route: RibRoute;
  /** Feasible distance — full metric through this neighbour. */
  fd: number;
  /** Reported distance — the neighbour's own metric to the prefix. */
  rd: number;
}

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
  if (stmt.wildcard) {
    const w = toNum(stmt.wildcard);
    const mask = (~w) >>> 0;
    return (ipNum & mask) === (netNum & mask);
  }
  const bits = classfulMaskBits(stmt.network);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/** Topology-table entry surfaced by `show ip eigrp topology`. */
export interface EigrpTopoEntry {
  fd: number;
  successorNextHop: IPAddress | null;
  successorIface: string;
  feasibleSuccessors: Array<{
    nextHop: IPAddress | null;
    iface: string;
    rd: number;
    metric: number;
  }>;
}

export class EIGRPEngine extends AbstractRoutingProtocolEngine<EIGRPConfig> {
  readonly protocol = 'eigrp';
  private topo: Map<string, EigrpTopoEntry> = new Map();

  getTopologyTable(): ReadonlyMap<string, EigrpTopoEntry> {
    return this.topo;
  }

  protected defaultConfig(): EIGRPConfig {
    return {
      asn: 0, networks: [], passive: new Set(), autoSummary: true,
      variance: 1, maximumPaths: 4, redistribute: [],
      kValues: EIGRP_DEFAULT_K_VALUES,
    };
  }

  get asn(): number { return this.config.asn; }

  /** Connected networks this device really originates into EIGRP. */
  originatedPrefixes(): EigrpOriginatedPrefix[] {
    const out: EigrpOriginatedPrefix[] = [];
    for (const c of this.deviceCtx.connectedNetworks()) {
      if (this.config.passive.has(c.iface)) continue;
      const activated = this.config.networks.some((s) =>
        statementCovers(s, String(c.localIp)));
      if (activated) {
        out.push({
          network: c.network, mask: c.mask,
          bandwidthKbps: c.bandwidthKbps, delayUsec: c.delayUsec,
        });
      }
    }
    return out;
  }

  protected computeNeighbors(peers: RoutingPeer[]): void {
    const previousIds = new Set(this.neighbors.view().map((n) => n.id));
    const keep = new Set<string>();
    for (const p of peers) {
      if (this.config.passive.has(p.localIface)) continue;
      const peerEng = p.peerEngineFor('eigrp') as EIGRPEngine | null;
      if (!peerEng || !peerEng.isEnabled()) continue;
      if (peerEng.asn !== this.config.asn) continue;   // AS must match
      // RFC 7868 §5.4 — mismatched K values block the adjacency. Real
      // IOS logs '%DUAL-5-NBRCHANGE … K-value mismatch' instead of
      // hiding the neighbour silently — make it diagnosable.
      if (!kValuesMatch(this.config.kValues,
        peerEng.getConfig().kValues)) {
        const peerIp = p.remoteIp ? String(p.remoteIp) : p.hostname;
        this.bus?.publish({
          topic: 'eigrp.neighbor.k-value-mismatch',
          payload: {
            deviceId: this.deviceId,
            neighbor: p.deviceId,
            neighborIp: peerIp,
            iface: p.localIface,
            asn: this.config.asn,
            localK: { ...this.config.kValues },
            peerK: { ...peerEng.getConfig().kValues },
          },
        } as never);
        Logger.warn(this.deviceId, 'eigrp:k-mismatch',
          `EIGRP-IPv4 ${this.config.asn}: Neighbor ${peerIp} (${p.localIface}) is down: K-value mismatch`);
        continue;
      }
      keep.add(p.deviceId);
      const isNew = !previousIds.has(p.deviceId);
      this.neighbors.upsert(
        p.deviceId,
        p.remoteIp ? String(p.remoteIp) : p.hostname,
        p.localIface, 'Up',
        peerEng.getConfig().routerId,
      );
      if (isNew) {
        this.bus?.publish({
          topic: 'eigrp.neighbor.state-changed',
          payload: {
            deviceId: this.deviceId,
            neighbor: p.deviceId,
            iface: p.localIface,
            oldState: 'Down', newState: 'Up',
            asn: this.config.asn,
          },
        } as never);
      }
    }
    for (const stale of previousIds) {
      if (!keep.has(stale)) {
        this.bus?.publish({
          topic: 'eigrp.neighbor.state-changed',
          payload: {
            deviceId: this.deviceId,
            neighbor: stale,
            iface: '',
            oldState: 'Up', newState: 'Down',
            asn: this.config.asn,
          },
        } as never);
      }
    }
    this.neighbors.retainOnly(keep);
  }

  protected computeRoutes(peers: RoutingPeer[]): RibRoute[] {
    const k = this.config.kValues;
    // Real IOS never installs a protocol route for its own connected
    // prefixes — connected (AD 0) always wins.
    const ownNetworks = new Set(this.deviceCtx.connectedNetworks()
      .map((c) => `${c.network}/${c.mask}`));

    const candidatesByPrefix = new Map<string, PathCandidate[]>();
    for (const p of peers) {
      const peerEng = p.peerEngineFor('eigrp') as EIGRPEngine | null;
      if (!peerEng || !peerEng.isEnabled() || peerEng.asn !== this.config.asn) {
        continue;
      }
      if (!kValuesMatch(k, peerEng.getConfig().kValues)) continue;
      const linkBw = p.linkBandwidthKbps ?? EIGRP_FALLBACK_BANDWIDTH_KBPS;
      const linkDelay = p.linkDelayUsec ?? EIGRP_FALLBACK_DELAY_USEC;
      for (const pre of peerEng.originatedPrefixes()) {
        const key = `${pre.network}/${pre.mask}`;
        if (ownNetworks.has(key)) continue;
        const destBw = pre.bandwidthKbps ?? EIGRP_FALLBACK_BANDWIDTH_KBPS;
        const destDelay = pre.delayUsec ?? EIGRP_FALLBACK_DELAY_USEC;
        const rd = compositeMetric(
          { bandwidthKbps: destBw, delayUsec: destDelay }, k);
        const fd = compositeMetric({
          bandwidthKbps: Math.min(linkBw, destBw),
          delayUsec: linkDelay + destDelay,
        }, k);
        const candidate: PathCandidate = {
          fd, rd,
          route: {
            network: pre.network, mask: pre.mask,
            nextHop: p.remoteIp, iface: p.localIface,
            protocol: 'eigrp',
            adminDistance: EIGRP_INTERNAL_AD,
            metric: fd,
          },
        };
        const group = candidatesByPrefix.get(key);
        if (group) group.push(candidate);
        else candidatesByPrefix.set(key, [candidate]);
      }
    }
    return this.selectSuccessors(candidatesByPrefix);
  }

  /**
   * DUAL path selection per prefix: best-FD successor first, then
   * feasible alternates (RD < FD(successor)) within the variance
   * multiplier, capped by `maximum-paths`.
   */
  private selectSuccessors(
    candidatesByPrefix: Map<string, PathCandidate[]>,
  ): RibRoute[] {
    const variance = Math.max(1, this.config.variance);
    const maxPaths = Math.max(1, this.config.maximumPaths);
    const routes: RibRoute[] = [];
    const newTopo = new Map<string, EigrpTopoEntry>();
    for (const group of candidatesByPrefix.values()) {
      group.sort((a, b) => a.fd - b.fd);
      const successor = group[0];
      const displayKey =
        `${successor.route.network}/${successor.route.mask.toCIDR()}`;
      newTopo.set(displayKey, {
        fd: successor.fd,
        successorNextHop: successor.route.nextHop,
        successorIface: successor.route.iface,
        feasibleSuccessors: group.slice(1)
          .filter((p) => p.rd < successor.fd)
          .map((p) => ({
            nextHop: p.route.nextHop, iface: p.route.iface,
            rd: p.rd, metric: p.fd,
          })),
      });
      routes.push(successor.route);
      let installed = 1;
      for (const alt of group.slice(1)) {
        if (installed >= maxPaths) break;
        const feasible = alt.rd < successor.fd;
        const withinVariance = alt.fd <= successor.fd * variance;
        if (feasible && withinVariance) {
          routes.push(alt.route);
          installed += 1;
        }
      }
    }
    this.topo = newTopo;
    return routes;
  }
}
