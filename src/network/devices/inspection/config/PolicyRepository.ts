/**
 * PolicyRepository — config-driven routing-policy state (Lot C):
 * IP/IPv6 prefix-lists and route-maps. `ip prefix-list …` /
 * `route-map …` mutate real entries; `show ip prefix-list` /
 * `show route-map` project them. No fabricated policy.
 */

export interface PrefixListEntry {
  seq: number;
  action: 'permit' | 'deny';
  prefix: string;       // e.g. 10.0.0.0/8
  ge?: number;
  le?: number;
}

export interface RouteMapClause {
  action: 'permit' | 'deny';
  seq: number;
  match: string[];
  set: string[];
  description?: string;
}

export class PolicyRepository {
  private readonly prefixLists = new Map<string, PrefixListEntry[]>();
  private readonly v6PrefixLists = new Map<string, PrefixListEntry[]>();
  private readonly routeMaps = new Map<string, RouteMapClause[]>();

  // ── Prefix-lists ────────────────────────────────────────────────
  addPrefix(name: string, entry: PrefixListEntry, v6 = false): void {
    const map = v6 ? this.v6PrefixLists : this.prefixLists;
    const list = map.get(name) ?? [];
    const i = list.findIndex((e) => e.seq === entry.seq);
    if (i >= 0) list[i] = entry; else list.push(entry);
    list.sort((a, b) => a.seq - b.seq);
    map.set(name, list);
  }

  removePrefixList(name: string, seq?: number, v6 = false): void {
    const map = v6 ? this.v6PrefixLists : this.prefixLists;
    if (seq === undefined) { map.delete(name); return; }
    const list = map.get(name);
    if (list) map.set(name, list.filter((e) => e.seq !== seq));
  }

  nextPrefixSeq(name: string, v6 = false): number {
    const list = (v6 ? this.v6PrefixLists : this.prefixLists).get(name) ?? [];
    return list.length ? Math.max(...list.map((e) => e.seq)) + 5 : 5;
  }

  renderPrefixLists(name?: string, v6 = false): string {
    const map = v6 ? this.v6PrefixLists : this.prefixLists;
    const names = name ? [name] : [...map.keys()];
    if (!names.length) return v6
      ? 'No IPv6 prefix-lists configured.'
      : 'No IP prefix-lists configured.';
    const out: string[] = [];
    for (const n of names) {
      const list = map.get(n);
      if (!list) { out.push(`% prefix-list ${n} not found`); continue; }
      out.push(`ip${v6 ? 'v6' : ''} prefix-list ${n}: ${list.length} entries`);
      for (const e of list) {
        out.push(`   seq ${e.seq} ${e.action} ${e.prefix}` +
          `${e.ge !== undefined ? ` ge ${e.ge}` : ''}` +
          `${e.le !== undefined ? ` le ${e.le}` : ''}`);
      }
    }
    return out.join('\n');
  }

  // ── Route-maps ──────────────────────────────────────────────────
  ensureRouteMap(name: string, action: 'permit' | 'deny', seq: number): RouteMapClause {
    const clauses = this.routeMaps.get(name) ?? [];
    let c = clauses.find((x) => x.seq === seq);
    if (!c) {
      c = { action, seq, match: [], set: [] };
      clauses.push(c);
      clauses.sort((a, b) => a.seq - b.seq);
    } else {
      c.action = action;
    }
    this.routeMaps.set(name, clauses);
    return c;
  }

  removeRouteMap(name: string): void { this.routeMaps.delete(name); }

  renderRouteMaps(name?: string): string {
    const names = name ? [name] : [...this.routeMaps.keys()];
    if (!names.length) return 'No route-maps configured.';
    const out: string[] = [];
    for (const n of names) {
      const clauses = this.routeMaps.get(n);
      if (!clauses) { out.push(`% route-map ${n} not found`); continue; }
      for (const c of clauses) {
        out.push(`route-map ${n}, ${c.action} sequence ${c.seq}`);
        if (c.description) out.push(`  Description: ${c.description}`);
        out.push('  Match clauses:');
        for (const m of c.match) out.push(`    ${m}`);
        out.push('  Set clauses:');
        for (const s of c.set) out.push(`    ${s}`);
      }
    }
    return out.join('\n');
  }

  reset(): void {
    this.prefixLists.clear();
    this.v6PrefixLists.clear();
    this.routeMaps.clear();
  }
}
