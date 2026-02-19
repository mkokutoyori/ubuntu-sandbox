/**
 * HuaweiOspfCommands - OSPF CLI commands for Huawei VRP Shell
 *
 * Handles:
 *   - System view: "ospf <process-id>", "undo ospf"
 *   - OSPF view: "area", "router-id", "silent-interface"
 *   - Area view: "network"
 *   - Display commands: "display ospf peer", "display ospf lsdb", "display ospf brief"
 */

import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';

// ─── Types for Huawei Shell Context ──────────────────────────────────

export type HuaweiOSPFShellMode = 'ospf' | 'ospf-area';

export interface HuaweiOSPFShellContext {
  r(): Router;
  setMode(mode: string): void;
  getMode(): string;
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
}

// ─── Display Commands ────────────────────────────────────────────────

export function registerOSPFDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('display ospf brief', 'Display OSPF brief information', () => displayOspfBrief(getRouter()));
  trie.register('display ospf peer', 'Display OSPF neighbor information', () => displayOspfPeer(getRouter()));
  trie.register('display ospf lsdb', 'Display OSPF link-state database', () => displayOspfLsdb(getRouter()));
  trie.register('display ospf interface', 'Display OSPF interface information', () => displayOspfInterface(getRouter()));
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
