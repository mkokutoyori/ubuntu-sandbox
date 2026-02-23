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
import { CommandTrie } from '../CommandTrie';
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
  configTrie.register('ip routing', 'Enable IP routing', () => '');
}

// ─── Config-Router Mode: OSPF sub-commands ───────────────────────────

export function buildConfigRouterOSPFCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
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

  trie.register('log-adjacency-changes', 'Log OSPF adjacency changes', () => '');
  trie.register('version 2', 'Use RIPv2', () => '');
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
    const ifName = ctx.resolveInterfaceName(args.join(' '));
    if (!ifName) return `% Invalid interface`;
    v3.setPassiveInterface(ifName);
    return '';
  });

  trie.registerGreedy('default-information originate', 'Distribute default route', (_args) => {
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return '% OSPFv3 is not enabled.';
    v3.setDefaultInformationOriginate(true);
    return '';
  });

  trie.registerGreedy('redistribute', 'Redistribute routes', (_args) => '');

  trie.registerGreedy('area', 'OSPFv3 area parameters', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const v3 = ctx.r()._getOSPFv3EngineInternal();
    if (!v3) return '% OSPFv3 is not enabled.';
    const areaId = args[0];
    const subCmd = args[1].toLowerCase();
    if (subCmd === 'stub') {
      v3.setAreaType(areaId, 'stub');
      return '';
    } else if (subCmd === 'range') {
      return '';
    } else if (subCmd === 'virtual-link') {
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

  trie.registerGreedy('distribute-list', 'Filter routes', (_args) => '');

  trie.registerGreedy('bfd', 'BFD configuration', (args) => {
    if (args.length >= 1 && args[0].toLowerCase() === 'all-interfaces') {
      ctx.r()._getOSPFExtraConfig().bfdAllInterfaces = true;
    }
    return '';
  });
}

// ─── Config-If Mode: OSPF interface commands ─────────────────────────

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
      }
    }
  };

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

  configIfTrie.registerGreedy('ip ospf demand-circuit', 'Configure demand circuit', (_args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    setPendingOspfIf(ifName, { demandCircuit: true });
    return '';
  });

  // BFD on interface
  configIfTrie.registerGreedy('bfd', 'BFD configuration', (_args) => '');

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
  configIfTrie.registerGreedy('frame-relay', 'Frame relay configuration', (_args) => '');

  // Tunnel commands
  configIfTrie.registerGreedy('tunnel source', 'Set tunnel source', (_args) => '');
  configIfTrie.registerGreedy('tunnel destination', 'Set tunnel destination', (_args) => '');
}

// ─── Show Commands ───────────────────────────────────────────────────

export function registerOSPFShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show ip ospf', 'Display OSPF information', () => showIpOspf(getRouter()));
  trie.register('show ip ospf neighbor', 'Display OSPF neighbor table', () => showIpOspfNeighbor(getRouter()));
  trie.register('show ip ospf database', 'Display OSPF link-state database', () => showIpOspfDatabase(getRouter()));
  trie.registerGreedy('show ip ospf database external', 'Display external LSAs', (args) => showIpOspfDatabaseExternal(getRouter(), args[0]));
  trie.registerGreedy('show ip ospf interface', 'Display OSPF interface information', (args) => showIpOspfInterface(getRouter(), args[0]));
  trie.registerGreedy('show ip route ospf', 'Display OSPF routes', (_args) => showIpRouteOspf(getRouter()));
  trie.registerGreedy('show ip route', 'Display IP routing table', (args) => {
    if (args.length > 0 && args[0] !== 'ospf') return showIpRouteSpecific(getRouter(), args[0]);
    return showIpRouteAll(getRouter());
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

function showIpOspfDatabaseExternal(router: Router, network?: string): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';
  // Simplified external LSA display
  const lines = [`            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`, ''];
  lines.push('                Type-5 AS External Link States');
  lines.push('');
  lines.push('Link ID         ADV Router      Age   Seq#            Checksum  Tag  Forward Address');
  // Show forwarding address
  lines.push(`${(network || '0.0.0.0').padEnd(16)}${ospf.getRouterId().padEnd(16)}0     0x80000001      0x0000    0    Forward Address: 0.0.0.0`);
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
    // Demand circuit
    const pendingCfg = extra.pendingIfConfig?.get(name);
    if (pendingCfg?.demandCircuit) lines.push(`  Demand circuits enabled`);
    lines.push('');
  }

  return lines.join('\n');
}

function showIpRouteAll(router: Router): string {
  router._ospfAutoConverge();
  const rt = (router as any).routingTable as any[];
  const lines: string[] = ['Codes: C - connected, S - static, O - OSPF, O IA - OSPF inter area',
    '       O E1 - OSPF external type 1, O E2 - OSPF external type 2',
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
    } else if (r.type === 'ospf') {
      const code = getOSPFRouteCode(router, netStr, cidr, r);
      lines.push(`${code}     ${netStr}/${cidr} [110/${r.metric}] ${nh}, ${r.iface}`);
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
      lines.push(`${code}     ${netStr}/${cidr} [110/${r.metric}] via ${r.nextHop || 'directly connected'}, ${r.iface}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '';
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
  const extra = router._getOSPFExtraConfig();
  const lines: string[] = [];
  const resolvedIfName = ifName ? resolveOSPFIfName(ifName) : undefined;
  for (const [name, iface] of v3.getInterfaces()) {
    if (resolvedIfName && name !== resolvedIfName) continue;
    const ntStr = iface.networkType === 'point-to-point' ? 'Point-to-point' : 'Broadcast';
    lines.push(`${name} is up, line protocol is up`);
    lines.push(`  Network Type ${ntStr}, Cost: ${iface.cost}, Priority: ${iface.priority}`);
    lines.push(`  DR: ${iface.dr || '0.0.0.0'}`);
    lines.push(`  BDR: ${iface.bdr || '0.0.0.0'}`);
    // Check IPsec auth
    const v3Pending = extra.pendingV3IfConfig?.get(name);
    if (v3Pending?.ipsecAuth) lines.push(`  IPsec authentication enabled`);
    if (extra.bfdAllInterfaces) lines.push(`  BFD enabled`);
    lines.push('');
  }
  return lines.join('\n');
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
  const rt = (router as any).ipv6RoutingTable as any[] || [];
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
  const rt = (router as any).ipv6RoutingTable as any[] || [];

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
  return `${code} ${prefix}/${prefLen} [${ad}/${metric}]\n  ${nh}, ${best.iface}`;
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
  const parts = mask.split('.').map(Number);
  let bits = 0;
  for (const p of parts) {
    let n = p;
    while (n) { bits += n & 1; n >>>= 1; }
  }
  return bits;
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInSubnet(ip: string, network: string, mask: string): boolean {
  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(network);
  const maskNum = ipToNumber(mask);
  return (ipNum & maskNum) === (netNum & maskNum);
}
