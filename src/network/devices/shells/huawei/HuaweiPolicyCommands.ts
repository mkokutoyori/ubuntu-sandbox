import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import type { HuaweiShellContext } from './HuaweiConfigCommands';

export interface HuaweiPolicyShellCtx extends HuaweiShellContext {
  setMode(mode: any): void;
  getMode(): string;
  setSelectedPrefixList(name: string | null): void;
  getSelectedPrefixList(): string | null;
  setSelectedRoutePolicy(name: string | null): void;
  getSelectedRoutePolicy(): string | null;
  setSelectedRoutePolicyNode(node: number | null): void;
  getSelectedRoutePolicyNode(): number | null;
  setSelectedClassifier(name: string | null): void;
  getSelectedClassifier(): string | null;
  setSelectedBehavior(name: string | null): void;
  getSelectedBehavior(): string | null;
  setSelectedTrafficPolicy(name: string | null): void;
  getSelectedTrafficPolicy(): string | null;
  setSelectedNqa(admin: string | null, name: string | null): void;
  getSelectedNqa(): { admin: string; name: string } | null;
}

function parsePrefixSpec(args: string[]): {
  name: string; index?: number; action: 'permit' | 'deny';
  network: string; prefixLength: number;
  lessEqual?: number; greaterEqual?: number;
} | string {
  const name = args[0]; if (!name) return 'Error: Incomplete command.';
  let i = 1;
  let index: number | undefined;
  if (args[i] === 'index' && /^\d+$/.test(args[i + 1] ?? '')) {
    index = parseInt(args[++i], 10); i++;
  }
  const action = args[i] as 'permit' | 'deny';
  if (action !== 'permit' && action !== 'deny') return `Error: Invalid action '${args[i]}'`;
  i++;
  const network = args[i++];
  const prefixLength = parseInt(args[i++], 10);
  if (!network || Number.isNaN(prefixLength)) return 'Error: Incomplete command.';
  let lessEqual: number | undefined;
  let greaterEqual: number | undefined;
  while (i < args.length) {
    if (args[i] === 'less-equal') { lessEqual = parseInt(args[++i], 10); i++; }
    else if (args[i] === 'greater-equal') { greaterEqual = parseInt(args[++i], 10); i++; }
    else { i++; }
  }
  return { name, index, action, network, prefixLength, lessEqual, greaterEqual };
}

export function registerHuaweiPolicySystemCommands(
  t: CommandTrie,
  ctx: HuaweiPolicyShellCtx,
): void {
  const r = () => ctx.r();

  t.registerGreedy('ip ip-prefix', 'Configure an IPv4 prefix list', (args) => {
    const parsed = parsePrefixSpec(args);
    if (typeof parsed === 'string') return parsed;
    const list = r().getIpPrefixListStore().upsert(parsed.name, 'ipv4');
    list.upsert({
      index: parsed.index, action: parsed.action,
      network: parsed.network, prefixLength: parsed.prefixLength,
      lessEqual: parsed.lessEqual, greaterEqual: parsed.greaterEqual,
    });
    return '';
  });

  t.registerGreedy('ip ipv6-prefix', 'Configure an IPv6 prefix list', (args) => {
    const parsed = parsePrefixSpec(args);
    if (typeof parsed === 'string') return parsed;
    const list = r().getIpPrefixListStore().upsert(parsed.name, 'ipv6');
    list.upsert({
      index: parsed.index, action: parsed.action,
      network: parsed.network, prefixLength: parsed.prefixLength,
      lessEqual: parsed.lessEqual, greaterEqual: parsed.greaterEqual,
    });
    return '';
  });

  t.registerGreedy('undo ip ip-prefix', 'Remove an IPv4 prefix list entry', (args) => {
    const name = args[0]; if (!name) return 'Error: Incomplete command.';
    const store = r().getIpPrefixListStore();
    if (args[1] === 'index' && args[2]) {
      store.removeEntry(name, parseInt(args[2], 10), 'ipv4');
      return '';
    }
    store.remove(name, 'ipv4');
    return '';
  });

  t.registerGreedy('undo ip ipv6-prefix', 'Remove an IPv6 prefix list entry', (args) => {
    const name = args[0]; if (!name) return 'Error: Incomplete command.';
    const store = r().getIpPrefixListStore();
    if (args[1] === 'index' && args[2]) {
      store.removeEntry(name, parseInt(args[2], 10), 'ipv6');
      return '';
    }
    store.remove(name, 'ipv6');
    return '';
  });

  t.registerGreedy('route-policy', 'Enter route-policy view', (args) => {
    const name = args[0];
    const action = args[1] as 'permit' | 'deny';
    if (!name || (action !== 'permit' && action !== 'deny')) return 'Error: Incomplete command.';
    let node = 10;
    if (args[2] === 'node' && /^\d+$/.test(args[3] ?? '')) node = parseInt(args[3], 10);
    r().getRoutePolicyStore().upsert(name).upsertNode(node, action);
    ctx.setSelectedRoutePolicy(name);
    ctx.setSelectedRoutePolicyNode(node);
    ctx.setMode('route-policy');
    return '';
  });

  t.registerGreedy('undo route-policy', 'Remove a route-policy', (args) => {
    if (!args[0]) return 'Error: Incomplete command.';
    if (args[1] === 'node' && /^\d+$/.test(args[2] ?? '')) {
      r().getRoutePolicyStore().get(args[0])?.removeNode(parseInt(args[2], 10));
      return '';
    }
    r().getRoutePolicyStore().remove(args[0]);
    return '';
  });

  t.registerGreedy('traffic classifier', 'Enter traffic classifier view', (args) => {
    if (!args[0]) return 'Error: Incomplete command.';
    let op: 'and' | 'or' = 'or';
    if (args[1] === 'operator' && (args[2] === 'and' || args[2] === 'or')) op = args[2];
    r().getTrafficPolicyStore().upsertClassifier(args[0], op);
    ctx.setSelectedClassifier(args[0]);
    ctx.setMode('traffic-classifier');
    return '';
  });

  t.registerGreedy('traffic behavior', 'Enter traffic behavior view', (args) => {
    if (!args[0]) return 'Error: Incomplete command.';
    r().getTrafficPolicyStore().upsertBehavior(args[0]);
    ctx.setSelectedBehavior(args[0]);
    ctx.setMode('traffic-behavior');
    return '';
  });

  t.registerGreedy('traffic policy', 'Enter traffic policy view', (args) => {
    if (!args[0]) return 'Error: Incomplete command.';
    r().getTrafficPolicyStore().upsertPolicy(args[0]);
    ctx.setSelectedTrafficPolicy(args[0]);
    ctx.setMode('traffic-policy');
    return '';
  });

  t.registerGreedy('undo traffic classifier', 'Remove traffic classifier', (args) => {
    if (args[0]) r().getTrafficPolicyStore().listClassifiers()
      .filter(c => c.name === args[0])
      .forEach(c => (r().getTrafficPolicyStore() as any).classifiers?.delete?.(c.name));
    return '';
  });

  t.registerGreedy('nqa test-instance', 'Enter NQA test instance view', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    r().getNqaEngine().upsert(args[0], args[1]);
    ctx.setSelectedNqa(args[0], args[1]);
    ctx.setMode('nqa-test');
    return '';
  });

  t.registerGreedy('undo nqa test-instance', 'Remove NQA test instance', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    r().getNqaEngine().remove(args[0], args[1]);
    return '';
  });
}

export function registerHuaweiPolicyDisplayCommands(
  t: CommandTrie,
  getRouter: () => Router,
): void {
  t.register('display ip ip-prefix', 'Display IPv4 prefix lists', () => {
    const out = getRouter().getIpPrefixListStore().renderHuawei('ipv4');
    return out || 'Info: No prefix-list configured.';
  });
  t.registerGreedy('display ip ip-prefix', 'Display IPv4 prefix list by name', (args) => {
    if (args.length === 0) return getRouter().getIpPrefixListStore().renderHuawei('ipv4') || 'Info: No prefix-list configured.';
    const list = getRouter().getIpPrefixListStore().get(args[0], 'ipv4');
    if (!list) return `Info: prefix-list ${args[0]} does not exist.`;
    const head = [`Prefix-list ${args[0]}`, '  Description: -'];
    for (const e of list.list()) {
      const extras: string[] = [];
      if (e.greaterEqual !== undefined) extras.push(`greater-equal ${e.greaterEqual}`);
      if (e.lessEqual !== undefined) extras.push(`less-equal ${e.lessEqual}`);
      head.push(`  index ${e.index} ${e.action} ${e.network}/${e.prefixLength}${extras.length ? ' ' + extras.join(' ') : ''}`);
    }
    return head.join('\n');
  });
  t.register('display ip ipv6-prefix', 'Display IPv6 prefix lists', () => {
    const out = getRouter().getIpPrefixListStore().renderHuawei('ipv6');
    return out || 'Info: No IPv6 prefix-list configured.';
  });

  t.register('display route-policy', 'Display all route-policies', () => {
    const out = getRouter().getRoutePolicyStore().renderHuawei();
    return out || 'Info: No route-policy configured.';
  });
  t.registerGreedy('display route-policy', 'Display a route-policy', (args) => {
    if (args.length === 0) {
      return getRouter().getRoutePolicyStore().renderHuawei() || 'Info: No route-policy configured.';
    }
    const rp = getRouter().getRoutePolicyStore().get(args[0]);
    if (!rp) return `Info: route-policy ${args[0]} does not exist.`;
    return rp.render().join('\n');
  });

  t.registerGreedy('display traffic policy user-defined', 'Display traffic policies', (args) => {
    const store = getRouter().getTrafficPolicyStore();
    if (args[0]) {
      const pol = store.getPolicy(args[0]);
      if (!pol) return `Info: traffic-policy ${args[0]} does not exist.`;
      return pol.render().join('\n');
    }
    const lines = store.renderHuawei();
    return lines.length > 0 ? lines.join('\n') : 'Info: No traffic policy configured.';
  });
  t.register('display traffic-policy applied-record', 'Display applied traffic policies', () => {
    const apps = getRouter().getTrafficPolicyStore().listApplications();
    if (apps.length === 0) return 'Info: No traffic policy applied.';
    return apps.map(a => `traffic-policy ${a.policy} ${a.direction} on ${a.iface}`).join('\n');
  });

  t.registerGreedy('display nqa results test-instance', 'Display NQA results', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    const t = getRouter().getNqaEngine().get(args[0], args[1]);
    if (!t) return `Info: NQA test-instance ${args[0]} ${args[1]} does not exist.`;
    return t.renderResults();
  });
  t.register('display nqa results', 'Display all NQA results', () => {
    const list = getRouter().getNqaEngine().list();
    if (list.length === 0) return 'Info: No NQA test-instance configured.';
    return list.map(t => t.renderResults()).join('\n');
  });
}

export function buildRoutePolicyView(t: CommandTrie, ctx: HuaweiPolicyShellCtx): void {
  const r = () => ctx.r();
  const node = () => {
    const name = ctx.getSelectedRoutePolicy(); const id = ctx.getSelectedRoutePolicyNode();
    if (!name || id === null) return null;
    return r().getRoutePolicyStore().get(name)?.getNode(id) ?? null;
  };
  t.registerGreedy('if-match', 'Match clause', (args) => {
    const n = node(); if (!n) return '';
    const kind = args[0];
    if (kind === 'ip-prefix' && args[1]) n.ifMatch({ ipPrefix: args[1] });
    else if (kind === 'acl' && args[1]) n.ifMatch({ acl: parseInt(args[1], 10) });
    else if (kind === 'interface' && args[1]) n.ifMatch({ interface: args.slice(1).join(' ') });
    else if (kind === 'tag' && args[1]) n.ifMatch({ tag: parseInt(args[1], 10) });
    else if (kind === 'community' && args[1]) n.ifMatch({ community: args.slice(1).join(' ') });
    else if (kind === 'as-path' && args[1]) n.ifMatch({ asPath: args.slice(1).join(' ') });
    return '';
  });
  t.registerGreedy('apply', 'Apply clause', (args) => {
    const n = node(); if (!n) return '';
    const kind = args[0];
    if (kind === 'ip-address' && args[1] === 'next-hop' && args[2]) n.applySet({ ipNextHop: args[2] });
    else if (kind === 'cost' && args[1]) n.applySet({ cost: parseInt(args[1], 10) });
    else if (kind === 'preference' && args[1]) n.applySet({ preference: parseInt(args[1], 10) });
    else if (kind === 'tag' && args[1]) n.applySet({ tag: parseInt(args[1], 10) });
    else if (kind === 'community' && args[1]) n.applySet({ community: args.slice(1).join(' ') });
    else if (kind === 'local-preference' && args[1]) n.applySet({ localPreference: parseInt(args[1], 10) });
    return '';
  });
}

export function buildTrafficClassifierView(t: CommandTrie, ctx: HuaweiPolicyShellCtx): void {
  t.registerGreedy('if-match', 'Classifier match clause', (args) => {
    const name = ctx.getSelectedClassifier(); if (!name) return '';
    const c = ctx.r().getTrafficPolicyStore().getClassifier(name); if (!c) return '';
    const kind = args[0];
    if (kind === 'acl' && args[1]) c.addMatch({ kind: 'acl', value: parseInt(args[1], 10) });
    else if (kind === 'acl-ipv6' && args[1]) c.addMatch({ kind: 'acl-ipv6', value: parseInt(args[1], 10) });
    else if (kind === 'dscp' && args[1]) c.addMatch({ kind: 'dscp', value: parseInt(args[1], 10) });
    else if (kind === 'ip-precedence' && args[1]) c.addMatch({ kind: 'ip-precedence', value: parseInt(args[1], 10) });
    else if (kind === 'protocol' && args[1]) c.addMatch({ kind: 'protocol', value: args[1] });
    else if (kind === 'vlan' && args[1]) c.addMatch({ kind: 'vlan', value: parseInt(args[1], 10) });
    else if (kind === 'any') c.addMatch({ kind: 'any' });
    return '';
  });
}

export function buildTrafficBehaviorView(t: CommandTrie, ctx: HuaweiPolicyShellCtx): void {
  t.registerGreedy('permit', 'Permit traffic', () => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    ctx.r().getTrafficPolicyStore().getBehavior(name)?.addAction({ kind: 'permit' });
    return '';
  });
  t.registerGreedy('deny', 'Deny traffic', () => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    ctx.r().getTrafficPolicyStore().getBehavior(name)?.addAction({ kind: 'deny' });
    return '';
  });
  t.registerGreedy('redirect', 'Redirect traffic', (args) => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    const b = ctx.r().getTrafficPolicyStore().getBehavior(name); if (!b) return '';
    if (args[0] === 'ip-nexthop' && args[1]) b.addAction({ kind: 'redirect-ip-nexthop', nextHop: args[1] });
    else if (args[0] === 'ipv6-nexthop' && args[1]) b.addAction({ kind: 'redirect-ipv6-nexthop', nextHop: args[1] });
    else if (args[0] === 'interface' && args[1]) b.addAction({ kind: 'redirect-interface', iface: args.slice(1).join(' ') });
    return '';
  });
  t.registerGreedy('remark', 'Remark traffic', (args) => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    const b = ctx.r().getTrafficPolicyStore().getBehavior(name); if (!b) return '';
    if (args[0] === 'dscp' && args[1]) b.addAction({ kind: 'remark-dscp', value: parseInt(args[1], 10) });
    else if (args[0] === 'ip-precedence' && args[1]) b.addAction({ kind: 'remark-precedence', value: parseInt(args[1], 10) });
    return '';
  });
  t.registerGreedy('car', 'Committed access rate', (args) => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    const b = ctx.r().getTrafficPolicyStore().getBehavior(name); if (!b) return '';
    let cir = 0; let pir: number | undefined; let cbs: number | undefined; let pbs: number | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'cir' && args[i + 1]) cir = parseInt(args[++i], 10);
      else if (args[i] === 'pir' && args[i + 1]) pir = parseInt(args[++i], 10);
      else if (args[i] === 'cbs' && args[i + 1]) cbs = parseInt(args[++i], 10);
      else if (args[i] === 'pbs' && args[i + 1]) pbs = parseInt(args[++i], 10);
    }
    b.addAction({ kind: 'car', cir, pir, cbs, pbs });
    return '';
  });
  t.registerGreedy('queue', 'Queue scheduling', (args) => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    const b = ctx.r().getTrafficPolicyStore().getBehavior(name); if (!b) return '';
    const head = args[0]?.toLowerCase();
    if (head === 'ef') {
      let bandwidth: number | undefined; let cbs: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === 'bandwidth' && args[i + 1]) bandwidth = parseInt(args[++i], 10);
        else if (args[i] === 'cbs' && args[i + 1]) cbs = parseInt(args[++i], 10);
      }
      b.addAction({ kind: 'queue-ef', bandwidthKbps: bandwidth, cbs });
    } else if (head === 'af') {
      let bandwidthKbps: number | undefined; let bandwidthPct: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === 'bandwidth') {
          if (args[i + 1] === 'pct' && args[i + 2]) {
            bandwidthPct = parseInt(args[i + 2], 10); i += 2;
          } else if (args[i + 1]) {
            bandwidthKbps = parseInt(args[++i], 10);
          }
        }
      }
      b.addAction({ kind: 'queue-af', bandwidthKbps, bandwidthPct });
    } else if (head === 'wfq') {
      let queueNumber: number | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === 'queue-number' && args[i + 1]) queueNumber = parseInt(args[++i], 10);
      }
      b.addAction({ kind: 'queue-wfq', queueNumber });
    }
    return '';
  });
  t.register('statistics enable', 'Enable statistics', () => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    ctx.r().getTrafficPolicyStore().getBehavior(name)?.addAction({ kind: 'statistic', enabled: true });
    return '';
  });
  t.register('undo statistics enable', 'Disable statistics', () => {
    const name = ctx.getSelectedBehavior(); if (!name) return '';
    ctx.r().getTrafficPolicyStore().getBehavior(name)?.addAction({ kind: 'statistic', enabled: false });
    return '';
  });
}

export function buildTrafficPolicyView(t: CommandTrie, ctx: HuaweiPolicyShellCtx): void {
  t.registerGreedy('classifier', 'Bind classifier to behavior', (args) => {
    const policyName = ctx.getSelectedTrafficPolicy(); if (!policyName) return '';
    const policy = ctx.r().getTrafficPolicyStore().getPolicy(policyName); if (!policy) return '';
    const classifier = args[0];
    let behavior: string | undefined;
    let precedence: number | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'behavior' && args[i + 1]) behavior = args[++i];
      else if (args[i] === 'precedence' && args[i + 1]) precedence = parseInt(args[++i], 10);
    }
    if (classifier && behavior) policy.attach(classifier, behavior, precedence);
    return '';
  });
}

export function buildNqaTestView(t: CommandTrie, ctx: HuaweiPolicyShellCtx): void {
  const cur = () => {
    const sel = ctx.getSelectedNqa(); if (!sel) return null;
    return ctx.r().getNqaEngine().get(sel.admin, sel.name) ?? null;
  };
  t.registerGreedy('test-type', 'Set test type', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0]) t.testType = args[0] as any;
    return '';
  });
  t.registerGreedy('destination-address', 'Set destination address', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0] === 'ipv4' && args[1]) t.destinationAddress = args[1];
    else if (args[0] === 'ipv6' && args[1]) t.destinationAddress = args[1];
    else if (args[0]) t.destinationAddress = args[0];
    return '';
  });
  t.registerGreedy('source-address', 'Set source address', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0] === 'ipv4' && args[1]) t.sourceAddress = args[1];
    else if (args[0]) t.sourceAddress = args[0];
    return '';
  });
  t.registerGreedy('destination-port', 'Set destination port', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0]) t.destinationPort = parseInt(args[0], 10);
    return '';
  });
  t.registerGreedy('frequency', 'Set probe frequency (sec)', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0]) t.frequency = parseInt(args[0], 10);
    return '';
  });
  t.registerGreedy('probe-count', 'Probes per cycle', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0]) t.probeCount = parseInt(args[0], 10);
    return '';
  });
  t.registerGreedy('interval', 'Probe interval', (args) => {
    const t = cur(); if (!t) return '';
    const i = args[0] === 'seconds' ? 1 : 0;
    if (args[i]) t.intervalSec = parseInt(args[i], 10);
    return '';
  });
  t.registerGreedy('timeout', 'Probe timeout', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0]) t.timeoutSec = parseInt(args[0], 10);
    return '';
  });
  t.registerGreedy('threshold', 'Threshold', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0] === 'rtt' && args[1]) t.thresholds.rttMaxMs = parseInt(args[1], 10);
    else if (args[0] === 'packet-loss' && args[1]) t.thresholds.packetLossPct = parseInt(args[1], 10);
    return '';
  });
  t.registerGreedy('start', 'Start the test instance', (args) => {
    const t = cur(); if (!t) return '';
    if (args[0] === 'now') t.start();
    return '';
  });
  t.registerGreedy('stop', 'Stop the test instance', () => {
    const t = cur(); if (!t) return '';
    t.stop();
    return '';
  });
}
