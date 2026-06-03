export type TrafficMatchKind = 'acl' | 'acl-ipv6' | 'dscp' | 'ip-precedence' | 'protocol' | 'mac' | 'vlan' | 'any';

export interface TrafficMatch {
  kind: TrafficMatchKind;
  value?: string | number;
}

export type TrafficBehaviorAction =
  | { kind: 'permit' }
  | { kind: 'deny' }
  | { kind: 'redirect-ip-nexthop'; nextHop: string }
  | { kind: 'redirect-ipv6-nexthop'; nextHop: string }
  | { kind: 'redirect-interface'; iface: string }
  | { kind: 'remark-dscp'; value: number }
  | { kind: 'remark-precedence'; value: number }
  | { kind: 'car'; cir: number; cbs?: number }
  | { kind: 'statistic'; enabled: boolean }
  | { kind: 'mirror-to'; iface: string };

export class TrafficClassifier {
  readonly name: string;
  readonly operator: 'and' | 'or';
  private matches: TrafficMatch[] = [];

  constructor(name: string, operator: 'and' | 'or' = 'or') {
    this.name = name;
    this.operator = operator;
  }
  addMatch(m: TrafficMatch): void { this.matches.push(m); }
  removeMatch(kind: TrafficMatchKind, value?: string | number): void {
    this.matches = this.matches.filter(x => !(x.kind === kind && (value === undefined || x.value === value)));
  }
  list(): TrafficMatch[] { return [...this.matches]; }
  render(): string[] {
    const out = [`traffic classifier ${this.name} operator ${this.operator}`];
    for (const m of this.matches) {
      if (m.kind === 'any') out.push(' if-match any');
      else if (m.value !== undefined) out.push(` if-match ${m.kind} ${m.value}`);
      else out.push(` if-match ${m.kind}`);
    }
    return out;
  }
}

export class TrafficBehavior {
  readonly name: string;
  private actions: TrafficBehaviorAction[] = [];
  constructor(name: string) { this.name = name; }
  addAction(a: TrafficBehaviorAction): void {
    this.actions = this.actions.filter(x => x.kind !== a.kind);
    this.actions.push(a);
  }
  list(): TrafficBehaviorAction[] { return [...this.actions]; }
  render(): string[] {
    const out = [`traffic behavior ${this.name}`];
    for (const a of this.actions) {
      switch (a.kind) {
        case 'permit': out.push(' permit'); break;
        case 'deny': out.push(' deny'); break;
        case 'redirect-ip-nexthop': out.push(` redirect ip-nexthop ${a.nextHop}`); break;
        case 'redirect-ipv6-nexthop': out.push(` redirect ipv6-nexthop ${a.nextHop}`); break;
        case 'redirect-interface': out.push(` redirect interface ${a.iface}`); break;
        case 'remark-dscp': out.push(` remark dscp ${a.value}`); break;
        case 'remark-precedence': out.push(` remark ip-precedence ${a.value}`); break;
        case 'car': out.push(` car cir ${a.cir}${a.cbs !== undefined ? ` cbs ${a.cbs}` : ''}`); break;
        case 'statistic': out.push(a.enabled ? ' statistic enable' : ' undo statistic enable'); break;
        case 'mirror-to': out.push(` mirror to interface ${a.iface}`); break;
      }
    }
    return out;
  }
}

export interface TrafficPolicyBinding {
  classifier: string;
  behavior: string;
  precedence?: number;
}

export class TrafficPolicy {
  readonly name: string;
  private bindings = new Map<string, TrafficPolicyBinding>();
  constructor(name: string) { this.name = name; }
  attach(classifier: string, behavior: string, precedence?: number): void {
    this.bindings.set(classifier, { classifier, behavior, precedence });
  }
  detach(classifier: string): boolean { return this.bindings.delete(classifier); }
  list(): TrafficPolicyBinding[] { return [...this.bindings.values()]; }
  render(): string[] {
    const out = [`traffic policy ${this.name}`];
    for (const b of this.bindings.values()) {
      out.push(` classifier ${b.classifier} behavior ${b.behavior}${b.precedence !== undefined ? ` precedence ${b.precedence}` : ''}`);
    }
    return out;
  }
}

export type TrafficPolicyDirection = 'inbound' | 'outbound';

export interface TrafficPolicyApplication {
  policy: string;
  iface: string;
  direction: TrafficPolicyDirection;
}

export class TrafficPolicyStore {
  private classifiers = new Map<string, TrafficClassifier>();
  private behaviors = new Map<string, TrafficBehavior>();
  private policies = new Map<string, TrafficPolicy>();
  private applications: TrafficPolicyApplication[] = [];

  upsertClassifier(name: string, operator: 'and' | 'or' = 'or'): TrafficClassifier {
    let c = this.classifiers.get(name);
    if (!c) { c = new TrafficClassifier(name, operator); this.classifiers.set(name, c); }
    return c;
  }
  upsertBehavior(name: string): TrafficBehavior {
    let b = this.behaviors.get(name);
    if (!b) { b = new TrafficBehavior(name); this.behaviors.set(name, b); }
    return b;
  }
  upsertPolicy(name: string): TrafficPolicy {
    let p = this.policies.get(name);
    if (!p) { p = new TrafficPolicy(name); this.policies.set(name, p); }
    return p;
  }
  getClassifier(name: string): TrafficClassifier | undefined { return this.classifiers.get(name); }
  getBehavior(name: string): TrafficBehavior | undefined { return this.behaviors.get(name); }
  getPolicy(name: string): TrafficPolicy | undefined { return this.policies.get(name); }
  apply(iface: string, policy: string, direction: TrafficPolicyDirection): void {
    this.applications = this.applications.filter(a => !(a.iface === iface && a.direction === direction));
    this.applications.push({ policy, iface, direction });
  }
  removeApplication(iface: string, direction: TrafficPolicyDirection): boolean {
    const before = this.applications.length;
    this.applications = this.applications.filter(a => !(a.iface === iface && a.direction === direction));
    return this.applications.length !== before;
  }
  listApplications(): TrafficPolicyApplication[] { return [...this.applications]; }
  listClassifiers(): TrafficClassifier[] { return [...this.classifiers.values()]; }
  listBehaviors(): TrafficBehavior[] { return [...this.behaviors.values()]; }
  listPolicies(): TrafficPolicy[] { return [...this.policies.values()]; }

  renderHuawei(): string[] {
    const out: string[] = [];
    for (const c of this.listClassifiers()) { out.push(...c.render(), '#'); }
    for (const b of this.listBehaviors()) { out.push(...b.render(), '#'); }
    for (const p of this.listPolicies()) { out.push(...p.render(), '#'); }
    return out;
  }
}
