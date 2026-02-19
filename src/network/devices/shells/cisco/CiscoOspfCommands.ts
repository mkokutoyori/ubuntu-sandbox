/**
 * CiscoOspfCommands - OSPF CLI commands for Cisco IOS Shell
 *
 * Handles:
 *   - config mode: "router ospf <process-id>", "no router ospf"
 *   - config-router-ospf mode: "network", "router-id", "passive-interface", "area"
 *   - config-if mode: "ip ospf cost", "ip ospf priority"
 *   - show commands: "show ip ospf", "show ip ospf neighbor", "show ip ospf database"
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

  configTrie.registerGreedy('no router ospf', 'Disable OSPF routing protocol', (args) => {
    ctx.r()._disableOSPF();
    return '';
  });
}

// ─── Config-Router Mode: OSPF sub-commands ───────────────────────────

export function buildConfigRouterOSPFCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('network', 'Define OSPF network/area', (args) => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';

    // Check if we're in RIP mode or OSPF mode
    if (ctx.r().isRIPEnabled() && !ospf) {
      // Delegate to RIP network command (already handled by CiscoRipCommands)
      return '';
    }

    // Syntax: network <ip> <wildcard> area <area-id>
    if (args.length < 4) return '% Incomplete command.';
    const network = args[0];
    const wildcard = args[1];
    if (args[2].toLowerCase() !== 'area') return '% Invalid input. Expected "area" keyword.';
    const areaId = args[3];

    ospf.addNetwork(network, wildcard, areaId);
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
      // Make all interfaces passive
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

  trie.register('default-information originate', 'Distribute default route', () => {
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    ospf.setDefaultInformationOriginate(true);
    return '';
  });

  trie.register('log-adjacency-changes', 'Log OSPF adjacency changes', () => '');

  trie.register('version 2', 'Use RIPv2', () => '');
}

// ─── Config-If Mode: OSPF interface commands ─────────────────────────

export function registerOSPFInterfaceCommands(configIfTrie: CommandTrie, ctx: CiscoShellContext): void {
  configIfTrie.registerGreedy('ip ospf cost', 'Set OSPF cost on interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const cost = parseInt(args[0], 10);
    if (isNaN(cost) || cost < 1 || cost > 65535) return '% Invalid cost value (1-65535)';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    ospf.setInterfaceCost(ifName, cost);
    return '';
  });

  configIfTrie.registerGreedy('ip ospf priority', 'Set OSPF priority on interface', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const priority = parseInt(args[0], 10);
    if (isNaN(priority) || priority < 0 || priority > 255) return '% Invalid priority value (0-255)';
    const ospf = ctx.r()._getOSPFEngineInternal();
    if (!ospf) return '% OSPF is not enabled.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    ospf.setInterfacePriority(ifName, priority);
    return '';
  });
}

// ─── Show Commands ───────────────────────────────────────────────────

export function registerOSPFShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show ip ospf', 'Display OSPF information', () => showIpOspf(getRouter()));
  trie.register('show ip ospf neighbor', 'Display OSPF neighbor table', () => showIpOspfNeighbor(getRouter()));
  trie.register('show ip ospf database', 'Display OSPF link-state database', () => showIpOspfDatabase(getRouter()));
  trie.register('show ip ospf interface', 'Display OSPF interface information', () => showIpOspfInterface(getRouter()));
}

// ─── Show Command Implementations ───────────────────────────────────

function showIpOspf(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  const config = ospf.getConfig();
  const lines = [
    `Routing Process "ospf ${config.processId}" with ID ${config.routerId}`,
    ` Number of areas in this router is ${config.areas.size}`,
    ` Reference bandwidth unit is ${config.autoCostReferenceBandwidth} mbps`,
    '',
  ];

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

  const neighbors = ospf.getNeighbors();
  const lines = [
    'Neighbor ID     Pri   State           Dead Time   Address         Interface',
  ];

  if (neighbors.length === 0) {
    return lines.join('\n');
  }

  for (const n of neighbors) {
    const iface = ospf.getInterface(n.iface);
    const drFlag = iface?.dr === n.ipAddress ? 'DR' :
                   iface?.bdr === n.ipAddress ? 'BDR' : 'DROTHER';
    const stateStr = `${n.state}/${drFlag}`;
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

  const lsdb = ospf.getLSDB();
  const lines = [
    `            OSPF Router with ID (${ospf.getRouterId()}) (Process ID ${ospf.getProcessId()})`,
    '',
  ];

  for (const [areaId, areaDB] of lsdb.areas) {
    lines.push(`                Router Link States (Area ${areaId})`);
    lines.push('');
    lines.push('Link ID         ADV Router      Age         Seq#            Checksum  Link count');

    for (const [, lsa] of areaDB) {
      if (lsa.lsType === 1) {
        const rLSA = lsa as any;
        lines.push(
          `${lsa.linkStateId.padEnd(16)}${lsa.advertisingRouter.padEnd(16)}` +
          `${String(lsa.lsAge).padEnd(12)}0x${lsa.lsSequenceNumber.toString(16).padEnd(16)}` +
          `0x${lsa.checksum.toString(16).padEnd(10)}${rLSA.numLinks ?? 0}`
        );
      }
    }

    // Network LSAs
    const networkLSAs = [...areaDB.values()].filter(l => l.lsType === 2);
    if (networkLSAs.length > 0) {
      lines.push('');
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
    }

    lines.push('');
  }

  return lines.join('\n');
}

function showIpOspfInterface(router: Router): string {
  const ospf = router._getOSPFEngineInternal();
  if (!ospf) return '% OSPF is not configured';

  const lines: string[] = [];
  for (const [name, iface] of ospf.getInterfaces()) {
    lines.push(`${name} is up, line protocol is up`);
    lines.push(`  Internet Address ${iface.ipAddress}/${maskToCIDR(iface.mask)}, Area ${iface.areaId}`);
    lines.push(`  Process ID ${ospf.getProcessId()}, Router ID ${ospf.getRouterId()}, Network Type ${iface.networkType.toUpperCase()}, Cost: ${iface.cost}`);
    lines.push(`  Transmit Delay is ${iface.transmitDelay} sec, State ${iface.state}, Priority ${iface.priority}`);
    lines.push(`  Designated Router (ID) ${iface.dr}`);
    lines.push(`  Backup Designated Router (ID) ${iface.bdr}`);
    lines.push(`  Timer intervals configured, Hello ${iface.helloInterval}, Dead ${iface.deadInterval}, Wait ${iface.deadInterval}, Retransmit ${iface.retransmitInterval}`);
    lines.push(`  Neighbor Count is ${iface.neighbors.size}, Adjacent neighbor count is ${countFullNeighbors(iface)}`);
    if (iface.passive) {
      lines.push(`  No Hellos (Passive interface)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

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
