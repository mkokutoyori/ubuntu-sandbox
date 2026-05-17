/**
 * RoutingConfigRepository — config-driven state for routing processes
 * that have no full engine (BGP, EIGRP) plus the extra RIP knobs the
 * RIP engine doesn't model. The CLI records exactly what was
 * configured; `show ip protocols` / `show ip bgp` / `show ip eigrp`
 * project this real remembered state. No fabricated adjacencies: a
 * lone device has no peers, so neighbours stay Idle/none — which is
 * the true state.
 */

export interface RipExtras {
  version: 1 | 2 | null;
  autoSummary: boolean;
  passiveDefault: boolean;
  passive: Set<string>;
  redistribute: string[];
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
  redistribute: string[];
  variance?: number;
  maximumPaths?: number;
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

export interface BgpProcess {
  asn: number;
  routerId?: string;
  networks: string[];
  redistribute: string[];
  neighbors: Map<string, BgpNeighbor>;
  addressFamilies: string[];
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
  ensureBgp(asn: number): BgpProcess {
    if (!this.bgp || this.bgp.asn !== asn) {
      this.bgp = { asn, networks: [], redistribute: [],
        neighbors: new Map(), addressFamilies: [] };
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
