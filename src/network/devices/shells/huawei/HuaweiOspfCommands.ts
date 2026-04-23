/**
 * HuaweiOspfCommands - OSPF CLI commands for Huawei VRP Shell
 *
 * Handles:
 *   - System view: "ospf <process-id>", "undo ospf", "ospfv3 <process-id>"
 *   - OSPF view: "area", "router-id", "silent-interface", "import-route", "filter-policy",
 *                "spf-schedule-interval", "graceful-restart", "log-peer-change", "stub-router",
 *                "lsa-originate-count", "peer"
 *   - Area view: "network", "stub", "nssa", "abr-summary", "vlink-peer"
 *   - Interface view: "ospf cost", "ospf dr-priority", "ospf timer hello/dead",
 *                     "ospf network-type", "ospf authentication-mode", "ospfv3 <id> area <area>"
 *   - Display commands: "display ospf peer [verbose]", "display ospf lsdb [router|network|summary|external]",
 *                       "display ospf brief", "display ospf interface [brief]",
 *                       "display ospf vlink", "display ospf abr-asbr", "display ospf statistics",
 *                       "display ip routing-table protocol ospf",
 *                       "display ospfv3 peer", "display ospfv3 lsdb", "display ospfv3 interface"
 */

import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
// ─── Types for Huawei Shell Context ──────────────────────────────────

export type HuaweiOSPFShellMode = 'ospf' | 'ospf-area' | 'ospfv3';

export interface HuaweiOSPFShellContext {
  r(): Router;
  setMode(mode: string): void;
  getMode(): string;
  getSelectedInterface(): string | null;
}

// ─── System View Commands ────────────────────────────────────────────

export function registerOSPFSystemCommands(
  systemTrie: CommandTrie,
  ctx: HuaweiOSPFShellContext,
  setOSPFArea: (area: string | null) => void,
): void {
  systemTrie.registerGreedy('ospf', 'Configure OSPF protocol', (args) => {
    const processId = args.length >= 1 ? parseInt(args[0], 10) : 1;
    if (isNaN(processId) || processId < 1 || processId > 65535) {
      return 'Error: Invalid OSPF process ID.';
    }
    const router = ctx.r();
    if (!router._getOSPFEngineInternal()) {
      router._enableOSPF(processId);
    }
    ctx.setMode('ospf');
    return '';
  });

  systemTrie.registerGreedy('undo ospf', 'Remove OSPF protocol configuration', (args) => {
    ctx.r()._disableOSPF();
    return '';
  });

  // OSPFv3 system view commands
  systemTrie.registerGreedy('ospfv3', 'Configure OSPFv3 protocol', (args) => {
    const processId = args.length >= 1 ? parseInt(args[0], 10) : 1;
    if (isNaN(processId) || processId < 1 || processId > 65535) {
      return 'Error: Invalid OSPFv3 process ID.';
    }
    const router = ctx.r();
    if (!router._getOSPFv3EngineInternal()) {
      router._enableOSPFv3(processId);
    }
    ctx.setMode('ospfv3');
    return '';
  });

  systemTrie.registerGreedy('undo ospfv3', 'Remove OSPFv3 protocol configuration', (_args) => {
    // OSPFv3 disable not available in Router base, but we can set it up
    return '';
  });
}

// ─── OSPF View Commands ──────────────────────────────────────────────

export function buildOSPFViewCommands(
  trie: CommandTrie,
  ctx: HuaweiOSPFShellContext,
  setOSPFArea: (area: string | null) => void,
): void {
  trie.registerGreedy('router-id', 'Set OSPF router ID', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    ospf.setRouterId(args[0]);
    return '';
  });

  trie.registerGreedy('area', 'Configure OSPF area', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    setOSPFArea(args[0]);
    ctx.setMode('ospf-area');
    return '';
  });

  trie.registerGreedy('silent-interface', 'Set interface as silent (passive)', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    ospf.setPassiveInterface(args.join(' '));
    return '';
  });

  trie.registerGreedy('undo silent-interface', 'Remove silent interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    ospf.removePassiveInterface(args.join(' '));
    return '';
  });

  trie.register('default-route-advertise', 'Advertise default route', () => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    ospf.setDefaultInformationOriginate(true);
    return '';
  });

  trie.registerGreedy('bandwidth-reference', 'Set reference bandwidth for cost calculation', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    const bw = parseInt(args[0], 10);
    if (isNaN(bw) || bw < 1) return 'Error: Invalid bandwidth value.';
    ospf.setReferenceBandwidth(bw);
    return '';
  });

  trie.registerGreedy('import-route', 'Redistribute routes from another protocol', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    const protocol = args[0].toLowerCase();
    if (protocol === 'static') {
      let metricType = 2;
      for (let i = 1; i < args.length - 1; i++) {
        if (args[i].toLowerCase() === 'type') metricType = parseInt(args[i + 1], 10);
      }
      extra.redistributeStatic = { subnets: true, metricType };
    } else if (protocol === 'direct' || protocol === 'connected') {
      extra.redistributeConnected = { subnets: true };
    }
    return '';
  });

  trie.registerGreedy('filter-policy', 'Filter routes in routing updates', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    const direction = args[1].toLowerCase() as 'in' | 'out';
    extra.distributeList = { aclId: args[0], direction: direction === 'export' ? 'out' : direction === 'import' ? 'in' : direction };
    return '';
  });

  trie.registerGreedy('spf-schedule-interval', 'Set SPF computation throttle timers', (args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    // spf-schedule-interval millisecond <initial> <hold> <max>
    // OR spf-schedule-interval <seconds>
    if (args[0]?.toLowerCase() === 'millisecond' && args.length >= 4) {
      extra.spfThrottle = {
        initial: parseInt(args[1], 10),
        hold: parseInt(args[2], 10),
        max: parseInt(args[3], 10),
      };
    } else if (args.length >= 1) {
      const seconds = parseInt(args[0], 10);
      if (!isNaN(seconds)) {
        extra.spfThrottle = { initial: seconds * 1000, hold: seconds * 1000, max: seconds * 1000 };
      }
    }
    return '';
  });

  trie.registerGreedy('graceful-restart', 'Configure graceful restart', (args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    let gracePeriod = 120;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i].toLowerCase() === 'interval') gracePeriod = parseInt(args[i + 1], 10);
    }
    extra.gracefulRestart = { enabled: true, gracePeriod };
    return '';
  });

  trie.register('log-peer-change', 'Log OSPF adjacency changes', () => {
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.logAdjacencyChanges = true;
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (ospf) ospf.logAdjacencyChanges = true;
    return '';
  });

  trie.registerGreedy('stub-router', 'Configure stub router (max-metric)', (args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    let onStartup: number | undefined;
    if (args[0]?.toLowerCase() === 'on-startup' && args[1]) {
      onStartup = parseInt(args[1], 10);
    }
    extra.maxMetric = { enabled: true, onStartup };
    return '';
  });

  trie.registerGreedy('undo stub-router', 'Remove stub router configuration', (_args) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.maxMetric = { enabled: false };
    return '';
  });

  trie.registerGreedy('lsa-originate-count', 'Set maximum number of LSAs', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.maxLsa = parseInt(args[0], 10);
    return '';
  });

  trie.registerGreedy('peer', 'Configure NBMA neighbor', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ip = args[0];
    const extra = ctx.r()._getOSPFExtraConfig();
    if (!extra.nbmaNeighbors) extra.nbmaNeighbors = [];
    let priority: number | undefined;
    let pollInterval: number | undefined;
    for (let i = 1; i < args.length - 1; i++) {
      if (args[i].toLowerCase() === 'dr-priority') priority = parseInt(args[i + 1], 10);
      if (args[i].toLowerCase() === 'poll-interval') pollInterval = parseInt(args[i + 1], 10);
    }
    const existing = extra.nbmaNeighbors.findIndex(n => n.ip === ip);
    const entry = { ip, priority, pollInterval };
    if (existing >= 0) extra.nbmaNeighbors[existing] = entry;
    else extra.nbmaNeighbors.push(entry);
    return '';
  });
}

// ─── OSPF Area View Commands ─────────────────────────────────────────

export function buildOSPFAreaViewCommands(
  trie: CommandTrie,
  ctx: HuaweiOSPFShellContext,
  getOSPFArea: () => string | null,
): void {
  trie.registerGreedy('network', 'Specify network range in area', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    const areaId = getOSPFArea();
    if (!areaId) return 'Error: Not in area view.';

    const network = args[0];
    const wildcard = args[1];
    ospf.addNetwork(network, wildcard, areaId);
    return '';
  });

  trie.registerGreedy('stub', 'Configure area as stub', (args) => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    const areaId = getOSPFArea();
    if (!areaId) return 'Error: Not in area view.';

    if (args[0]?.toLowerCase() === 'no-summary') {
      ospf.setAreaType(areaId, 'totally-stubby');
    } else {
      ospf.setAreaType(areaId, 'stub');
    }
    return '';
  });

  trie.register('nssa', 'Configure area as NSSA', () => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return 'Error: OSPF is not enabled.';
    const areaId = getOSPFArea();
    if (!areaId) return 'Error: Not in area view.';
    ospf.setAreaType(areaId, 'nssa');
    return '';
  });

  trie.registerGreedy('abr-summary', 'Summarize routes at area boundary', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    const areaId = getOSPFArea();
    if (!areaId) return 'Error: Not in area view.';
    const extra = ctx.r()._getOSPFExtraConfig();
    if (!extra.areaRanges.has(areaId)) extra.areaRanges.set(areaId, []);
    extra.areaRanges.get(areaId)!.push({ network: args[0], mask: args[1] });
    return '';
  });

  trie.registerGreedy('vlink-peer', 'Configure virtual link to ABR', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const areaId = getOSPFArea();
    if (!areaId) return 'Error: Not in area view.';
    const extra = ctx.r()._getOSPFExtraConfig();
    extra.virtualLinks.set(areaId, args[0]);
    return '';
  });
}

// ─── OSPFv3 View Commands ───────────────────────────────────────────

export function buildOSPFv3ViewCommands(
  trie: CommandTrie,
  ctx: HuaweiOSPFShellContext,
): void {
  trie.registerGreedy('router-id', 'Set OSPFv3 router ID', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return 'Error: OSPFv3 is not enabled.';
    v3.setRouterId(args[0]);
    return '';
  });

  trie.registerGreedy('area', 'OSPFv3 area parameters', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return 'Error: OSPFv3 is not enabled.';
    const areaId = args[0];
    const subCmd = args[1].toLowerCase();
    if (subCmd === 'stub') {
      v3.addArea(areaId, 'stub');
      v3.setAreaType(areaId, 'stub');
    }
    return '';
  });

  trie.registerGreedy('default-route-advertise', 'Advertise default route in OSPFv3', (_args) => {
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return 'Error: OSPFv3 is not enabled.';
    v3.setDefaultInformationOriginate(true);
    return '';
  });
}

// ─── OSPF Interface Commands ────────────────────────────────────────

export function registerOSPFInterfaceCommands(
  trie: CommandTrie,
  ctx: HuaweiOSPFShellContext,
): void {
  const setPendingOspfIf = (ifName: string, updates: Record<string, any>) => {
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    Object.assign(pending, updates);
    extra.pendingIfConfig.set(ifName, pending);

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

  trie.registerGreedy('ospf cost', 'Set OSPF cost on interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const cost = parseInt(args[0], 10);
    if (isNaN(cost) || cost < 1 || cost > 65535) return 'Error: Invalid cost value (1-65535).';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { cost });
    return '';
  });

  trie.registerGreedy('ospf dr-priority', 'Set OSPF DR priority on interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const priority = parseInt(args[0], 10);
    if (isNaN(priority) || priority < 0 || priority > 255) return 'Error: Invalid priority value (0-255).';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { priority });
    return '';
  });

  trie.registerGreedy('ospf timer hello', 'Set OSPF hello interval on interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val)) return 'Error: Invalid value.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { helloInterval: val });
    return '';
  });

  trie.registerGreedy('ospf timer dead', 'Set OSPF dead interval on interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val)) return 'Error: Invalid value.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { deadInterval: val });
    return '';
  });

  trie.registerGreedy('ospf network-type', 'Set OSPF network type on interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { networkType: args[0].toLowerCase() });
    return '';
  });

  trie.registerGreedy('ospf authentication-mode', 'Set OSPF authentication on interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    const mode = args[0].toLowerCase();
    if (mode === 'md5') {
      setPendingOspfIf(ifName, { authType: 2 });
      // md5 <key-id> cipher <key>
      if (args.length >= 4) {
        setPendingOspfIf(ifName, { authKey: args[3] });
      }
    } else if (mode === 'simple') {
      setPendingOspfIf(ifName, { authType: 1 });
      if (args.length >= 2) {
        setPendingOspfIf(ifName, { authKey: args[1] });
      }
    }
    return '';
  });

  trie.registerGreedy('ospf retransmit-interval', 'Set OSPF retransmit interval', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 1 || val > 65535) return 'Error: Invalid value (1-65535).';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { retransmitInterval: val });
    return '';
  });

  trie.registerGreedy('ospf transmit-delay', 'Set OSPF transmit delay', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const val = parseInt(args[0], 10);
    if (isNaN(val) || val < 1 || val > 65535) return 'Error: Invalid value (1-65535).';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    setPendingOspfIf(ifName, { transmitDelay: val });
    return '';
  });

  // OSPFv3 interface commands
  trie.registerGreedy('ospfv3', 'Enable OSPFv3 on interface', (args) => {
    // ospfv3 <process-id> area <area-id>
    if (args.length < 3) return 'Error: Incomplete command.';
    const processId = parseInt(args[0], 10);
    if (isNaN(processId)) return 'Error: Invalid process ID.';
    if (args[1].toLowerCase() !== 'area') return 'Error: Expected "area" keyword.';
    const areaId = args[2];
    const router = ctx.r();
    if (!router._getOSPFv3EngineInternal()) {
      router._enableOSPFv3(processId);
    }
    const v3 = router._getOSPFv3EngineInternal()!;
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected.';
    const port = router._getPortsInternal().get(ifName);
    if (port) {
      const ipv6Addrs = port.getIPv6Addresses();
      const globalAddr = ipv6Addrs.find(a => a.scope === 'global');
      const addr = globalAddr ? globalAddr.address.toString() : '::';
      if (!v3.getInterface(ifName)) {
        v3.activateInterface(ifName, areaId, { ipAddress: addr });
      }
    }
    return '';
  });
}

// ─── Display Commands ────────────────────────────────────────────────

export function registerOSPFDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('display ospf brief', 'Display OSPF brief information', () => displayOspfBrief(getRouter()));
  trie.register('display ospf peer', 'Display OSPF neighbor information', () => displayOspfPeer(getRouter()));
  trie.register('display ospf peer verbose', 'Display detailed OSPF neighbor information', () => displayOspfPeerVerbose(getRouter()));
  trie.register('display ospf lsdb', 'Display OSPF link-state database', () => displayOspfLsdb(getRouter()));
  trie.registerGreedy('display ospf lsdb router', 'Display Router LSAs', (_args) => displayOspfLsdbTyped(getRouter(), 1));
  trie.registerGreedy('display ospf lsdb network', 'Display Network LSAs', (_args) => displayOspfLsdbTyped(getRouter(), 2));
  trie.registerGreedy('display ospf lsdb summary', 'Display Summary LSAs', (_args) => displayOspfLsdbTyped(getRouter(), 3));
  trie.registerGreedy('display ospf lsdb ase', 'Display External LSAs', (_args) => displayOspfLsdbTyped(getRouter(), 5));
  trie.register('display ospf interface', 'Display OSPF interface information', () => displayOspfInterface(getRouter()));
  trie.register('display ospf interface brief', 'Display OSPF interface brief', () => displayOspfInterfaceBrief(getRouter()));
  trie.register('display ospf vlink', 'Display OSPF virtual links', () => displayOspfVlink(getRouter()));
  trie.register('display ospf abr-asbr', 'Display OSPF border routers', () => displayOspfAbrAsbr(getRouter()));
  trie.register('display ospf statistics', 'Display OSPF statistics', () => displayOspfStatistics(getRouter()));
  trie.register('display ip routing-table protocol ospf', 'Display OSPF routes', () => displayRoutingTableOspf(getRouter()));

  // OSPFv3 display commands
  trie.register('display ospfv3 peer', 'Display OSPFv3 neighbor information', () => displayOspfv3Peer(getRouter()));
  trie.register('display ospfv3 lsdb', 'Display OSPFv3 link-state database', () => displayOspfv3Lsdb(getRouter()));
  trie.register('display ospfv3 interface', 'Display OSPFv3 interface information', () => displayOspfv3Interface(getRouter()));
}

function displayOspfBrief(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  const config = ospf.getConfig();
  const lines = [
    `OSPF Process ${config.processId} with Router ID ${config.routerId}`,
    '',
    ' Area    Type   Intf    Adj   LSA',
  ];

  for (const [areaId, area] of config.areas) {
    const areaDB = ospf.getAreaLSDB(areaId);
    const lsaCount = areaDB?.size ?? 0;
    const adjCount = ospf.getFullNeighborCount();
    lines.push(
      ` ${areaId.padEnd(8)}${area.type.padEnd(7)}${String(area.interfaces.length).padEnd(8)}` +
      `${String(adjCount).padEnd(6)}${lsaCount}`
    );
  }

  return lines.join('\n');
}

function displayOspfPeer(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  const neighbors = ospf.getNeighbors();
  const lines = [
    'OSPF Process with Router ID ' + ospf.getRouterId(),
    '                 Neighbor Brief Information',
    '',
    ' Area ID    Interface       Neighbor ID     State',
  ];

  for (const n of neighbors) {
    const iface = ospf.getInterface(n.iface);
    lines.push(
      ` ${(iface?.areaId ?? '-').padEnd(11)}${n.iface.padEnd(16)}${n.routerId.padEnd(16)}${n.state}`
    );
  }

  return lines.join('\n');
}

function displayOspfLsdb(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  const lsdb = ospf.getLSDB();
  const lines = [
    `         OSPF Process ${ospf.getProcessId()} with Router ID ${ospf.getRouterId()}`,
    `                  Link State Database`,
    '',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    lines.push(`                     Area: ${areaId}`);
    lines.push(' Type      LinkState ID    AdvRouter       Age   Len   Sequence');

    for (const [, lsa] of areaDB) {
      const typeNames: Record<number, string> = { 1: 'Router', 2: 'Network', 3: 'Sum-Net', 4: 'Sum-Asbr', 5: 'External' };
      lines.push(
        ` ${(typeNames[lsa.lsType] ?? String(lsa.lsType)).padEnd(10)}` +
        `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
        `${String(lsa.lsAge).padEnd(6)}${String(lsa.length).padEnd(6)}` +
        `0x${lsa.lsSequenceNumber.toString(16)}`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function displayOspfInterface(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const lines: string[] = [];
  for (const [name, iface] of ospf.getInterfaces()) {
    lines.push(` ${name} (${iface.ipAddress})`);
    lines.push(`   Area: ${iface.areaId}  Cost: ${iface.cost}  State: ${iface.state}`);
    lines.push(`   Type: ${iface.networkType}  Priority: ${iface.priority}`);
    lines.push(`   DR: ${iface.dr}  BDR: ${iface.bdr}`);
    lines.push(`   Hello: ${iface.helloInterval}s  Dead: ${iface.deadInterval}s`);
    lines.push(`   Neighbors: ${iface.neighbors.size}`);
    if (iface.passive) lines.push(`   (Passive interface)`);
    lines.push('');
  }

  return lines.join('\n');
}

function displayOspfPeerVerbose(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const neighbors = ospf.getNeighbors();
  if (neighbors.length === 0) {
    return `OSPF Process with Router ID ${ospf.getRouterId()}\n\n (No neighbors)`;
  }

  const lines = [
    `OSPF Process with Router ID ${ospf.getRouterId()}`,
    '           Neighbor Detail Information',
    '',
  ];

  for (const n of neighbors) {
    const iface = ospf.getInterface(n.iface);
    const deadInterval = iface ? iface.deadInterval : 40;
    lines.push(` Neighbor ${n.routerId}, address ${n.ipAddress}`);
    lines.push(`   Area ${iface?.areaId ?? '0.0.0.0'} via interface ${n.iface}`);
    lines.push(`   State: ${n.state.toUpperCase()}, Priority: ${n.priority}`);
    lines.push(`   DR: ${n.neighborDR}  BDR: ${n.neighborBDR}`);
    lines.push(`   Dead timer remaining: ${deadInterval}s`);
    lines.push(`   Neighbor up for 00:00:00`);
    lines.push('');
  }

  return lines.join('\n');
}

function displayOspfLsdbTyped(router: Router, lsType: number): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const typeNames: Record<number, string> = { 1: 'Router', 2: 'Network', 3: 'Sum-Net', 4: 'Sum-Asbr', 5: 'External' };
  const lsdb = ospf.getLSDB();
  const lines = [
    `         OSPF Process ${ospf.getProcessId()} with Router ID ${ospf.getRouterId()}`,
    `                  Link State Database`,
    '',
    `                     Type: ${typeNames[lsType] ?? String(lsType)}`,
    ' Type      LinkState ID    AdvRouter       Age   Len   Sequence',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    for (const [, lsa] of areaDB) {
      if (lsa.lsType !== lsType) continue;
      lines.push(
        ` ${(typeNames[lsa.lsType] ?? String(lsa.lsType)).padEnd(10)}` +
        `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
        `${String(lsa.lsAge).padEnd(6)}${String(lsa.length).padEnd(6)}` +
        `0x${lsa.lsSequenceNumber.toString(16)}`
      );
    }
  }

  return lines.join('\n');
}

function displayOspfInterfaceBrief(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const lines = [
    'Interface       PID   Area            IP Address/Mask    Cost  State Nbrs',
  ];

  for (const [name, iface] of ospf.getInterfaces()) {
    const pid = ospf.getProcessId();
    const area = iface.areaId;
    const ipMask = `${iface.ipAddress}/${maskToCIDR(iface.mask)}`;
    const cost = iface.cost;
    const state = iface.state;
    const nbrs = iface.neighbors.size;
    lines.push(
      `${name.padEnd(16)}${String(pid).padEnd(6)}${area.padEnd(16)}${ipMask.padEnd(19)}${String(cost).padEnd(6)}${state.padEnd(6)}${nbrs}`
    );
  }

  return lines.join('\n');
}

function displayOspfVlink(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const extra = router._getOSPFExtraConfig();
  const configVLs = extra.virtualLinks;
  const engineVLs = ospf.getVirtualLinks();

  if (configVLs.size === 0 && engineVLs.size === 0) {
    return `OSPF Process with Router ID ${ospf.getRouterId()}\n\n No virtual links configured`;
  }

  const lines: string[] = [];
  let vlIndex = 0;

  if (engineVLs.size > 0) {
    for (const [peerRid, vl] of engineVLs) {
      const vlIface = vl.iface;
      const neighbor = vlIface.neighbors.get(peerRid);
      const isUp = neighbor?.state === 'Full';
      lines.push(`Virtual Link to router ${peerRid} is ${isUp ? 'up' : 'down'}`);
      lines.push(`  Transit area ${vl.transitAreaId}, Cost ${vlIface.cost}`);
      lines.push(`  State: ${isUp ? 'POINT_TO_POINT' : 'DOWN'}`);
      lines.push(`  Timer: Hello ${vlIface.helloInterval}, Dead ${vlIface.deadInterval}`);
      lines.push('');
      vlIndex++;
    }
  } else {
    for (const [transitAreaId, peerRid] of configVLs) {
      lines.push(`Virtual Link to router ${peerRid} is down`);
      lines.push(`  Transit area ${transitAreaId}, Cost 1`);
      lines.push(`  State: DOWN`);
      lines.push(`  Timer: Hello 10, Dead 40`);
      lines.push('');
      vlIndex++;
    }
  }

  return lines.join('\n');
}

function displayOspfAbrAsbr(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const lsdb = ospf.getLSDB();
  const lines = [
    `OSPF Process ${ospf.getProcessId()} with Router ID ${ospf.getRouterId()}`,
    '',
  ];

  const borderRouters: Map<string, { isABR: boolean; isASBR: boolean }> = new Map();

  for (const [, areaDB] of lsdb.areas) {
    for (const [, lsa] of areaDB) {
      if (lsa.lsType !== 1) continue;
      const rLSA = lsa as any;
      const flags = rLSA.flags ?? 0;
      const isABR = !!(flags & 0x01);
      const isASBR = !!(flags & 0x02);
      const rid = lsa.advertisingRouter;
      if (rid === ospf.getRouterId()) continue;
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

  if (borderRouters.size === 0) {
    lines.push(' (No border routers known)');
    return lines.join('\n');
  }

  lines.push('Router         Type');
  for (const [rid, info] of borderRouters) {
    const typeStr = info.isABR && info.isASBR ? 'ABR/ASBR' : info.isABR ? 'ABR' : 'ASBR';
    lines.push(`${rid.padEnd(15)}${typeStr}`);
  }

  return lines.join('\n');
}

function displayOspfStatistics(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return 'Error: OSPF is not configured.';

  router._ospfAutoConverge();

  const lsdb = ospf.getLSDB();
  let lsaCount = 0;
  for (const [, areaDB] of lsdb.areas) {
    lsaCount += areaDB.size;
  }

  const neighborCount = ospf.getNeighborCount();
  const fullNeighborCount = ospf.getFullNeighborCount();
  const spfRunCount = ospf.getSpfRunCount();

  const lines = [
    `OSPF statistics:`,
    `  LSA: ${lsaCount} total`,
    `  SPF: ${spfRunCount} runs`,
    `  Neighbors: ${neighborCount}, Adjacent: ${fullNeighborCount}`,
    '',
    '  Area statistics:',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    const routerLsas = [...areaDB.values()].filter(l => l.lsType === 1).length;
    const networkLsas = [...areaDB.values()].filter(l => l.lsType === 2).length;
    const summaryLsas = [...areaDB.values()].filter(l => l.lsType === 3).length;
    lines.push(`    Area ${areaId}: ${routerLsas} router LSA(s), ${networkLsas} network LSA(s), ${summaryLsas} summary LSA(s)`);
  }

  return lines.join('\n');
}

function displayRoutingTableOspf(router: Router): string {
  router._ospfAutoConverge();
  const rt = (router as any).routingTable as any[];
  const lines: string[] = ['OSPF Routing Table:'];
  for (const r of rt) {
    if (r.type === 'ospf') {
      const netStr = r.network.toString();
      const cidr = maskToCIDR(r.mask.toString());
      const nh = r.nextHop ? `via ${r.nextHop}` : 'directly connected';
      lines.push(`O    ${netStr}/${cidr} [110/${r.metric}] ${nh}, ${r.iface}`);
    }
  }
  if (lines.length === 1) lines.push('  (No OSPF routes)');
  return lines.join('\n');
}

// OSPFv3 display commands

function displayOspfv3Peer(router: Router): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return 'Info: OSPFv3 is not configured.';
  router._ospfAutoConverge();
  const neighbors = v3.getNeighbors();
  const lines = [
    `OSPFv3 Process ${v3.getProcessId()} with Router ID ${v3.getRouterId()}`,
    '',
    'Neighbor ID     Pri   State           Interface',
  ];
  for (const n of neighbors) {
    lines.push(`${n.routerId.padEnd(16)}${String(n.priority).padEnd(6)}${n.state.toUpperCase().padEnd(16)}${n.iface}`);
  }
  return lines.join('\n');
}

function displayOspfv3Lsdb(router: Router): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return 'Info: OSPFv3 is not configured.';
  return `OSPFv3 Process ${v3.getProcessId()} with Router ID ${v3.getRouterId()}\n\n  Link State Database\n`;
}

function displayOspfv3Interface(router: Router): string {
  const v3 = router._getOSPFv3EngineInternal();
  if (!v3) return 'Info: OSPFv3 is not configured.';
  router._ospfAutoConverge();
  const lines: string[] = [];
  for (const [name, iface] of v3.getInterfaces()) {
    lines.push(` ${name} is up`);
    lines.push(`   Network Type: ${iface.networkType}, Cost: ${iface.cost}, Priority: ${iface.priority}`);
    lines.push('');
  }
  return lines.join('\n');
}

function maskToCIDR(mask: string): number {
  const parts = mask.split('.').map(Number);
  let bits = 0;
  for (const p of parts) {
    let n = p;
    while (n) { bits += n & 1; n >>>= 1; }
  }
  return bits;
}
