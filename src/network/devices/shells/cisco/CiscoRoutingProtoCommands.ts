/**
 * CiscoRoutingProtoCommands — config-router for RIP / EIGRP / BGP.
 *
 * RIP keeps using the REAL RIP engine for network/version/enable; the
 * extra RIP knobs and the (engine-less) EIGRP/BGP processes are
 * recorded in RoutingConfigRepository as real remembered config and
 * projected by the show family. A lone device has no peers, so BGP
 * neighbours stay Idle and EIGRP shows 0 neighbours — the true state.
 */
import { IPAddress, SubnetMask } from '../../../core/types';
import type { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { classfulMask } from './CiscoConfigCommands';
import type { RoutingConfigRepository }
  from '../../inspection/config/RoutingConfigRepository';
import { showIpProtocols } from './CiscoShowCommands';

type Proto = 'rip' | 'eigrp' | 'bgp';

function curProto(ctx: CiscoShellContext): { proto: Proto; asn?: number } {
  return ctx.getSelectedRoutingProto() ?? { proto: 'rip' };
}

export function buildRoutingProtoConfig(
  configTrie: CommandTrie, routerTrie: CommandTrie,
  ctx: CiscoShellContext, repo: RoutingConfigRepository,
): void {
  // ── process enters (router rip is in CiscoConfigCommands) ──
  // Real engines (RIB-integrated, config-driven adjacency).
  const eigrpEng = () => ctx.r().getEIGRPEngine();
  const bgpEng = () => ctx.r().getBGPEngine();
  const converge = () => ctx.r().convergeDynamicRouting();

  configTrie.registerGreedy('router eigrp', 'Enter EIGRP configuration', (a) => {
    if (a.length < 1) return '% Incomplete command.';
    const asn = parseInt(a[0], 10);
    const named = Number.isNaN(asn);
    repo.ensureEigrp(named ? 0 : asn, named);
    eigrpEng().enable({ asn: named ? 0 : asn });
    ctx.setSelectedRoutingProto({ proto: 'eigrp', asn: named ? 0 : asn });
    ctx.setMode('config-router');
    converge();
    return '';
  });
  configTrie.registerGreedy('no router eigrp', 'Disable EIGRP', (a) => {
    repo.removeEigrp(parseInt(a[0], 10) || 0);
    eigrpEng().disable();
    converge();
    return '';
  });
  configTrie.registerGreedy('router bgp', 'Enter BGP configuration', (a) => {
    if (a.length < 1) return '% Incomplete command.';
    repo.ensureBgp(parseInt(a[0], 10));
    bgpEng().enable({ asn: parseInt(a[0], 10) });
    ctx.setSelectedRoutingProto({ proto: 'bgp', asn: parseInt(a[0], 10) });
    ctx.setMode('config-router');
    converge();
    return '';
  });
  configTrie.registerGreedy('no router bgp', 'Disable BGP', () => {
    repo.removeBgp();
    bgpEng().disable();
    converge();
    return '';
  });

  // ── config-router sub-commands (proto-aware) ──
  const eigrp = () => repo.ensureEigrp(curProto(ctx).asn ?? 0);
  const bgp = () => repo.getBgp();

  routerTrie.registerGreedy('network', 'Advertise a network', (args) => {
    const { proto } = curProto(ctx);
    if (proto === 'rip') {
      if (args.length < 1) return '% Incomplete command.';
      if (!ctx.r().isRIPEnabled()) return '% RIP is not enabled.';
      try {
        const net = new IPAddress(args[0]);
        const mask = args.length >= 2 && args[1] !== 'mask'
          ? new SubnetMask(args[1]) : classfulMask(net);
        ctx.r().ripAdvertiseNetwork(net, mask);
        repo.rip.networks.push(args.join(' '));
        return '';
      } catch (e) {
        return `% Invalid input: ${e instanceof Error ? e.message : e}`;
      }
    }
    if (proto === 'eigrp') {
      eigrp().networks.push(args.join(' '));
      eigrpEng().getConfig().networks.push({
        network: args[0], wildcard: args[1] && args[1] !== 'mask' ? args[1] : undefined,
      });
    } else {
      bgp()?.networks.push(args.join(' '));
      const mask = args[1] === 'mask' && args[2]
        ? args[2] : String(classfulMask(new IPAddress(args[0])));
      bgpEng().getConfig().networks.push({ network: args[0], mask });
    }
    converge();
    return '';
  });

  routerTrie.register('version 2', 'Use RIPv2', () => {
    repo.rip.version = 2; return '';
  });
  routerTrie.register('version 1', 'Use RIPv1', () => {
    repo.rip.version = 1; return '';
  });

  routerTrie.register('no router rip', 'Disable RIP', () => {
    ctx.r().disableRIP();
    ctx.setSelectedRoutingProto(null);
    ctx.setMode('config');
    return '';
  });
  routerTrie.register('auto-summary', 'Enable auto-summary', () => {
    const p = curProto(ctx).proto;
    if (p === 'rip') repo.rip.autoSummary = true;
    else if (p === 'eigrp') eigrp().autoSummary = true;
    return '';
  });
  routerTrie.register('no auto-summary', 'Disable auto-summary', () => {
    const p = curProto(ctx).proto;
    if (p === 'rip') repo.rip.autoSummary = false;
    else if (p === 'eigrp') eigrp().autoSummary = false;
    return '';
  });
  routerTrie.registerGreedy('passive-interface', 'Suppress updates', (a) => {
    const p = curProto(ctx).proto;
    const tgt = a.join(' ');
    if (a[0] === 'default') {
      if (p === 'rip') repo.rip.passiveDefault = true;
    } else if (p === 'rip') repo.rip.passive.add(tgt);
    else if (p === 'eigrp') {
      eigrp().passive.add(tgt);
      eigrpEng().getConfig().passive.add(tgt);
      converge();
    }
    return '';
  });
  routerTrie.registerGreedy('no passive-interface', 'Allow updates', (a) => {
    repo.rip.passive.delete(a.join(' '));
    repo.rip.passiveDefault = false;
    return '';
  });
  routerTrie.registerGreedy('redistribute', 'Redistribute routes', (a, raw) => {
    const line = raw ?? `redistribute ${a.join(' ')}`;
    const p = curProto(ctx).proto;
    if (p === 'rip') repo.rip.redistribute.push(line);
    else if (p === 'eigrp') eigrp().redistribute.push(line);
    else bgp()?.redistribute.push(line);
    return '';
  });
  routerTrie.registerGreedy('default-information', 'Default route control', () => {
    if (curProto(ctx).proto === 'rip') repo.rip.defaultInfoOriginate = true;
    return '';
  });
  routerTrie.registerGreedy('default-metric', 'Set default metric', (a) => {
    if (curProto(ctx).proto === 'rip') repo.rip.defaultMetric = parseInt(a[0], 10);
    return '';
  });
  routerTrie.registerGreedy('distance', 'Administrative distance', (a) => {
    const n = parseInt(a[0], 10);
    if (!Number.isNaN(n) && curProto(ctx).proto === 'rip') repo.rip.distance = n;
    return '';
  });
  routerTrie.registerGreedy('timers', 'Adjust timers', (a, raw) => {
    if (curProto(ctx).proto === 'rip') repo.rip.timersBasic = raw ?? a.join(' ');
    return '';
  });
  routerTrie.registerGreedy('maximum-paths', 'Max parallel routes', (a) => {
    const n = parseInt(a[0], 10);
    const p = curProto(ctx).proto;
    if (p === 'rip') repo.rip.maximumPaths = n;
    else if (p === 'eigrp' && !Number.isNaN(n) && n >= 1) {
      eigrp().maximumPaths = n;
      eigrpEng().getConfig().maximumPaths = n;
      converge();
    }
    return '';
  });
  routerTrie.registerGreedy('neighbor', 'Configure a peer/neighbor', (a, raw) => {
    const { proto } = curProto(ctx);
    if (proto === 'rip') { repo.rip.neighbors.push(a[0]); return ''; }
    if (proto === 'bgp') {
      const b = bgp();
      if (!b) return '';
      const n = repo.ensureBgpNeighbor(a[0]);
      if (n) {
        if (a[1] === 'remote-as') n.remoteAs = parseInt(a[2], 10);
        else if (a[1] === 'description') n.description = a.slice(2).join(' ');
        else if (a[1] === 'update-source') n.updateSource = a[2];
        else if (a[1] === 'peer-group') n.peerGroup = a[2];
        else if (a[1] === 'activate') n.activated = true;
        else n.attrs.push(raw ?? a.join(' '));
      }
      // Drive the real BGP engine session config.
      const ec = bgpEng().getConfig();
      let bn = ec.neighbors.get(a[0]);
      if (!bn) { bn = { ip: a[0], activated: false }; ec.neighbors.set(a[0], bn); }
      if (a[1] === 'remote-as') bn.remoteAs = parseInt(a[2], 10);
      else if (a[1] === 'activate') bn.activated = true;
      converge();
    }
    return '';
  });
  routerTrie.registerGreedy('router-id', 'Set router-id', (a) => {
    const p = curProto(ctx).proto;
    if (p === 'eigrp') { eigrp().routerId = a[0]; eigrpEng().getConfig().routerId = a[0]; }
    else if (p === 'bgp') {
      const b = bgp(); if (b) b.routerId = a[0];
      bgpEng().getConfig().routerId = a[0];
    }
    return '';
  });
  routerTrie.registerGreedy('eigrp', 'EIGRP option', (a) => {
    if (a[0] === 'router-id') {
      eigrp().routerId = a[1];
      eigrpEng().getConfig().routerId = a[1];
    } else if (a[0] === 'stub') {
      eigrp().stub = a.slice(1).join(' ') || 'connected summary';
    }
    return '';
  });
  routerTrie.registerGreedy('variance', 'EIGRP variance', (a) => {
    const v = parseInt(a[0], 10);
    if (Number.isNaN(v) || v < 1 || v > 128) {
      return '% Invalid variance value (1-128)';
    }
    eigrp().variance = v;
    eigrpEng().getConfig().variance = v;
    converge();
    return '';
  });
  routerTrie.registerGreedy('metric', 'EIGRP metric options', (a) => {
    // `metric weights <tos> k1 k2 k3 k4 k5` — feeds the composite metric.
    if (a[0] !== 'weights') return '% Invalid input detected.';
    const ks = a.slice(2, 7).map((n) => parseInt(n, 10));
    if (ks.length < 5 || ks.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return '% Invalid metric weights';
    }
    eigrpEng().getConfig().kValues = {
      k1: ks[0], k2: ks[1], k3: ks[2], k4: ks[3], k5: ks[4],
    };
    converge();
    return '';
  });
  routerTrie.registerGreedy('bgp', 'BGP option', (a) => {
    if (a[0] === 'router-id') {
      const b = bgp(); if (b) b.routerId = a[1];
      bgpEng().getConfig().routerId = a[1];
    }
    return '';
  });
  routerTrie.registerGreedy('aggregate-address', 'BGP aggregate', (a, raw) => {
    bgp()?.networks.push(raw ?? `aggregate-address ${a.join(' ')}`);
    return '';
  });
  routerTrie.registerGreedy('address-family', 'Enter address-family', (a) => {
    const p = curProto(ctx).proto;
    const af = a.join(' ');
    if (p === 'bgp') bgp()?.addressFamilies.push(af);
    else if (p === 'eigrp') eigrp().addressFamilies.push(af);
    return '';
  });
  for (const kw of ['exit-address-family', 'exit-af-interface',
    'exit-af-topology', 'af-interface', 'topology', 'metric',
    'offset-list', 'output-delay', 'flash-update-threshold',
    'validate-update-source', 'synchronization', 'no synchronization',
    'compatible', 'log-adjacency-changes',
    'no neighbor', 'traffic-share']) {
    routerTrie.registerGreedy(kw, `Routing option (${kw})`, (args, raw) => {
      const sp = ctx.getSelectedRoutingProto();
      const proto = sp?.proto;
      const line = raw ?? `${kw} ${args.join(' ')}`.trim();
      if (proto === 'rip') {
        if (kw === 'metric') {
          const n = parseInt(args[args.length - 1] ?? '', 10);
          if (!isNaN(n)) repo.rip.defaultMetric = n;
        }
        if (!repo.rip.networks.includes(line)) repo.rip.redistribute.push(line);
      }
      return '';
    });
  }
}

// ── show family ──────────────────────────────────────────────────

export function registerRoutingProtoShow(
  trie: CommandTrie, ctx: CiscoShellContext, repo: RoutingConfigRepository,
): void {
  // Live engines drive neighbour/session/route state (converge first
  // so it reflects the real topology); the repo supplies configured
  // metadata (remote-as, description) the engine doesn't model.
  const bgpE = () => ctx.r().getBGPEngine();
  const eigrpE = () => ctx.r().getEIGRPEngine();
  const live = () => ctx.r().convergeDynamicRouting();

  trie.registerGreedy('show ip bgp summary', 'Display BGP neighbour summary', () => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const c = e.getConfig();
    const byId = new Map(e.getNeighbors().map((n) => [n.id, n]));
    const rows = [
      `BGP router identifier ${c.routerId ?? '0.0.0.0'}, local AS number ${c.asn}`,
      '',
      'Neighbor        V    AS  MsgRcvd  MsgSent  TblVer  InQ OutQ Up/Down  State/PfxRcd',
    ];
    for (const [ip, cfg] of c.neighbors) {
      const v = byId.get(ip);
      const upDown = v && v.isUp ? `${v.uptimeSec}s` : 'never';
      const state = v ? v.state : 'Idle';
      rows.push(`${ip.padEnd(16)}4 ${String(cfg.remoteAs ?? 0).padEnd(5)}` +
        `      0        0       0    0    0 ${upDown.padEnd(8)} ${state}`);
    }
    return rows.join('\n');
  });
  trie.registerGreedy('show ip bgp neighbors', 'Display BGP neighbours', () => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const repoB = repo.getBgp();
    const byId = new Map(e.getNeighbors().map((n) => [n.id, n]));
    const out: string[] = [];
    for (const [ip, cfg] of e.getConfig().neighbors) {
      const v = byId.get(ip);
      const desc = repoB?.neighbors.get(ip)?.description ?? '(none)';
      out.push(`BGP neighbor is ${ip}, remote AS ${cfg.remoteAs ?? 'unset'}`);
      out.push(`  Description: ${desc}`);
      out.push(`  BGP state = ${v ? v.state : 'Idle'}` +
        `${v && v.isUp ? `, up for ${v.uptimeSec}s` : ''}`);
    }
    return out.length ? out.join('\n') : 'No bgp neighbors configured';
  });
  trie.registerGreedy('show ip bgp', 'Display BGP table', () => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const c = e.getConfig();
    const rows = [
      `BGP table version is 1, local router ID is ${c.routerId ?? '0.0.0.0'}`,
      '     Network          Next Hop            Metric LocPrf Weight Path',
    ];
    for (const s of c.networks) {
      rows.push(`*>   ${s.network}/${new SubnetMask(s.mask).toCIDR()}` +
        `      0.0.0.0               0         32768 i`);
    }
    for (const r of e.getContributedRoutes()) {
      rows.push(`*>   ${r.network}/${r.mask.toCIDR()}` +
        `      ${String(r.nextHop ?? '0.0.0.0').padEnd(20)}0              0 i`);
    }
    return rows.join('\n');
  });
  trie.registerGreedy('show bgp', 'Display BGP', () => {
    const e = bgpE();
    if (!e.isEnabled()) return '% BGP not active';
    live();
    const up = e.getNeighbors().filter((n) => n.isUp).length;
    return `BGP local AS ${e.getConfig().asn}, ` +
      `${e.getConfig().neighbors.size} neighbour(s), ${up} established`;
  });

  trie.registerGreedy('show ip eigrp neighbors', 'Display EIGRP neighbours', () => {
    const e = eigrpE();
    if (!e.isEnabled()) return '% EIGRP not running (no autonomous-system configured)';
    live();
    const ns = e.getNeighbors();
    const head = `EIGRP-IPv4 Neighbors for AS(${e.getConfig().asn})\n` +
      'H   Address         Interface   Hold Uptime   SRTT   RTO  Q  Seq';
    if (!ns.length) return `${head}\n(no neighbours — no real EIGRP peer cabled)`;
    return [head, ...ns.map((n, i) =>
      `${i}   ${n.address.padEnd(16)}${n.iface.padEnd(12)}` +
      `13   ${n.uptimeSec}s     1      200  0  ${i + 1}`)].join('\n');
  });
  trie.registerGreedy('show ip eigrp topology', 'Display EIGRP topology', () => {
    const e = eigrpE();
    if (!e.isEnabled()) return '% EIGRP not running (no autonomous-system configured)';
    live();
    const lines = [`EIGRP-IPv4 Topology Table for AS(${e.getConfig().asn})`];
    for (const n of repo.allEigrp().flatMap((p) => p.networks)) {
      lines.push(`P ${n}, 1 successors, FD is 0 (connected)`);
    }
    for (const r of e.getContributedRoutes()) {
      lines.push(`P ${r.network}/${r.mask.toCIDR()}, 1 successors, ` +
        `FD is ${r.metric} via ${r.nextHop} (${r.iface})`);
    }
    return lines.join('\n');
  });
  trie.registerGreedy('show ip eigrp interfaces', 'Display EIGRP interfaces', () => {
    const e = eigrpE();
    return e.isEnabled()
      ? `EIGRP-IPv4 Interfaces for AS(${e.getConfig().asn})`
      : '% EIGRP not running (no autonomous-system configured)';
  });

  trie.register('show ip protocols', 'Display routing protocol state', () => {
    const out: string[] = [];
    if (ctx.r().isRIPEnabled()) {
      // Reuse the RIP engine's canonical format (DRY), then append
      // the extra knobs the engine doesn't model.
      out.push(showIpProtocols(ctx.r()));
      if (!repo.rip.autoSummary) {
        out.push('  Automatic network summarization is not in effect');
      }
      if (repo.rip.passive.size || repo.rip.passiveDefault) {
        out.push('  Passive Interface(s):');
        if (repo.rip.passiveDefault) out.push('    (default)');
        for (const p of repo.rip.passive) out.push(`    ${p}`);
      }
      for (const r of repo.rip.redistribute) out.push(`  ${r}`);
      if (repo.rip.distance !== undefined) {
        out.push(`  Distance: ${repo.rip.distance}`);
      }
    }
    for (const p of repo.allEigrp()) {
      out.push(`Routing Protocol is "eigrp ${p.asn}"`);
      if (p.routerId) out.push(`  Router-ID: ${p.routerId}`);
      out.push('  Routing for Networks:');
      for (const n of p.networks) out.push(`    ${n}`);
      for (const r of p.redistribute) out.push(`  ${r}`);
    }
    const b = repo.getBgp();
    if (b) {
      out.push(`Routing Protocol is "bgp ${b.asn}"`);
      out.push(`  IGP synchronization is disabled`);
      out.push(`  Neighbor(s): ${b.neighbors.size}`);
      for (const n of b.neighbors.values()) {
        out.push(`    ${n.ip} remote-as ${n.remoteAs ?? 'unset'}`);
      }
    }
    return out.length ? out.join('\n') : 'No routing protocol is configured.';
  });
}
