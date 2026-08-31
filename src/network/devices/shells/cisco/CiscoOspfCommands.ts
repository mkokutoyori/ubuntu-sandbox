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
import { normalizeOspfRouteType, ospfRouteCode } from '@/network/ospf/routeCodes';
import { renderIpRouteTable, routerRouteTableHost } from './CiscoShowCommands';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import { CISCO_ERRORS } from '../cli-utils';
import { inSameSubnet, isValidIPv4 } from '../../../core/ip';
import { CommandTrie } from '../CommandTrie';
import { EIGRP_EXTERNAL_AD } from '../../../eigrp/EIGRPEngine';
import { IPAddress, SubnetMask } from '../../../core/types';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { iosShortInterfaceName, iosInterfaceStatus }
  from '@/network/devices/inspection/InterfaceStatusView';

/**
 * The backbone, however it was spelled. IOS accepts an area id as a
 * decimal or in dotted-quad form, so `area 0`, `area 0.0.0.0` and
 * `area 00` all name the same area — a check on the literal text would
 * be defeated by the second spelling.
 */
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { AdapterKeyword } from '@/cli/commands/trieAdapter';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { MODES_INTERFACE } from './CiscoConfigCommands';

export function setOspfv3InterfaceParams(
  router: Router, ifName: string, updates: Record<string, unknown>,
): void {
  const extra = router._getOSPFExtraConfig();
  const pending = extra.pendingV3IfConfig.get(ifName) || {};
  Object.assign(pending, updates);
  extra.pendingV3IfConfig.set(ifName, pending);

  const engine = router._getOSPFv3EngineInternal();
  const iface = engine?.getInterface(ifName);
  if (!iface) return;

  const live = iface as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key in live) live[key] = value;
  }
}

export function enableOspfv3OnInterface(
  router: Router, ifName: string, processId: number, areaId: string,
): void {
  if (!router._getOSPFv3EngineInternal()) router._enableOSPFv3(processId);
  const engine = router._getOSPFv3EngineInternal();
  if (!engine) return;

  const port = router._getPortsInternal().get(ifName);
  if (!port) return;

  const globalAddr = port.getIPv6Addresses().find(a => a.origin !== 'link-local');
  const pending = router._getOSPFExtraConfig().pendingV3IfConfig.get(ifName);
  if (engine.getInterface(ifName)) return;

  engine.activateInterface(ifName, areaId, {
    ipAddress: globalAddr ? globalAddr.address.toString() : '::',
    cost: pending?.cost,
    priority: pending?.priority,
    networkType: pending?.networkType as never,
    helloInterval: pending?.helloInterval,
    deadInterval: pending?.deadInterval,
  });
}

export function disableOspfv3OnInterface(router: Router, ifName: string): void {
  router._getOSPFv3EngineInternal()?.deactivateInterface(ifName);
  router._getOSPFExtraConfig().pendingV3IfConfig.delete(ifName);
}

export function setOspfv3InterfaceAuthentication(
  router: Router, ifName: string, protege: boolean,
): void {
  const extra = router._getOSPFExtraConfig();
  const pending = extra.pendingV3IfConfig.get(ifName) || {};
  pending.ipsecAuth = protege;
  extra.pendingV3IfConfig.set(ifName, pending);
}

function isBackboneArea(areaId: string): boolean {
  const t = areaId.trim();
  if (/^\d+$/.test(t)) return Number(t) === 0;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t.split('.').every((o) => Number(o) === 0);
  return false;
}

// ─── Config Mode: "router ospf <id>" ─────────────────────────────────

export function registerOSPFConfigCommands(configTrie: CommandTrie, ctx: CiscoShellContext): void {
  configTrie.registerGreedy('router ospf', 'Enter OSPF routing protocol configuration', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const processId = parseInt(args[0], 10);
    if (isNaN(processId) || processId < 1 || processId > 65535) {
      return '% Invalid OSPF process ID';
    }
    const router = ctx.r();
    const running = router._getOSPFEngineInternal();
    if (running && running.getConfig().processId !== processId) {
      return `% OSPF process ${running.getConfig().processId} is already running,`
        + ' only one OSPF process is supported on this platform';
    }
    if (args.length > 1) {
      if (args[1].toLowerCase() === 'vrf') {
        return '% VRF-aware OSPF is not supported on this platform';
      }
      throw new CliInvalidInput();
    }
    if (!running) router._enableOSPF(processId);
    ctx.setMode('config-router-ospf');
    return '';
  });

  configTrie.registerGreedy('no router ospf', 'Disable OSPF routing protocol', (_args) => {
    ctx.r()._disableOSPF();
    return '';
  });

  // IPv6 OSPF router configuration mode
  configTrie.registerGreedy('ipv6 router eigrp', 'Configure EIGRP for IPv6', (args) => {
    if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
    const asn = parseInt(args[0], 10);
    if (Number.isNaN(asn) || asn < 1 || asn > 65535) throw new CliInvalidInput();
    const r = ctx.r() as unknown as {
      _ipv6EigrpProcesses?: Set<number>;
      _recordUnhandledConfigLine?: (l: string) => void;
    };
    (r._ipv6EigrpProcesses ??= new Set()).add(asn);
    ctx.setMode('config-router');
    ctx.setSelectedRoutingProto({ proto: 'eigrp', asn });
    return '';
  });

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

  // `ip classless` et `ip subnet-zero` sont le comportement PAR DEFAUT
  // depuis IOS 12.0 : un vrai routeur les accepte et ne fait rien, et ne
  // les rend pas dans sa configuration puisqu'elles ne s'en ecartent
  // pas. Les refuser cassait le rejeu d'une configuration ancienne, ou
  // elles figurent presque toujours. Accepter sans effet est ici la
  // fidelite meme — a la difference d'une commande qui, sur le materiel,
  // ferait quelque chose.
  for (const mot of ['ip classless', 'no ip classless',
    'ip subnet-zero', 'no ip subnet-zero']) {
    configTrie.register(mot, 'Accepted, default behaviour on IOS 12.0 and later', () => '');
  }
}

// ─── Config-Router Mode: OSPF sub-commands ───────────────────────────

export function buildConfigRouterOSPFCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  const extra = () => ctx.r()._getOSPFExtraConfig() as unknown as Record<string, unknown> & {
    maximumPaths?: number; defaultMetric?: number; compatibleRfc1583?: boolean;
    logAdjacencyChanges?: boolean; logAdjacencyChangesDetail?: boolean;
    distance?: { intraArea?: number; interArea?: number; external?: number };
    timersThrottleLsa?: { startMs: number; holdMs: number; maxMs: number };
    timersLsaArrivalMs?: number;
    timersPacingFloodMs?: number; timersPacingRetransmissionMs?: number;
    ispf?: boolean; prefixSuppression?: boolean; shutdown?: boolean;
    segmentRoutingMpls?: boolean; discardRouteExternal?: boolean;
  };

  trie.registerGreedy('maximum-paths', 'Forward equal-cost paths', (args) => {
    const n = parseInt(args[0], 10);
    if (isNaN(n) || n < 1) return '';
    extra().maximumPaths = n;
    ctx.r().setMaximumPaths('ospf', n);
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

function adresseReseau(ip: string, wildcard: string): string {
  const o = ip.split('.').map(Number);
  const w = wildcard.split('.').map(Number);
  if (o.length !== 4 || w.length !== 4 || [...o, ...w].some(n => !Number.isFinite(n))) return ip;
  return o.map((v, i) => v & (~w[i] & 255)).join('.');
}


  trie.registerGreedy('network', 'Define OSPF network/area', (args) => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not configured';

    // Syntax: network <ip> <wildcard> area <area-id>
    if (args.length < 4) return '% Incomplete command.';
    const network = args[0];
    const wildcard = args[1];
    if (!'area'.startsWith(args[2].toLowerCase())) return '% Invalid input. Expected "area" keyword.';
    const areaId = args[3];

    ospf.addNetwork(adresseReseau(network, wildcard), wildcard, areaId);
    ctx.r()._ospfAutoConverge();
    return '';
  });

  trie.registerGreedy('router-id', 'Set OSPF Router ID', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!isValidIPv4(args[0])) return "% Invalid input detected at '^' marker.";
    ctx.r().getOspfIntegration().routerIdManuel = true;
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not configured';
    ospf.setRouterId(args[0]);
    return '';
  });

  trie.registerGreedy('passive-interface', 'Suppress routing updates on an interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not configured';

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
    if (!ospf) return '% OSPF is not configured';
    const ifName = ctx.resolveInterfaceName(args.join(' '));
    if (!ifName) return `% Invalid interface "${args.join(' ')}"`;
    ospf.removePassiveInterface(ifName);
    return '';
  });

  trie.registerGreedy('area', 'OSPF area parameters', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not configured';

    const areaId = args[0];
    const subCmd = args[1].toLowerCase();

    if (subCmd === 'stub' || subCmd === 'nssa') {
      // Area 0 carries the inter-area LSAs a stub/NSSA area exists to
      // suppress, so the backbone can be neither (RFC 2328 §3.6). IOS
      // refuses in these exact words rather than storing a contradiction.
      if (isBackboneArea(areaId)) {
        return `% OSPF: Area 0 is the backbone area and cannot be a ${
          subCmd === 'stub' ? 'stub' : 'NSSA'} area.`;
      }
    }
    if (subCmd === 'stub') {
      ospf.setAreaType(areaId, args[2]?.toLowerCase() === 'no-summary' ? 'totally-stubby' : 'stub');
      return '';
    } else if (subCmd === 'nssa') {
      ospf.setAreaType(areaId, 'nssa');
      return '';
    } else if (subCmd === 'range') {
      // area <id> range <network> <mask> [not-advertise]
      if (args.length < 4) return '% Incomplete command.';
      const extra = ctx.r()._getOSPFExtraConfig();
      if (!extra.areaRanges.has(areaId)) extra.areaRanges.set(areaId, []);
      extra.areaRanges.get(areaId)!.push({ network: args[2], mask: args[3] });
      const advertise = !args.some(a => a.toLowerCase() === 'not-advertise');
      ospf.addAreaRange(areaId, args[2], args[3], advertise);
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
    if (!ospf) return '% OSPF is not configured';
    const bw = parseInt(args[1], 10);
    if (isNaN(bw) || bw < 1) return '% Invalid bandwidth value';
    ospf.setReferenceBandwidth(bw);
    return `% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.`;
  });

  trie.registerGreedy('default-information originate', 'Distribute default route', (args) => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not configured';
    ospf.setDefaultInformationOriginate(true);
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.defaultInfoAlways = args.some(a => a.toLowerCase() === 'always');
    // Check for metric-type argument
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === 'metric-type') {
        extra.defaultInfoMetricType = parseInt(args[i + 1], 10);
      }
    }
    if (extra.defaultInfoMetricType === undefined) extra.defaultInfoMetricType = 2;
    ctx.r()._ospfAutoConverge?.();
    return '';
  });

  trie.registerGreedy('redistribute', 'Redistribute routes from another routing protocol', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    const protocol = args[0].toLowerCase();
    const knownProtocols = ['connected', 'static', 'rip', 'eigrp', 'bgp', 'isis', 'ospf'];
    if (!knownProtocols.includes(protocol)) return "% Invalid input detected at '^' marker.";
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
    } else if (protocol === 'rip') {
      const subnets = args.some(a => a.toLowerCase() === 'subnets');
      let metricType = 2;
      let metric: number | undefined;
      for (let i = 0; i < args.length - 1; i++) {
        const tk = args[i].toLowerCase();
        if (tk === 'metric-type') metricType = parseInt(args[i + 1], 10);
        else if (tk === 'metric') {
          const m = parseInt(args[i + 1], 10);
          if (!Number.isNaN(m)) metric = m;
        }
      }
      extra.redistributeRip = { subnets, metric, metricType };
    }
    ctx.r()._ospfAutoConverge?.();
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
    else if (protocol === 'rip') extra.redistributeRip = undefined;
    else {
      extra.redistributeStatic = undefined;
      extra.redistributeConnected = undefined;
      extra.redistributeRip = undefined;
    }
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

  // `detail` était refusé faute d'être greedy — le suffixe le plus
  // courant en cours (il fait journaliser CHAQUE transition d'état de
  // l'adjacence, pas seulement l'entrée et la sortie de Full).
  trie.registerGreedy('log-adjacency-changes', 'Log OSPF adjacency changes', (args) => {
    if (args.length > 0 && args[0] !== 'detail') {
      throw new CliInvalidInput();
    }
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.logAdjacencyChanges = true;
    extra.logAdjacencyChangesDetail = args[0] === 'detail';
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
    if (subCmd === 'stub' && isBackboneArea(areaId)) {
      // Same rule as OSPFv2 — the backbone is not a stub area.
      return '% OSPF: Area 0 is the backbone area and cannot be a stub area.';
    }
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

/**
 * Les places d'OSPF sur une interface.
 *
 * Les bornes sont celles de la reference Cisco pour la version que
 * `show version` annonce, verifiees plutot que tirees de memoire :
 * cout 1-65535, priorite 0-255, les quatre minuteurs 1-65535 secondes,
 * identifiant de cle 1-255. Elles sont DECLAREES et non laissees au
 * gestionnaire parce qu'IOS les connait a l'analyse — une valeur hors
 * bornes y recoit le caret, et c'est deja ce que cette machine rend.
 */
const SECONDES_OSPF = (description: string): ArgumentSpec => ({
  name: 'secondes', type: 'INT', description, range: [1, 65535],
});

const OSPF_IF_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'ip ospf bfd': null,
  'ip ospf flood-reduction': null,
  'ip ospf demand-circuit': null,
  'ip ospf mtu-ignore': null,
  'ip ospf cost': {
    name: 'cout', type: 'INT', description: 'Cost of this interface',
    range: [1, 65535],
  },
  'ip ospf priority': {
    name: 'priorite', type: 'INT',
    description: 'Priority in the designated-router election', range: [0, 255],
  },
  'ip ospf hello-interval': SECONDES_OSPF('Interval between hello packets'),
  'ip ospf dead-interval': SECONDES_OSPF(
    'Silence after which a neighbour is declared down'),
  'ip ospf retransmit-interval': SECONDES_OSPF(
    'Interval between retransmissions of an unacknowledged LSA'),
  'ip ospf transmit-delay': SECONDES_OSPF(
    'Time taken to transmit an update on this interface'),
  'ip ospf network': [
    {
      name: 'genre', type: 'ENUM', description: 'Network type of this interface',
      values: [
        { keyword: 'broadcast', description: 'Specify OSPF broadcast multi-access network' },
        { keyword: 'non-broadcast', description: 'Specify OSPF NBMA network' },
        { keyword: 'point-to-multipoint', description: 'Specify OSPF point-to-multipoint network' },
        { keyword: 'point-to-point', description: 'Specify OSPF point-to-point network' },
      ],
    },
    // `point-to-multipoint non-broadcast` est la seule forme a deux
    // mots : la place suivante existe pour elle, et le gestionnaire ne
    // lit que le premier mot.
    { name: 'reste', type: 'REST', optional: true,
      description: 'non-broadcast, for a point-to-multipoint network' },
  ],
  'ip ospf authentication-key': {
    name: 'cle', type: 'REST', literal: 'LINE',
    description: 'The authentication key itself',
  },
  'ip ospf message-digest-key': [
    { name: 'identifiant', type: 'INT', description: 'Key identifier',
      range: [1, 255] },
    { name: 'reste', type: 'REST', description: '`md5` then the key itself' },
  ],
  'ip ospf area': {
    name: 'aire', type: 'REST', description: 'Area this interface belongs to',
    alternatives: [
      { keyword: '<0-4294967295>', description: 'Area number' },
      { keyword: 'A.B.C.D', description: 'Area number in dotted-decimal' },
    ],
  },
  'ip ospf database-filter': {
    name: 'reste', type: 'REST', description: '`all out`',
    alternatives: [{ keyword: 'all', description: 'Filter every outgoing LSA' }],
  },
  'ip ospf': {
    name: 'reste', type: 'REST',
    description: 'Process identifier, then `area <aire>`',
  },
};

export function ospfInterfaceSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      registerOSPFInterfaceCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: MODES_INTERFACE, minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => OSPF_IF_ARGUMENTS[path],
    },
  );
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
        // Le type de réseau passe par le moteur, qui relance la machine
        // à états : l'écrire ici laissait l'interface dans l'état
        // d'avant, minuteurs compris.
        if (updates.networkType !== undefined) {
          ospf.setInterfaceNetworkType(ifName, updates.networkType);
        }
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
    'no ip ospf priority': { priority: 1 },
    'no ip ospf hello-interval': { helloInterval: 10 },
    'no ip ospf dead-interval': { deadInterval: 40 },
    'no ip ospf network': { networkType: 'broadcast' },
    'no ip ospf authentication': { authType: 0 },
    'no ip ospf authentication-key': { authKey: '' },
    'no ip ospf message-digest-key': { authType: 0, authKey: '' },
    'no ip ospf retransmit-interval': { retransmitInterval: 5 },
    'no ip ospf transmit-delay': { transmitDelay: 1 },
    'no ip ospf mtu-ignore': { mtuIgnore: false },
    'no ip ospf demand-circuit': { demandCircuit: false },
    'no ip ospf bfd': { bfd: false },
    'no ip ospf flood-reduction': { floodReduction: false },
    'no ip ospf database-filter': { databaseFilterAllOut: false },
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

  configIfTrie.registerGreedy('no ip ospf cost', 'Restore the bandwidth-derived OSPF cost', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    const pending = ctx.r()._getOSPFExtraConfig().pendingIfConfig.get(ifName);
    if (pending) delete (pending as Record<string, unknown>).cost;
    ctx.r()._getOSPFEngineInternal()?.resetInterfaceCost(ifName);
    ctx.r()._ospfAutoConverge?.();
    return '';
  });

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
    if (sub === 'interval' && args[1]) pending.bfdInterval = parseInt(args[1], 10);
    else if (sub === 'min_rx' && args[1]) pending.bfdMinRx = parseInt(args[1], 10);
    else if (sub === 'multiplier' && args[1]) pending.bfdMultiplier = parseInt(args[1], 10);
    else if (sub === 'template' && args[1]) pending.bfdTemplate = args[1];
    else if (sub === 'echo') pending.bfdEcho = true;
    else (pending as any).bfd = args.join(' ');
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });

  configIfTrie.registerGreedy('no bfd echo', 'Disable BFD echo on interface', () => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const pending = ctx.r()._getOSPFExtraConfig().pendingIfConfig.get(ifName);
    if (pending) delete pending.bfdEcho;
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
      // Static NBMA binding only — real Cisco NHRP doesn't consider a peer
      // "up" just because a static map was typed; that requires an actual
      // Registration/Resolution Reply (see NhrpEngine).
      svc.addMapping(ifName, args[1], args[2], { static: true });
    }
    else if (sub === 'nhs' && args[1]) {
      svc.addNhsServer(ifName, args[1]);
      // Real RFC 2332 §5.2.3 registration: send a Registration Request to
      // the configured NHS now (over IP protocol 54, via NhrpEngine) rather
      // than fabricating a DMVPN session directly. The tunnel interface
      // itself carries no cable — `tunnel source` names the real,
      // NBMA-cabled physical interface the packet must actually go out.
      // The NHS marks the spoke's binding "up" only once the real reply lands.
      const ports = ctx.r()._getPortsInternal();
      const tunnelIp = ports.get(ifName)?.getIPAddress()?.toString();
      const physicalIfName = (ctx.r()._getOSPFExtraConfig().pendingIfConfig.get(ifName) as { tunnelSource?: string } | undefined)?.tunnelSource;
      if (tunnelIp && physicalIfName && ports.has(physicalIfName)) {
        ctx.r().getNhrpEngine().sendRegistrationRequest(physicalIfName, ifName, tunnelIp, args[1]);
      }
    }
    else if (sub === 'shortcut') svc.configure(ifName, { shortcut: true });
    else if (sub === 'redirect') svc.configure(ifName, { redirect: true });
    return '';
  });
}

// ─── Show Commands ───────────────────────────────────────────────────


const OSPF_INT = (
  name: string, min: number, max: number, description: string,
): ArgumentSpec => ({ name, type: 'INT', range: [min, max], description });

const ROUTER_OSPF_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  network: [
    { name: 'reseau', type: 'IP_ADDR', description: 'Network number' },
    { name: 'masque', type: 'IP_ADDR', optional: true, description: 'OSPF wild card bits' },
  ],
  'summary-address': [
    { name: 'adresse', type: 'IP_ADDR', description: 'Summary address' },
    { name: 'masque', type: 'SUBNET_MASK', description: 'Summary mask' },
  ],
  'router-id': { name: 'id', type: 'IP_ADDR', description: 'OSPF router-id in IP address format' },
  'default-metric': OSPF_INT('metrique', 1, 16777214, 'Default metric of redistributed routes'),
  'maximum-paths': OSPF_INT('chemins', 1, 32, 'Number of equal-cost paths installed'),
  'max-lsa': OSPF_INT('lsas', 1, 4294967294, 'Maximum number of non self-generated LSAs'),
  'passive-interface': { name: 'interface', type: 'INTERFACE', optional: true, description: 'Interface on which updates are suppressed' },
  redistribute: [{
    name: 'protocole', type: 'ENUM', description: 'Source protocol to redistribute',
    values: [
      { keyword: 'bgp', description: 'Border Gateway Protocol (BGP)' },
      { keyword: 'connected', description: 'Connected' },
      { keyword: 'eigrp', description: 'Enhanced Interior Gateway Routing Protocol (EIGRP)' },
      { keyword: 'rip', description: 'Routing Information Protocol (RIP)' },
      { keyword: 'static', description: 'Static routes' },
    ],
  }, { name: 'options', type: 'REST', optional: true, values: [], description: '' }],
  'distribute-list': [{
    name: 'filtre', type: 'WORD', description: 'Filter to apply',
    alternatives: [
      { keyword: '<1-199>', description: 'IP access list number' },
      { keyword: 'gateway', description: 'Filtering incoming updates based on gateway' },
      { keyword: 'prefix', description: 'Filter prefixes in routing updates' },
    ],
  }, { name: 'options', type: 'REST', optional: true, values: [], description: '' }],
  shutdown: null,
  ispf: null,
  'prefix-suppression': null,
};

const ROUTER_OSPF_KEYWORDS:
Readonly<Record<string, ReadonlyArray<{
  keyword: string; description: string; afterArguments?: boolean;
  argument?: ArgumentSpec | null;
}>>> = {
  network: [{
    keyword: 'area', description: 'Set the OSPF area ID', afterArguments: true,
    argument: { name: 'aire', type: 'WORD', literal: '<0-4294967295>', description: 'OSPF area ID' },
  }],
  'passive-interface': [{ keyword: 'default', description: 'Suppress routing updates on all interfaces', argument: null }],
  'auto-cost': [{ keyword: 'reference-bandwidth', description: 'Reference bandwidth for cost calculation' }],
  bfd: [{ keyword: 'all-interfaces', description: 'Enable BFD on all interfaces' }],
  capability: [
    { keyword: 'opaque', description: 'Opaque LSA' },
    { keyword: 'transit', description: 'Transit area capability' },
  ],
  compatible: [{ keyword: 'rfc1583', description: 'RFC 1583 compatible route selection' }],
  'default-information originate': [{ keyword: 'metric-type', description: 'OSPF metric type for default routes' }],
  'discard-route': [{ keyword: 'external', description: 'Discard route for external summary' }],
  distance: [
    { keyword: 'external', description: 'External type 5 and type 7 routes' },
    { keyword: 'inter-area', description: 'Inter-area routes' },
    { keyword: 'intra-area', description: 'Intra-area routes' },
    { keyword: 'ospf', description: 'OSPF distance' },
  ],
  'graceful-restart': [{ keyword: 'grace-period', description: 'Grace period in seconds' }],
  'log-adjacency-changes': [{ keyword: 'detail', description: 'Detailed output' }],
  'max-metric router-lsa': [{ keyword: 'on-startup', description: 'Set maximum metric temporarily after reboot' }],
  neighbor: [
    { keyword: 'poll-interval', description: 'OSPF dead-neighbor polling interval' },
    { keyword: 'priority', description: 'OSPF priority of non-broadcast neighbor' },
  ],
  'segment-routing': [{ keyword: 'mpls', description: 'Segment Routing global block' }],
  area: [
    { keyword: 'authentication', description: 'Authentication configuration' },
    { keyword: 'default-cost', description: 'Cost of the default summary route' },
    { keyword: 'filter-list', description: 'Filter prefixes' },
    { keyword: 'message-digest', description: 'MD5 authentication' },
    { keyword: 'no-summary', description: 'Do not send summary LSAs into the area' },
    { keyword: 'nssa-only', description: 'Limit the route to the NSSA area' },
    { keyword: 'range', description: 'Range of values' },
    { keyword: 'sham-link', description: 'OSPF sham link' },
    { keyword: 'stub', description: 'Stub area' },
    { keyword: 'virtual-link', description: 'OSPF virtual link' },
  ],
};

export function routerOspfSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildConfigRouterOSPFCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-router-ospf'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => ROUTER_OSPF_ARGUMENTS[path],
      keywordsFor: (path) => ROUTER_OSPF_KEYWORDS[path],
    },
  );
}

const ROUTER_OSPFV3_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'router-id': { name: 'id', type: 'IP_ADDR', description: 'OSPFv3 router-id in IP address format' },
  'passive-interface': { name: 'interface', type: 'INTERFACE', optional: true, description: 'Interface on which updates are suppressed' },
  area: { name: 'aire', type: 'WORD', literal: '<0-4294967295>', description: 'OSPFv3 area number' },
  redistribute: [{
    name: 'protocole', type: 'ENUM', description: 'Source protocol to redistribute',
    values: [{ keyword: 'static', description: 'Static routes' }],
  }, { name: 'options', type: 'REST', optional: true, values: [], description: '' }],
  'distribute-list': [{
    name: 'genre', type: 'ENUM', description: 'Filter to apply',
    values: [{ keyword: 'prefix-list', description: 'Filter prefixes in routing updates' }],
  }, {
    name: 'nom', type: 'WORD', description: 'Name of an IPv6 prefix list',
  }, {
    name: 'sens', type: 'ENUM', description: 'Direction to filter',
    values: [
      { keyword: 'in', description: 'Filter incoming routing updates' },
      { keyword: 'out', description: 'Filter outgoing routing updates' },
    ],
  }],
  'default-information originate': null,
  'graceful-restart': null,
  bfd: null,
};

const ROUTER_OSPFV3_KEYWORDS:
Readonly<Record<string, ReadonlyArray<AdapterKeyword>>> = {
  'passive-interface': [{ keyword: 'default', description: 'Suppress routing updates on all interfaces', argument: null }],
  'default-information originate': [{ keyword: 'always', description: 'Always advertise the default route', argument: null }],
  'graceful-restart': [{
    keyword: 'grace-period', description: 'Maximum time before the restart completes',
    argument: OSPF_INT('secondes', 1, 1800, 'Grace period in seconds'),
  }],
  bfd: [{ keyword: 'all-interfaces', description: 'Enable BFD on all interfaces', argument: null }],
  area: [
    {
      keyword: 'range', description: 'Summarize routes matching an address/mask',
      afterArguments: true,
      argument: { name: 'prefixe', type: 'WORD', literal: 'X:X:X:X::X/<0-128>', description: 'IPv6 prefix' },
    },
    { keyword: 'stub', description: 'Stub area', afterArguments: true, argument: null },
    {
      keyword: 'virtual-link', description: 'OSPFv3 virtual link',
      afterArguments: true,
      argument: { name: 'voisin', type: 'IP_ADDR', description: 'Router ID of the virtual link neighbor' },
    },
  ],
};

export function routerOspfv3Specs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildConfigRouterOSPFv3Commands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-router-ospfv3'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => ROUTER_OSPFV3_ARGUMENTS[path],
      keywordsFor: (path) => ROUTER_OSPFV3_KEYWORDS[path],
    },
  );
}

export function registerOSPFShowCommands(trie: CommandTrie, getRouter: () => Router): void {
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
    if (!ospf) return '% OSPF is not configured';
    const last = args[args.length - 1]?.toLowerCase();
    if (last === 'counters') ospf.resetPacketStats();
    else if (last === 'redistribution') router._ospfAutoConverge();
    else if (last === 'process' || last === 'force-spf' || args.length === 0) {
      ospf.clearEventLog();
      if (last === 'process') router.getOspfIntegration().reelireRouterId();
      router._ospfAutoConverge();
    }
    return '';
  });
  const OSPF_DEBUG: ReadonlyArray<readonly [string, string]> = [
    ['adj', 'ip.ospf.adj'],
    ['events', 'ip.ospf.events'],
    ['spf', 'ip.ospf.spf'],
    ['hello', 'ip.ospf.hello'],
    ['packet', 'ip.ospf.packet'],
    ['lsa-generation', 'ip.ospf.lsa-generation'],
  ];
  const ospfDebugCategory = (args: string[]): string | null => {
    const flag = args.join(' ').toLowerCase();
    if (!flag) return 'ip.ospf.adj';
    for (const [mot, cat] of OSPF_DEBUG) if (mot.startsWith(flag)) return cat;
    return null;
  };
  trie.registerGreedy('debug ip ospf', 'Enable OSPF debugging', (args) => {
    const cat = ospfDebugCategory(args);
    if (!cat) throw new CliInvalidInput({ token: args[0] });
    const ospf = getRouter()._getOSPFEngineInternal();
    if (ospf) ospf.logAdjacencyChanges = true;
    return getRouter().getDebugService().enable(cat as never);
  });
  trie.registerGreedy('no debug ip ospf', 'Disable OSPF debugging', (args) => {
    const cat = ospfDebugCategory(args);
    if (!cat) throw new CliInvalidInput({ token: args[0] });
    const ospf = getRouter()._getOSPFEngineInternal();
    if (ospf) ospf.logAdjacencyChanges = false;
    return getRouter().getDebugService().disable(cat as never);
  });

  trie.registerGreedy('show ip ospf', 'Display OSPF information', (args) => {
    if (args.length === 0) return showIpOspf(getRouter());
    const pidParsed = parseInt(args[0], 10);
    // Un process-id explicite qui ne correspond à aucun processus : IOS
    // ne répond rien. Montrer le processus VOISIN, comme avant, laisse
    // croire que celui qu'on a nommé existe.
    if (!isNaN(pidParsed) && !ospfProcessExists(getRouter(), pidParsed)) return '';
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
    throw new CliInvalidInput({ token: subArgs[0] });
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
  trie.registerGreedy('show ipv6 eigrp neighbors', 'Display EIGRP for IPv6 neighbours', () => {
    const r = getRouter() as unknown as { _ipv6EigrpProcesses?: Set<number> };
    const procs = [...(r._ipv6EigrpProcesses ?? [])];
    if (procs.length === 0) return '';
    return procs
      .map((asn) => `EIGRP-IPv6 Neighbors for AS(${asn})\n`
        + 'H   Address                 Interface        Hold Uptime   SRTT   RTO  Q  Seq\n'
        + '                                            (sec)          (ms)       Cnt Num')
      .join('\n');
  });

  trie.registerGreedy('show ipv6 protocols', 'Display IPv6 routing protocols', () => {
    const router = getRouter();
    const lines: string[] = [];
    const v3 = router._getOSPFv3EngineInternal();
    if (v3) {
      lines.push(`IPv6 Routing Protocol is "ospf ${v3.getProcessId()}"`);
      const ifaces = [...v3.getInterfaces().keys()];
      lines.push('  Interfaces (Area)');
      for (const name of ifaces) lines.push(`    ${name}`);
      lines.push('  Redistribution:');
      lines.push('    None');
    }
    const r = router as unknown as { _ipv6EigrpProcesses?: Set<number>; _ipv6EigrpIfaces?: Map<number, Set<string>> };
    for (const asn of r._ipv6EigrpProcesses ?? []) {
      lines.push(`IPv6 Routing Protocol is "eigrp ${asn}"`);
      lines.push('  Interfaces:');
      for (const i of r._ipv6EigrpIfaces?.get(asn) ?? []) lines.push(`    ${i}`);
      lines.push('  Redistribution:');
      lines.push('    None');
    }
    lines.unshift('IPv6 Routing Protocol is "connected"');
    if ((router._getIPv6RoutingTableInternal() as unknown as unknown[] ?? [])
      .some((e) => (e as { type?: string }).type === 'static')) {
      lines.push('IPv6 Routing Protocol is "static"');
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ipv6 route', 'Display IPv6 routing table', (args) => {
    if (args.length > 0) {
      // Même règle qu'en IPv4 : un nom de protocole filtre la table, il
      // ne désigne pas un préfixe. `show ipv6 route static` répondait
      // `% Route to static`, en cherchant une destination nommée
      // « static ».
      // `summary` is not a destination either — it counts the table by
      // source. It answered `% Route to summary`, hunting for a prefix
      // by that name.
      if ('summary'.startsWith(args[0].toLowerCase())) {
        return showIpv6RouteSummary(getRouter());
      }
      const codes = ROUTE_FILTER_CODES[args[0].toLowerCase()];
      if (codes) return filterRouteTableByCode(showIpv6Route(getRouter()), codes);
      return showIpv6RouteSpecific(getRouter(), args[0]);
    }
    return showIpv6Route(getRouter());
  });
}

// ─── Show Command Implementations ───────────────────────────────────

/**
 * `show ip ospf <process-id>` pour un processus qui n'existe pas. IOS ne
 * répond rien plutôt que de montrer un AUTRE processus : la sortie
 * précédente affichait `Routing Process "ospf 1"` en réponse à une
 * question sur le 99, ce qui donne à croire que le 99 existe.
 */
function ospfProcessExists(router: Router, processId: number): boolean {
  const ospf = router._getOSPFEngineInternal();
  return !!ospf && ospf.getProcessId() === processId;
}

function showIpOspf(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';

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

export function showIpOspfNeighbor(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';

  // Trigger convergence to ensure neighbors are up-to-date
  router._ospfAutoConverge();

  const neighbors = ospf.getNeighbors();
  const lines = [
    'Neighbor ID     Pri   State           Dead Time   Address         Interface',
  ];

  for (const n of neighbors) {
    const iface = ospf.getInterface(n.iface);
    if (!iface || iface.state === 'Down') continue;
    const stateStr = `${n.state.toUpperCase()}/  -`;
    const deadTime = compteARebours(iface, n.lastHelloReceived);

    lines.push(
      `${n.routerId.padEnd(16)}${String(n.priority).padEnd(6)}` +
      `${stateStr.padEnd(16)}${deadTime.padEnd(12)}` +
      `${n.ipAddress.padEnd(16)}${n.iface}`
    );
  }

  return lines.join('\n');
}

function compteARebours(iface: { deadInterval?: number } | undefined, lastHelloMs: number): string {
  const dead = iface?.deadInterval ?? 40;
  const ecoule = Math.max(0, Date.now() - lastHelloMs) / 1000;
  const restant = Math.max(0, Math.min(dead, Math.floor(dead - ecoule)));
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(Math.floor(restant / 3600))}:${pad(Math.floor((restant % 3600) / 60))}:${pad(restant % 60)}`;
}

function showIpOspfDatabaseSummaryCounts(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';
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
  if (!ospf) return '';

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
  if (!ospf) return '';

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


/**
 * The interface's operational state, read from the one place every other
 * view reads it. `show ip ospf interface` used to print a hardcoded
 * `is up, line protocol is up`, so the same interface at the same instant
 * read up/up here and down/down in `show ip interface brief`,
 * `show interfaces` and `show ip igmp interface`. A view that answers
 * from its own imagination is worse than a missing view: it is the one an
 * operator believes.
 */
function ospfIfaceStatusLine(router: Router, name: string): string {
  const ports = router._getPortsInternal();
  const port = ports.get(name);
  if (!port) return `${name} is up, line protocol is up`;   // virtual, no bearer
  const st = iosInterfaceStatus(port, name, ports);
  return `${name} is ${st.status}, line protocol is ${st.protocol}`;
}

/** True when the bearer is genuinely usable — no DR on a dead link. */
function ospfIfaceOperUp(router: Router, name: string): boolean {
  const ports = router._getPortsInternal();
  const port = ports.get(name);
  if (!port) return true;
  return iosInterfaceStatus(port, name, ports).protocol === 'up';
}

function showIpOspfInterface(router: Router, ifName?: string): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';

  // Trigger convergence
  router._ospfAutoConverge();

  const extra = router._getOSPFExtraConfig();
  const lines: string[] = [];
  const ifaces = ospf.getInterfaces();
  const resolvedIfName = ifName ? resolveOSPFIfName(ifName) : undefined;
  if (resolvedIfName !== undefined) {
    if (!router._getPortsInternal().has(resolvedIfName)) {
      throw new CliInvalidInput({ token: ifName });
    }
    if (!ifaces.has(resolvedIfName)) return `%OSPF: OSPF not enabled on ${resolvedIfName}`;
  }

  for (const [name, iface] of ifaces) {
    if (resolvedIfName && name !== resolvedIfName) continue;

    const operUp = ospfIfaceOperUp(router, name);
    lines.push(ospfIfaceStatusLine(router, name));
    lines.push(`  Internet address is ${iface.ipAddress}/${maskToCIDR(iface.mask)}, Area ${iface.areaId}`);
    lines.push(`  Process ID ${ospf.getProcessId()}, Router ID ${ospf.getRouterId()}, Network Type ${iface.networkType.toUpperCase()}, Cost: ${iface.cost}`);
    // Une interface de bouclage s'arrête là : elle n'a ni délai de
    // transmission, ni DR, ni minuteurs, ni voisins, et IOS n'en écrit
    // aucun. Les afficher revenait à décrire une élection qui n'a pas
    // lieu — la vue annonçait `State DR` pour une interface seule.
    if (iface.networkType === 'loopback') {
      lines.push(`  Loopback interface is treated as a stub Host`);
      lines.push('');
      continue;
    }
    // A dead link elects nobody: IOS reports State DOWN there, never DR.
    lines.push(`  Transmit Delay is ${iface.transmitDelay} sec, State ${operUp ? iface.state : 'DOWN'}, Priority ${iface.priority}`);
    lines.push(`  DR: ${operUp ? iface.dr : '0.0.0.0'}`);
    lines.push(`  BDR: ${operUp ? iface.bdr : '0.0.0.0'}`);
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
  if (!ospf) return '';

  router._ospfAutoConverge();

  // La colonne `Interface` fait douze caractères, ce qui n'entre que si
  // le nom est abrégé comme IOS l'abrège — `Gi0/0`. En entier,
  // `GigabitEthernet0/0` débordait et décalait toute la ligne.
  const lines: string[] = [
    'Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C',
  ];

  const pid = ospf.getProcessId();
  const rendu = (name: string, area: string, ipMask: string, cost: number,
    state: string, total: number, full: number) => {
    lines.push(
      `${iosShortInterfaceName(name).padEnd(13)}${String(pid).padEnd(6)}${area.padEnd(16)}`
      + `${ipMask.padEnd(19)}${String(cost).padEnd(6)}${state.padEnd(6)}${total}/${full}`
    );
  };

  for (const [name, iface] of ospf.getInterfaces()) {
    rendu(name, iface.areaId, `${iface.ipAddress}/${maskToCIDR(iface.mask)}`, iface.cost,
      ospfIfStateAbbr(ospfIfaceOperUp(router, name) ? iface.state : 'Down'),
      iface.neighbors.size, countFullNeighbors(iface));
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
  if (!ospf) return '';

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
  if (!ospf) return '';

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
  if (!ospf) return '';

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
  if (!ospf) return '';

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
  if (!ospf) return '';

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
  if (!ospf) return '';

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
  if (!ospf) return '';

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
  if (!ospf) return '';
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
  if (!ospf) return '';
  const log = ospf.getEventLog();
  if (log.length === 0) return 'OSPF Router with ID (' + ospf.getConfig().routerId + ') (Process ID ' + ospf.getConfig().processId + ')\n\n  No events logged';
  return ['OSPF Router with ID (' + ospf.getConfig().routerId + ') (Process ID ' + ospf.getConfig().processId + ')', '', ...log].join('\n');
}

function showIpOspfTimers(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';
  const extra = router._getOSPFExtraConfig() as unknown as Record<string, unknown> & {
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
  if (!ospf) return '';
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
  if (!ospf) return '';
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
  if (!ospf) return '';
  const lines: string[] = ['Interface              Area'];
  for (const iface of ospf.getInterfaces().values()) {
    lines.push(`${iface.name.padEnd(23)}${iface.areaId}`);
  }
  lines.push('(no LSAs in flood list — flooding is synchronous in this implementation)');
  return lines.join('\n');
}

function showIpOspfMaxMetric(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';
  const extra = router._getOSPFExtraConfig();
  const mm = extra.maxMetric;
  const header = `OSPF Router with ID (${ospf.getConfig().routerId}) (Process ID ${ospf.getConfig().processId})`;
  if (!mm?.enabled) return `${header}\n  Originating router-LSAs with maximum metric: not configured`;
  const start = mm.onStartup !== undefined ? `${mm.onStartup} seconds on startup` : 'permanent';
  return `${header}\n  Originating router-LSAs with maximum metric (${start})`;
}

function showIpOspfRib(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';
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
  if (!ospf) return '';
  const extra = router._getOSPFExtraConfig();
  const summaries = extra.summaryAddresses ?? [];
  const header = `OSPF Router with ID (${ospf.getConfig().routerId}) (Process ID ${ospf.getConfig().processId}), Summary-address`;
  if (summaries.length === 0) return `${header}\n  (no summary-address configured)`;
  return [header, ...summaries.map(s => `  ${s.network} ${s.mask}`)].join('\n');
}

function showIpOspfSegmentRouting(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';
  const extra = router._getOSPFExtraConfig() as unknown as Record<string, unknown> & { segmentRoutingMpls?: boolean };
  if (!extra.segmentRoutingMpls) return 'OSPF Segment Routing is not enabled';
  return `OSPF Router with ID (${ospf.getConfig().routerId})\n  Segment Routing MPLS: enabled\n  SRGB: 16000 - 23999`;
}

function showIpOspfDatabaseNssaExternal(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '';
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
  if (!ospf) return '';
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
  if (!ospf) return '';
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

export function bestRoutesPerPrefix(routes: any[]): any[] {
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


/**
 * `show ip route <protocole>` — la table complète, filtrée sur les codes
 * du protocole demandé.
 *
 * Trois défauts tenaient dans l'ancienne écriture. Elle ne gardait que
 * les lignes commençant par `Codes`, donc la légende ressortait tronquée
 * à sa première ligne, suivie de lignes vides. Elle ne connaissait que
 * `connected` et `static`, si bien que `local`, `eigrp` ou `rip`
 * tombaient sur `showIpRouteSpecific` et répondaient
 * `% Network not in table` — le message qui dit qu'un PRÉFIXE est absent,
 * là où la bonne réponse à « aucune route de ce protocole » est une table
 * vide. Et elle jetait les en-têtes `is subnetted` qui structurent la
 * sortie d'IOS.
 */
export const ROUTE_FILTER_CODES: Readonly<Record<string, readonly string[]>> = {
  connected: ['C'],
  local: ['L'],
  static: ['S'],
  rip: ['R'],
  eigrp: ['D'],
  bgp: ['B'],
  isis: ['i'],
};

export function filterRouteTableByCode(all: string, codes: readonly string[]): string {
  const lines = all.split('\n');
  // L'en-tête va jusqu'à la passerelle de dernier recours incluse.
  const gw = lines.findIndex((l) => l.startsWith('Gateway of last resort'));
  const headEnd = gw >= 0 ? gw + 1 : lines.findIndex((l) => l.trim() === '');
  const head = lines.slice(0, Math.max(headEnd, 0) + 1);
  const body = lines.slice(Math.max(headEnd, 0) + 1);

  const matches = (l: string): boolean => {
    const code = l.trimStart().split(/\s/)[0];
    return codes.some((c) => code === c || code.startsWith(c));
  };
  const out: string[] = [];
  let pendingSubnetHeader: string | null = null;
  let kept = false;
  for (const l of body) {
    if (l.trim() === '') continue;
    if (/is subnetted|is variably subnetted/.test(l)) {
      pendingSubnetHeader = l; kept = false; continue;
    }
    if (!matches(l)) {
      // Une route inutilisable tient sur deux lignes chez IOS ; la
      // seconde appartient à la première et se garde avec elle.
      if (kept && /^\s{6,}/.test(l)) out.push(l);
      else kept = false;
      continue;
    }
    if (pendingSubnetHeader) { out.push(pendingSubnetHeader); pendingSubnetHeader = null; }
    out.push(l);
    kept = true;
  }
  return [...head, ...out].join('\n');
}

function showIpRouteAll(router: Router): string {
  router._ospfAutoConverge();
  router.convergeDynamicRouting();
  const rt = bestRoutesPerPrefix(
    ((router as any).routingTable as any[]).filter((r) => router.isRouteUsable(r)),
  );
  // Un seul rendu pour toute la table : voir `renderIpRouteTable`.
  return renderIpRouteTable(routerRouteTableHost(router), rt as any, (route) => {
    const r = route as any;
    if (r.type !== 'ospf') return null;
    return getOSPFRouteCode(router, r.network.toString(), maskToCIDR(r.mask.toString()), r);
  });
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
  const perPrefix = new Map<string, any>();
  for (const r of router.installedRoutes() as any[]) {
    const key = `${r.network}/${r.mask.toCIDR()}`;
    if (!perPrefix.has(key)) perPrefix.set(key, r);
  }
  const rt = [...perPrefix.values()];
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
  // 4 est la valeur par défaut d'IOS ; 32 est le MAXIMUM configurable,
  // pas ce que la table applique. Aucun `maximum-paths` de RIB n'existe
  // ici (le réglage est par protocole), donc la constante est celle
  // d'un routeur non configuré — et le dire vaut mieux que lire un
  // accesseur que personne n'implémente.
  const lines = [
    'IP routing table name is Default-IP-Routing-Table(0)',
    'IP routing table maximum-paths is 4',
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

function showIpRouteVrf(router: Router, vrfName: string): string {
  const r = router as unknown as { _vrfs?: Map<string, unknown>; _ciscoVrfRoutes?: Map<string, Array<{ network: string; mask: string; nextHop: string | null; iface: string | null }>> };
  if (!r._vrfs || !r._vrfs.has(vrfName)) return `% No such VRF, ${vrfName}`;
  const routes = r._ciscoVrfRoutes?.get(vrfName) ?? [];
  const codes = [
    'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
    '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
    '       * - candidate default, U - per-user static route, o - ODR',
    '',
    `Routing Table: ${vrfName}`,
    '',
  ];
  if (routes.length === 0) {
    codes.push(`Routes: 0 in VRF ${vrfName}`);
    return codes.join('\n');
  }
  const lines: string[] = [];
  for (const entry of routes) {
    const cidr = maskToCIDR(entry.mask);
    const via = entry.nextHop ? `via ${entry.nextHop}` : entry.iface ? `directly connected, ${entry.iface}` : '';
    lines.push(`S       ${entry.network}/${cidr} [1/0] ${via}`);
  }
  return [...codes, ...lines].join('\n');
}

function formatRouteAge(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  if (total >= 86400) {
    const days = Math.floor(total / 86400);
    return `${days}d${String(Math.floor((total % 86400) / 3600)).padStart(2, '0')}h`;
  }
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
}

const DEFAULT_DISTANCE: Record<string, number> = {
  connected: 0, static: 1, default: 1, eigrp: 90, ospf: 110, rip: 120, bgp: 20,
};

const OSPF_ROUTE_TYPE_NAME: Record<string, string> = {
  'O': 'intra area', 'O IA': 'inter area',
  'O E1': 'extern 1', 'O E2': 'extern 2',
  'O N1': 'NSSA extern 1', 'O N2': 'NSSA extern 2',
};

/**
 * Le detail d'une route, rendu depuis la TABLE et non depuis la machine.
 *
 * Les deux plateformes repondent a `show ip route <prefixe>`, et un
 * Catalyst ne repondait rien : il rendait la table entiere, en ignorant
 * le prefixe. Ce qui reste PROPRE au routeur — nommer le processus OSPF,
 * le numero d'AS d'EIGRP, le type d'une route externe — passe par des
 * crochets facultatifs, parce qu'un commutateur ne produit aucune route
 * de ces types-la.
 */
export interface RouteDetailHooks {
  readonly sourceName?: (route: { type: string }) => string | null;
  readonly typeSuffix?: (route: { type: string }, distance: number) => string | null;
}

export function renderRouteEntryDetail(
  table: readonly any[], destIP: string, hooks: RouteDetailHooks = {},
): string {
  let bestLen = -1;
  for (const r of table) {
    const cidr = maskToCIDR(r.mask.toString());
    if (ipInSubnet(destIP, r.network.toString(), r.mask.toString()) && cidr > bestLen) {
      bestLen = cidr;
    }
  }
  if (bestLen < 0) return '% Network not in table';

  const candidates = table.filter((r) => maskToCIDR(r.mask.toString()) === bestLen
    && ipInSubnet(destIP, r.network.toString(), r.mask.toString()));

  const distanceOf = (r: any) => r.ad ?? DEFAULT_DISTANCE[r.type] ?? 1;
  const bestDistance = Math.min(...candidates.map(distanceOf));
  const preferred = candidates.filter((r) => distanceOf(r) === bestDistance);
  const bestMetric = Math.min(...preferred.map((r) => r.metric ?? 0));
  const paths = preferred.filter((r) => (r.metric ?? 0) === bestMetric);
  const best = paths[0];

  const netStr = best.network.toString();
  const cidr = maskToCIDR(best.mask.toString());
  const source = hooks.sourceName?.(best)
    ?? (best.type === 'default' ? 'static' : best.type);

  const lines = [`Routing entry for ${netStr}/${cidr}`];
  let header = `  Known via "${source}", distance ${bestDistance}, metric ${bestMetric}`;
  const suffix = hooks.typeSuffix?.(best, bestDistance);
  if (suffix) header += suffix;
  else if (best.type === 'connected') header += ' (connected, via interface)';
  lines.push(header);

  if (best.nextHop && best.type !== 'connected') {
    const age = best.installedAt !== undefined
      ? ` , ${formatRouteAge(Date.now() - best.installedAt)} ago`.replace(' ,', ',')
      : '';
    lines.push(`  Last update from ${best.nextHop} on ${best.iface}${age}`);
  }

  lines.push('  Routing Descriptor Blocks:');
  for (const [i, path] of paths.entries()) {
    const marker = i === 0 ? '  *' : '   ';
    const target = path.nextHop
      ? `${path.nextHop}${path.iface ? `, via ${path.iface}` : ''}`
      : `directly connected, via ${path.iface}`;
    lines.push(`${marker} ${target}`);
    lines.push(`      Route metric is ${path.metric ?? 0}, traffic share count is 1`);
  }

  return lines.join('\n');
}

function showIpRouteSpecific(router: Router, destIP: string): string {
  router._ospfAutoConverge();
  const rt = ((router as any).routingTable as any[]).filter((r) => router.isRouteUsable(r));
  const eigrpAsn = router.getEIGRPEngine?.()?.getConfig().asn;

  return renderRouteEntryDetail(rt, destIP, {
    sourceName: (route) => {
      if (route.type === 'ospf') return `ospf ${getOSPFProcessId(router)}`;
      if (route.type === 'eigrp' && eigrpAsn) return `eigrp ${eigrpAsn}`;
      return null;
    },
    typeSuffix: (route, distance) => {
      if (route.type === 'ospf') {
        const best = route as any;
        const code = getOSPFRouteCode(
          router, best.network.toString(), maskToCIDR(best.mask.toString()), best,
        ).replace('*', ' ').trim();
        return `, type ${OSPF_ROUTE_TYPE_NAME[code] ?? 'intra area'}`;
      }
      if (route.type === 'eigrp') {
        return `, type ${distance === EIGRP_EXTERNAL_AD ? 'external' : 'internal'}`;
      }
      return null;
    },
  });
}

function getOSPFRouteCode(router: Router, net: string, cidr: number, routeEntry?: any): string {
  const extra = router._getOSPFExtraConfig();
  const isDefault = net === '0.0.0.0' && cidr === 0;

  // Check if route has metadata from advanced route computation
  if (routeEntry?._metricType || routeEntry?._isDefault || routeEntry?.routeType || routeEntry?._isStubDefault) {
    // Stub area default route
    if (routeEntry._isStubDefault && isDefault) return 'O*IA';
    // Real OSPFEngine routes (routeType 'external-type1'/'external-type2', from
    // processExternalRoutes()) don't carry a separate `_metricType` field — the
    // type is baked into routeType itself.
    const isType1External = routeEntry.routeType === 'type1-external' || routeEntry.routeType === 'external-type1';
    const mt = routeEntry._metricType ?? (isType1External ? 1 : 2);
    if (isDefault && (routeEntry._metricType || routeEntry.routeType?.includes('external'))) {
      return mt === 1 ? 'O*E1' : 'O*E2';
    }
    const shared = normalizeOspfRouteType(routeEntry.routeType);
    if (shared && shared !== 'intra-area') return ospfRouteCode(shared, isDefault);
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
    lines.push(ospfIfaceStatusLine(router, name));
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

/**
 * `show ipv6 route summary` — how many prefixes each source contributes.
 * Every number is COUNTED on the live table; nothing here is a constant.
 */
function showIpv6RouteSummary(router: Router): string {
  router._ospfAutoConverge();
  const rt = (router._getIPv6RoutingTableInternal() as Array<{ type?: string }>) || [];
  const parSource = new Map<string, number>();
  for (const r of rt) {
    const source = r.type === 'default' ? 'static' : (r.type ?? 'connected');
    parSource.set(source, (parSource.get(source) ?? 0) + 1);
  }
  const lines = [
    `IPv6 routing table name is Default-IPv6-Routing-Table(0)`,
    `IPv6 routing table maximum-paths is 4`,
    `Route Source    Networks    Overhead    Memory (bytes)`,
  ];
  let total = 0;
  for (const source of ['connected', 'local', 'static', 'ospf', 'rip', 'bgp', 'eigrp']) {
    const n = parSource.get(source) ?? 0;
    if (n === 0 && source !== 'connected' && source !== 'local' && source !== 'static') continue;
    total += n;
    // IOS bills 88 bytes of overhead and 44 of table per IPv6 route.
    lines.push(`${source.padEnd(16)}${String(n).padEnd(12)}${String(n * 88).padEnd(12)}${n * 44}`);
  }
  lines.push(`Total           ${String(total).padEnd(12)}${String(total * 88).padEnd(12)}${total * 44}`);
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

export function ospfShowSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerOSPFShowCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      restDescription: 'Filter',
      restDescriptionFor: (path) => ({
        'show ip ospf': 'Process ID number',
        'show ip ospf interface': 'Interface name',
        'show ip ospf neighbor': 'Neighbor ID',
        'show ip ospf database router': 'Link-state ID, or detail',
        'show ip ospf database network': 'Link-state ID, or detail',
        'show ip ospf database summary': 'Link-state ID, or detail',
        'show ip ospf database external': 'Link-state ID',
      })[path],
      skip: (path) => !path.startsWith('show ip ospf'),
      keywordsFor: (path) => /^show ip ospf database (router|network|summary)$/.test(path)
        ? [{ keyword: 'detail', description: 'Detailed LSA output' }]
        : undefined,
    },
  );
}

export function ospfIpv6ShowSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerOSPFShowCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      restDescriptionFor: (path) => ({
        'show ipv6 ospf': 'Process ID number',
        'show ipv6 route': 'Prefix or protocol',
      })[path],
      restLiteralFor: (path) => path === 'show ipv6 ospf' ? '<1-65535>' : undefined,
      keywordsFor: (path) => ({
        'show ipv6 ospf': [
          { keyword: 'database', description: 'Database contents' },
          { keyword: 'interface', description: 'Interface configuration' },
          { keyword: 'neighbor', description: 'Neighbor information' },
        ],
        'show ipv6 route': [{ keyword: 'summary', description: 'Summary' }],
      })[path],
      skip: (path) => !path.startsWith('show ipv6 '),
    },
  );
}

export function ospfClearSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerOSPFShowCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['privileged'], minPrivilege: 15,
      restDescription: 'Process ID number',
      skip: (path) => !path.startsWith('clear ip ospf'),
      keywordsFor: (path) => path === 'clear ip ospf'
        ? [
          { keyword: 'process', description: 'Reset OSPF process' },
          { keyword: 'counters', description: 'Reset OSPF counters' },
          { keyword: 'force-spf', description: 'Force SPF recalculation' },
          { keyword: 'redistribution', description: 'Refresh redistributed routes' },
        ]
        : undefined,
    },
  );
}

/**
 * Ce que `show ip route` rend sur un ROUTEUR, une fois la commande
 * declaree sur le socle.
 *
 * Les trois mots `repair-paths`, `track-table` et `profile` sont des
 * VUES d'IOS et non des prefixes : repondre `% Network not in table`
 * envoyait chercher une adresse que personne n'avait demandee.
 */
export function routerIpRouteView(router: Router, args: readonly string[]): string {
  if (args.length === 0) return showIpRouteAll(router);
  const first = args[0].toLowerCase();
  if (first === 'vrf') {
    if (!args[1]) return '% Incomplete command.';
    return showIpRouteVrf(router, args[1]);
  }
  if (first === 'ospf') return showIpRouteOspf(router);
  if (first === 'summary') return showIpRouteSummary(router);
  const codes = ROUTE_FILTER_CODES[first];
  if (codes) return filterRouteTableByCode(showIpRouteAll(router), codes);
  if (first === 'repair-paths' || first === 'track-table' || first === 'profile') {
    return showIpRouteAll(router);
  }
  return showIpRouteSpecific(router, args[0]);
}
