import { simulationNowMs } from '@/network/core/SystemClock';

import { isValidIPv4 } from '@/network/core/ip';
import type { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import {
  specsFromTrieRegistrations, collectRegistrations,
} from '@/cli/commands/trieAdapter';
import type { Router } from '../../Router';
import type { PimAgent } from '../../../pim/PimAgent';
import type { PimMode } from '../../../pim/types';
import { hms } from '@/lib/format';
import { CISCO_ERRORS } from '../cli-utils';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import { MODES_INTERFACE } from './CiscoConfigCommands';
import { FIXED_TABLE, padToWidth, renderTable, type TableColumn } from '@/network/devices/shells/cli/TextTable';

interface IfCtx {
  selectedPorts(): string[];
  r(): Router;
}

interface ShowCtx {
  r(): Router;
  resolveInterfaceName?(input: string): string | null;
}

function namedInterface(ctx: ShowCtx, input: string | undefined): string | undefined {
  if (!input) return undefined;
  return ctx.resolveInterfaceName?.(input) ?? input;
}

function agent(router: Router): PimAgent | undefined {
  return (router as unknown as { getPimAgent?: () => PimAgent }).getPimAgent?.();
}

/**
 * The engine only ever builds explicit-join (*,G) state — dense mode's
 * flood-and-prune is not modelled. The mode is still stored and displayed,
 * so the CLI has to say plainly that it does not change behaviour rather
 * than let the output imply otherwise.
 */
export const PIM_DENSE_MODE_NOTE =
  '% PIM dense mode is accepted but behaves as sparse mode in this simulator '
  + '(explicit join only — flood-and-prune is not modelled).';

const PIM_DEFAULT_DR_PRIORITY = 1;
const PIM_DEFAULT_HELLO_SECONDS = 30;
const PIM_DEFAULT_JOIN_PRUNE_SECONDS = 60;

export function pimInterfaceRunningConfigLines(router: Router, iface: string): string[] {
  const a = agent(router);
  if (!a) return [];
  const rt = a.getInterfaceRuntime(iface);
  if (!rt?.enabled) return [];
  const lines = [` ip pim ${rt.mode}-mode`];
  if (rt.drPriority !== PIM_DEFAULT_DR_PRIORITY) lines.push(` ip pim dr-priority ${rt.drPriority}`);
  if (rt.helloIntervalSec !== PIM_DEFAULT_HELLO_SECONDS) lines.push(` ip pim query-interval ${rt.helloIntervalSec}`);
  return lines;
}

export function pimInterfaceSpecs(ctx: IfCtx): CommandSpec[] {
  const base = { modes: MODES_INTERFACE, minPrivilege: 15 };
  const onPorts = (apply: (a: PimAgent, port: string) => void): string => {
    const a = agent(ctx.r());
    if (!a) return '';
    for (const port of ctx.selectedPorts()) apply(a, port);
    return '';
  };
  const disable = (): string => onPorts((a, port) => a.disableInterface(port));
  const enableMode = (mode: PimMode, description: string): CommandSpec => ({
    ...base,
    id: `config-if-ip-pim-${mode}-mode`,
    path: ['ip', 'pim', `${mode}-mode`],
    description,
    undoDescription: 'Disable PIM on interface',
    run: () => {
      onPorts((a, port) => a.enableInterface(port, mode));
      return mode === 'sparse' ? '' : PIM_DENSE_MODE_NOTE;
    },
    undo: disable,
  });
  return [
    {
      ...base, id: 'config-if-ip-pim-negated', path: ['ip', 'pim'],
      description: 'PIM interface configuration', existsOnlyNegated: true,
      run: () => '', undo: disable,
    },
    enableMode('sparse', 'Enable PIM sparse mode'),
    enableMode('dense', 'Enable PIM dense mode'),
    enableMode('sparse-dense', 'Enable PIM sparse-dense mode'),
    {
      ...base, id: 'config-if-ip-pim-dr-priority', undoOmitsArguments: true,
      path: ['ip', 'pim', 'dr-priority', {
        name: 'priority', type: 'INT', range: [0, 4294967295],
        description: 'DR election priority',
      }],
      description: 'Set PIM DR election priority',
      undoDescription: 'Restore the default DR priority',
      run: (_session, args) =>
        onPorts((a, port) => a.setDrPriority(port, parseInt(args.priority, 10))),
      undo: () => onPorts((a, port) => a.setDrPriority(port, PIM_DEFAULT_DR_PRIORITY)),
    },
    {
      ...base, id: 'config-if-ip-pim-query-interval', undoOmitsArguments: true,
      path: ['ip', 'pim', 'query-interval', {
        name: 'seconds', type: 'INT', range: [1, 65535],
        description: 'Hello interval in seconds',
      }],
      description: 'Set PIM hello interval (seconds)',
      undoDescription: 'Restore the default hello interval',
      run: (_session, args) =>
        onPorts((a, port) => a.setHelloInterval(port, parseInt(args.seconds, 10))),
      undo: () => onPorts((a, port) => a.setHelloInterval(port, PIM_DEFAULT_HELLO_SECONDS)),
    },
  ];
}

export function pimGlobalRunningConfigLines(router: Router): string[] {
  const a = agent(router);
  if (!a) return [];
  const spt = a.getSptThreshold();
  return [
    ...a.listRps()
      .filter((rp) => rp.isStatic)
      .map((rp) => `ip pim rp-address ${rp.rpAddress}`),
    ...(spt === null ? [] : [`ip pim spt-threshold ${spt}`]),
  ];
}

const PIM_GLOBAL_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'ip pim send-rp-announce': {
    name: 'reste', type: 'REST', description: 'Interface, then `scope <ttl>`',
  },
  'ip pim send-rp-discovery': {
    name: 'reste', type: 'REST', description: 'Interface, then `scope <ttl>`',
  },
  'ip pim rp-candidate': {
    name: 'reste', type: 'REST', description: 'Interface, then interval and priority',
  },
};

export function pimGlobalSpecs(ctx: ShowCtx): CommandSpec[] {
  const base = { modes: ['config'], minPrivilege: 15 };
  const withAgent = (apply: (a: PimAgent) => string): string => {
    const a = agent(ctx.r());
    return a ? apply(a) : '';
  };
  const native: CommandSpec[] = [
    {
      ...base, id: 'config-ip-pim-rp-address',
      path: ['ip', 'pim', 'rp-address', {
        name: 'rp', type: 'IP_ADDR', description: 'Address of the rendezvous point',
      }],
      description: 'Configure static PIM RP address',
      undoDescription: 'Remove static PIM RP address',
      run: (_session, args) => withAgent((a) => { a.addStaticRp(args.rp); return ''; }),
      undo: (_session, args) => withAgent((a) => { a.removeStaticRp(args.rp); return ''; }),
    },
    {
      ...base, id: 'config-ip-pim-spt-threshold', undoOmitsArguments: true,
      path: ['ip', 'pim', 'spt-threshold', {
        name: 'threshold', type: 'WORD',
        description: 'Rate above which the router joins the shortest-path tree',
        alternatives: [
          { keyword: 'infinity', description: 'Never join the shortest-path tree' },
          { keyword: '<0-4294967>', description: 'Rate in kbps' },
        ],
        pattern: /^(infinity|\d{1,7})$/i,
      }],
      description: 'Configure PIM SPT switchover threshold',
      undoDescription: 'Restore the default SPT switchover threshold',
      run: (_session, args) => withAgent((a) => {
        const word = args.threshold.toLowerCase();
        const kbps = word === 'infinity' ? word : parseInt(word, 10);
        if (kbps !== 'infinity' && kbps > 4294967) throw new CliInvalidInput();
        a.setSptThreshold(kbps);
        return '';
      }),
      undo: () => withAgent((a) => { a.setSptThreshold(null); return ''; }),
    },
    {
      ...base, id: 'config-ip-pim-join-prune-interval', undoOmitsArguments: true,
      path: ['ip', 'pim', 'join-prune-interval', {
        name: 'seconds', type: 'INT', range: [1, 65535],
        description: 'Join/prune interval in seconds',
      }],
      description: 'Set PIM join/prune interval (seconds)',
      undoDescription: 'Restore the default join/prune interval',
      run: (_session, args) => withAgent((a) => {
        a.setJoinPruneInterval(parseInt(args.seconds, 10));
        return '';
      }),
      undo: () => withAgent((a) => { a.setJoinPruneInterval(PIM_DEFAULT_JOIN_PRUNE_SECONDS); return ''; }),
    },
    {
      ...base, id: 'config-ip-pim-bsr-candidate', undoOmitsArguments: true,
      path: ['ip', 'pim', 'bsr-candidate',
        { name: 'interface', type: 'INTERFACE', description: 'Interface whose address identifies the BSR' },
        { name: 'hashMaskLength', type: 'INT', range: [0, 32], optional: true,
          description: 'Hash mask length for RP selection' },
        { name: 'priority', type: 'INT', range: [0, 255], optional: true,
          description: 'Priority of the candidate BSR' },
      ],
      description: 'Configure this router as a candidate BSR',
      undoDescription: 'Remove the candidate BSR configuration',
      run: (_session, args) => withAgent((a) => {
        const ip = ctx.r().getPort(args.interface)?.getIPAddress()?.toString();
        if (!ip) return `% Interface ${args.interface} has no IP address`;
        a.setBsrCandidate(ip, args.priority === undefined ? 0 : parseInt(args.priority, 10));
        return '';
      }),
      undo: () => withAgent((a) => { a.clearBsrCandidate(); return ''; }),
    },
  ];
  return [...native, ...specsFromTrieRegistrations(
    (collector) =>
      buildPimGlobalConfigCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => PIM_GLOBAL_ARGUMENTS[path],
    },
  )];
}

export function buildPimGlobalConfigCommands(trie: CommandTrie, ctx: ShowCtx): void {
  // `ip pim rp-candidate <iface> [group-list <acl>] [priority <n>]`.
  trie.registerGreedy('ip pim rp-candidate', 'Advertise this router as a candidate RP', (args) => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const iface = args[0];
    if (!iface) return '% Incomplete command.';
    const ip = r.getPort(iface)?.getIPAddress()?.toString();
    if (!ip) return `% Interface ${iface} has no IP address`;
    const pIdx = args.findIndex((x) => x.toLowerCase() === 'priority');
    const priority = pIdx >= 0 ? parseInt(args[pIdx + 1] ?? '', 10) : 0;
    if (Number.isNaN(priority) || priority < 0 || priority > 255) {
      return `% Invalid input detected at '^' marker.`;
    }
    a.setRpCandidate(ip, priority);
    return '';
  });

  trie.registerGreedy('ip pim send-rp-announce', 'Announce this router as an Auto-RP candidate RP', (args, raw) => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const iface = args[0];
    if (!iface) return CISCO_ERRORS.INCOMPLETE;
    const ip = r.getPort(iface)?.getIPAddress()?.toString();
    if (!ip) return `% Interface ${iface} has no IP address`;
    const scopeIdx = args.findIndex((x) => x.toLowerCase() === 'scope');
    if (scopeIdx === -1) return CISCO_ERRORS.INCOMPLETE;
    const scope = parseInt(args[scopeIdx + 1] ?? '', 10);
    if (Number.isNaN(scope) || scope < 1 || scope > 255) throw new CliInvalidInput();
    a.setRpCandidate(ip, 0);
    (r as unknown as { _recordUnhandledConfigLine?: (l: string) => void })
      ._recordUnhandledConfigLine?.(raw ?? `ip pim send-rp-announce ${args.join(' ')}`);
    return '';
  });

  trie.registerGreedy('ip pim send-rp-discovery', 'Act as the Auto-RP mapping agent', (args, raw) => {
    const r = ctx.r();
    if (!agent(r)) return '';
    const scopeIdx = args.findIndex((x) => x.toLowerCase() === 'scope');
    if (scopeIdx === -1) return CISCO_ERRORS.INCOMPLETE;
    const scope = parseInt(args[scopeIdx + 1] ?? '', 10);
    if (Number.isNaN(scope) || scope < 1 || scope > 255) throw new CliInvalidInput();
    (r as unknown as { _recordUnhandledConfigLine?: (l: string) => void })
      ._recordUnhandledConfigLine?.(raw ?? `ip pim send-rp-discovery ${args.join(' ')}`);
    return '';
  });

  trie.registerGreedy('no ip pim rp-candidate', 'Remove the candidate RP configuration', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    a.clearRpCandidate();
    return '';
  });
}

export function pimShowSpecs(ctx: ShowCtx): CommandSpec[] {
  const neighbors = (requestedInterface: string | undefined): string => {
    const a = agent(ctx.r());
    if (!a) return '';
    const neighbors = a.listNeighbors(namedInterface(ctx, requestedInterface));
    const rows = ['PIM Neighbor Table',
      'Neighbor Address  Interface                Uptime/Expires    Ver  DR Prio/Mode'];
    for (const n of neighbors) {
      const uptime = hms(simulationNowMs() - n.upSinceMs);
      const expires = hms(Math.max(0, n.helloHoldSec * 1000 - (simulationNowMs() - n.lastHeardMs)));
      rows.push(`${padToWidth(n.neighborIp, 18)}${padToWidth(n.iface, 25)}${padToWidth(uptime + '/' + expires, 18)}v2   ${n.drPriority}${n.hasDrPriorityOption ? '' : ' (default)'}`);
    }
    return rows.join('\n');
  };

  const rpMapping = (): string => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rps = a.listRps();
    if (rps.length === 0) return 'PIM Group-to-RP Mappings\nThis system is not a PIM RP.';
    const now = a.nowMs();
    const bsr = a.getConfig().currentBsr;
    const lines: string[] = ['PIM Group-to-RP Mappings'];
    for (const rp of rps) {
      lines.push('');
      lines.push(`Group(s) ${rp.groupRangeAddress}/${rp.groupRangeMaskBits}`);
      lines.push(`  RP: ${rp.rpAddress}`);
      if (rp.isStatic) {
        lines.push(`    Info source: static`);
      } else {
        const expires = hms(Math.max(0, (rp.expiresMs ?? now) - now));
        lines.push(`    Info source: ${bsr?.address ?? '0.0.0.0'} (?), via bootstrap, priority ${rp.priority ?? 0}`);
        lines.push(`         Expires: ${expires}`);
      }
    }
    return lines.join('\n');
  };

  const bsrRouter = (): string => {
    const a = agent(ctx.r());
    if (!a) return '';
    const cfg = a.getConfig();
    if (!cfg.currentBsr && !cfg.bsrCandidate && !cfg.rpCandidate) {
      return 'PIMv2 Bootstrap information\n  This system is not part of any PIM domain.';
    }
    const now = a.nowMs();
    const lines: string[] = ['PIMv2 Bootstrap information'];
    if (cfg.currentBsr) {
      const isSelf = cfg.bsrCandidate?.address === cfg.currentBsr.address;
      lines.push(`  BSR address: ${cfg.currentBsr.address}${isSelf ? ' (?)' : ''}`);
      lines.push(`  Uptime:      ${cfg.lastBsrHeardMs === null ? 'local' : hms(now - cfg.lastBsrHeardMs)}, BSR Priority: ${cfg.currentBsr.priority}, Hash mask length: 30`);
      lines.push(`  This system is ${isSelf ? 'the Bootstrap Router (BSR)' : 'not the Bootstrap Router (BSR)'}`);
    } else if (cfg.bsrCandidate) {
      lines.push(`  This system is a candidate BSR`);
      lines.push(`    Candidate BSR address: ${cfg.bsrCandidate.address}, priority: ${cfg.bsrCandidate.priority}, hash mask length: 30`);
    }
    if (cfg.rpCandidate) {
      lines.push(`  Candidate RP: ${cfg.rpCandidate.address}`);
      lines.push(`    Group(s) ${cfg.rpCandidate.groupRangeAddress}/${cfg.rpCandidate.groupRangeMaskBits}, priority ${cfg.rpCandidate.priority}`);
    }
    return lines.join('\n');
  };

  const interfaces = (requestedInterface: string | undefined): string => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const requested = namedInterface(ctx, requestedInterface);
    const ifaces = requested ? [requested] : Array.from(a.getConfig().interfaces.keys());
    // L'en-tête tient sur deux lignes et les données sur une : les trois
    // se déduisent des MÊMES largeurs, sinon elles finissent décalées
    // comme elles l'étaient — `Nbr Count` annoncé une colonne à droite
    // du compte qu'il surmonte.
    const columns: TableColumn<string[]>[] = [
      { superHeader: 'Address', header: '', width: 17 },
      { superHeader: 'Interface', header: '', width: 25 },
      { superHeader: 'Ver/Mode', header: '', width: 11 },
      { superHeader: 'Nbr', header: 'Count', width: 6 },
      { superHeader: 'Query', header: 'Intvl', width: 7 },
      { superHeader: 'DR', header: 'Prior', width: 7 },
      { superHeader: 'DR', header: '' },
    ].map((column, i) => ({ ...column, value: (cells: string[]) => cells[i] }));
    const tableRows: string[][] = [];
    for (const ifaceName of ifaces) {
      const rt = a.getInterfaceRuntime(ifaceName);
      if (!rt || !rt.enabled) continue;
      const port = r.getPort(ifaceName);
      const ip = port?.getIPAddress()?.toString() ?? '0.0.0.0';
      const nbrCount = a.listNeighbors(ifaceName).length;
      tableRows.push([ip, ifaceName, `v2/${rt.mode}`, String(nbrCount),
        String(rt.helloIntervalSec), String(rt.drPriority), rt.designatedRouterIp ?? 'none']);
    }
    const lines = renderTable(tableRows, columns, FIXED_TABLE);
    const anyDense = ifaces.some((n) => {
      const rt = a.getInterfaceRuntime(n);
      return rt !== undefined && rt.enabled && rt.mode !== 'sparse';
    });
    if (anyDense) {
      lines.push('');
      lines.push('Note: dense mode is displayed as configured but behaves as sparse mode');

    }
    return lines.join('\n');
  };

  const mroute = (groupFilter: string | undefined): string => {
    const a = agent(ctx.r());
    if (!a) return '';
    const mroutes = a.listMroutes().filter((m) => !groupFilter || m.groupAddress === groupFilter);
    const lines: string[] = ['IP Multicast Routing Table',
      "Flags: D - Dense, S - Sparse, s - SSM Group, C - Connected, L - Local,",
      "       J - Join SPT",
      "Outgoing interface flags: H - Hardware switched, A - Assert winner",
      ''];
    for (const m of mroutes) {
      const src = m.sourceAddress ?? '*';
      lines.push(`(${src}, ${m.groupAddress}), ${hms(simulationNowMs() - m.uptimeMs)}/${hms(Math.max(0, m.joinExpiryMs - simulationNowMs()))}, RP ${m.rpAddress ?? '0.0.0.0'}, flags: S`);
      lines.push(`  Incoming interface: ${m.incomingInterface ?? 'Null'}, RPF nbr ${m.upstreamNeighborIp ?? '0.0.0.0'}`);
      lines.push(`  Outgoing interface list:`);
      if (m.outgoingInterfaces.size === 0) {
        lines.push(`    Null`);
      } else {
        for (const oif of m.outgoingInterfaces) {
          lines.push(`    ${oif}, Forward/${m.entryType === 'star-g' ? 'Sparse' : 'Sparse-Dense'}, ${hms(simulationNowMs() - m.uptimeMs)}/${hms(Math.max(0, m.joinExpiryMs - simulationNowMs()))}`);
        }
      }
      lines.push('');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  };
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  const interfacePlace: ArgumentSpec = {
    name: 'interface', type: 'INTERFACE', optional: true, description: 'Interface name',
  };
  return [
    {
      ...base, id: 'show-ip-pim-neighbor', path: ['show', 'ip', 'pim', 'neighbor', interfacePlace],
      description: 'Display PIM neighbors', run: (_session, args) => neighbors(args.interface),
    },
    {
      ...base, id: 'show-ip-pim-rp-mapping', path: ['show', 'ip', 'pim', 'rp', 'mapping'],
      description: 'Display PIM RP mappings', run: () => rpMapping(),
    },
    {
      ...base, id: 'show-ip-pim-bsr-router', path: ['show', 'ip', 'pim', 'bsr-router'],
      description: 'Display the PIM bootstrap router', run: () => bsrRouter(),
    },
    {
      ...base, id: 'show-ip-pim-interface', path: ['show', 'ip', 'pim', 'interface', interfacePlace],
      description: 'Display PIM interface state', run: (_session, args) => interfaces(args.interface),
    },
    {
      ...base, id: 'show-ip-mroute',
      path: ['show', 'ip', 'mroute', {
        name: 'group', type: 'IP_ADDR', optional: true, description: 'Multicast group address',
      }],
      description: 'Display IP multicast routing table', run: (_session, args) => mroute(args.group),
    },
  ];
}
