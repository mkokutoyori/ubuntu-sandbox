import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { PimAgent } from '../../../pim/PimAgent';
import type { PimMode } from '../../../pim/types';
import { hms } from '@/lib/format';

interface IfCtx {
  selectedPorts(): string[];
  r(): Router;
}

interface ShowCtx {
  r(): Router;
}

function agent(router: Router): PimAgent | undefined {
  return (router as unknown as { getPimAgent?: () => PimAgent }).getPimAgent?.();
}

export function buildPimInterfaceCommands(trie: CommandTrie, ctx: IfCtx): void {
  const enable = (mode: PimMode) => (args: string[]) => {
    void args;
    const a = agent(ctx.r());
    if (!a) return '';
    for (const port of ctx.selectedPorts()) a.enableInterface(port, mode);
    return '';
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

export function buildPimGlobalConfigCommands(trie: CommandTrie, ctx: ShowCtx): void {
  trie.registerGreedy('ip pim rp-address', 'Configure static PIM RP address', (args) => {
    const a = agent(ctx.r());
    if (!a) return '';
    const rpAddress = args[0];
    if (!rpAddress || !/^\d+\.\d+\.\d+\.\d+$/.test(rpAddress)) return '% Invalid RP address';
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
    let iface: string | undefined;
    if (args[0] && args[0].toLowerCase() !== 'detail' && args[0].toLowerCase() !== 'count') iface = args[0];
    const neighbors = a.listNeighbors(iface);
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
    const rps = a.getConfig().rps;
    if (rps.length === 0) return 'PIM Group-to-RP Mappings\nThis system is not a PIM RP.';
    const lines: string[] = ['PIM Group-to-RP Mappings'];
    for (const rp of rps) {
      lines.push('');
      lines.push(`Group(s) ${rp.groupRangeAddress}/${rp.groupRangeMaskBits}`);
      lines.push(`  RP: ${rp.rpAddress}`);
      lines.push(`    Info source: ${rp.isStatic ? 'static' : 'bootstrap'}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip pim interface', 'Display PIM interface state', (args) => {
    const a = agent(ctx.r());
    const r = ctx.r();
    if (!a) return '';
    const requested = args[0] && args[0].toLowerCase() !== 'count' ? args[0] : undefined;
    const ifaces = requested ? [requested] : Array.from(a.getConfig().interfaces.keys());
    const lines: string[] = [
      'Address          Interface                Ver/Mode   Nbr   Query  DR     DR',
      '                                                    Count Intvl  Prior  ',
    ];
    for (const ifaceName of ifaces) {
      const rt = a.getInterfaceRuntime(ifaceName);
      if (!rt) continue;
      const port = r.getPort(ifaceName);
      const ip = port?.getIPAddress()?.toString() ?? '0.0.0.0';
      const nbrCount = a.listNeighbors(ifaceName).length;
      lines.push(`${ip.padEnd(17)}${ifaceName.padEnd(25)}v2/${rt.mode.padEnd(7)}${String(nbrCount).padEnd(6)}${String(rt.helloIntervalSec).padEnd(7)}${String(rt.drPriority).padEnd(7)}${rt.designatedRouterIp ?? 'none'}`);
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
