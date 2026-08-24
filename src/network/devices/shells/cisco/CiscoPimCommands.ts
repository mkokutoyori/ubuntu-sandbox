import type { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import type { Router } from '../../Router';
import type { PimAgent } from '../../../pim/PimAgent';
import type { PimMode } from '../../../pim/types';
import { hms } from '@/lib/format';
import { CISCO_ERRORS } from '../cli-utils';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import { MODES_INTERFACE } from './CiscoConfigCommands';

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

export function pimInterfaceRunningConfigLines(router: Router, iface: string): string[] {
  const a = agent(router);
  if (!a) return [];
  const rt = a.getInterfaceRuntime(iface);
  if (!rt?.enabled) return [];
  const lines = [` ip pim ${rt.mode}-mode`];
  if (rt.drPriority !== 1) lines.push(` ip pim dr-priority ${rt.drPriority}`);
  return lines;
}

const PIM_IF_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'ip pim sparse-mode': null,
  'ip pim dense-mode': null,
  'ip pim sparse-dense-mode': null,
  'ip pim dr-priority': {
    name: 'priorite', type: 'REST', description: 'DR election priority',
    alternatives: [{ keyword: '<0-4294967295>', description: 'DR election priority' }],
  },
  'ip pim query-interval': {
    name: 'secondes', type: 'REST', description: 'Hello interval in seconds',
    alternatives: [{ keyword: '<1-65535>', description: 'Hello interval in seconds' }],
  },
  'no ip pim': null,
};

export function pimInterfaceSpecs(ctx: IfCtx): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildPimInterfaceCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: MODES_INTERFACE, minPrivilege: 15,
      argumentFor: (path) => PIM_IF_ARGUMENTS[path],
    },
  );
}

export function buildPimInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  const enable = (mode: PimMode) => (args: string[]) => {
    void args;
    const a = agent(ctx.r());
    if (!a) return '';
    for (const port of ctx.selectedPorts()) a.enableInterface(port, mode);
    return mode === 'sparse' ? '' : PIM_DENSE_MODE_NOTE;
  };
  trie.registerGreedy('ip pim sparse-mode', 'Enable PIM sparse mode', enable('sparse'));
  trie.registerGreedy('ip pim dense-mode', 'Enable PIM dense mode', enable('dense'));
  trie.registerGreedy('ip pim sparse-dense-mode', 'Enable PIM sparse-dense mode', enable('sparse-dense'));

  trie.registerGreedy('no ip pim', 'Disable PIM on interface', (args) => {
    void args;
    const a = agent(ctx.r());
    if (!a) return '';
    for (const port of ctx.selectedPorts()) a.disableInterface(port);
    return '';
  });

  trie.registerGreedy('ip pim dr-priority', 'Set PIM DR election priority', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const prio = parseInt(args[0], 10);
    if (Number.isNaN(prio) || prio < 0) return '% Invalid priority';
    for (const port of ctx.selectedPorts()) a.setDrPriority(port, prio);
    return '';
  });

  trie.registerGreedy('ip pim query-interval', 'Set PIM hello interval (seconds)', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const secs = parseInt(args[0], 10);
    if (Number.isNaN(secs) || secs <= 0) return '% Invalid interval';
    for (const port of ctx.selectedPorts()) a.setHelloInterval(port, secs);
    return '';
  });
}

export function pimGlobalRunningConfigLines(router: Router): string[] {
  const a = agent(router);
  if (!a) return [];
  return a.listRps()
    .filter((rp) => rp.isStatic)
    .map((rp) => `ip pim rp-address ${rp.rpAddress}`);
}

export function buildPimGlobalConfigCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('ip pim rp-address', 'Configure static PIM RP address', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rpAddress = args[0];
    if (!rpAddress || !/^\d+\.\d+\.\d+\.\d+$/.test(rpAddress)) return '% Invalid RP address';
    if (args.length > 1) return CISCO_ERRORS.INVALID_INPUT;
    a.addStaticRp(rpAddress);
    return '';
  });

  trie.registerGreedy('no ip pim rp-address', 'Remove static PIM RP address', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rpAddress = args[0];
    if (!rpAddress) return '';
    a.removeStaticRp(rpAddress);
    return '';
  });

  trie.registerGreedy('ip pim spt-threshold', 'Configure PIM SPT switchover threshold', () => '');

  // `ip pim bsr-candidate <iface> [hash-mask-length] [priority]` — the BSR
  // identity is the interface's own address, exactly as on real IOS.
  trie.registerGreedy('ip pim bsr-candidate', 'Configure this router as a candidate BSR', (args) => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const iface = args[0];
    if (!iface) return '% Incomplete command.';
    const ip = r.getPort(iface)?.getIPAddress()?.toString();
    if (!ip) return `% Interface ${iface} has no IP address`;
    const priority = args[2] !== undefined ? parseInt(args[2], 10) : 0;
    if (Number.isNaN(priority) || priority < 0 || priority > 255) {
      return `% Invalid input detected at '^' marker.`;
    }
    a.setBsrCandidate(ip, priority);
    return '';
  });

  trie.registerGreedy('no ip pim bsr-candidate', 'Remove the candidate BSR configuration', () => {
    const a = agent(ctx.r());
    if (!a) return '';
    a.clearBsrCandidate();
    return '';
  });

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

  trie.registerGreedy('ip pim join-prune-interval', 'Set PIM join/prune interval (seconds)', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const secs = parseInt(args[0], 10);
    if (Number.isNaN(secs) || secs <= 0) return '% Invalid interval';
    a.setJoinPruneInterval(secs);
    return '';
  });
}

export function registerPimShowCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('show ip pim neighbor', 'Display PIM neighbors', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const neighbors = a.listNeighbors(namedInterface(ctx, args[0]));
    const rows = ['PIM Neighbor Table',
      'Neighbor Address  Interface                Uptime/Expires    Ver  DR Prio/Mode'];
    for (const n of neighbors) {
      const uptime = hms(Date.now() - n.upSinceMs);
      const expires = hms(Math.max(0, n.helloHoldSec * 1000 - (Date.now() - n.lastHeardMs)));
      rows.push(`${n.neighborIp.padEnd(18)}${n.iface.padEnd(25)}${(uptime + '/' + expires).padEnd(18)}v2   ${n.drPriority}${n.hasDrPriorityOption ? '' : ' (default)'}`);
    }
    return rows.join('\n');
  });

  trie.registerGreedy('show ip pim rp mapping', 'Display PIM RP mappings', () => {
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
  });

  trie.registerGreedy('show ip pim bsr-router', 'Display the PIM bootstrap router', () => {
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
  });

  trie.registerGreedy('show ip pim interface', 'Display PIM interface state', (args) => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const requested = namedInterface(ctx, args[0]);
    const ifaces = requested ? [requested] : Array.from(a.getConfig().interfaces.keys());
    // L'en-tête tient sur deux lignes et les données sur une : les trois
    // se déduisent des MÊMES largeurs, sinon elles finissent décalées
    // comme elles l'étaient — `Nbr Count` annoncé une colonne à droite
    // du compte qu'il surmonte.
    const COLS = [17, 25, 11, 6, 7, 7] as const;
    const row = (cells: readonly string[]) =>
      cells.map((c, i) => (i < COLS.length ? c.padEnd(COLS[i]) : c)).join('').trimEnd();
    const lines: string[] = [
      row(['Address', 'Interface', 'Ver/Mode', 'Nbr', 'Query', 'DR', 'DR']),
      row(['', '', '', 'Count', 'Intvl', 'Prior', '']),
    ];
    for (const ifaceName of ifaces) {
      const rt = a.getInterfaceRuntime(ifaceName);
      if (!rt || !rt.enabled) continue;
      const port = r.getPort(ifaceName);
      const ip = port?.getIPAddress()?.toString() ?? '0.0.0.0';
      const nbrCount = a.listNeighbors(ifaceName).length;
      lines.push(row([ip, ifaceName, `v2/${rt.mode}`, String(nbrCount),
        String(rt.helloIntervalSec), String(rt.drPriority), rt.designatedRouterIp ?? 'none']));
    }
    const anyDense = ifaces.some((n) => {
      const rt = a.getInterfaceRuntime(n);
      return rt !== undefined && rt.enabled && rt.mode !== 'sparse';
    });
    if (anyDense) {
      lines.push('');
      lines.push('Note: dense mode is displayed as configured but behaves as sparse mode');

    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip mroute', 'Display IP multicast routing table', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const groupFilter = args.find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
    const mroutes = a.listMroutes().filter((m) => !groupFilter || m.groupAddress === groupFilter);
    const lines: string[] = ['IP Multicast Routing Table',
      "Flags: D - Dense, S - Sparse, s - SSM Group, C - Connected, L - Local,",
      "       J - Join SPT",
      "Outgoing interface flags: H - Hardware switched, A - Assert winner",
      ''];
    for (const m of mroutes) {
      const src = m.sourceAddress ?? '*';
      lines.push(`(${src}, ${m.groupAddress}), ${hms(Date.now() - m.uptimeMs)}/${hms(Math.max(0, m.joinExpiryMs - Date.now()))}, RP ${m.rpAddress ?? '0.0.0.0'}, flags: S`);
      lines.push(`  Incoming interface: ${m.incomingInterface ?? 'Null'}, RPF nbr ${m.upstreamNeighborIp ?? '0.0.0.0'}`);
      lines.push(`  Outgoing interface list:`);
      if (m.outgoingInterfaces.size === 0) {
        lines.push(`    Null`);
      } else {
        for (const oif of m.outgoingInterfaces) {
          lines.push(`    ${oif}, Forward/${m.entryType === 'star-g' ? 'Sparse' : 'Sparse-Dense'}, ${hms(Date.now() - m.uptimeMs)}/${hms(Math.max(0, m.joinExpiryMs - Date.now()))}`);
        }
      }
      lines.push('');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  });
}

const PIM_SHOW_ARGUMENTS: Readonly<Record<string, [string, string]>> = {
  'show ip pim neighbor': ['WORD', 'Interface name'],
  'show ip pim interface': ['WORD', 'Interface name'],
  'show ip mroute': ['A.B.C.D', 'Multicast group address'],
};

export function pimShowSpecs(ctx: ShowCtx): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerPimShowCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['user', 'privileged'],
      minPrivilege: 1,
      restDescriptionFor: (path) => PIM_SHOW_ARGUMENTS[path]?.[1],
      restLiteralFor: (path) => PIM_SHOW_ARGUMENTS[path]?.[0],
    },
  );
}
