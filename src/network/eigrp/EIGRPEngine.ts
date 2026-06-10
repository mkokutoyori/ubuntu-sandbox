import { IPAddress, SubnetMask } from '../core/types';
import {
  AbstractRoutingProtocolEngine,
} from '../routing/AbstractRoutingProtocolEngine';
import type { RibRoute, RoutingPeer } from '../routing/types';

export interface EigrpNetworkStmt {
  network: string;
  wildcard?: string;
}

export interface EigrpIfaceMetrics {
  bandwidthKbps: number;
  delayTensOfUs: number;
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
  k1: number;
  k2: number;
  k3: number;
  k4: number;
  k5: number;
  ifaceMetrics: Map<string, EigrpIfaceMetrics>;
}

const EIGRP_INTERNAL_AD = 90;
const DEFAULT_BW_KBPS = 100_000;
const DEFAULT_DELAY_TENS_US = 10;

function toNum(ip: string): number {
  return IPAddress.tryParse(ip)?.toUint32() ?? -1;
}

function classfulMaskBits(ip: string): number {
  const first = Number(ip.split('.')[0]);
  if (first < 128) return 8;
  if (first < 192) return 16;
  return 24;
}

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

interface TopoEntry {
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
  private topo: Map<string, TopoEntry> = new Map();

  protected defaultConfig(): EIGRPConfig {
    return {
      asn: 0, networks: [], passive: new Set(), autoSummary: true,
      variance: 1, maximumPaths: 4, redistribute: [],
      k1: 1, k2: 0, k3: 1, k4: 0, k5: 0,
      ifaceMetrics: new Map(),
    };
  }

  get asn(): number { return this.config.asn; }

  setInterfaceMetrics(ifName: string, bwKbps: number, delayTensOfUs: number): void {
    this.config.ifaceMetrics.set(ifName, { bandwidthKbps: bwKbps, delayTensOfUs });
  }

  private ifaceMetrics(ifName: string): EigrpIfaceMetrics {
    return this.config.ifaceMetrics.get(ifName) ?? {
      bandwidthKbps: DEFAULT_BW_KBPS,
      delayTensOfUs: DEFAULT_DELAY_TENS_US,
    };
  }

  private compositeMetric(minBwKbps: number, totalDelayTensOfUs: number): number {
    const { k1, k2, k3, k4, k5 } = this.config;
    const bwComp = k1 * Math.round((1e7 / minBwKbps) * 256);
    const delayComp = k3 * totalDelayTensOfUs * 256;
    const loadComp = k2 * Math.round((1e7 / minBwKbps) * 256 / (256 - 1));
    const reliabilityComp = k4 > 0 ? k4 * 0 : 0;
    const mtuFactor = k5 > 0 ? (k5 / (k4 + 1)) : 0;
    return bwComp + delayComp + loadComp + reliabilityComp + mtuFactor;
  }

  private localMetricForIface(ifName: string): { bwKbps: number; delayTensOfUs: number } {
    const m = this.ifaceMetrics(ifName);
    return { bwKbps: m.bandwidthKbps, delayTensOfUs: m.delayTensOfUs };
  }

  originatedPrefixes(): Array<{ network: IPAddress; mask: SubnetMask; bwKbps: number; delayTensOfUs: number }> {
    const out: Array<{ network: IPAddress; mask: SubnetMask; bwKbps: number; delayTensOfUs: number }> = [];
    for (const c of this.deviceCtx.connectedNetworks()) {
      if (this.config.passive.has(c.iface)) continue;
      const activated = this.config.networks.some((s) =>
        statementCovers(s, String(c.localIp)));
      if (!activated) continue;
      const { bwKbps, delayTensOfUs } = this.localMetricForIface(c.iface);
      out.push({ network: c.network, mask: c.mask, bwKbps, delayTensOfUs });
    }
    return out;
  }

  getTopologyTable(): ReadonlyMap<string, TopoEntry> {
    return this.topo;
  }

  protected computeNeighbors(peers: RoutingPeer[]): void {
    const previousIds = new Set(this.neighbors.view().map((n) => n.id));
    const keep = new Set<string>();
    for (const p of peers) {
      if (this.config.passive.has(p.localIface)) continue;
      const peerEng = p.peerEngineFor('eigrp') as EIGRPEngine | null;
      if (!peerEng || !peerEng.isEnabled()) continue;
      if (peerEng.asn !== this.config.asn) continue;
      const kMatch = peerEng.config.k1 === this.config.k1 &&
        peerEng.config.k2 === this.config.k2 &&
        peerEng.config.k3 === this.config.k3 &&
        peerEng.config.k4 === this.config.k4 &&
        peerEng.config.k5 === this.config.k5;
      if (!kMatch) continue;
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
    const candidates: Map<string, Array<{
      nextHop: IPAddress | null;
      iface: string;
      metric: number;
      rd: number;
    }>> = new Map();

    const prefixMasks = new Map<string, { network: IPAddress; mask: SubnetMask }>();

    for (const p of peers) {
      const peerEng = p.peerEngineFor('eigrp') as EIGRPEngine | null;
      if (!peerEng || !peerEng.isEnabled() || peerEng.asn !== this.config.asn) continue;

      const { bwKbps: localBw, delayTensOfUs: localDelay } = this.localMetricForIface(p.localIface);

      for (const pre of peerEng.originatedPrefixes()) {
        const cidr = pre.mask.toCIDR();
        const key = `${pre.network}/${cidr}`;
        const minBw = Math.min(localBw, pre.bwKbps);
        const totalDelay = localDelay + pre.delayTensOfUs;
        const rd = this.compositeMetric(pre.bwKbps, pre.delayTensOfUs);
        const metric = this.compositeMetric(minBw, totalDelay);

        if (!candidates.has(key)) candidates.set(key, []);
        if (!prefixMasks.has(key)) prefixMasks.set(key, { network: pre.network, mask: pre.mask });
        candidates.get(key)!.push({ nextHop: p.remoteIp, iface: p.localIface, metric, rd });
      }
    }

    const newTopo = new Map<string, TopoEntry>();
    const routes: RibRoute[] = [];

    for (const [key, paths] of candidates) {
      paths.sort((a, b) => a.metric - b.metric);
      const best = paths[0];
      const fd = best.metric;

      const feasibleSuccessors = paths.slice(1).filter(p => p.rd < fd);

      newTopo.set(key, {
        fd,
        successorNextHop: best.nextHop,
        successorIface: best.iface,
        feasibleSuccessors: feasibleSuccessors.map(p => ({
          nextHop: p.nextHop,
          iface: p.iface,
          rd: p.rd,
          metric: p.metric,
        })),
      });

      const threshold = fd * this.config.variance;
      let count = 0;
      const pm = prefixMasks.get(key)!;
      for (const path of paths) {
        if (count >= this.config.maximumPaths) break;
        if (path.metric > threshold) break;
        routes.push({
          network: pm.network,
          mask: pm.mask,
          nextHop: path.nextHop,
          iface: path.iface,
          protocol: 'eigrp',
          adminDistance: EIGRP_INTERNAL_AD,
          metric: path.metric,
        });
        count++;
      }
    }

    this.topo = newTopo;
    return routes;
  }
}
