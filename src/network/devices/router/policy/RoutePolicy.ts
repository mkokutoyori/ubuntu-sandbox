export type RoutePolicyAction = 'permit' | 'deny';

export interface RoutePolicyMatch {
  ipPrefix?: string;
  ipv6Prefix?: string;
  acl?: number;
  community?: string;
  asPath?: string;
  interface?: string;
  tag?: number;
  routeType?: string;
  extCommunity?: string;
}

export interface RoutePolicyApply {
  ipNextHop?: string;
  ipv6NextHop?: string;
  cost?: number;
  preference?: number;
  tag?: number;
  community?: string;
  asPath?: string;
  localPreference?: number;
  origin?: 'igp' | 'egp' | 'incomplete';
  metricType?: 'type-1' | 'type-2';
}

export class RoutePolicyNode {
  readonly nodeId: number;
  readonly action: RoutePolicyAction;
  match: RoutePolicyMatch = {};
  apply: RoutePolicyApply = {};

  constructor(nodeId: number, action: RoutePolicyAction) {
    this.nodeId = nodeId;
    this.action = action;
  }

  ifMatch(patch: Partial<RoutePolicyMatch>): void { Object.assign(this.match, patch); }
  applySet(patch: Partial<RoutePolicyApply>): void { Object.assign(this.apply, patch); }

  render(): string[] {
    const out: string[] = [];
    if (this.match.ipPrefix) out.push(` if-match ip-prefix ${this.match.ipPrefix}`);
    if (this.match.ipv6Prefix) out.push(` if-match ipv6 address prefix-list ${this.match.ipv6Prefix}`);
    if (this.match.acl !== undefined) out.push(` if-match acl ${this.match.acl}`);
    if (this.match.community) out.push(` if-match community ${this.match.community}`);
    if (this.match.asPath) out.push(` if-match as-path ${this.match.asPath}`);
    if (this.match.interface) out.push(` if-match interface ${this.match.interface}`);
    if (this.match.tag !== undefined) out.push(` if-match tag ${this.match.tag}`);
    if (this.match.routeType) out.push(` if-match route-type ${this.match.routeType}`);
    if (this.apply.ipNextHop) out.push(` apply ip-address next-hop ${this.apply.ipNextHop}`);
    if (this.apply.ipv6NextHop) out.push(` apply ipv6 next-hop ${this.apply.ipv6NextHop}`);
    if (this.apply.cost !== undefined) out.push(` apply cost ${this.apply.cost}`);
    if (this.apply.preference !== undefined) out.push(` apply preference ${this.apply.preference}`);
    if (this.apply.tag !== undefined) out.push(` apply tag ${this.apply.tag}`);
    if (this.apply.community) out.push(` apply community ${this.apply.community}`);
    if (this.apply.localPreference !== undefined) out.push(` apply local-preference ${this.apply.localPreference}`);
    if (this.apply.origin) out.push(` apply origin ${this.apply.origin}`);
    if (this.apply.metricType) out.push(` apply cost-type ${this.apply.metricType}`);
    return out;
  }
}

export class RoutePolicy {
  readonly name: string;
  private nodes = new Map<number, RoutePolicyNode>();

  constructor(name: string) { this.name = name; }

  upsertNode(nodeId: number, action: RoutePolicyAction): RoutePolicyNode {
    let n = this.nodes.get(nodeId);
    if (!n || n.action !== action) { n = new RoutePolicyNode(nodeId, action); this.nodes.set(nodeId, n); }
    return n;
  }

  removeNode(nodeId: number): boolean { return this.nodes.delete(nodeId); }
  getNode(nodeId: number): RoutePolicyNode | undefined { return this.nodes.get(nodeId); }
  list(): RoutePolicyNode[] {
    return [...this.nodes.values()].sort((a, b) => a.nodeId - b.nodeId);
  }

  render(): string[] {
    const lines: string[] = [];
    for (const n of this.list()) {
      lines.push(`route-policy ${this.name} ${n.action} node ${n.nodeId}`);
      lines.push(...n.render());
    }
    return lines;
  }
}

export class RoutePolicyStore {
  private policies = new Map<string, RoutePolicy>();
  upsert(name: string): RoutePolicy {
    let p = this.policies.get(name);
    if (!p) { p = new RoutePolicy(name); this.policies.set(name, p); }
    return p;
  }
  get(name: string): RoutePolicy | undefined { return this.policies.get(name); }
  remove(name: string): boolean { return this.policies.delete(name); }
  list(): RoutePolicy[] { return [...this.policies.values()]; }

  renderHuawei(): string {
    const out: string[] = [];
    for (const p of this.list()) out.push(...p.render());
    return out.join('\n');
  }
}
