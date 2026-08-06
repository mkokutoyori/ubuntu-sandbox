/**
 * RoutingConfigRepository — config-driven state for routing processes
 * that have no full engine (BGP, EIGRP) plus the extra RIP knobs the
 * RIP engine doesn't model. The CLI records exactly what was
 * configured; `show ip protocols` / `show ip bgp` / `show ip eigrp`
 * project this real remembered state. No fabricated adjacencies: a
 * lone device has no peers, so neighbours stay Idle/none — which is
 * the true state.
 */

export type RedistributeProtocol =
  'connected' | 'static' | 'rip' | 'ospf' | 'eigrp' | 'bgp' | 'isis';

export interface RedistributeSource {
  protocol: RedistributeProtocol;
  processId?: number;
  metric?: number[];
  metricType?: number;
  routeMap?: string;
  subnets?: boolean;
  tail?: string[];
}

export function redistributeKey(source: RedistributeSource): string {
  return `${source.protocol}${source.processId !== undefined ? ` ${source.processId}` : ''}`;
}

export function renderRedistribute(source: RedistributeSource): string {
  const parts: string[] = [source.protocol];
  if (source.processId !== undefined) parts.push(String(source.processId));
  if (source.metric && source.metric.length > 0) parts.push('metric', ...source.metric.map(String));
  if (source.metricType !== undefined) parts.push('metric-type', String(source.metricType));
  if (source.subnets) parts.push('subnets');
  if (source.routeMap) parts.push('route-map', source.routeMap);
  if (source.tail && source.tail.length > 0) parts.push(...source.tail);
  return parts.join(' ');
}

const REDISTRIBUTE_PROTOCOLS: readonly RedistributeProtocol[] =
  ['connected', 'static', 'rip', 'ospf', 'eigrp', 'bgp', 'isis'];

export function parseRedistribute(args: readonly string[]): RedistributeSource | null {
  const protocol = REDISTRIBUTE_PROTOCOLS.find((p) => p === (args[0] ?? '').toLowerCase());
  if (!protocol) return null;
  const source: RedistributeSource = { protocol };
  let i = 1;
  if (/^\d+$/.test(args[1] ?? '')) { source.processId = parseInt(args[1], 10); i = 2; }
  const tail: string[] = [];
  while (i < args.length) {
    const token = args[i].toLowerCase();
    if (token === 'metric') {
      const values: number[] = [];
      while (i + 1 < args.length && /^\d+$/.test(args[i + 1])) values.push(parseInt(args[++i], 10));
      if (values.length === 0) return null;
      source.metric = values;
    } else if (token === 'metric-type' && /^\d+$/.test(args[i + 1] ?? '')) {
      source.metricType = parseInt(args[++i], 10);
    } else if (token === 'subnets') {
      source.subnets = true;
    } else if (token === 'route-map' && args[i + 1]) {
      source.routeMap = args[++i];
    } else {
      tail.push(args[i]);
    }
    i++;
  }
  if (tail.length > 0) source.tail = tail;
  return source;
}

export function upsertRedistribute(list: RedistributeSource[], source: RedistributeSource): void {
  const key = redistributeKey(source);
  const i = list.findIndex((s) => redistributeKey(s) === key);
  if (i >= 0) list[i] = source; else list.push(source);
}

export interface RipExtras {
  version: 1 | 2 | null;
  autoSummary: boolean;
  passiveDefault: boolean;
  passive: Set<string>;
  redistribute: RedistributeSource[];
  networks: string[];
  neighbors: string[];
  distance?: number;
  defaultMetric?: number;
  defaultInfoOriginate: boolean;
  maximumPaths?: number;
  timersBasic?: string;
}

export interface EigrpProcess {
  asn: number;
  routerId?: string;
  networks: string[];
  passive: Set<string>;
  redistribute: RedistributeSource[];
  variance?: number;
  maximumPaths?: number;
  /** `metric maximum-hops <n>` — diamètre au-delà duquel une route est inaccessible. */
  maximumHops?: number;
  autoSummary: boolean;
  stub?: string;
  named?: boolean;
  addressFamilies: string[];
}

export interface BgpNeighbor {
  ip: string;
  remoteAs?: number;
  description?: string;
  updateSource?: string;
  peerGroup?: string;
  activated: boolean;
  attrs: string[];        // remaining per-neighbor knobs, as configured
}

/**
 * Un groupe de pairs BGP — un MODÈLE, pas un pair.
 *
 * La distinction est toute la subtilité de la construction : `neighbor
 * IBGP peer-group` crée un gabarit, `neighbor 10.0.0.2 peer-group IBGP`
 * y rattache un vrai voisin, et tout ce qui est réglé sur le gabarit
 * s'applique à ses membres. Un groupe n'a pas de session, ne s'établit
 * pas, et ne doit donc JAMAIS apparaître dans `show ip bgp summary` —
 * l'y voir avec « AS 0, Idle » est ce que faisait le simulateur, et
 * c'est un pair qui n'existe pas.
 */
export interface BgpPeerGroup {
  name: string;
  remoteAs?: number;
  description?: string;
  updateSource?: string;
  activated?: boolean;
  attrs: string[];
}

export interface BgpProcess {
  asn: number;
  routerId?: string;
  networks: string[];
  redistribute: RedistributeSource[];
  neighbors: Map<string, BgpNeighbor>;
  /** Les gabarits, tenus à part des voisins pour qu'on ne puisse pas les confondre. */
  peerGroups: Map<string, BgpPeerGroup>;
  addressFamilies: string[];
  /**
   * `no bgp default ipv4-unicast`. Quand la famille par défaut est
   * désactivée, un voisin doit être explicitement `activate`é dans son
   * address-family avant d'échanger des préfixes — c'est la première
   * ligne de toute configuration MP-BGP.
   */
  defaultIpv4Unicast: boolean;
}

export class RoutingConfigRepository {
  readonly rip: RipExtras = {
    version: null, autoSummary: true, passiveDefault: false,
    passive: new Set(), redistribute: [], networks: [], neighbors: [],
    defaultInfoOriginate: false,
  };
  private readonly eigrp = new Map<number, EigrpProcess>();
  private bgp: BgpProcess | null = null;

  // ── EIGRP ───────────────────────────────────────────────────────
  ensureEigrp(asn: number, named = false): EigrpProcess {
    let p = this.eigrp.get(asn);
    if (!p) {
      p = { asn, networks: [], passive: new Set(), redistribute: [],
        autoSummary: true, named, addressFamilies: [] };
      this.eigrp.set(asn, p);
    }
    return p;
  }
  removeEigrp(asn: number): void { this.eigrp.delete(asn); }
  allEigrp(): EigrpProcess[] {
    return [...this.eigrp.values()].sort((a, b) => a.asn - b.asn);
  }

  // ── BGP ─────────────────────────────────────────────────────────
  ensureBgp(asn: number): BgpProcess | null {
    if (this.bgp && this.bgp.asn !== asn) return null;
    if (!this.bgp) {
      this.bgp = { asn, networks: [], redistribute: [],
        neighbors: new Map(), peerGroups: new Map(),
        addressFamilies: [], defaultIpv4Unicast: true };
    }
    return this.bgp;
  }
  getBgp(): BgpProcess | null { return this.bgp; }
  removeBgp(): void { this.bgp = null; }

  ensureBgpNeighbor(ip: string): BgpNeighbor | null {
    if (!this.bgp) return null;
    let n = this.bgp.neighbors.get(ip);
    if (!n) {
      n = { ip, activated: false, attrs: [] };
      this.bgp.neighbors.set(ip, n);
    }
    return n;
  }

  /** Crée le gabarit s'il n'existe pas. Jamais un voisin. */
  ensureBgpPeerGroup(name: string): BgpPeerGroup | null {
    if (!this.bgp) return null;
    let g = this.bgp.peerGroups.get(name);
    if (!g) {
      g = { name, attrs: [] };
      this.bgp.peerGroups.set(name, g);
    }
    return g;
  }

  getBgpPeerGroup(name: string): BgpPeerGroup | undefined {
    return this.bgp?.peerGroups.get(name);
  }

  /**
   * Recopie les réglages du gabarit sur chacun de ses membres. Appelée
   * après CHAQUE modification du gabarit, parce que sur un vrai IOS
   * l'ordre n'importe pas : régler `remote-as` sur le groupe après que
   * les membres l'ont rejoint doit les atteindre quand même. Un réglage
   * posé explicitement sur le voisin lui-même n'est pas écrasé — le
   * gabarit fournit un défaut, il ne confisque pas.
   */
  applyBgpPeerGroup(name: string): BgpNeighbor[] {
    const g = this.bgp?.peerGroups.get(name);
    if (!g || !this.bgp) return [];
    const touches: BgpNeighbor[] = [];
    for (const n of this.bgp.neighbors.values()) {
      if (n.peerGroup !== name) continue;
      if (g.remoteAs !== undefined && n.remoteAs === undefined) n.remoteAs = g.remoteAs;
      if (g.updateSource !== undefined && n.updateSource === undefined) n.updateSource = g.updateSource;
      if (g.description !== undefined && n.description === undefined) n.description = g.description;
      if (g.activated) n.activated = true;
      touches.push(n);
    }
    return touches;
  }

  reset(): void {
    this.eigrp.clear();
    this.bgp = null;
    Object.assign(this.rip, {
      version: null, autoSummary: true, passiveDefault: false,
      passive: new Set<string>(), redistribute: [], networks: [],
      neighbors: [], defaultInfoOriginate: false,
      distance: undefined, defaultMetric: undefined,
      maximumPaths: undefined, timersBasic: undefined,
    });
  }
}
