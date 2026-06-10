/**
 * CiscoOspfCommands - OSPF CLI commands for Cisco IOS Shell
 *
 * Handles:
 *   - config mode: "router ospf <process-id>", "no router ospf"
 *   - config-router-ospf mode: "network", "router-id", "passive-interface", "area", etc.
 *   - config-if mode: "ip ospf cost/priority/hello-interval/dead-interval/network/auth"
 *   - show commands: "show ip ospf", "show ip ospf neighbor", "show ip ospf database", "show ip ospf interface"
 *   - ipv6/OSPFv3: "ipv6 unicast-routing", "ipv6 router ospf", "ipv6 ospf <id> area", show ipv6 ospf
 */

import type { Router } from '../../Router';
import { inSameSubnet } from '../../../core/ip';
import { CommandTrie } from '../CommandTrie';
import { IPAddress, SubnetMask } from '../../../core/types';
import type { CiscoShellContext } from './CiscoConfigCommands';

// ─── Config Mode: "router ospf <id>" ─────────────────────────────────

export function registerOSPFConfigCommands(configTrie: CommandTrie, ctx: CiscoShellContext): void {
  configTrie.registerGreedy('router ospf', 'Enter OSPF routing protocol configuration', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const processId = parseInt(args[0], 10);
    if (isNaN(processId) || processId < 1 || processId > 65535) {
      return '% Invalid OSPF process ID';
    }
    const router = ctx.r();
    if (!router._getOSPFEngineInternal()) {
      router._enableOSPF(processId);
    }
    ctx.setMode('config-router-ospf');
    return '';
  });

  configTrie.registerGreedy('no router ospf', 'Disable OSPF routing protocol', (_args) => {
    ctx.r()._disableOSPF();
    return '';
  });

  // IPv6 OSPF router configuration mode
  configTrie.registerGreedy('ipv6 router ospf', 'Configure IPv6 OSPF', (args) => {
    const processId = args.length >= 1 ? parseInt(args[0], 10) : 1;
    if (isNaN(processId) || processId < 1 || processId > 65535) return '% Invalid OSPFv3 process ID';
    const router = ctx.r();
    if (!router._getOSPFv3EngineInternal()) {
      router._enableOSPFv3(processId);
    }
    ctx.setMode('config-router-ospfv3' as any);
    return '';
  });

  // ipv6 unicast-routing
  configTrie.register('ipv6 unicast-routing', 'Enable IPv6 unicast routing', () => {
    ctx.r().enableIPv6Routing();
    return '';
  });

  // ip routing
  configTrie.register('ip routing', 'Enable IP routing', () => {
    const r = ctx.r() as unknown as { _setIpRoutingEnabled?: (e: boolean) => void };
    r._setIpRoutingEnabled?.(true);
    return '';
  });
  configTrie.register('no ip routing', 'Disable IP routing', () => {
    const r = ctx.r() as unknown as { _setIpRoutingEnabled?: (e: boolean) => void };
    r._setIpRoutingEnabled?.(false);
    return '';
  });
}

// ─── Config-Router Mode: OSPF sub-commands ───────────────────────────

export function buildConfigRouterOSPFCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  const extra = () => ctx.r()._getOSPFExtraConfig() as Record<string, unknown> & {
    maximumPaths?: number; defaultMetric?: number; compatibleRfc1583?: boolean;
    logAdjacencyChanges?: boolean; logAdjacencyChangesDetail?: boolean;
    distance?: { intraArea?: number; interArea?: number; external?: number };
    timersThrottleLsa?: { startMs: number; holdMs: number; maxMs: number };
    timersLsaArrivalMs?: number;
    timersPacingFloodMs?: number; timersPacingRetransmissionMs?: number;
    ispf?: boolean; prefixSuppression?: boolean; shutdown?: boolean;
    segmentRoutingMpls?: boolean; discardRouteExternal?: boolean;
  };

  trie.registerGreedy('log-adjacency-changes', 'Log adjacency changes', (args) => {
    const e = extra();
    e.logAdjacencyChanges = true;
    if (args[0]?.toLowerCase() === 'detail') e.logAdjacencyChangesDetail = true;
    return '';
  });
  trie.registerGreedy('maximum-paths', 'Forward equal-cost paths', (args) => {
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) extra().maximumPaths = n;
    return '';
  });
  trie.registerGreedy('compatible', 'Compatibility mode', (args) => {
    if (args[0]?.toLowerCase() === 'rfc1583') extra().compatibleRfc1583 = true;
    return '';
  });
  trie.registerGreedy('default-metric', 'Default metric', (args) => {
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) extra().defaultMetric = n;
    return '';
  });
  trie.registerGreedy('distance', 'Administrative distance', (args) => {
    if (args[0]?.toLowerCase() !== 'ospf') return '';
    const d: { intraArea?: number; interArea?: number; external?: number } = {};
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'intra-area' && args[i + 1]) d.intraArea = parseInt(args[i + 1], 10);
      if (args[i] === 'inter-area' && args[i + 1]) d.interArea = parseInt(args[i + 1], 10);
      if (args[i] === 'external' && args[i + 1]) d.external = parseInt(args[i + 1], 10);
    }
    extra().distance = d;
    return '';
  });
  trie.registerGreedy('timers throttle lsa', 'LSA throttle timers', (args) => {
    if (args.length < 3) return '% Incomplete command.';
    extra().timersThrottleLsa = {
      startMs: parseInt(args[0], 10),
      holdMs: parseInt(args[1], 10),
      maxMs: parseInt(args[2], 10),
    };
    return '';
  });
  trie.registerGreedy('timers lsa arrival', 'LSA arrival timer', (args) => {
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) extra().timersLsaArrivalMs = n;
    return '';
  });
  trie.registerGreedy('timers pacing flood', 'Pacing flood', (args) => {
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) extra().timersPacingFloodMs = n;
    return '';
  });
  trie.registerGreedy('timers pacing retransmission', 'Pacing retransmission', (args) => {
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) extra().timersPacingRetransmissionMs = n;
    return '';
  });
  trie.register('ispf', 'Enable incremental SPF', () => { extra().ispf = true; return ''; });
  trie.register('prefix-suppression', 'Enable prefix suppression', () => { extra().prefixSuppression = true; return ''; });
  trie.register('shutdown', 'Disable OSPF process', () => { extra().shutdown = true; return ''; });
  trie.register('no shutdown', 'Re-enable OSPF process', () => { extra().shutdown = false; return ''; });
  trie.registerGreedy('segment-routing', 'Segment routing', (args) => {
    if (args[0]?.toLowerCase() === 'mpls') extra().segmentRoutingMpls = true;
    return '';
  });
  trie.registerGreedy('discard-route', 'Discard route', (args) => {
    if (args[0]?.toLowerCase() === 'external') extra().discardRouteExternal = true;
    return '';
  });

  trie.registerGreedy('network', 'Define OSPF network/area', (args) => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';

    // Syntax: network <ip> <wildcard> area <area-id>
    if (args.length < 4) return '% Incomplete command.';
    const network = args[0];
    const wildcard = args[1];
    if (args[2].toLowerCase() !== 'area') return '% Invalid input. Expected "area" keyword.';
    const areaId = args[3];

    ospf.addNetwork(network, wildcard, areaId);
    ctx.r()._ospfAutoConverge();
    return '';
  });

  trie.registerGreedy('router-id', 'Set OSPF Router ID', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    ospf.setRouterId(args[0]);
    return '';
  });

  trie.registerGreedy('passive-interface', 'Suppress routing updates on an interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';

    if (args[0].toLowerCase() === 'default') {
      const ports = ctx.r()._getPortsInternal();
      for (const [name] of ports) {
        ospf.setPassiveInterface(name);
      }
    } else {
      const ifName = ctx.resolveInterfaceName(args.join(' '));
      if (!ifName) return `% Invalid interface "${args.join(' ')}"`;
      ospf.setPassiveInterface(ifName);
    }
    return '';
  });

  trie.registerGreedy('no passive-interface', 'Enable routing updates on a passive interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    const ifName = ctx.resolveInterfaceName(args.join(' '));
    if (!ifName) return `% Invalid interface "${args.join(' ')}"`;
    ospf.removePassiveInterface(ifName);
    return '';
  });

  trie.registerGreedy('area', 'OSPF area parameters', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';

    const areaId = args[0];
    const subCmd = args[1].toLowerCase();

    if (subCmd === 'stub') {
      ospf.setAreaType(areaId, args[2]?.toLowerCase() === 'no-summary' ? 'totally-stubby' : 'stub');
      return '';
    } else if (subCmd === 'nssa') {
      ospf.setAreaType(areaId, 'nssa');
      return '';
    } else if (subCmd === 'range') {
      // area <id> range <network> <mask>
      if (args.length < 4) return '% Incomplete command.';
      const extra = ctx.r()._getOSPFExtraConfig();
      if (!extra.areaRanges.has(areaId)) extra.areaRanges.set(areaId, []);
      extra.areaRanges.get(areaId)!.push({ network: args[2], mask: args[3] });
      return '';
    } else if (subCmd === 'virtual-link') {
      if (args.length < 3) return '% Incomplete command.';
      const extra = ctx.r()._getOSPFExtraConfig();
      extra.virtualLinks.set(areaId, args[2]);
      return '';
    } else if (subCmd === 'default-cost') {
      if (args.length < 3) return '% Incomplete command.';
      const cost = parseInt(args[2], 10);
      if (isNaN(cost) || cost < 0 || cost > 65535) return '% Invalid default-cost value (0-65535)';
      const extra = ctx.r()._getOSPFExtraConfig();
      extra.areaDefaultCost.set(areaId, cost);
      ospf.setAreaDefaultCost?.(areaId, cost);
      return '';
    } else if (subCmd === 'authentication') {
      const mode = args[2]?.toLowerCase();
      const extra = ctx.r()._getOSPFExtraConfig();
      const authMode: 'simple' | 'message-digest' | 'null' = mode === 'message-digest'
        ? 'message-digest'
        : mode === 'null' ? 'null' : 'simple';
      extra.areaAuthentication.set(areaId, authMode);
      ospf.setAreaAuthentication?.(areaId, authMode);
      return '';
    } else if (subCmd === 'nssa-only' || subCmd === 'filter-list') {
      return '';
    } else if (subCmd === 'sham-link') {
      if (args.length < 4) return '% Incomplete command.';
      const extra = ctx.r()._getOSPFExtraConfig();
      if (!extra.shamLinks) extra.shamLinks = new Map();
      extra.shamLinks.set(`${args[2]}->${args[3]}`, { areaId, source: args[2], destination: args[3] });
      return '';
    }
    return `% Invalid area sub-command "${args[1]}"`;
  });

  trie.registerGreedy('auto-cost', 'Calculate OSPF interface cost according to bandwidth', (args) => {
    if (args.length < 2 || args[0].toLowerCase() !== 'reference-bandwidth') {
      return '% Incomplete command.';
    }
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    const bw = parseInt(args[1], 10);
    if (isNaN(bw) || bw < 1) return '% Invalid bandwidth value';
    ospf.setReferenceBandwidth(bw);
    return `% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.`;
  });

  trie.registerGreedy('default-information originate', 'Distribute default route', (args) => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    ospf.setDefaultInformationOriginate(true);
    const extra = ctx.r()._getOSPFExtraConfig();
    // Check for metric-type argument
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === 'metric-type') {
        extra.defaultInfoMetricType = parseInt(args[i + 1], 10);
      }
    }
    if (extra.defaultInfoMetricType === undefined) extra.defaultInfoMetricType = 2;
    return '';
  });

  trie.registerGreedy('redistribute', 'Redistribute routes from another routing protocol', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    const protocol = args[0].toLowerCase();
    if (protocol === 'static') {
      const subnets = args.some(a => a.toLowerCase() === 'subnets');
      let metricType = 2; // default E2
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i].toLowerCase() === 'metric-type') metricType = parseInt(args[i + 1], 10);
      }
      extra.redistributeStatic = { subnets, metricType };
    } else if (protocol === 'connected') {
      const subnets = args.some(a => a.toLowerCase() === 'subnets');
      extra.redistributeConnected = { subnets };
    }
    return '';
  });

  trie.registerGreedy('distribute-list', 'Filter networks in routing updates', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.distributeList = { aclId: args[0], direction: args[1].toLowerCase() as 'in' | 'out' };
    return '';
  });

  trie.registerGreedy('no default-information originate', 'Stop distributing default route', () => {
    ctx.r()._getOSPFEngineInternal()?.setDefaultInformationOriginate(false);
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.defaultInfoMetricType = undefined;
    ctx.r()._ospfAutoConverge?.();
    return '';
  });

  trie.registerGreedy('no redistribute', 'Stop redistributing routes', (args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    const protocol = (args[0] ?? '').toLowerCase();
    if (protocol === 'static') extra.redistributeStatic = undefined;
    else if (protocol === 'connected') extra.redistributeConnected = undefined;
    else { extra.redistributeStatic = undefined; extra.redistributeConnected = undefined; }
    ctx.r()._ospfAutoConverge?.();
    return '';
  });

  trie.registerGreedy('no distribute-list', 'Remove distribute-list filter', () => {
    ctx.r()._getOSPFExtraConfig().distributeList = undefined;
    ctx.r()._ospfAutoConverge?.();
    return '';
  });

  trie.registerGreedy('no area', 'Remove OSPF area parameter', (args) => {
    const areaId = args[0];
    const subCmd = (args[1] ?? '').toLowerCase();
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf || areaId === undefined) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    if (subCmd === 'range') {
      const ranges = extra.areaRanges.get(areaId);
      if (ranges) extra.areaRanges.set(areaId, ranges.filter(r => !(r.network === args[2] && r.mask === args[3])));
    } else if (subCmd === 'stub' || subCmd === 'nssa') {
      ospf.setAreaType?.(areaId, 'normal');
    }
    ctx.r()._ospfAutoConverge?.();
    return '';
  });

  trie.registerGreedy('timers throttle spf', 'Set OSPF SPF throttle timers', (args) => {
    if (args.length < 3) return '% Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.spfThrottle = {
      initial: parseInt(args[0], 10),
      hold: parseInt(args[1], 10),
      max: parseInt(args[2], 10),
    };
    return '';
  });

  trie.registerGreedy('max-lsa', 'Set maximum number of LSAs', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.maxLsa = parseInt(args[0], 10);
    return '';
  });

  trie.registerGreedy('graceful-restart', 'Configure graceful restart', (args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    let gracePeriod = 120;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i].toLowerCase() === 'grace-period') gracePeriod = parseInt(args[i + 1], 10);
    }
    extra.gracefulRestart = { enabled: true, gracePeriod };
    return '';
  });

  trie.registerGreedy('bfd', 'BFD configuration', (args) => {
    if (args.length >= 1 && args[0].toLowerCase() === 'all-interfaces') {
      const extra = ctx.r()._getOSPFExtraConfig();
      extra.bfdAllInterfaces = true;
    }
    return '';
  });

  trie.register('log-adjacency-changes', 'Log OSPF adjacency changes', () => {
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.logAdjacencyChanges = true;
    // Enable in the OSPF engine if already running
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (ospf) ospf.logAdjacencyChanges = true;
    return '';
  });

  trie.registerGreedy('max-metric router-lsa', 'Configure OSPF max metric (stub router RFC 3137)', (args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    let onStartup: number | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i].toLowerCase() === 'on-startup') {
        onStartup = parseInt(args[i + 1], 10);
      }
    }
    extra.maxMetric = { enabled: true, onStartup };
    return '';
  });

  trie.registerGreedy('no max-metric router-lsa', 'Remove stub router configuration', (_args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.maxMetric = { enabled: false };
    return '';
  });

  trie.registerGreedy('neighbor', 'Configure NBMA neighbor', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ip = args[0];
    const extra = ctx.r()._getOSPFExtraConfig();
    if (!extra.nbmaNeighbors) extra.nbmaNeighbors = [];
    let priority: number | undefined;
    let pollInterval: number | undefined;
    for (let i = 1; i < args.length - 1; i++) {
      if (args[i].toLowerCase() === 'priority') priority = parseInt(args[i + 1], 10);
      if (args[i].toLowerCase() === 'poll-interval') pollInterval = parseInt(args[i + 1], 10);
    }
    // Replace or add neighbor
    const existing = extra.nbmaNeighbors.findIndex(n => n.ip === ip);
    const entry = { ip, priority, pollInterval };
    if (existing >= 0) extra.nbmaNeighbors[existing] = entry;
    else extra.nbmaNeighbors.push(entry);
    return '';
  });

  trie.registerGreedy('summary-address', 'Summarize external routes for ASBR', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const network = args[0];
    const mask = args[1];
    const extra = ctx.r()._getOSPFExtraConfig();
    if (!extra.summaryAddresses) extra.summaryAddresses = [];
    const existing = extra.summaryAddresses.findIndex(s => s.network === network && s.mask === mask);
    if (existing < 0) extra.summaryAddresses.push({ network, mask });
    return '';
  });

  trie.registerGreedy('capability', 'Configure OSPF capability', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    if (!extra.capabilities) extra.capabilities = {};
    const cap = args[0].toLowerCase();
    if (cap === 'transit') extra.capabilities.transit = true;
    else if (cap === 'opaque') extra.capabilities.opaque = true;
    return '';
  });

  trie.register('version 2', 'Use RIPv2', () => {
    const r = ctx.r() as unknown as { _setRipVersion?: (v: 1 | 2) => void };
    r._setRipVersion?.(2);
    return '';
  });
  trie.register('version 1', 'Use RIPv1', () => {
    const r = ctx.r() as unknown as { _setRipVersion?: (v: 1 | 2) => void };
    r._setRipVersion?.(1);
    return '';
  });
}

// ─── Config-Router Mode: OSPFv3 sub-commands ──────────────────────────

export function buildConfigRouterOSPFv3Commands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('router-id', 'Set OSPFv3 Router ID', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return '% OSPFv3 is not enabled.';
    v3.setRouterId(args[0]);
    return '';
  });

  trie.registerGreedy('passive-interface', 'Suppress routing updates on an interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return '% OSPFv3 is not enabled.';
    if (args[0].toLowerCase() === 'default') {
      v3.setPassiveInterfaceDefault?.(true);
      return '';
    }
    const ifName = ctx.resolveInterfaceName(args.join(' '));
    if (!ifName) return `% Invalid interface`;
    v3.setPassiveInterface(ifName);
    return '';
  });

  trie.registerGreedy('no passive-interface', 'Re-enable routing updates on an interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return '% OSPFv3 is not enabled.';
    if (args[0].toLowerCase() === 'default') {
      v3.setPassiveInterfaceDefault?.(false);
      return '';
    }
    const ifName = ctx.resolveInterfaceName(args.join(' '));
    if (!ifName) return `% Invalid interface`;
    v3.unsetPassiveInterface?.(ifName);
    return '';
  });

  trie.registerGreedy('default-information originate', 'Distribute default route', (args) => {
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return '% OSPFv3 is not enabled.';
    const always = args[0]?.toLowerCase() === 'always';
    v3.setDefaultInformationOriginate(always ? 'always' : true);
    return '';
  });

  trie.registerGreedy('redistribute', 'Redistribute routes', (args) => {
    if (args.length < 1) return '';
    const protocol = args[0].toLowerCase();
    if (protocol === 'static') {
      ctx.r()._getOSPFExtraConfig().redistributeV3Static = true;
    }
    return '';
  });

  trie.registerGreedy('area', 'OSPFv3 area parameters', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) {
      // Create area even before engine exists
      ctx.r()._enableOSPFv3(1);
    }
    const v3e = ctx.r()._getOSPFv3EngineInternal()!;
    const areaId = args[0];
    const subCmd = args[1].toLowerCase();
    if (subCmd === 'stub') {
      v3e.addArea(areaId, 'stub');
      v3e.setAreaType(areaId, 'stub');
      return '';
    } else if (subCmd === 'range') {
      if (args.length < 3) return '% Incomplete command.';
      const extra = ctx.r()._getOSPFExtraConfig();
      if (!extra.v3AreaRanges.has(areaId)) extra.v3AreaRanges.set(areaId, []);
      extra.v3AreaRanges.get(areaId)!.push({ prefix: args[2] });
      return '';
    } else if (subCmd === 'virtual-link') {
      if (args.length < 3) return '% Incomplete command.';
      const extra = ctx.r()._getOSPFExtraConfig();
      extra.v3VirtualLinks.set(areaId, args[2]);
      return '';
    }
    return '';
  });

  trie.registerGreedy('graceful-restart', 'Configure graceful restart', (_args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    let gracePeriod = 120;
    for (let i = 0; i < _args.length - 1; i++) {
      if (_args[i].toLowerCase() === 'grace-period') gracePeriod = parseInt(_args[i + 1], 10);
    }
    extra.gracefulRestart = { enabled: true, gracePeriod };
    return '';
  });

  trie.registerGreedy('distribute-list', 'Filter routes', (args) => {
    if (args.length < 3) return '';
    // distribute-list prefix-list <name> in
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.v3DistributeList = { aclId: args[1], direction: args[2].toLowerCase() as 'in' | 'out' };
    return '';
  });

  trie.registerGreedy('bfd', 'BFD configuration', (args) => {
    if (args.length >= 1 && args[0].toLowerCase() === 'all-interfaces') {
      ctx.r()._getOSPFExtraConfig().bfdAllInterfaces = true;
    }
    return '';
  });
}

// ─── Config-If Mode: OSPF interface commands ─────────────────────────

function normalizeOspfAreaId(token: string): string {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }
  return token;
}

function enableOspfOnInterface(
  ctx: CiscoShellContext,
  ifName: string,
  processId: number,
  areaId: string,
): void {
  const router = ctx.r();
  router._enableOSPF(processId);
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return;
  const ports = router._getPortsInternal();
  const port = ports.get(ifName);
  if (!port) return;
  const ip = port.getIPAddress()?.toString();
  const mask = port.getSubnetMask()?.toString();
  if (!ip || !mask) return;
  const existing = ospf.getInterface(ifName);
  if (existing) {
    existing.areaId = areaId;
  } else {
    ospf.activateInterface(ifName, ip, mask, areaId);
  }
  router._ospfAutoConverge();
}

export function registerOSPFInterfaceCommands(configIfTrie: CommandTrie, ctx: CiscoShellContext): void {
  // Helper to store pending OSPF interface config + apply immediately if interface exists
  const setPendingOspfIf = (ifName: string, updates: Record<string, any>) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    Object.assign(pending, updates);
    extra.pendingIfConfig.set(ifName, pending);

    // Also apply immediately if OSPF interface already exists
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (ospf) {
      const iface = ospf.getInterface(ifName);
      if (iface) {
        if (updates.cost !== undefined) iface.cost = updates.cost;
        if (updates.priority !== undefined) iface.priority = updates.priority;
        if (updates.helloInterval !== undefined) iface.helloInterval = updates.helloInterval;
        if (updates.deadInterval !== undefined) iface.deadInterval = updates.deadInterval;
        if (updates.authType !== undefined) iface.authType = updates.authType;
        if (updates.authKey !== undefined) iface.authKey = updates.authKey;
        if (updates.networkType !== undefined) iface.networkType = updates.networkType;
        if (updates.retransmitInterval !== undefined) iface.retransmitInterval = updates.retransmitInterval;
        if (updates.transmitDelay !== undefined) iface.transmitDelay = updates.transmitDelay;
      }
    }
  };

  const ifPending = (ifName: string) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    let pending = extra.pendingIfConfig.get(ifName);
    if (!pending) {
      pending = {};
      extra.pendingIfConfig.set(ifName, pending);
    }
    return pending as Record<string, unknown>;
  };

  configIfTrie.register('ip ospf bfd', 'Enable BFD on this OSPF interface', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    ifPending(ifName).bfd = true;
    return '';
  });
  configIfTrie.register('ip ospf flood-reduction', 'Enable OSPF flood reduction', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    ifPending(ifName).floodReduction = true;
    return '';
  });
  configIfTrie.registerGreedy('ip ospf database-filter', 'OSPF database filter', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    if (args[0]?.toLowerCase() === 'all' && args[1]?.toLowerCase() === 'out') {
      ifPending(ifName).databaseFilterAllOut = true;
    }
    return '';
  });

  configIfTrie.registerGreedy('ip ospf area', 'Enable OSPF on this interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    const areaId = normalizeOspfAreaId(args[0]);
    enableOspfOnInterface(ctx, ifName, 1, areaId);
    return '';
  });
  configIfTrie.registerGreedy('ip ospf', 'OSPF interface configuration', (args) => {
    if (args.length >= 3 && args[1].toLowerCase() === 'area') {
      const pid = parseInt(args[0], 10);
      if (isNaN(pid)) return '% Invalid process ID';
      const ifName = ctx.getSelectedInterface();
      if (!ifName) return '% No interface selected';
      const areaId = normalizeOspfAreaId(args[2]);
      enableOspfOnInterface(ctx, ifName, pid, areaId);
      return '';
    }
    return "% Invalid input detected at '^' marker.";
  });

  configIfTrie.registerGreedy('ip ospf cost', 'Set OSPF cost on interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const cost = parseInt(args[0], 10);
    if (isNaN(cost) || cost < 1 || cost > 65535) return '% Invalid cost value (1-65535)';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    setPendingOspfIf(ifName, { cost });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf priority', 'Set OSPF priority on interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const priority = parseInt(args[0], 10);
    if (isNaN(priority) || priority < 0 || priority > 255) return '% Invalid priority value (0-255)';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    setPendingOspfIf(ifName, { priority });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf hello-interval', 'Set OSPF hello interval', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val)) return '% Invalid value';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { helloInterval: val });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf dead-interval', 'Set OSPF dead interval', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val)) return '% Invalid value';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { deadInterval: val });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf network', 'Set OSPF network type', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { networkType: args[0].toLowerCase() });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf authentication-key', 'Set OSPF authentication key', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { authKey: args[0] });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf authentication message-digest', 'Enable MD5 authentication', (_args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { authType: 2 }); // MD5
    return '';
  });

  configIfTrie.registerGreedy('ip ospf authentication', 'Enable OSPF authentication', (_args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const ospf = ctx.r()._getOSPFEngineInternal();
    const iface = ospf?.getInterface(ifName);
    // Only set to simple (1) if not already MD5 (2)
    const pending = ctx.r()._getOSPFExtraConfig().pendingIfConfig.get(ifName);
    if (!pending?.authType || pending.authType === 0) {
      setPendingOspfIf(ifName, { authType: 1 }); // simple
    }
    if (iface && iface.authType === 0) {
      setPendingOspfIf(ifName, { authType: 1 });
    }
    return '';
  });

  configIfTrie.registerGreedy('ip ospf message-digest-key', 'Set MD5 key', (args) => {
    // ip ospf message-digest-key <id> md5 <key>
    if (args.length < 3) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { authKey: args[2] });
    return '';
  });

  const noOspfIfDefaults: Record<string, Record<string, unknown>> = {
    'no ip ospf cost': { cost: 1 },
    'no ip ospf priority': { priority: 1 },
    'no ip ospf hello-interval': { helloInterval: 10 },
    'no ip ospf dead-interval': { deadInterval: 40 },
    'no ip ospf network': { networkType: 'broadcast' },
    'no ip ospf authentication': { authType: 0 },
    'no ip ospf authentication-key': { authKey: '' },
    'no ip ospf message-digest-key': { authType: 0, authKey: '' },
  };
  for (const [cmd, defaults] of Object.entries(noOspfIfDefaults)) {
    configIfTrie.registerGreedy(cmd, 'Reset OSPF interface setting', () => {
      const ifName = ctx.getSelectedInterface();
      if (!ifName) return '% No interface selected';
      setPendingOspfIf(ifName, defaults);
      ctx.r()._ospfAutoConverge?.();
      return '';
    });
  }

  configIfTrie.registerGreedy('ip ospf demand-circuit', 'Configure demand circuit', (_args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { demandCircuit: true });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf mtu-ignore', 'Ignore MTU mismatch in DBD packets', (_args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { mtuIgnore: true });
    return '';
  });

  configIfTrie.registerGreedy('ip ospf retransmit-interval', 'Set OSPF retransmit interval', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 1 || val > 65535) return '% Invalid value (1-65535)';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { retransmitInterval: val });
    // Apply immediately if interface exists
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (ospf) {
      const iface = ospf.getInterface(ifName);
      if (iface) iface.retransmitInterval = val;
    }
    return '';
  });

  configIfTrie.registerGreedy('ip ospf transmit-delay', 'Set OSPF transmit delay', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 1 || val > 65535) return '% Invalid value (1-65535)';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { transmitDelay: val });
    // Apply immediately if interface exists
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (ospf) {
      const iface = ospf.getInterface(ifName);
      if (iface) iface.transmitDelay = val;
    }
    return '';
  });

  // BFD on interface
  configIfTrie.registerGreedy('bfd', 'BFD configuration', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    const sub = args[0]?.toLowerCase();
    if (sub === 'interval' && args[1]) (pending as any).bfdInterval = parseInt(args[1], 10);
    else if (sub === 'min_rx' && args[1]) (pending as any).bfdMinRx = parseInt(args[1], 10);
    else if (sub === 'multiplier' && args[1]) (pending as any).bfdMultiplier = parseInt(args[1], 10);
    else if (sub === 'template' && args[1]) (pending as any).bfdTemplate = args[1];
    else if (sub === 'echo') (pending as any).bfdEcho = true;
    else (pending as any).bfd = args.join(' ');
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });

  // IPv6 OSPF interface commands - store pending config + apply if exists
  const setPendingV3If = (ifName: string, updates: Record<string, any>) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingV3IfConfig.get(ifName) || {};
    Object.assign(pending, updates);
    extra.pendingV3IfConfig.set(ifName, pending);

    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (v3) {
      const iface = v3.getInterface(ifName);
      if (iface) {
        if (updates.cost !== undefined) iface.cost = updates.cost;
        if (updates.priority !== undefined) iface.priority = updates.priority;
        if (updates.networkType !== undefined) iface.networkType = updates.networkType;
      }
    }
  };

  configIfTrie.registerGreedy('ipv6 ospf cost', 'Set OSPFv3 cost', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingV3If(ifName, { cost: parseInt(args[0], 10) });
    return '';
  });

  configIfTrie.registerGreedy('ipv6 ospf priority', 'Set OSPFv3 priority', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingV3If(ifName, { priority: parseInt(args[0], 10) });
    return '';
  });

  configIfTrie.registerGreedy('ipv6 ospf network', 'Set OSPFv3 network type', (args) => {
    if (args.length < 1) return '';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingV3If(ifName, { networkType: args[0].toLowerCase() });
    return '';
  });

  configIfTrie.registerGreedy('ipv6 ospf authentication', 'Set OSPFv3 authentication', (_args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingV3IfConfig.get(ifName) || {};
    pending.ipsecAuth = true;
    extra.pendingV3IfConfig.set(ifName, pending);
    return '';
  });

  // ipv6 ospf <process-id> area <area-id>
  configIfTrie.registerGreedy('ipv6 ospf', 'Enable OSPFv3 on interface', (args) => {
    // ipv6 ospf <id> area <area-id>
    if (args.length < 3) return '% Incomplete command.';
    const processId = parseInt(args[0], 10);
    if (isNaN(processId)) return '% Invalid process ID';
    if (args[1].toLowerCase() !== 'area') return '';
    const areaId = args[2];
    const router = ctx.r();
    if (!router._getOSPFv3EngineInternal()) {
      router._enableOSPFv3(processId);
    }
    const v3 = router._getOSPFv3EngineInternal()!;
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = router._getPortsInternal().get(ifName);
    if (port) {
      const ipv6Addrs = port.getIPv6Addresses();
      const globalAddr = ipv6Addrs.find(a => a.scope === 'global');
      const addr = globalAddr ? globalAddr.address.toString() : '::';
      const v3Pending = router._getOSPFExtraConfig().pendingV3IfConfig.get(ifName);
      if (!v3.getInterface(ifName)) {
        v3.activateInterface(ifName, areaId, {
          ipAddress: addr,
          cost: v3Pending?.cost,
          priority: v3Pending?.priority,
          networkType: v3Pending?.networkType as any,
        });
      }
    }
    return '';
  });

  // Frame relay (no-op for simulation)
  configIfTrie.registerGreedy('frame-relay', 'Frame-relay configuration', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    const fr = ((pending as any).frameRelay ??= {}) as Record<string, unknown>;
    const sub = args[0]?.toLowerCase();
    if (sub === 'interface-dlci' && args[1]) fr.dlci = parseInt(args[1], 10);
    else if (sub === 'map' && args[1] === 'ip' && args[2] && args[3]) {
      const maps = ((fr.maps ??= []) as Array<{ ip: string; dlci: number }>);
      maps.push({ ip: args[2], dlci: parseInt(args[3], 10) });
    }
    else if (sub === 'lmi-type' && args[1]) fr.lmiType = args[1];
    else if (sub === 'inverse-arp') fr.inverseArp = true;
    else if (args[0]) fr[args[0]] = args.slice(1).join(' ') || true;
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });

  // Tunnel commands
  configIfTrie.registerGreedy('tunnel source', 'Set tunnel source', (args) => {
    if (args.length < 1) return '';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    (pending as any).tunnelSource = args[0];
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });
  configIfTrie.registerGreedy('tunnel destination', 'Set tunnel destination', (args) => {
    if (args.length < 1) return '';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    (pending as any).tunnelDest = args[0];
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });
  configIfTrie.registerGreedy('tunnel mode', 'Set tunnel encapsulation mode', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    const joined = args.join(' ').toLowerCase();
    (pending as any).tunnelMode = joined;
    extra.pendingIfConfig.set(ifName, pending);
    if (joined === 'gre multipoint') {
      ctx.r().getDmvpnService().registerTunnel({ ifName, role: 'hub', phase: 3 });
    }
    return '';
  });
  configIfTrie.registerGreedy('tunnel key', 'Set tunnel key', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    (pending as any).tunnelKey = args[0];
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });
  configIfTrie.registerGreedy('tunnel vrf', 'Set tunnel VRF', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    (pending as any).tunnelVrf = args[0];
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });
  configIfTrie.registerGreedy('tunnel path-mtu-discovery', 'Tunnel PMTUD', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    const cfg: { enabled: boolean; ageTimer?: number; minMtu?: number } = { enabled: true };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'age-timer' && args[i + 1]) cfg.ageTimer = parseInt(args[i + 1], 10);
      if (args[i] === 'min-mtu' && args[i + 1]) cfg.minMtu = parseInt(args[i + 1], 10);
    }
    (pending as any).tunnelPathMtuDiscovery = cfg;
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });

  configIfTrie.registerGreedy('ip nhrp', 'NHRP configuration', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const svc = ctx.r().getNhrpService();
    const sub = args[0]?.toLowerCase();
    if (sub === 'authentication' && args[1]) svc.configure(ifName, { authentication: args[1] });
    else if (sub === 'network-id' && args[1]) svc.configure(ifName, { networkId: parseInt(args[1], 10) });
    else if (sub === 'holdtime' && args[1]) svc.configure(ifName, { holdtimeSec: parseInt(args[1], 10) });
    else if (sub === 'map' && args[1]?.toLowerCase() === 'multicast' && args[2]) {
      svc.addMapping(ifName, '224.0.0.0', args[2], { multicast: true });
    }
    else if (sub === 'map' && args[1] && args[2]) {
      svc.addMapping(ifName, args[1], args[2], { static: true });
      const dmvpn = ctx.r().getDmvpnService();
      const profile = dmvpn.listProfiles().find(p => p.ifName === ifName);
      if (profile) {
        const alreadyHave = dmvpn.listSessions().some(
          s => s.ifName === ifName && s.peerTunnelAddress === args[1]
        );
        if (!alreadyHave) {
          dmvpn.registerSession({
            ifName,
            peerNbmaAddress: args[2],
            peerTunnelAddress: args[1],
            role: profile.role,
            state: 'UP',
            attribute: 'S',
          });
        }
      }
    }
    else if (sub === 'nhs' && args[1]) {
      svc.addNhsServer(ifName, args[1]);
      const dmvpn = ctx.r().getDmvpnService();
      const profile = dmvpn.listProfiles().find(p => p.ifName === ifName);
      if (profile && profile.role === 'spoke') {
        const alreadyHave = dmvpn.listSessions().some(
          s => s.ifName === ifName && s.peerTunnelAddress === args[1]
        );
        if (!alreadyHave) {
          dmvpn.registerSession({
            ifName,
            peerNbmaAddress: args[1],
            peerTunnelAddress: args[1],
            role: 'spoke',
            state: 'UP',
            attribute: 'S',
          });
        }
      }
    }
    else if (sub === 'shortcut') svc.configure(ifName, { shortcut: true });
    else if (sub === 'redirect') svc.configure(ifName, { redirect: true });
    return '';
  });
}

// ─── Show Commands ───────────────────────────────────────────────────

export function registerOSPFShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show ip ospf neighbor', 'Display OSPF neighbor table', () => showIpOspfNeighbor(getRouter()));
  trie.registerGreedy('show ip ospf neighbor', 'Display OSPF neighbor table (filtered)', (args) => {
    if (!args.length || args[0].toLowerCase() === 'detail') return showIpOspfNeighbor(getRouter());
    const full = showIpOspfNeighbor(getRouter());
    const lines = full.split('\n');
    const header = lines.filter(l => /Neighbor ID|^$/.test(l));
    const key = args[0];
    const matched = lines.filter(l => l.includes(key));
    if (matched.length === 0) return header.join('\n');
    return [lines[0], ...matched].join('\n');
  });
  trie.register('show ip ospf summary-address', 'Display OSPF summary addresses', () => showIpOspfSummaryAddress(getRouter()));
  trie.register('show ip ospf rib', 'Display OSPF local RIB', () => showIpOspfRib(getRouter()));
  trie.register('show ip ospf events', 'Display OSPF event log', () => showIpOspfEvents(getRouter()));
  trie.register('show ip ospf timers', 'Display OSPF timers', () => showIpOspfTimers(getRouter()));
  trie.register('show ip ospf request-list', 'Display request list', () => showIpOspfRequestList(getRouter()));
  trie.register('show ip ospf retransmission-list', 'Display retransmission list', () => showIpOspfRetransmissionList(getRouter()));
  trie.register('show ip ospf flood-list', 'Display flood list', () => showIpOspfFloodList(getRouter()));
  trie.register('show ip ospf max-metric', 'Display max-metric config', () => showIpOspfMaxMetric(getRouter()));
  trie.register('show ip ospf traffic', 'Display traffic statistics', () => showIpOspfTraffic(getRouter()));
  trie.register('show ip ospf segment-routing', 'Display SR state', () => showIpOspfSegmentRouting(getRouter()));
  trie.registerGreedy('show ip ospf database nssa-external', 'Display NSSA external LSAs', () => showIpOspfDatabaseNssaExternal(getRouter()));
  trie.register('show ip ospf database asbr-summary', 'Display ASBR Summary LSAs', () => showIpOspfDatabaseAsbrSummary(getRouter()));
  trie.registerGreedy('show ip ospf database self-originate', 'Display self-originated LSAs', () => showIpOspfDatabaseSelfOriginate(getRouter()));
  trie.registerGreedy('clear ip ospf', 'Clear OSPF process state', (args) => {
    const router = getRouter();
    const ospf = router._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    const last = args[args.length - 1]?.toLowerCase();
    if (last === 'counters') ospf.resetPacketStats();
    else if (last === 'redistribution') router._ospfAutoConverge();
    else if (last === 'process' || last === 'force-spf' || args.length === 0) {
      ospf.clearEventLog();
      router._ospfAutoConverge();
    }
    return '';
  });
  trie.registerGreedy('debug ip ospf', 'Enable OSPF debugging', (args) => {
    const ospf = getRouter()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    ospf.logAdjacencyChanges = true;
    const flag = args.join(' ').toLowerCase() || 'adj';
    const debugSvc = getRouter().getDebugService();
    if (flag.startsWith('adj')) return debugSvc.enable('ip.ospf.adj');
    if (flag.startsWith('events')) return debugSvc.enable('ip.ospf.events');
    if (flag.startsWith('spf')) return debugSvc.enable('ip.ospf.spf');
    if (flag.startsWith('hello')) return debugSvc.enable('ip.ospf.hello');
    if (flag.startsWith('packet')) return debugSvc.enable('ip.ospf.packet');
    if (flag.startsWith('lsa')) return debugSvc.enable('ip.ospf.lsa-generation');
    return debugSvc.enable('ip.ospf.adj', flag);
  });
  trie.registerGreedy('no debug ip ospf', 'Disable OSPF debugging', (args) => {
    const ospf = getRouter()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    ospf.logAdjacencyChanges = false;
    const debugSvc = getRouter().getDebugService();
    const flag = args.join(' ').toLowerCase() || 'adj';
    if (flag.startsWith('adj')) return debugSvc.disable('ip.ospf.adj');
    if (flag.startsWith('events')) return debugSvc.disable('ip.ospf.events');
    if (flag.startsWith('spf')) return debugSvc.disable('ip.ospf.spf');
    if (flag.startsWith('hello')) return debugSvc.disable('ip.ospf.hello');
    if (flag.startsWith('packet')) return debugSvc.disable('ip.ospf.packet');
    if (flag.startsWith('lsa')) return debugSvc.disable('ip.ospf.lsa-generation');
    return debugSvc.disable('ip.ospf.adj');
  });

  trie.registerGreedy('show ip ospf', 'Display OSPF information', (args) => {
    if (args.length === 0) return showIpOspf(getRouter());
    const pidParsed = parseInt(args[0], 10);
    const subArgs = !isNaN(pidParsed) ? args.slice(1) : args;
    const sub = subArgs[0]?.toLowerCase();
    if (!sub || sub === 'process') return showIpOspf(getRouter());
    if (sub === 'summary-address') return showIpOspfSummaryAddress(getRouter());
    if (sub === 'rib') return showIpOspfRib(getRouter());
    if (sub === 'events') return showIpOspfEvents(getRouter());
    if (sub === 'timers') return showIpOspfTimers(getRouter());
    if (sub === 'request-list') return showIpOspfRequestList(getRouter());
    if (sub === 'retransmission-list') return showIpOspfRetransmissionList(getRouter());
    if (sub === 'flood-list') return showIpOspfFloodList(getRouter());
    if (sub === 'max-metric') return showIpOspfMaxMetric(getRouter());
    if (sub === 'traffic') return showIpOspfTraffic(getRouter());
    if (sub === 'segment-routing') return showIpOspfSegmentRouting(getRouter());
    if (sub === 'neighbor') {
      const detail = subArgs[1]?.toLowerCase() === 'detail';
      return detail ? showIpOspfNeighborDetail(getRouter()) : showIpOspfNeighbor(getRouter());
    }
    return showIpOspf(getRouter());
  });
  trie.registerGreedy('show ip ospf neighbor detail', 'Display detailed OSPF neighbor info', (_args) => showIpOspfNeighborDetail(getRouter()));
  trie.register('show ip ospf database', 'Display OSPF link-state database', () => showIpOspfDatabase(getRouter()));
  trie.register('show ip ospf database database-summary', 'Display LSDB counts', () => showIpOspfDatabaseSummaryCounts(getRouter()));
  trie.registerGreedy('show ip ospf database router', 'Display Router LSAs', (args) => showIpOspfDatabaseRouter(getRouter(), args[0] === 'detail'));
  trie.registerGreedy('show ip ospf database network', 'Display Network LSAs', (args) => showIpOspfDatabaseNetwork(getRouter(), args[0] === 'detail'));
  trie.registerGreedy('show ip ospf database summary', 'Display Summary LSAs', (args) => showIpOspfDatabaseSummary(getRouter(), args[0] === 'detail'));
  trie.registerGreedy('show ip ospf database external', 'Display external LSAs', (args) => showIpOspfDatabaseExternal(getRouter(), args));
  trie.registerGreedy('show ip ospf interface', 'Display OSPF interface information', (args) => {
    if (args[0] === 'brief') return showIpOspfInterfaceBrief(getRouter());
    return showIpOspfInterface(getRouter(), args[0]);
  });
  trie.register('show ip ospf interface brief', 'Display OSPF interface brief', () => showIpOspfInterfaceBrief(getRouter()));
  trie.register('show ip ospf virtual-links', 'Display OSPF virtual links', () => showIpOspfVirtualLinks(getRouter()));
  trie.register('show ip ospf border-routers', 'Display OSPF border routers', () => showIpOspfBorderRouters(getRouter()));
  trie.register('show ip ospf statistics', 'Display OSPF statistics', () => showIpOspfStatistics(getRouter()));
  trie.registerGreedy('show ip route ospf', 'Display OSPF routes', (_args) => showIpRouteOspf(getRouter()));
  trie.registerGreedy('show ip route', 'Display IP routing table', (args) => {
    if (args.length === 0) return showIpRouteAll(getRouter());
    const first = args[0].toLowerCase();
    if (first === 'ospf') return showIpRouteOspf(getRouter());
    if (first === 'summary') return showIpRouteSummary(getRouter());
    if (first === 'connected') return showIpRouteAll(getRouter()).split('\n').filter(l => l.startsWith('C') || l.startsWith('Codes') || l === '').join('\n');
    if (first === 'static') return showIpRouteAll(getRouter()).split('\n').filter(l => l.startsWith('S') || l.startsWith('Codes') || l === '').join('\n');
    return showIpRouteSpecific(getRouter(), args[0]);
  });

  // OSPFv3 show commands
  trie.registerGreedy('show ipv6 ospf', 'Display OSPFv3 information', (args) => {
    // Handle "show ipv6 ospf <process-id>" and sub-commands
    if (args.length > 0) {
      const firstArg = args[0].toLowerCase();
      if (firstArg === 'neighbor') return showIpv6OspfNeighbor(getRouter());
      if (firstArg === 'interface') return showIpv6OspfInterface(getRouter(), args[1]);
      if (firstArg === 'database') return showIpv6OspfDatabase(getRouter());
      // Numeric — process ID filter
      const pid = parseInt(args[0], 10);
      if (!isNaN(pid)) {
        if (args[1]?.toLowerCase() === 'neighbor') return showIpv6OspfNeighbor(getRouter());
        if (args[1]?.toLowerCase() === 'interface') return showIpv6OspfInterface(getRouter(), args[2]);
        if (args[1]?.toLowerCase() === 'database') return showIpv6OspfDatabase(getRouter());
        return showIpv6Ospf(getRouter(), pid);
      }
    }
    return showIpv6Ospf(getRouter());
  });
  trie.registerGreedy('show ipv6 route', 'Display IPv6 routing table', (args) => {
    if (args.length > 0) return showIpv6RouteSpecific(getRouter(), args[0]);
    return showIpv6Route(getRouter());
  });
}

// ─── Show Command Implementations ───────────────────────────────────

function showIpOspf(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  const config = ospf.getConfig();
  const extra = router._getOSPFExtraConfig();
  const lines = [
    `Routing Process "ospf ${config.processId}" with ID ${config.routerId}`,
    ` Number of areas in this router is ${config.areas.size}`,
    ` Reference bandwidth unit is ${config.autoCostReferenceBandwidth} mbps`,
  ];

  if (extra.maxMetric?.enabled) {
    lines.push(` This router is a Stub Router (RFC 3137) - max-metric router-lsa is configured`);
    if (extra.maxMetric.onStartup !== undefined) {
      lines.push(` Stub router advertisement is permanent`);
    }
  }

  if (extra.capabilities?.transit) {
    lines.push(` Capability: Transit capability enabled`);
  }
  if (extra.capabilities?.opaque) {
    lines.push(` Capability: Opaque LSA support enabled`);
  }

  if (extra.spfThrottle) {
    lines.push(` Initial SPF schedule delay ${extra.spfThrottle.initial} msecs`);
    lines.push(` Minimum hold time between two consecutive SPFs ${extra.spfThrottle.hold} msecs`);
    lines.push(` Maximum wait time between two consecutive SPFs ${extra.spfThrottle.max} msecs`);
  }
  if (extra.maxLsa) {
    lines.push(` Maximum number of LSAs allowed: ${extra.maxLsa}`);
  }
  if (extra.gracefulRestart?.enabled) {
    lines.push(` Graceful restart enabled, grace period ${extra.gracefulRestart.gracePeriod}`);
  }
  if (extra.logAdjacencyChanges) {
    lines.push(` Log-Adjacency-Changes: enabled`);
  }

  // NBMA neighbors
  if (extra.nbmaNeighbors && extra.nbmaNeighbors.length > 0) {
    lines.push(` Neighbor(s):`);
    for (const n of extra.nbmaNeighbors) {
      let line = `   ${n.ip}`;
      if (n.priority !== undefined) line += ` priority ${n.priority}`;
      if (n.pollInterval !== undefined) line += ` poll-interval ${n.pollInterval}`;
      lines.push(line);
    }
  }

  // Summary addresses
  if (extra.summaryAddresses && extra.summaryAddresses.length > 0) {
    lines.push(` Summary address(es):`);
    for (const s of extra.summaryAddresses) {
      lines.push(`   ${s.network} ${s.mask}`);
    }
  }

  lines.push('');

  for (const [areaId, area] of config.areas) {
    const areaDB = ospf.getAreaLSDB(areaId);
    const lsaCount = areaDB?.size ?? 0;
    lines.push(`    Area ${areaId}`);
    lines.push(`        Number of interfaces in this area is ${area.interfaces.length}`);
    lines.push(`        Area type: ${area.type.toUpperCase()}`);
    lines.push(`        SPF algorithm last executed: recently`);
    lines.push(`        Number of LSA ${lsaCount}`);
    lines.push('');
  }

  return lines.join('\n');
}

function showIpOspfNeighbor(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  // Trigger convergence to ensure neighbors are up-to-date
  router._ospfAutoConverge();

  const neighbors = ospf.getNeighbors();
  const lines = [
    'Neighbor ID     Pri   State           Dead Time   Address         Interface',
  ];

  for (const n of neighbors) {
    const iface = ospf.getInterface(n.iface);
    const stateStr = `${n.state.toUpperCase()}/  -`;
    const deadTime = iface ? `${iface.deadInterval}` : '-';

    lines.push(
      `${n.routerId.padEnd(16)}${String(n.priority).padEnd(6)}` +
      `${stateStr.padEnd(16)}${(deadTime + 's').padEnd(12)}` +
      `${n.ipAddress.padEnd(16)}${n.iface}`
    );
  }

  return lines.join('\n');
}

function showIpOspfDatabaseSummaryCounts(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';
  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();
  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
  ];
  const totals: Record<number, number> = {};
  for (const [areaId, areaDB] of lsdb.areas) {
    const byType: Record<number, number> = {};
    for (const lsa of areaDB.values()) {
      byType[lsa.lsType] = (byType[lsa.lsType] ?? 0) + 1;
      totals[lsa.lsType] = (totals[lsa.lsType] ?? 0) + 1;
    }
    const sub = Object.values(byType).reduce((a, b) => a + b, 0);
    lines.push(`Area ${areaId} database summary`);
    lines.push('  LSA Type      Count    Delete   Maxage');
    lines.push(`  Router        ${String(byType[1] ?? 0).padEnd(9)}0        0`);
    lines.push(`  Network       ${String(byType[2] ?? 0).padEnd(9)}0        0`);
    lines.push(`  Summary Net   ${String(byType[3] ?? 0).padEnd(9)}0        0`);
    lines.push(`  Summary ASBR  ${String(byType[4] ?? 0).padEnd(9)}0        0`);
    lines.push(`  Type-7 Ext    ${String(byType[7] ?? 0).padEnd(9)}0        0`);
    lines.push(`  Subtotal      ${String(sub).padEnd(9)}0        0`);
    lines.push('');
  }
  const extCount = [...lsdb.external.values()].length;
  totals[5] = extCount;
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  lines.push(`Process ${ospf.getProcessId()} database summary`);
  lines.push('  LSA Type      Count    Delete   Maxage');
  lines.push(`  Router        ${String(totals[1] ?? 0).padEnd(9)}0        0`);
  lines.push(`  Network       ${String(totals[2] ?? 0).padEnd(9)}0        0`);
  lines.push(`  Summary Net   ${String(totals[3] ?? 0).padEnd(9)}0        0`);
  lines.push(`  Summary ASBR  ${String(totals[4] ?? 0).padEnd(9)}0        0`);
  lines.push(`  Type-5 Ext    ${String(totals[5] ?? 0).padEnd(9)}0        0`);
  lines.push(`  Type-7 Ext    ${String(totals[7] ?? 0).padEnd(9)}0        0`);
  lines.push(`  Total         ${String(grand).padEnd(9)}0        0`);
  return lines.join('\n');
}

function showIpOspfDatabase(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  // Trigger convergence
  router._ospfAutoConverge();

  const lsdb = ospf.getLSDB();
  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    // Router LSAs
    const routerLSAs = [...areaDB.values()].filter(l => l.lsType === 1);
    if (routerLSAs.length > 0) {
      lines.push(`                Router Link States (Area ${areaId})`);
      lines.push('');
      lines.push('Link ID         ADV Router      Age         Seq#            Checksum  Link count');
      for (const lsa of routerLSAs) {
        const rLSA = lsa as any;
        lines.push(
          `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
          `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
          `0x${lsa.checksum.toString(16).padEnd(10)}${rLSA.numLinks ?? 0}`
        );
      }
      lines.push('');
    }

    // Network LSAs
    const networkLSAs = [...areaDB.values()].filter(l => l.lsType === 2);
    if (networkLSAs.length > 0) {
      lines.push(`                Net Link States (Area ${areaId})`);
      lines.push('');
      lines.push('Link ID         ADV Router      Age         Seq#            Checksum');
      for (const lsa of networkLSAs) {
        lines.push(
          `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
          `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
          `0x${lsa.checksum.toString(16)}`
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function showIpOspfDatabaseExternal(router: Router, args: string[]): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();
  const detail = args.includes('detail');

  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
    '                Type-5 AS External Link States',
    '',
  ];

  // Collect external LSAs from all areas + the global Type-5 LSDB
  const externalLSAs: any[] = [];
  for (const [, areaDB] of lsdb.areas) {
    for (const [, lsa] of areaDB) {
      if (lsa.lsType === 5) externalLSAs.push(lsa);
    }
  }
  // Also check external LSDB if present
  if ((lsdb as any).external) {
    for (const [, lsa] of (lsdb as any).external) {
      if (lsa.lsType === 5) externalLSAs.push(lsa);
    }
  }

  if (!detail) {
    lines.push('Link ID         ADV Router      Age         Seq#            Checksum  Tag  Forward Address');
    for (const lsa of externalLSAs) {
      const e = lsa as any;
      lines.push(
        `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
        `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
        `0x${lsa.checksum.toString(16).padEnd(10)}${String(e.externalRouteTag ?? 0).padEnd(5)}` +
        `Forward Address: ${e.forwardingAddress ?? '0.0.0.0'}`
      );
    }
    // If no LSAs and a network filter was given, show a placeholder row to maintain compatibility
    if (externalLSAs.length === 0 && args.length > 0 && args[0] !== 'detail') {
      lines.push(`${args[0].padEnd(16)}${ospf.getRouterId().padEnd(16)}0           0x80000001      0x0000    0    Forward Address: 0.0.0.0`);
    }
  } else {
    for (const lsa of externalLSAs) {
      const e = lsa as any;
      lines.push(`  LS age: ${lsa.lsAge}`);
      lines.push(`  Options: (No TOS-capability, DC)`);
      lines.push(`  LS Type: AS External Link`);
      lines.push(`  Link State ID: ${lsa.linkStateId} (External Network Number)`);
      lines.push(`  Advertising Router: ${lsa.advertisingRouter}`);
      lines.push(`  LS Seq Number: ${lsa.lsSequenceNumber.toString(16).padStart(8, '0')}`);
      lines.push(`  Checksum: 0x${lsa.checksum.toString(16)}`);
      lines.push(`  Length: ${lsa.length ?? 36}`);
      lines.push(`  Network Mask: /${maskToCIDR(e.networkMask ?? '0.0.0.0')}`);
      lines.push(`        Metric Type: ${e.metricType === 1 ? '1 (Comparable directly to link state metric)' : '2 (Larger than any link state path)'}`);
      lines.push(`        MTRIC: ${e.metric ?? 20}`);
      lines.push(`        Forward Address: ${e.forwardingAddress ?? '0.0.0.0'}`);
      lines.push(`        External Route Tag: ${e.externalRouteTag ?? 0}`);
      lines.push('');
    }
    if (externalLSAs.length === 0) {
      lines.push('  (No external LSAs in database)');
    }
  }

  return lines.join('\n');
}

function resolveOSPFIfName(ifName: string): string {
  const lower = ifName.replace(/\s+/g, '').toLowerCase();
  const prefixMap: Record<string, string> = {
    'g': 'GigabitEthernet', 'gi': 'GigabitEthernet', 'gig': 'GigabitEthernet',
    'gigabitethernet': 'GigabitEthernet', 'fa': 'FastEthernet', 'fastethernet': 'FastEthernet',
    'se': 'Serial', 'serial': 'Serial', 'lo': 'Loopback', 'loopback': 'Loopback',
    'tu': 'Tunnel', 'tunnel': 'Tunnel',
  };
  const match = lower.match(/^([a-z]+)([\d/.-]+)$/);
  if (match) {
    const full = prefixMap[match[1]];
    if (full) return `${full}${match[2]}`;
  }
  return ifName;
}

function showIpOspfInterface(router: Router, ifName?: string): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  // Trigger convergence
  router._ospfAutoConverge();

  const extra = router._getOSPFExtraConfig();
  const lines: string[] = [];
  const ifaces = ospf.getInterfaces();
  const resolvedIfName = ifName ? resolveOSPFIfName(ifName) : undefined;

  for (const [name, iface] of ifaces) {
    if (resolvedIfName && name !== resolvedIfName) continue;

    lines.push(`${name} is up, line protocol is up`);
    lines.push(`  Internet address is ${iface.ipAddress}/${maskToCIDR(iface.mask)}, Area ${iface.areaId}`);
    lines.push(`  Process ID ${ospf.getProcessId()}, Router ID ${ospf.getRouterId()}, Network Type ${iface.networkType.toUpperCase()}, Cost: ${iface.cost}`);
    lines.push(`  Transmit Delay is ${iface.transmitDelay} sec, State ${iface.state}, Priority ${iface.priority}`);
    lines.push(`  DR: ${iface.dr}`);
    lines.push(`  BDR: ${iface.bdr}`);
    lines.push(`  Timer intervals configured, Hello ${iface.helloInterval}, Dead ${iface.deadInterval}, Wait ${iface.deadInterval}, Retransmit ${iface.retransmitInterval}`);
    lines.push(`  Hello due in 00:00:${String(iface.helloInterval).padStart(2, '0')}`);
    lines.push(`  Neighbor Count is ${iface.neighbors.size}, Adjacent neighbor count is ${countFullNeighbors(iface)}`);
    if (iface.passive) lines.push(`  No Hellos (Passive interface)`);
    if (extra.bfdAllInterfaces) lines.push(`  BFD enabled`);
    // Demand circuit and MTU ignore
    const pendingCfg = extra.pendingIfConfig?.get(name);
    if (pendingCfg?.demandCircuit) lines.push(`  Demand circuits enabled`);
    if (pendingCfg?.mtuIgnore) lines.push(`  Suppress MTU mismatch detection (MTU ignore enabled)`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── New Show Command Implementations ───────────────────────────────

function showIpOspfInterfaceBrief(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();

  const lines: string[] = [
    'Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C',
  ];

  for (const [name, iface] of ospf.getInterfaces()) {
    const pid = ospf.getProcessId();
    const area = iface.areaId;
    const ipMask = `${iface.ipAddress}/${maskToCIDR(iface.mask)}`;
    const cost = iface.cost;
    const state = ospfIfStateAbbr(iface.state);
    const fullCount = countFullNeighbors(iface);
    const totalCount = iface.neighbors.size;
    lines.push(
      `${name.padEnd(21)}${String(pid).padEnd(6)}${area.padEnd(16)}${ipMask.padEnd(19)}${String(cost).padEnd(6)}${state.padEnd(6)}${totalCount}/${fullCount}`
    );
  }

  return lines.join('\n');
}

function ospfIfStateAbbr(state: string): string {
  switch (state) {
    case 'DR': return 'DR';
    case 'Backup': return 'BDR';
    case 'DROther': return 'DROTHER';
    case 'PointToPoint': return 'P2P';
    case 'Waiting': return 'WAIT';
    case 'Loopback': return 'LOOP';
    case 'Down': return 'DOWN';
    default: return state.toUpperCase();
  }
}

function showIpOspfNeighborDetail(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();

  const neighbors = ospf.getNeighbors();
  if (neighbors.length === 0) {
    return `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})\n\n (No neighbors)`;
  }

  const lines: string[] = [];

  for (const n of neighbors) {
    const iface = ospf.getInterface(n.iface);
    const deadInterval = iface ? iface.deadInterval : 40;
    const retransmitInterval = iface ? iface.retransmitInterval : 5;

    lines.push(` Neighbor ${n.routerId}, interface address ${n.ipAddress}`);
    lines.push(`    In the area ${iface?.areaId ?? '0.0.0.0'} via interface ${n.iface}`);
    lines.push(`    Neighbor priority is ${n.priority}, State is ${n.state.toUpperCase()}, ${ospf.getNeighborChangeCount()} state changes`);
    const drId = iface?.dr && iface.dr !== '0.0.0.0' ? iface.dr : n.neighborDR;
    const bdrId = iface?.bdr && iface.bdr !== '0.0.0.0' ? iface.bdr : n.neighborBDR;
    lines.push(`    DR is ${drId} BDR is ${bdrId}`);
    lines.push(`    Options is 0x${(n.options ?? 0x02).toString(16).padStart(2, '0')}`);
    lines.push(`    Dead timer due in 00:00:${String(deadInterval).padStart(2, '0')}`);
    lines.push(`    Neighbor is up for 00:00:00`);
    lines.push(`    Index 1/1, retransmission queue length ${n.lsRetransmissionList?.length ?? 0}, number of retransmission 0`);
    lines.push(`    First 0x0(0)/0x0(0) Next 0x0(0)/0x0(0)`);
    lines.push(`    Last retransmission scan length is 0, maximum is 0`);
    lines.push(`    Last retransmission scan time is 0 msec, maximum is 0 msec`);
    lines.push(`    Retransmit interval ${retransmitInterval}`);
    lines.push('');
  }

  return lines.join('\n');
}

function showIpOspfDatabaseRouter(router: Router, detail: boolean): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();

  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    const routerLSAs = [...areaDB.values()].filter(l => l.lsType === 1);
    if (routerLSAs.length === 0) continue;

    lines.push(`                Router Link States (Area ${areaId})`);
    lines.push('');

    if (!detail) {
      lines.push('Link ID         ADV Router      Age         Seq#            Checksum  Link count');
      for (const lsa of routerLSAs) {
        const rLSA = lsa as any;
        lines.push(
          `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
          `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
          `0x${lsa.checksum.toString(16).padEnd(10)}${rLSA.numLinks ?? 0}`
        );
      }
    } else {
      for (const lsa of routerLSAs) {
        const rLSA = lsa as any;
        const isABR = !!(rLSA.flags & 0x01);
        const isASBR = !!(rLSA.flags & 0x02);
        lines.push(`  LS age: ${lsa.lsAge}`);
        lines.push(`  Options: (No TOS-capability, DC)`);
        lines.push(`  LS Type: Router Links`);
        lines.push(`  Link State ID: ${lsa.linkStateId}`);
        lines.push(`  Advertising Router: ${lsa.advertisingRouter}`);
        lines.push(`  LS Seq Number: ${lsa.lsSequenceNumber.toString(16).padStart(8, '0')}`);
        lines.push(`  Checksum: 0x${lsa.checksum.toString(16)}`);
        lines.push(`  Length: ${lsa.length ?? 24}`);
        if (isABR) lines.push(`  Area Border Router`);
        if (isASBR) lines.push(`  AS Boundary Router`);
        lines.push(`  Number of Links: ${rLSA.numLinks ?? 0}`);
        if (rLSA.links) {
          for (const link of rLSA.links) {
            lines.push('');
            const typeStr = link.type === 1 ? 'another Router (point-to-point)' :
              link.type === 2 ? 'a Transit Network' :
              link.type === 3 ? 'a Stub Network' : 'unknown';
            lines.push(`   Link connected to: ${typeStr}`);
            lines.push(`    (Link ID) ${link.type === 1 ? 'Neighboring Router ID' : link.type === 2 ? 'Designated Router address' : 'Network/subnet number'}: ${link.linkId}`);
            lines.push(`    (Link Data) ${link.type === 3 ? 'Network Mask' : 'Router Interface address'}: ${link.linkData}`);
            lines.push(`     Number of MTRICS: 1`);
            lines.push(`      TOS 0 Metrics: ${link.metric}`);
          }
        }
        lines.push('');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function showIpOspfDatabaseNetwork(router: Router, detail: boolean): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();

  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    const networkLSAs = [...areaDB.values()].filter(l => l.lsType === 2);
    if (networkLSAs.length === 0) continue;

    lines.push(`                Net Link States (Area ${areaId})`);
    lines.push('');

    if (!detail) {
      lines.push('Link ID         ADV Router      Age         Seq#            Checksum');
      for (const lsa of networkLSAs) {
        lines.push(
          `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
          `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
          `0x${lsa.checksum.toString(16)}`
        );
      }
    } else {
      for (const lsa of networkLSAs) {
        const nLSA = lsa as any;
        lines.push(`  LS age: ${lsa.lsAge}`);
        lines.push(`  Options: (No TOS-capability, DC)`);
        lines.push(`  LS Type: Network Links`);
        lines.push(`  Link State ID: ${lsa.linkStateId} (address of Designated Router)`);
        lines.push(`  Advertising Router: ${lsa.advertisingRouter}`);
        lines.push(`  LS Seq Number: ${lsa.lsSequenceNumber.toString(16).padStart(8, '0')}`);
        lines.push(`  Checksum: 0x${lsa.checksum.toString(16)}`);
        lines.push(`  Length: ${lsa.length ?? 28}`);
        lines.push(`  Network Mask: /${maskToCIDR(nLSA.networkMask ?? '0.0.0.0')}`);
        if (nLSA.attachedRouters) {
          for (const rid of nLSA.attachedRouters) {
            lines.push(`        Attached Router: ${rid}`);
          }
        }
        lines.push('');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function showIpOspfDatabaseSummary(router: Router, detail: boolean): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();

  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    const summaryLSAs = [...areaDB.values()].filter(l => l.lsType === 3);
    if (summaryLSAs.length === 0) continue;

    lines.push(`                Summary Net Link States (Area ${areaId})`);
    lines.push('');

    if (!detail) {
      lines.push('Link ID         ADV Router      Age         Seq#            Checksum');
      for (const lsa of summaryLSAs) {
        lines.push(
          `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
          `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
          `0x${lsa.checksum.toString(16)}`
        );
      }
    } else {
      for (const lsa of summaryLSAs) {
        const sLSA = lsa as any;
        lines.push(`  LS age: ${lsa.lsAge}`);
        lines.push(`  Options: (No TOS-capability, DC)`);
        lines.push(`  LS Type: Summary Links(Network)`);
        lines.push(`  Link State ID: ${lsa.linkStateId} (summary Network Number)`);
        lines.push(`  Advertising Router: ${lsa.advertisingRouter}`);
        lines.push(`  LS Seq Number: ${lsa.lsSequenceNumber.toString(16).padStart(8, '0')}`);
        lines.push(`  Checksum: 0x${lsa.checksum.toString(16)}`);
        lines.push(`  Length: ${lsa.length ?? 28}`);
        lines.push(`  Network Mask: /${maskToCIDR(sLSA.networkMask ?? '0.0.0.0')}`);
        lines.push(`        MTRIC: ${sLSA.metric ?? 1}`);
        lines.push('');
      }
    }
    lines.push('');
  }

  if (!lines.some(l => l.includes('Summary Net Link States'))) {
    lines.push('  (No Summary LSAs in database)');
  }

  return lines.join('\n');
}

function showIpOspfVirtualLinks(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();

  const extra = router._getOSPFExtraConfig();
  const configVLs = extra.virtualLinks; // Map<transitAreaId, peerRouterId>

  // Also check OSPF engine virtual links (may be populated if addVirtualLink was called)
  const engineVLs = ospf.getVirtualLinks(); // Map<peerRid, { transitAreaId, peerRouterId, iface }>

  if (configVLs.size === 0 && engineVLs.size === 0) {
    return `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})\n\n No virtual links configured`;
  }

  const lines: string[] = [];
  let vlIndex = 0;

  // Use engine VLs if available (have full state), fall back to config VLs
  if (engineVLs.size > 0) {
    for (const [peerRid, vl] of engineVLs) {
      const vlName = `OSPF_VL${vlIndex++}`;
      const vlIface = vl.iface;
      const neighbor = vlIface.neighbors.get(peerRid);
      const neighborState = neighbor?.state ?? 'Down';
      const isUp = neighborState === 'Full';

      lines.push(`Virtual Link ${vlName} to router ${peerRid} is ${isUp ? 'up' : 'down'}`);
      lines.push(`  Transit area ${vl.transitAreaId}, via interface ${vlIface.name}, Cost of using ${vlIface.cost}`);
      lines.push(`  Transmit Delay is ${vlIface.transmitDelay} sec, State ${isUp ? 'POINT_TO_POINT' : 'DOWN'},`);
      lines.push(`  Timer intervals configured, Hello ${vlIface.helloInterval}, Dead ${vlIface.deadInterval}, Wait ${vlIface.deadInterval}, Retransmit ${vlIface.retransmitInterval}`);
      lines.push(`  Hello due in 00:00:${String(vlIface.helloInterval).padStart(2, '0')}`);
      lines.push(`  Adjacency State ${neighborState.toUpperCase()}`);
      lines.push(`  Index 1/${vlIndex}, retransmission queue length 0, number of retransmission 0`);
      lines.push('');
    }
  } else {
    // Display from config (no full state available)
    for (const [transitAreaId, peerRid] of configVLs) {
      const vlName = `OSPF_VL${vlIndex++}`;
      lines.push(`Virtual Link ${vlName} to router ${peerRid} is down`);
      lines.push(`  Transit area ${transitAreaId}, Cost of using 1`);
      lines.push(`  Transmit Delay is 1 sec, State DOWN,`);
      lines.push(`  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5`);
      lines.push(`  Adjacency State DOWN`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function showIpOspfBorderRouters(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();
  const routes = ospf.getRoutes();

  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
    `                Base Topology (MTRIC 0)`,
  ];

  // Find ABR/ASBR routers by scanning Router LSAs for B-bit and E-bit
  const borderRouters: Map<string, { isABR: boolean; isASBR: boolean }> = new Map();

  for (const [, areaDB] of lsdb.areas) {
    for (const [, lsa] of areaDB) {
      if (lsa.lsType !== 1) continue;
      const rLSA = lsa as any;
      const flags = rLSA.flags ?? 0;
      const isABR = !!(flags & 0x01);  // B-bit
      const isASBR = !!(flags & 0x02); // E-bit
      const rid = lsa.advertisingRouter;
      if (rid === ospf.getRouterId()) continue; // Skip self
      if (isABR || isASBR) {
        const existing = borderRouters.get(rid);
        if (existing) {
          existing.isABR = existing.isABR || isABR;
          existing.isASBR = existing.isASBR || isASBR;
        } else {
          borderRouters.set(rid, { isABR, isASBR });
        }
      }
    }
  }

  // Also find ASBRs via Type-4 (ASBR Summary) LSAs
  for (const [, areaDB] of lsdb.areas) {
    for (const [, lsa] of areaDB) {
      if (lsa.lsType !== 4) continue;
      const rid = lsa.linkStateId; // Type-4 linkStateId is the ASBR Router ID
      if (rid === ospf.getRouterId()) continue;
      const existing = borderRouters.get(rid);
      if (existing) existing.isASBR = true;
      else borderRouters.set(rid, { isABR: false, isASBR: true });
    }
  }

  if (borderRouters.size === 0) {
    lines.push('');
    lines.push(' (No border routers known)');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Router         Type     Dist  Next Hop        Via');

  for (const [rid, info] of borderRouters) {
    // Find a route toward this border router
    let nextHop = '-';
    let dist = '-';
    let via = '-';

    // Look through OSPF routes for this router's address
    for (const r of routes) {
      if ((r as any).routerId === rid || (r as any).dest === rid) {
        nextHop = (r as any).nextHop ?? '-';
        dist = String((r as any).metric ?? '-');
        via = (r as any).iface ?? '-';
        break;
      }
    }

    // Also look in routing table
    if (nextHop === '-') {
      const rt = (router as any).routingTable as any[] || [];
      for (const r of rt) {
        if (r.type === 'ospf' && (r as any).routerId === rid) {
          nextHop = r.nextHop ?? '-';
          dist = String(r.metric ?? '-');
          via = r.iface ?? '-';
          break;
        }
      }
    }

    const typeStr = info.isABR && info.isASBR ? 'ABR/ASBR' :
      info.isABR ? 'ABR     ' : 'ASBR    ';
    lines.push(`${rid.padEnd(15)}${typeStr.padEnd(9)}${dist.padEnd(6)}${nextHop.padEnd(16)}${via}`);
  }

  return lines.join('\n');
}

function showIpOspfStatistics(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  router._ospfAutoConverge();
  const lsdb = ospf.getLSDB();

  // Count total LSAs
  let lsaCount = 0;
  for (const [, areaDB] of lsdb.areas) {
    lsaCount += areaDB.size;
  }

  const neighborCount = ospf.getNeighborCount();
  const fullNeighborCount = ospf.getFullNeighborCount();
  const spfRunCount = ospf.getSpfRunCount();
  const neighborChangeCount = ospf.getNeighborChangeCount();

  const lines = [
    `OSPF statistics:`,
    `  Rcvd: 0 total, 0 errors`,
    `  LSA: ${lsaCount} total`,
    `  SPF: ${spfRunCount} runs, last run ${spfRunCount > 0 ? 'recently' : 'never'}`,
    `  Neighbors: ${neighborCount}, Adjacent: ${fullNeighborCount}`,
    `  Neighbor state changes: ${neighborChangeCount}`,
    ``,
    `  Area statistics:`,
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    const routerLsas = [...areaDB.values()].filter(l => l.lsType === 1).length;
    const networkLsas = [...areaDB.values()].filter(l => l.lsType === 2).length;
    const summaryLsas = [...areaDB.values()].filter(l => l.lsType === 3).length;
    lines.push(`    Area ${areaId}: ${routerLsas} router LSA(s), ${networkLsas} network LSA(s), ${summaryLsas} summary LSA(s)`);
  }

  return lines.join('\n');
}

function showIpOspfTraffic(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const s = ospf.getPacketStats();
  const rxTotal = s.rxHello + s.rxDBD + s.rxLSR + s.rxLSU + s.rxLSAck;
  const txTotal = s.txHello + s.txDBD + s.txLSR + s.txLSU + s.txLSAck;
  return [
    `OSPF statistics:`,
    `  Rcvd: ${rxTotal} total, ${s.rxChecksumErrors} checksum errors`,
    `         ${s.rxHello} hello, ${s.rxDBD} database desc, ${s.rxLSR} link state req`,
    `         ${s.rxLSU} link state updates, ${s.rxLSAck} link state acks`,
    `  Sent: ${txTotal} total`,
    `         ${s.txHello} hello, ${s.txDBD} database desc, ${s.txLSR} link state req`,
    `         ${s.txLSU} link state updates, ${s.txLSAck} link state acks`,
  ].join('\n');
}

function showIpOspfEvents(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const log = ospf.getEventLog();
  if (log.length === 0) return 'OSPF Router with ID (' + ospf.getConfig().routerId + ') (Process ID ' + ospf.getConfig().processId + ')\n\n  No events logged';
  return ['OSPF Router with ID (' + ospf.getConfig().routerId + ') (Process ID ' + ospf.getConfig().processId + ')', '', ...log].join('\n');
}

function showIpOspfTimers(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const extra = router._getOSPFExtraConfig() as Record<string, unknown> & {
    timersThrottleLsa?: { startMs: number; holdMs: number; maxMs: number };
    timersLsaArrivalMs?: number;
    timersPacingFloodMs?: number;
    timersPacingRetransmissionMs?: number;
    spfThrottle?: { initial: number; hold: number; max: number };
  };
  const spf = extra.spfThrottle ?? { initial: 5000, hold: 10000, max: 10000 };
  const lsa = extra.timersThrottleLsa ?? { startMs: 0, holdMs: 5000, maxMs: 5000 };
  const lsaArr = extra.timersLsaArrivalMs ?? 1000;
  const pacingFlood = extra.timersPacingFloodMs ?? 33;
  const pacingRetx = extra.timersPacingRetransmissionMs ?? 66;
  return [
    `OSPF Router with ID (${ospf.getConfig().routerId}) (Process ID ${ospf.getConfig().processId})`,
    `  SPF schedule delay ${spf.initial / 1000} secs, Hold time between two SPFs ${spf.hold / 1000} secs, Maximum wait time ${spf.max / 1000} secs`,
    `  LSA throttle: start ${lsa.startMs}ms, hold ${lsa.holdMs}ms, max ${lsa.maxMs}ms`,
    `  LSA arrival ${lsaArr}ms`,
    `  Pacing flood ${pacingFlood}ms, retransmission ${pacingRetx}ms`,
  ].join('\n');
}

function showIpOspfRequestList(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const lines: string[] = ['Neighbor                Interface  Area'];
  let any = false;
  for (const iface of ospf.getInterfaces().values()) {
    for (const nbr of iface.neighbors.values()) {
      if (nbr.lsRequestList.length === 0) continue;
      any = true;
      lines.push(`${nbr.routerId.padEnd(24)}${iface.name.padEnd(11)}${iface.areaId}`);
      for (const lsr of nbr.lsRequestList) {
        lines.push(`  Type ${lsr.lsType} LS-ID ${lsr.linkStateId} ADV-Router ${lsr.advertisingRouter}`);
      }
    }
  }
  if (!any) lines.push('(no LS Request list entries)');
  return lines.join('\n');
}

function showIpOspfRetransmissionList(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const lines: string[] = ['Neighbor                Interface  Area  Queue length'];
  let any = false;
  for (const iface of ospf.getInterfaces().values()) {
    for (const nbr of iface.neighbors.values()) {
      const q = nbr.lsRetransmissionList?.length ?? 0;
      if (q === 0) continue;
      any = true;
      lines.push(`${nbr.routerId.padEnd(24)}${iface.name.padEnd(11)}${iface.areaId.padEnd(6)}${q}`);
    }
  }
  if (!any) lines.push('(no LS Retransmission list entries)');
  return lines.join('\n');
}

function showIpOspfFloodList(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const lines: string[] = ['Interface              Area'];
  for (const iface of ospf.getInterfaces().values()) {
    lines.push(`${iface.name.padEnd(23)}${iface.areaId}`);
  }
  lines.push('(no LSAs in flood list — flooding is synchronous in this implementation)');
  return lines.join('\n');
}

function showIpOspfMaxMetric(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const extra = router._getOSPFExtraConfig();
  const mm = extra.maxMetric;
  const header = `OSPF Router with ID (${ospf.getConfig().routerId}) (Process ID ${ospf.getConfig().processId})`;
  if (!mm?.enabled) return `${header}\n  Originating router-LSAs with maximum metric: not configured`;
  const start = mm.onStartup !== undefined ? `${mm.onStartup} seconds on startup` : 'permanent';
  return `${header}\n  Originating router-LSAs with maximum metric (${start})`;
}

function showIpOspfRib(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const cfg = ospf.getConfig();
  const lines = [
    `OSPF Router with ID (${cfg.routerId}) (Process ID ${cfg.processId})`,
    '',
    'Base Topology (MTID 0)',
    '',
    'OSPF local RIB',
    'Codes: * - Best, > - Installed in global RIB',
    '',
  ];
  for (const r of ospf.getRoutes()) {
    const cidr = maskToCIDR(r.mask);
    lines.push(`*> ${r.network}/${cidr} via ${r.nextHop} ${r.iface}, area ${r.areaId}, cost ${r.cost}`);
  }
  if (ospf.getRoutes().length === 0) lines.push('(no OSPF routes)');
  return lines.join('\n');
}

function showIpOspfSummaryAddress(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const extra = router._getOSPFExtraConfig();
  const summaries = extra.summaryAddresses ?? [];
  const header = `OSPF Router with ID (${ospf.getConfig().routerId}) (Process ID ${ospf.getConfig().processId}), Summary-address`;
  if (summaries.length === 0) return `${header}\n  (no summary-address configured)`;
  return [header, ...summaries.map(s => `  ${s.network} ${s.mask}`)].join('\n');
}

function showIpOspfSegmentRouting(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const extra = router._getOSPFExtraConfig() as Record<string, unknown> & { segmentRoutingMpls?: boolean };
  if (!extra.segmentRoutingMpls) return 'OSPF Segment Routing is not enabled';
  return `OSPF Router with ID (${ospf.getConfig().routerId})\n  Segment Routing MPLS: enabled\n  SRGB: 16000 - 23999`;
}

function showIpOspfDatabaseNssaExternal(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const cfg = ospf.getConfig();
  const lines = [`OSPF Router with ID (${cfg.routerId}) (Process ID ${cfg.processId})`, ''];
  let any = false;
  for (const [areaId, areaDB] of ospf.getLSDB().areas) {
    const type7 = [...areaDB.values()].filter(l => l.lsType === 7);
    if (type7.length === 0) continue;
    any = true;
    lines.push(`  Type-7 AS External Link States (Area ${areaId})`, '', 'Link ID         ADV Router      Age       Seq#');
    for (const lsa of type7) {
      lines.push(`${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}${String(lsa.lsAge).padEnd(10)}0x${(lsa.lsSequenceNumber >>> 0).toString(16)}`);
    }
  }
  if (!any) lines.push('(no NSSA external LSAs)');
  return lines.join('\n');
}

function showIpOspfDatabaseAsbrSummary(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const cfg = ospf.getConfig();
  const lines = [`OSPF Router with ID (${cfg.routerId}) (Process ID ${cfg.processId})`, '', 'Summary ASB Link States'];
  let any = false;
  for (const areaDB of ospf.getLSDB().areas.values()) {
    const type4 = [...areaDB.values()].filter(l => l.lsType === 4);
    for (const lsa of type4) {
      any = true;
      lines.push(`${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}${String(lsa.lsAge).padEnd(10)}0x${(lsa.lsSequenceNumber >>> 0).toString(16)}`);
    }
  }
  if (!any) lines.push('(no ASBR-summary LSAs)');
  return lines.join('\n');
}

function showIpOspfDatabaseSelfOriginate(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not enabled.';
  const cfg = ospf.getConfig();
  const lines = [`OSPF Router with ID (${cfg.routerId}) (Process ID ${cfg.processId})`, ''];
  let any = false;
  for (const [areaId, areaDB] of ospf.getLSDB().areas) {
    const self = [...areaDB.values()].filter(l => l.advertisingRouter === cfg.routerId);
    if (self.length === 0) continue;
    any = true;
    lines.push(`  Area ${areaId} self-originated LSAs`);
    for (const lsa of self) {
      lines.push(`    Type-${lsa.lsType} LS-ID ${lsa.linkStateId} Age ${lsa.lsAge} Seq 0x${(lsa.lsSequenceNumber >>> 0).toString(16)}`);
    }
  }
  if (!any) lines.push('(no self-originated LSAs)');
  return lines.join('\n');
}

function bestRoutesPerPrefix(routes: any[]): any[] {
  const protoAd: Record<string, number> = {
    connected: 0, static: 1, eigrp: 90, ospf: 110, rip: 120, bgp: 20, default: 1,
  };
  const best = new Map<string, any>();
  const order: string[] = [];
  for (const r of routes) {
    const key = `${r.network?.toString?.() ?? r.network}/${r.mask?.toString?.() ?? r.mask}`;
    const ad = r.ad ?? protoAd[r.type] ?? 255;
    const existing = best.get(key);
    if (!existing) { best.set(key, r); order.push(key); continue; }
    const existingAd = existing.ad ?? protoAd[existing.type] ?? 255;
    if (ad < existingAd) { best.set(key, r); continue; }
    if (ad === existingAd && (r.metric ?? 0) < (existing.metric ?? 0)) { best.set(key, r); }
  }
  return order.map(k => best.get(k));
}

function showIpRouteAll(router: Router): string {
  router._ospfAutoConverge();
  router.convergeDynamicRouting();
  const rt = bestRoutesPerPrefix((router as any).routingTable as any[]);
  const lines: string[] = ['Codes: C - connected, S - static, R - RIP, O - OSPF, O IA - OSPF inter area',
    '       O E1 - OSPF external type 1, O E2 - OSPF external type 2, D - EIGRP, B - BGP',
    ''];
  for (const r of rt) {
    const netStr = r.network.toString();
    const cidr = maskToCIDR(r.mask.toString());
    const nh = r.nextHop ? `via ${r.nextHop}` : 'directly connected';
    if (r.type === 'connected') {
      lines.push(`C    ${netStr}/${cidr} is directly connected, ${r.iface}`);
    } else if (r.type === 'static' || r.type === 'default') {
      const code = netStr === '0.0.0.0' && cidr === 0 ? 'S*' : 'S';
      lines.push(`${code}    ${netStr}/${cidr} [${r.ad ?? 1}/${r.metric ?? 0}] ${nh}`);
    } else if (r.type === 'rip') {
      lines.push(`R    ${netStr}/${cidr} [${r.ad ?? 120}/${r.metric ?? 1}] ${nh}, ${r.iface}`);
    } else if (r.type === 'eigrp') {
      lines.push(`D    ${netStr}/${cidr} [${r.ad ?? 90}/${r.metric ?? 0}] ${nh}, ${r.iface}`);
    } else if (r.type === 'bgp') {
      lines.push(`B    ${netStr}/${cidr} [${r.ad ?? 20}/${r.metric ?? 0}] ${nh}, ${r.iface}`);
    } else if (r.type === 'ospf') {
      const code = getOSPFRouteCode(router, netStr, cidr, r);
      lines.push(`${code} ${netStr}/${cidr} [110/${r.metric}] ${nh}, ${r.iface}`);
    }
  }
  return lines.join('\n');
}

function showIpRouteOspf(router: Router): string {
  router._ospfAutoConverge();
  const rt = (router as any).routingTable as any[];
  const lines: string[] = [];
  for (const r of rt) {
    if (r.type === 'ospf') {
      const netStr = r.network.toString();
      const cidr = maskToCIDR(r.mask.toString());
      const code = getOSPFRouteCode(router, netStr, cidr, r);
      lines.push(`${code} ${netStr}/${cidr} [110/${r.metric}] via ${r.nextHop || 'directly connected'}, ${r.iface}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '';
}

function showIpRouteSummary(router: Router): string {
  router._ospfAutoConverge();
  const rt = (router as any).routingTable as any[];
  const counts: Record<string, { networks: number; subnets: number; replicates: number; overhead: number; memory: number }> = {};
  const order = ['connected', 'static', 'ospf', 'eigrp', 'bgp', 'rip', 'default'];
  for (const k of order) counts[k] = { networks: 0, subnets: 0, replicates: 0, overhead: 0, memory: 0 };
  for (const r of rt) {
    const t = r.type ?? 'connected';
    if (!counts[t]) counts[t] = { networks: 0, subnets: 0, replicates: 0, overhead: 0, memory: 0 };
    counts[t].subnets++;
    counts[t].networks++;
    counts[t].overhead += 152;
    counts[t].memory += 360;
  }
  const lines = [
    'IP routing table name is Default-IP-Routing-Table(0)',
    'IP routing table maximum-paths is 32',
    'Route Source    Networks    Subnets     Replicates  Overhead    Memory (bytes)',
  ];
  let totN = 0, totS = 0, totR = 0, totO = 0, totM = 0;
  for (const k of order) {
    const c = counts[k];
    lines.push(`${k.padEnd(16)}${String(c.networks).padEnd(12)}${String(c.subnets).padEnd(12)}${String(c.replicates).padEnd(12)}${String(c.overhead).padEnd(12)}${c.memory}`);
    totN += c.networks; totS += c.subnets; totR += c.replicates; totO += c.overhead; totM += c.memory;
  }
  lines.push(`${'Total'.padEnd(16)}${String(totN).padEnd(12)}${String(totS).padEnd(12)}${String(totR).padEnd(12)}${String(totO).padEnd(12)}${totM}`);
  return lines.join('\n');
}

function showIpRouteSpecific(router: Router, destIP: string): string {
  // Trigger convergence before looking up routes
  router._ospfAutoConverge();
  const rt = (router as any).routingTable as any[];
  // Find the best matching route
  let best: any = null;
  let bestLen = -1;
  for (const r of rt) {
    const netStr = r.network.toString();
    const maskStr = r.mask.toString();
    const cidr = maskToCIDR(maskStr);
    // Check if destIP matches this route
    if (ipInSubnet(destIP, netStr, maskStr) && cidr > bestLen) {
      best = r;
      bestLen = cidr;
    }
  }
  if (!best) return `% Network not in table`;

  const cidr = maskToCIDR(best.mask.toString());
  const netStr = best.network.toString();

  if (best.type === 'ospf') {
    const metric = best.metric || 0;
    const nh = best.nextHop ? `via ${best.nextHop}` : `directly connected`;
    // Determine route code
    const code = getOSPFRouteCode(router, netStr, cidr, best);
    const routeDisplay = cidr === 32 ? netStr : `${netStr}/${cidr}`;
    return `Routing entry for ${netStr}/${cidr}\n  Known via "ospf ${getOSPFProcessId(router)}", distance 110, metric ${metric}, type ${code}\n  Last update from ${nh}\n${code} ${routeDisplay} [110/${metric}] ${nh}, ${best.iface}`;
  } else if (best.type === 'connected') {
    return `Routing entry for ${netStr}/${cidr}\n  Known via "connected", distance 0, metric 0\n  Directly connected, ${best.iface}\nConnected via ${best.iface}`;
  } else if (best.type === 'static') {
    return `Routing entry for ${netStr}/${cidr}\n  Known via "static", distance 1, metric 0\nS ${netStr}/${cidr} via ${best.nextHop}`;
  } else if (best.type === 'default') {
    return `Routing entry for ${netStr}/${cidr}\n  Known via "static", distance 1, metric 0\nS* ${netStr}/${cidr} via ${best.nextHop}`;
  }
  return `% Network not in table`;
}

function getOSPFRouteCode(router: Router, net: string, cidr: number, routeEntry?: any): string {
  const extra = router._getOSPFExtraConfig();
  const isDefault = net === '0.0.0.0' && cidr === 0;

  // Check if route has metadata from advanced route computation
  if (routeEntry?._metricType || routeEntry?._isDefault || routeEntry?.routeType || routeEntry?._isStubDefault) {
    // Stub area default route
    if (routeEntry._isStubDefault && isDefault) return 'O*IA';
    const mt = routeEntry._metricType ?? 2;
    if (isDefault && (routeEntry._metricType || routeEntry.routeType?.includes('external'))) {
      return mt === 1 ? 'O*E1' : 'O*E2';
    }
    if (routeEntry.routeType === 'type1-external') return 'O E1';
    if (routeEntry.routeType === 'type2-external') return 'O E2';
    if (isDefault && routeEntry.routeType === 'inter-area') return 'O*IA';
    if (routeEntry.routeType === 'inter-area') return 'O IA';
  }

  if (isDefault) {
    const mt = extra.defaultInfoMetricType ?? 2;
    return mt === 1 ? 'O*E1' : 'O*E2';
  }

  if (extra.redistributeStatic) {
    const mt = extra.redistributeStatic.metricType;
    if (mt === 1) return 'O E1';
    return 'O E2';
  }
  return 'O';
}

function getOSPFProcessId(router: Router): number {
  return router._getOSPFEngineInternal()?.getProcessId() ?? 1;
}

// OSPFv3 show commands

function showIpv6Ospf(router: Router, processId?: number): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return '% OSPFv3 is not configured';
  // If process ID specified and doesn't match, still show (for multi-process sim)
  const pid = processId ?? v3.getProcessId();
  const extra = router._getOSPFExtraConfig();
  const lines = [
    `Routing Process "ospfv3 ${pid}" with ID ${v3.getRouterId()}`,
    ` Number of areas: ${v3.getConfig().areas.size}`,
  ];
  if (extra.gracefulRestart?.enabled) {
    lines.push(` Graceful restart enabled, grace period ${extra.gracefulRestart.gracePeriod}`);
  }
  return lines.join('\n');
}

function showIpv6OspfNeighbor(router: Router): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return '% OSPFv3 is not configured';
  router._ospfAutoConverge();
  const neighbors = v3.getNeighbors();
  const lines = ['Neighbor ID     Pri   State           Dead Time   Interface'];
  for (const n of neighbors) {
    lines.push(`${n.routerId.padEnd(16)}${String(n.priority).padEnd(6)}FULL/ -         ${n.iface}`);
  }
  return lines.join('\n');
}

function showIpv6OspfInterface(router: Router, ifName?: string): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return '% OSPFv3 is not configured';
  router._ospfAutoConverge();
  const extra = router._getOSPFExtraConfig();
  const lines: string[] = [];
  const resolvedIfName = ifName ? resolveOSPFIfName(ifName) : undefined;
  for (const [name, iface] of v3.getInterfaces()) {
    if (resolvedIfName && name !== resolvedIfName) continue;
    const ntStr = iface.networkType === 'point-to-point' ? 'Point-to-point' : 'Broadcast';
    lines.push(`${name} is up, line protocol is up`);
    lines.push(`  Network Type ${ntStr}, Cost: ${iface.cost}, Priority: ${iface.priority}`);
    // For DR/BDR display, resolve router-id to IPv6 address of the neighbor
    const drAddr = resolveV3DRBDR(router, iface, iface.dr);
    const bdrAddr = resolveV3DRBDR(router, iface, iface.bdr);
    lines.push(`  DR: ${drAddr}`);
    lines.push(`  BDR: ${bdrAddr}`);
    // Check IPsec auth
    const v3Pending = extra.pendingV3IfConfig?.get(name);
    if (v3Pending?.ipsecAuth) lines.push(`  IPsec authentication enabled`);
    if (extra.bfdAllInterfaces) lines.push(`  BFD enabled`);
    lines.push('');
  }
  return lines.join('\n');
}

function resolveV3DRBDR(router: Router, iface: any, rid: string): string {
  if (!rid || rid === '0.0.0.0') return '0.0.0.0';
  // If the DR is ourselves, return our port's IPv6 address
  const v3 = router._getOSPFv3EngineInternal();
  if (v3 && rid === v3.getRouterId()) {
    const port = router.getPort(iface.name);
    if (port) {
      const addrs = port.getIPv6Addresses?.();
      const global = addrs?.find((a: any) => a.origin !== 'link-local');
      if (global) return global.address.toString();
    }
    return rid;
  }
  // Check neighbors for the router-id
  for (const [, n] of iface.neighbors) {
    if (n.routerId === rid) return n.ipAddress || rid;
  }
  return rid;
}

function showIpv6OspfDatabase(router: Router): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return '% OSPFv3 is not configured';
  const lines = [
    `            OSPFv3 Router with ID (${v3.getRouterId()}) (Process ID ${v3.getProcessId()})`,
    '',
    '                Router Link States (Area 0)',
    '',
    '                Net Link States (Area 0)',
    '',
    '                Link (Type-8) Link States (Area 0)',
    '',
    '                Intra Area Prefix Link States (Area 0)',
    '',
  ];
  return lines.join('\n');
}

function showIpv6Route(router: Router): string {
  router._ospfAutoConverge();
  const rt = router._getIPv6RoutingTableInternal() as any[] || [];
  const lines: string[] = ['IPv6 Routing Table'];
  for (const r of rt) {
    let code = r.type === 'connected' ? 'C' : r.type === 'static' ? 'S' : 'O';
    if (r.type === 'ospf') {
      if (r.routeType === 'type2-external') code = 'OE2';
      else if (r.routeType === 'type1-external') code = 'OE1';
      else if (r.routeType === 'inter-area') code = 'OI';
      else if (r._isDefault && r._isStubDefault) code = 'OI';
    }
    const prefix = r.prefix?.toString?.() || r.network?.toString?.() || '::';
    const prefLen = r.prefixLength ?? 64;
    const nh = r.nextHop ? `, via ${r.nextHop}` : '';
    const iface = r.iface ? `, ${r.iface}` : '';
    lines.push(`${code}  ${prefix}/${prefLen} [${r.ad || 0}/${r.metric || 0}]${nh}${iface}`);
  }
  return lines.join('\n');
}

function showIpv6RouteSpecific(router: Router, dest: string): string {
  router._ospfAutoConverge();
  const rt = router._getIPv6RoutingTableInternal() as any[] || [];

  // Parse destination: either "prefix/length" or just "prefix"
  let searchPrefix = dest;
  let searchPrefixLen: number | undefined;
  if (dest.includes('/')) {
    const parts = dest.split('/');
    searchPrefix = parts[0];
    searchPrefixLen = parseInt(parts[1]);
  }

  // Find matching route
  let best: any = null;
  for (const r of rt) {
    const prefix = r.prefix?.toString?.() || r.network?.toString?.() || '::';
    const prefLen = r.prefixLength ?? 64;
    if (searchPrefixLen !== undefined) {
      if (prefix === searchPrefix && prefLen === searchPrefixLen) {
        best = r;
        break;
      }
    } else {
      // Match by prefix only
      if (prefix === searchPrefix) {
        best = r;
        break;
      }
    }
  }

  if (!best) return `% Route to ${dest}`;

  const prefix = best.prefix?.toString?.() || '::';
  const prefLen = best.prefixLength ?? 64;
  const code = best.type === 'connected' ? 'C' :
    best.type === 'ospf' ? (best.routeType === 'type2-external' ? 'OE2' :
      best.routeType === 'type1-external' ? 'OE1' :
      best.routeType === 'inter-area' ? 'OI' : 'O') :
    best.type === 'static' ? 'S' : 'C';
  const ad = best.ad ?? 0;
  const metric = best.metric ?? 0;

  if (best.type === 'connected') {
    return `Connected via ${best.iface}`;
  }

  const nh = best.nextHop ? `via ${best.nextHop}` : 'directly connected';
  return `${code}  ${prefix}/${prefLen} [${ad}/${metric}]\n  ${nh}, ${best.iface}`;
}

// ─── Utility ─────────────────────────────────────────────────────────

function countFullNeighbors(iface: any): number {
  let count = 0;
  for (const [, n] of iface.neighbors) {
    if (n.state === 'Full') count++;
  }
  return count;
}

function maskToCIDR(mask: string): number {
  return new SubnetMask(mask).toCIDR();
}

function ipInSubnet(ip: string, network: string, mask: string): boolean {
  return inSameSubnet(ip, network, mask);
}
